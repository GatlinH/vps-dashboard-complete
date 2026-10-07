# F-09 / F-10 / F-03 缺口关闭设计

状态：设计定稿，供后续实现使用；本文不表示三项修复已经实施或验收通过。

核查日期：2026-10-07。工作树：`/root/.hermes/plans/solar-comet-upgrade/worktree`。核查起点 HEAD：`cfb4b89685f27a46b9699861ea6fc71e5e636603`。

本次唯一交付是本文。后续实现采用三个独立提交：**F-10 删除旧入口 → F-03 扩大门禁作用域 → F-09 统一层级施加位置**。F-09 在技术上独立，排在最后是为了先完成删除及防复活，再改有可观察命中效果的样式职责。

## 核查基线与引用约定

- 下文 `src/`、`scripts/`、`test/`、`package*.json` 均相对于工作树的 `frontend-vite/`；行号是本次读取的工作树行号，不是早期复审行号。
- `E/` 表示 **`/root/.hermes/plans/solar-comet-upgrade/evidence/`**，即工作树外的同级证据目录。任务给出的 round 16、round 17、Claude review 三组路径实际在这里，不能按 `worktree/evidence/` 读取。本文写作没有复制或修改这些证据。
- `W/evidence/` 表示工作树内的 `evidence/`，例如 K1 与 dashboard 修复记录。未来仓库门禁不得依赖上述机器绝对路径；历史证据是审计引用，不是测试运行依赖。
- HEAD 正确，但工作树并不干净：开始时已有 **13 个 tracked 文件修改**，另有未跟踪源码、测试和证据。这意味着“HEAD 相同”不足以证明源码字节相同。设计以当前工作树为准，后续实现必须保留这些既有改动，不能把它们带进三项原子提交。
- “414 单测、quality、build 绿”有历史记录支持：`W/evidence/k1-closure-20261006/impl/test-unit.log:310–311`、`quality.log:546–547` 及 `test-unit.exit` / `quality.exit` / `build.exit` 均为 0。本次没有重跑会写缓存或构建产物的命令，也没有把旧日志当作新鲜执行结果。
- 本次直接运行四个只读脚本，均 exit 0：`node scripts/verify-solar-system-home.mjs`、`node scripts/verify-single-renderer-home.mjs`、`node scripts/verify-detail-page-regressions.mjs`、`node scripts/verify-sw-precache-solar.mjs`。最后一项检查的是已有构建（17 个 precache URL、22 个纹理文件），不是本次新构建。
- `E/hermes-acceptance-round17-20261006/REPORT.md:101–112` 停留在 C4/C6 未完成的中间状态；应以各子目录的最终 JSON 为准：`c4-interaction/report.json` 为 `C4_PASS`，`c6-fallback/report.json` 为 `C6_PASS`，`c7-stacking/report.json` 为 PASS，`c8-dpr{1,2,3}/report.json` 均为 `C8_PASS`。不因汇总 Markdown 陈旧而重开已关闭项。
- “无框架”适用于太阳系场景实现，不适用于整个前端：`package.json` 已含 React / React DOM；首页静态 import 图包含 `GlobeStarmapMount.jsx` 和 `GlobeStarmap.jsx`。作用域检查必须支持 JSX，不能只处理 `.js`。

冻结边界：`SolarHitLayout.js` 中 `SEP_X=24.4`、`MAX_OFF=11.4`、`R_EM=12`、`R_S=12`、`BOX=24`、`R_YIELD=13.5`、`MAX_OFF_S=11`、`D0=1.6` 的声明与几何使用一律保持；求解器、`realizeSolarHitLayout`、`writeSolarHitCenter` 不变。F-02、F-04、C5、C10 不由本文关闭。不得修改 `clip-path: circle(50%)`、三层 inset 焦点阴影、单 renderer / 单 rAF 架构，不增加 npm 依赖。

所有下列新增断言均有稳定的错误前缀和对应变异。表中的函数接口是后续实现约定；例子中的源码变异在内存副本中完成，不应改测试运行中的产品文件。浏览器变异仅改变受控测试 DOM，并在 `finally` 中恢复。

## F-09：CSS 与运行时层级双真相源

### 1. 现状证据与独立复算

| 位置 | 已核实事实 |
| --- | --- |
| `src/styles/starfleet-theme.css:412–426` | 基类 width/height 已是 24px；423 行仍是 `z-index: 6`；419–420 行为圆角和圆形 clip。 |
| `src/styles/starfleet-theme.css:427–435` | hover / focus-visible 共用黑、白、黑三层 inset 阴影；本设计保留整个规则块。 |
| `src/components/SolarSystem.js:643–683` | 唯一创建点 `_buildHitButtons()`；655–658 行 targets 顺序为 Sun、Earth、Moon；668 行只设置基类；680 行把按钮 append 到 `this.container`。 |
| `src/components/SolarSystem.js:942–1013` | `_syncHitButtons()` 中 969 行求解、998 行写中心、999–1000 行写 BOX 尺寸；**1002 行**写 30/20/10；1010 行实现 DOM 精度修正。任务给出的 1001 行实际是注释。 |
| `src/components/SolarSystem.js:101–108,1039–1060,840–844` | 构造中建按钮后调用 `resume()`；`resume()` 同步执行 `_tick()`，首轮 sync 在首次 rAF 排队前发生。没有“必然等下一帧才赋 z”的正常路径。 |
| `src/components/solar/SolarHitLayout.js:2–25` | 冻结几何常数均存在；没有层级导出常数。 |
| `scripts/verify-solar-system-home.mjs:116–121` | 116 行只固定七个几何值，121 行只验圆角；没有 CSS 尺寸与 BOX 的交叉比较，也没有 CSS z 与 JS z 的比较。 |
| `scripts/solar_clip_contract.py:64,78–100` | C3 用 `key in row[4]`；C2 的六个契约点用未经筛选的完整栈首，并以 `KEYS=('sun','earth','moon')` 建模优先级。C2 不直接给全部径向采样逐条判 owner。 |

对 `E/hermes-acceptance-round17-20261006/c4-interaction/state-idle.json.gz` 解压复算，压缩文件 SHA-256 为：

```text
1f80833722f635fdd030b90c3a771af16099c144db00437af9ba539dbfe22719
```

该记录为视口 320×700、DPR 1、根字体 16px、JD 2446454.4312、canvas 320×180。其 `rowEncoding` 明确是 `[index, x, y, nativeTopStableId, nativeFullStackStableIds, nativeApisAgree]`。因此“第 4 / 第 3 元素”应明确写成 **零基下标 `row[4]` / `row[3]`**，按自然语言第几个计数则是第五 / 第四个。

| 中心对 | 由 `before.centers` 复算的距离（CSS px） | 两个半径 12 的圆盘 |
| --- | --- | --- |
| sun–earth | 18.288357032210474 | 重叠 |
| earth–moon | 24.40000709439014 | 不重叠 |
| sun–moon | 35.835683297678464 | 不重叠 |

查询数量是 `3 × 18 × 2401 = 129654` 条射线记录，加六个契约点，共 129660。**3480 是射线记录中的日地重叠数**，这些记录的 XY 也各不相同，3480 条完整栈首全部为 sun；独立 `points` 中另有 `probe sun` 重叠。因此若按全部查询记录计数，应是 **3481 条，而非“3480 条且包含 probe sun”**。`probe sun=(160,90.00000000000001)` 的完整栈开头是 `sun, earth, canvas, …`；`['sun','earth']` 只是其按钮子序列，不是完整栈。

本次还把记录深拷贝到内存，仅按树序把每个栈内已有的按钮重排为 moon > earth > sun，并重算 `apisAgree`，未改变任何 membership、坐标、中心或半径。调用当前 `check_points()` / `check_ray()` 得到：

```text
原记录：C2 PASS，failureCount=0；C3 无失败。
同级树序反事实：C2 FAIL，failureCount=1，failures=['C2_OWNERSHIP']。
54 条 check_ray 结果逐项完全相同；径向 owner 翻转 3480 条。
唯一失败契约点：probe sun，modelOwner=sun，nativeOwner=earth。
```

这证明用户的**因果推算与 C2/C3 区分正确**。它是离线顺序反事实，不是本次删除内联样式后的浏览器实测；字面量漂移仍未被现有 CSS/JS 交叉断言覆盖。

还须纠正复审时效：`E/claude-review-20261005/run-20261006T102956/review.md:86,137` 的“clip 后所有圆盘不重叠、任何 z 回归都无断言发现”不成立。0.4px 间隙只适用于本记录的地月对，不能套给日地对。Round 17 后另已有 **C7**：`E/hermes-acceptance-round17-20261006/verify_c7_stacking.py:205–217,239–265` 检查数值、同父树序及同心遮挡；报告记录五个层级变异已被杀死。其 `C7_ZINDEX_NUMERIC` 实际判断的是 **inline** 数值，computed 仅写入详情，不能声称已检查 CSS 来源。该脚本未构造按钮后代，故“clip 对后代裁剪及逃逸尚缺专项断言”仍成立。

### 2. 层叠环境与首帧判断

任务中的 DOM 关系需要修正。`src/modules/serverTable.js:375–386` 创建太阳系容器和 `.globe-overlay-layer` 作为 section 的兄弟；按钮在太阳系容器内，overlay 内的四个节点不是按钮的直接兄弟。下表 `globe.css` 均指 `src/styles/globe.css`。

| 节点 / 规则 | 实际层级和可命中性 | 来源 |
| --- | --- | --- |
| `.globe-overlay-layer` | 规则只有 `pointer-events:none`，没有自己的 position / z-index | `src/styles/globe.css:219` |
| `globeReturnSolarBtn` | z=40，`pointer-events:auto`；首页模板及 `showSolarSystem()` 中 `display:none` | `globe.css:220–225`；`serverTable.js:382,583–586` |
| `globeFirstEntryToast` | z=39，`pointer-events:none`；首页隐藏 | `globe.css:228–232`；`serverTable.js:383,586` |
| `globeFocusBadge` | 早期 z=19，最终由混合规则改为 **40 !important**，且最终 `display:none !important`；不是只看 203 行的 19 | `globe.css:199–216,1467–1473,1857–1859` |
| `globeTooltip` | 当前空 div；`src/` 中没有针对该 class/id 的层级声明，z=auto；不要把 `.detail-probe-globe-tooltip` 当成它 | `serverTable.js:385` |
| `.solar-ephemeris-controls` | **按钮同父的真实交互兄弟**，z=4，含可操作 input/button | `SolarSystem.js:295–296`；`src/components/solar/precision-ephemeris.css:1–6,30–45` |
| `.solar-body-label` | z=3，`pointer-events:none !important` | `starfleet-theme.css:654–666` |

`src/styles/globe.css` 是由懒加载的 `CesiumGlobe.js:2` 引入的。冷启动只有太阳系时，不能假定它已生效；本次 C4 记录中太阳系容器 computed z=auto。加载 Cesium 样式后，`.three-globe-host` 的 position/z=2（`globe.css:48–76`）会给太阳系容器建立上下文，此时按钮内部的 30 也不能越过容器去与外部 40 直接比较。验证须包含冷启动及 Earth→Esc 返回后两种样式加载状态。

删除基类 z 而保留每帧内联赋值，在正常同步构造路径上未必产生可见闪烁；但它仍留下错误回退。若漏写内联，clip 会让 `z:auto` 的按钮成为 0 层上下文，除了日地争用，还可能低于同父的 z=4 星历控件。不能以当前四个 overlay 节点隐藏为“auto 总安全”的证明。

### 3. 决策与职责边界

**采用按天体的 CSS 类，CSS 是运行时唯一施加 z-index 的位置。**

```css
/* .solar-system-hit 保留尺寸、clip、焦点相关声明，仅删除 z-index: 6。 */
.solar-system-hit--sun { z-index: 30; }
.solar-system-hit--earth { z-index: 20; }
.solar-system-hit--moon { z-index: 10; }
```

`_buildHitButtons()` 的 class 赋值改为：

```js
button.className = `solar-system-hit solar-system-hit--${target.name.toLowerCase()}`;
```

仍在 append 前执行；targets、DOM 顺序、button type、ARIA、事件绑定不变。`_syncHitButtons()` **只删除当前 1002 行的 z-index 赋值**，包括 1001 行注释在内的其余行保持。不得借此整理方法、改写中心/尺寸写入、调整 visibility 或重排求解调用。

在 `SolarHitLayout.js` 常量区**仅新增**一个非几何导出：

```js
export const HIT_Z_INDEX = Object.freeze({ sun: 30, earth: 20, moon: 10 });
```

它声明 sun > earth > moon 的契约及与现有控件的数值关系，供门禁/诊断使用；求解器不得读取它，运行时不得把它再写回 `el.style.zIndex`。现有几何声明（包括 D0）不动。

这不是声称跨语言只剩一份文字：JS 导出是可导入的契约值，CSS 有受门禁约束的镜像；消除的是两套同时施加样式、互相掩盖的运行时写入。CSS 及 JS 中任何一侧单改都会被交叉比较杀死。运行时不读取 computed z 驱动几何，也不加每帧 CSS 读取。

不选其它方案的理由：

- 仅删 CSS 6：保留首写/漏写窗口和三元字面量，不能关闭双来源问题。
- 把基类改成统一 30：同级依赖树序，正好产生已经证明的错误 owner。
- CSS 三类与 JS 每帧常量同时写：即使暂时相等，仍允许内联掩盖 CSS 退化。
- CSS 自定义属性再由 JS 每帧转写、或引入 CSS 生成管线：增加同步/构建职责；这三个固定层级不需要它们。

正常完成 sync 后 computed z 与现状相同，所有几何输入和输出相同；首个连接布局即有 30/20/10，漏掉 sync 不再改变层级。移除内联写入也意味着 sync **不再负责修复外部注入的内联 z**：产品代码禁止这样的写入，浏览器测试必须显式恢复变异，不能再依赖下一帧“冲掉”它。

### 4. 改动清单（未来实现）

| 操作 | 文件与精确范围 |
| --- | --- |
| 修改 | `src/styles/starfleet-theme.css`：仅在 `.solar-system-hit` 删除 z=6，并在其后新增三个 modifier 规则；不动尺寸、clip、hover/focus 规则。 |
| 修改 | `src/components/SolarSystem.js`：`_buildHitButtons()` 的 className 一行；`_syncHitButtons()` 仅删除 zIndex 赋值一行。 |
| 新增导出 | `src/components/solar/SolarHitLayout.js`：上述 `HIT_Z_INDEX`；不改任何原有几何语句。 |
| 新增 | `scripts/lib/solarHitStyleContract.mjs`：CSS AST 提取、CSS/导出常数交叉检查、内联层级写入检查，接口见下节。 |
| 修改 | `scripts/verify-solar-system-home.mjs`：导入新常数/检查器并调用；保留 116 行原有 deepEqual、121 行圆角断言及其它原有门禁。新增 D0 冻结检查，不修改 D0。 |
| 新增 | `test/unit/solarHitStyleContract.test.js`：真实源码检查、双向单侧变异、重复声明/交互覆盖变异、实际按钮创建方法的 class 绑定测试。 |
| 新增 | `scripts/verify_solar_hit_stacking.py`：把 round 17 C7 方法纳入仓库维护，改为相对仓库定位、CSS 所有权断言，补首连接布局及后代对照；复用已有 CDPDispatcher，不改历史 evidence 脚本。 |
| 修改 | `package.json` 只新增 `test:solar-hit-stacking` 命令指向上述 Python 脚本；dependencies / devDependencies / lockfile 不变。 |

`postcss` 已在 `package-lock.json:8080`，`acorn` / `acorn-jsx` 已在 4195 / 4208 行，且本次只读导入成功。复用它们解析 CSS 和 JS/JSX，无安装或依赖升级。

### 5. 验收断言及其变异

#### 5.1 静态交叉绑定

检查器接口：`assertSolarHitStyleContract({ css, solarSource, geometry, z })`，其中门禁调用必须传真实导出的 `{ BOX, R_EM, R_S, D0 }` 和 `HIT_Z_INDEX`，不能从 CSS 自己派生 expected。下列示例变量来自这些实参。CSS 用 PostCSS AST 解析，不在可能命中注释的整文件正则上抓第一个数字。

提取契约：精确选择 `.solar-system-hit` 基规则一次；width/height 各有一个非 important 的 px 字面量；三条 modifier 各一次、各一个非 important 的整数 z 声明，均在顶层。遍历全部包含这四种 class token 的规则，拒绝其它 width/height/z-index 声明，包括 media、hover、focus、重复规则中的覆盖。保留当前共同的 hover/focus 选择器合法。`readDecl()` 对缺失、重复、非字面量或不合规范形态统一抛 `F09_CSS_SHAPE:<selector>:<property>`。

关键比较可直接落成：

```js
assert.equal(readDecl('.solar-system-hit', 'width'), `${BOX}px`,
  'F09_CSS_BOX:width must equal BOX');
assert.equal(readDecl('.solar-system-hit', 'height'), `${BOX}px`,
  'F09_CSS_BOX:height must equal BOX');
assert.deepEqual([2 * R_EM, 2 * R_S], [BOX, BOX],
  'F09_CSS_RADIUS:circle(50%) must match both radii');
for (const key of ['sun', 'earth', 'moon']) {
  assert.equal(readDecl(`.solar-system-hit--${key}`, 'z-index'), String(HIT_Z_INDEX[key]),
    `F09_CSS_Z:${key} must equal HIT_Z_INDEX`);
}
assert.deepEqual(HIT_Z_INDEX, { sun: 30, earth: 20, moon: 10 },
  'F09_Z_POLICY:expected sun=30 earth=20 moon=10');
assert.equal(D0, 1.6, 'F09_FROZEN_D0:expected 1.6');
```

该检查应在原有几何值 deepEqual 前运行，使单侧漂移先得到专属诊断；旧的值固定断言仍保留，负责捕获“两边一起改”的未授权几何变化。

| 断言 / 落点 | 必杀变异与失败信息 |
| --- | --- |
| 两条 `F09_CSS_BOX`，共用检查器，静态门禁和 unit 均调用 | **只改 CSS** 的 width 或 height 为 48px：对应 `F09_CSS_BOX:width/height`。**只改 JS** `BOX=26`、CSS 保持 24px：同一比较失败。分别做两个方向的变异，不能仅验证常量固定表。 |
| `F09_CSS_RADIUS` | 只把 R_EM 或 R_S 改成 13，BOX/CSS 不变：半径比较失败；完整门禁的原有冻结值检查也仍会失败。这是检测用变异，不是获准修改几何。 |
| 三条 `F09_CSS_Z:<key>` | 每个天体分别做 CSS-only 与 JS-only 变异，例如 CSS earth=30、JS earth=20；JS sun=31、CSS sun=30。必须在相应比较处失败。 |
| `F09_Z_POLICY` | 同时把 CSS 和导出 sun 都改成 31，或三者都改成 30：交叉相等也不能放过，失败于固定层级策略。 |
| `F09_CSS_SHAPE` | 恢复基类 z=6；追加 `.solar-system-hit--earth:hover { z-index:31 !important }`；在另一个 media 规则改 width；复制第二条 sun 规则；删掉 moon 规则。任一种均给出具体 selector/property，不能悄悄选取其中一份。 |
| `assert.equal(findInlineZWrites(solarAst).length, 0, 'F09_INLINE_Z_WRITER')` | 恢复旧三元赋值，或改用 `style['zIndex']` / `style.setProperty('z-index', …)`：`F09_INLINE_Z_WRITER`。AST 遍历整个 SolarSystem 文件，不只一个方法；对应形式均有检测器变异测试。 |
| `assert.deepEqual(created.map(b => b.className), expectedClasses, 'F09_BODY_CLASS_BINDING')` | 从真实 `_buildHitButtons()` 提取/调用方法，以最小 DOM stub 捕获 append；删 modifier、三者都用 sun、对调 earth/moon：`F09_BODY_CLASS_BINDING`。stub 的 append 同时记录 class，保证赋类发生在连接前。 |
| 原有几何值 deepEqual 加 `F09_FROZEN_D0` | 两侧一起改 BOX=26：原有 deepEqual 报 BOX expected 24；D0=1.7：`F09_FROZEN_D0`。冻结检查不代替前述交叉比较。 |

变异单测必须调用同一个检查器。例如 CSS-only 传变异 CSS 与真实导出；JS-only 在内存中把布局模块的导出常量声明改值并加载其模块副本，再传原 CSS。当前该布局模块没有相对 import，可用唯一 data URL 导入副本。不得同时修正 expected，也不得仅构造一个无关的错误对象作为“JS 变异”。每项要求原版 PASS、变异出现表中失败前缀、还原 PASS；语法错误、模块加载失败不算杀死。

#### 5.2 浏览器中的来源、遮挡与 clip 后代

新脚本先验证生产 CSS/JS 资源及真实实例。**首连接取样是新增验证**：既有 C6 的 `verify_c6_fallback_path.py:156–190` 使用 document-start rAF 轮询，证明的是首次观察到三个按钮的完成帧，不是同步构造过程中“首次 sync 前”的状态，不能直接冒用该证据。

实现时用 CDP `Page.addScriptToEvaluateOnNewDocument` 安装仅用于取证的 `Node.prototype.appendChild` 包装：调用保存的原生方法后，若 child 是 hit button，立即同步记录其 class、computed 尺寸/z、inline z；原样返回原方法结果。第三个按钮记录完即恢复 appendChild，异常/退出也在 finally 恢复。不得替换 `_buildHitButtons`、`_syncHitButtons`、命中查询 API 或写入被测样式。这样读数发生在实际 `_buildHitButtons()` 的 append 返回前，尚未进入构造末尾的 resume/sync；未收到恰好三个记录即失败。MutationObserver 在任务结束时才回调，不能单凭它证明该时序。首连接时只检查来源/尺寸，不要求尚未完成投影的中心位置。后续暂停真实实例并固定构型 A，观察 1200ms + 3 帧的零样式写入，才进行回退和同心控制。

浏览器断言使用完整 `elementsFromPoint` 栈；只有证明三按钮相对次序时才提取三者索引，判断 owner 时绝不滤掉其它遮挡节点。下表快照都是 CDP JSON 对应的 Python dict，`KEYS=('sun','earth','moon')`，`EXPECTED_Z={'sun':'30','earth':'20','moon':'10'}`。C7 的同心控制单独标识，不拿它冒充构型 A 的几何证据。

| 可直接写入脚本的断言（快照由 CDP 采集） | 必杀变异与失败信息 |
| --- | --- |
| `assert first['connectedKeys'] == ['sun','earth','moon'], 'F09_FIRST_LAYOUT_TARGETS'`；`assert first['z'] == {'sun':'30','earth':'20','moon':'10'}, 'F09_FIRST_LAYOUT_Z'` | 漏建 moon：前者失败；漏赋 modifier 或把 class 延迟到 sync：后者失败，避免首连接样本缺失也绿。 |
| `assert first['wh'] == {k:[24,24] for k in KEYS}, 'F09_FIRST_LAYOUT_BOX'` | CSS 回退为 48、首次 sync 再写 24：首连接断言仍失败，不被完成帧掩盖。 |
| `assert all(v == '' for v in sample['inlineZ'].values()), 'F09_INLINE_Z_PRESENT'`，覆盖首连接、正常 sync、resize、暂停/恢复、Earth→Esc 和七种交互状态 | 将写 z 移到创建、resize 或交互回调中：对应阶段 `F09_INLINE_Z_PRESENT`。仅在单个空闲帧检查不够。 |
| `assert fallback['wh'] == {k:[24,24] for k in KEYS}, 'F09_CSS_FALLBACK_BOX'`；`assert fallback['z'] == EXPECTED_Z, 'F09_CSS_FALLBACK_Z'` | 暂停后仅移除内联 width/height/z；CSS width=48 或 earth z=6 分别失败。恢复 sync 后再次检查，不能让运行中的帧先覆盖坏 CSS 再取样。 |
| `assert 'sun' in probe['stack'] and 'earth' in probe['stack'], 'F09_OVERLAP_REQUIRED'`；`assert probe['stack'][0] == 'sun', 'C2_OWNERSHIP:probe sun'` | 换成无日地重叠的无区分度构型：前者失败；使三者同级或 earth 高于 sun：后者失败。另按原检查器运行完整 C0–C3。 |
| `assert paused['styleWrites'] == 0 and paused['frameId'] == 0, 'C7_PAUSE_TOTAL'` | 不完整暂停，控制期间 sync 覆盖手工位置/visibility：先判无效测量，不能把结果算层级 PASS。 |
| `assert computedZ == EXPECTED_Z, 'C7_ZINDEX_NUMERIC'` | sun 30→31 不改变 owner，但数值断言失败。**替换旧 C7 的 inline==EXPECTED_Z 表达方式，同时新增 inline 为空断言，保留数值语义。** |
| `assert sameParent and domOrder == ['sun','earth','moon'], 'C7_SAME_PARENT_AND_DOM_ORDER'` | 调换树序或包一层 wrapper：失败；防止错误 DOM 排列碰巧掩盖扁平 z。 |
| `assert park['maxCentreErrorPx'] <= 0.02 and park['boxes24'], 'C7_CONTROL_GEOMETRY'` | 把一个控制按钮中心错放 1px（仍在三者圆内，可能仍给出相同 owner）：该前提断言失败，不能把错误对照当同心证据。 |
| `assert allVisible['stack'][0]=='sun', 'C7_STEP1_TOP_SUN'`；`assert 0 <= order['sun'] < order['earth'] < order['moon'], 'C7_STEP1_STACK_ORDER'` | 扁平 z 由 moon 在顶；交换 earth/moon 则相对栈序错误；置顶外部遮罩则 owner 错误。保留 round 17 五项注入对这些原有断言的精确失败集合；新增来源断言的预期失败另列，不能忽略额外失败。 |
| `assert sunHidden['stack'][0]=='earth', 'C7_STEP2_TOP_EARTH'`；`assert sunEarthHidden['stack'][0]=='moon', 'C7_STEP3_TOP_MOON'` | sun 隐藏时把 earth 设 pointer-events:none，仅第二步失败；让 moon 失去命中，仅第三步失败。不要删去逐层隐藏步骤。 |
| `assert control['inside']['stack'][0]=='sibling', 'F09_CLIP_CONTEXT'` | 在下述独立对照中仅把 clip 改成 none：高 z 后代越过 sibling，失败于 `F09_CLIP_CONTEXT`。 |
| `assert 'child' not in control['outside']['stack'], 'F09_CLIP_DESCENDANT'` | 同一个 clip:none 变异让伸出圆盘的 child 恢复命中：`F09_CLIP_DESCENDANT`。采样离边界 4px，避免 0.02px API 差异混淆原因。 |
| `assert restored['attributes'] == original['attributes'] and restored['centers'] == original['centers'], 'F09_RESTORE'` | 漏删变异内联 z、残留后代或 wrapper、仅调用 sync 代替恢复：`F09_RESTORE`。位置数值使用现有 C7 的保存/恢复口径；attributes 快照还包含 parent/child 身份，不能只比较 style 字符串。 |

clip 专项对照必须隔离因果：在独立测试容器内使用生产 hit class 和 24px 盒；显式将父按钮设 `z-index:auto; transform:none; opacity:1; filter:none; backdrop-filter:none; contain:none; isolation:auto; will-change:auto; mix-blend-mode:normal`，排除其它建立上下文的因素。放一个 z=9999、四周伸出 8px 的 span 后代；另放中心重合、24px 大、z=1 的同父 sibling。保留 clip 时，中心 owner 是 sibling，中心向右 16px 处不含 child；只在这个**测试对照**中设 clip:none，两条断言均应反转。还原后再 PASS。原产品 clip 完全不改。

理由：现有按钮的非 auto z、定位 transform 本来也会建立上下文。若拿“z=30 且有 transform”的父节点做移除 clip 对照，后代仍不能逃逸，测试将没有区分度。独立对照证明 clip 的单独作用；真实 C7 证明生产层级，不把两种证据混称一项。

### 6. 风险与回滚

直接受影响的是 C2 owner、C4 交互栈不变性、C6 回退、C7 层级；这些必须在新构建上复验。C0/C1/C3/C8 的几何与测量口径未改，也必须沿用原检查器确认没有附带变化。C9 的六个 clip 变异继续要求“变异被杀死且恢复后 C0–C3 PASS”，不能因换了 z 来源而放宽。C5/C10 状态不升级。

受保护的回归检查及检测用变异：

| 保留检查 | 回退/误改时的失败 |
| --- | --- |
| `verify-solar-system-home.mjs:13–14` 的 renderer/rAF 计数仍各为 1 | 新增第二个实例/排帧点：原 equal 断言 expected 1。 |
| C0 的 42 记录与六契约点完整性 | 漏状态或漏点：`C0_EXACT_42_KEYS` / `C0_SIX_POINTS`。 |
| C1 与 C3 原断言 | 改构型或改命中盒/clip：`C1_CONFIGURATION` / `C3_RADIUS_ENVELOPE` 等原失败码。 |
| `C4_FULL_STACK_INVARIANT` | hover 时提高 earth z：状态完整栈差分失败。 |
| `C6_STAGE4_CSS_FALLBACK_IS_24PX` | CSS 回到 48：CSS 回退断言失败。 |
| `C8_CANVAS_LOCAL_INVARIANT` / `C8_C3_DISTRIBUTION_IDENTICAL` | 错改中心写入原点：平移不变量或分布相等性失败。 |
| `assert report['assertions']['C9']['status']=='PASS', 'F09_C9_RESTORE_OR_KILL'` | 跳过关键变异或不恢复 clip：C9 非 PASS，`F09_C9_RESTORE_OR_KILL`；不能把 NOT_MEASURED 当通过。 |

实现评审还须对 F-09 提交逐字核对 `_syncHitButtons()` diff 只删除 z 那一行；新增导出以外 `SolarHitLayout.js` 原文不变。回滚按整个 F-09 原子提交回滚，恢复旧 JS/CSS/测试的配套关系；不可只回滚 class 或只恢复 inline 赋值。回滚意味着重新打开 F-09，不能把旧的双来源状态记为关闭。

## F-10：删除没有调用者的旧 DOM 入口

### 1. 现状证据与删除边界

| 位置 | 结论 |
| --- | --- |
| `src/ui/sunMoonEntry.js:1–151` | 仅有 dashboard globals 副作用 import 与两个导出（2、82 行）；当前 `src/` 中两个函数均只有定义，没有 import/调用。没有其它 API 必须保留该文件。 |
| `src/pages/overviewPage.js:83–99` | 私有 `mountDisplayPage()` 无调用、无导出；95、97 行是旧 DOM 三 ID 在 JS 模板里的唯一生产处。真正首页入口在 `serverTable.js:370–388,2792`。 |
| `src/pages/overviewPage.js:32–81,351–374` | `summarizeMoonPanel()` 仍被 `renderPublicOverviewPage()` 调用，必须保留，不因名字含 MoonPanel 删除或改名。 |
| `src/pages/overviewPage.js:405,413–419,443–473` | summary 渲染到 `overview-hero-count`、`public-overview-kpi-strip`、到期/异常列表、地区/供应商成本列表；使用 `public-overview-*` / `kpi-item`，没有 `.globe-moon-*`、`.moon-stat` 等旧类。 |
| `src/styles/globe.css:334–565` | 任务所指 moon 规则不止到 490 行：还包含 grid、columns、`.moon-stat`、900px media。 |
| `src/styles/globe.css:567–873,1093–1273,1700–1734` | 多代 moon 外观、拖拽、移动端覆盖仍在，删基础块会留下大量死规则。 |
| `src/styles/globe.css:266–332,585–649,804–837,1055–1062,1245–1261` | 旧 sun badge 同样有专属规则；`src/globe.css:155–194` 还有一份旧 sun 样式。 |
| `src/styles/starfleet-theme.css:612–642,669–696` | 旧入口既有隐藏规则又有恢复可见的后置规则，都应随入口删除。 |
| `src/styles/globe.css:1467–1473` | **混合选择器**同时包含旧入口、仍存续的 `.globe-hint` / `.globe-focus-badge`；不能整块删除。 |
| `scripts/verify-solar-system-home.mjs:6,141` | 确实先读旧文件，再要求两个导出存在；删除文件必须同步移除读取与正向存在断言。 |
| `test/unit/dashboardMoonPanel.test.js:61–64` | **纠正任务描述**：这两条是 `expect(table).not.toMatch(...)`，禁止 serverTable 引用旧入口；没有要求导出存在。F-10 不应删除它们。 |

**选择删除，不加 `@deprecated`。** 旧模块已不可达，保留标注无法恢复任何当前功能，还增加作用域例外与误接入口的可能。删除范围是“无生产者的旧 sun/moon DOM 链”，不是删除 overview 业务，也不是清理所有带 moon 的代码。

CSS 删除集合精确定义为以下 **class/id token**，不能用 `/moon/` 或行号大段截断：

```text
ID：globeSunMount, globeSunBadge, globeMoonRoot, globeMoonPanel, globeMoonToggle
class 前缀：globe-moon-, three-globe-sun-, moon-solar-
class 精确项：moon-drag-only, moon-solar, three-globe-sun, three-globe-moon,
             vintage-moon-toggle, vintage-moon-sky, vintage-crescent,
             vintage-crater, vintage-star,
             moon-core, moon-copy, moon-stat, moon-section-title
```

已在 `src/**/*.{js,jsx,html}` 核对：除将删除的模块/模板外，没有这些 token 的生产者。对于以上 token 参与的每个逗号分隔 selector 分支，删掉该分支；剩余分支保留原声明及顺序，全部为空才删规则，并清除因此变空的 media 容器。当前 PostCSS 只读盘点为：`styles/globe.css` 166 个完全专属规则可删、1 个混合规则裁剪；`src/globe.css` 5 个；`starfleet-theme.css` 5 个。数量是定位校验，不是未来永久断言。

明确保留 `styles/globe.css:1467–1473` 中 `.globe-hint, .globe-focus-badge { z-index:40 !important }` 两个分支；保留 `.three-globe-host`、Cesium、所有 `public-overview-*`、`overview-*`、现役 solar 类及原有动画。`src/globe.css` 虽未在当前首页图中引用，也只删上述五个规则，不删除整个文件。

### 2. 拖拽 / 焦点守卫的真实历史

Git 可核实的提交链：

- `git log -- frontend-vite/src/ui/sunMoonEntry.js` 显示当前文件历史早于太阳系迁移；可读取的 `fabd9de:frontend-vite/src/ui/sunMoonEntry.js:82–95` 与当前一样，直接重写 `panel.innerHTML`，没有焦点守卫。
- `fa3958cb7060d8f9594f9fa6c286851d4be98a3c`（2026-09-03，#237）的提交正文明确：“The in-scene Sun and Moon take over the two draggable badges”。这是删除旧入口的产品意图依据。
- `26c32bee171cdf347ff233ec4e507f712f4a3dac`（2026-10-05）的实际 diff 删除 dashboard 的 `renderMoonPanel` 参数和调用，正文说明“补传”方案违反首页不变量；没有添加拖拽/焦点守卫。不要把“baseline ad12094 中存在”改写成“ad12094 引入”。

**“当年为何需要守卫”应准确记录为一次被否决的工作树方案，而非曾正式上线的保护。** 证据原件在 `E/hermes-acceptance-round12-20261005/codex-a-route-backup/sunMoonEntry.js:85–90`，`revert.patch:29–31` 保存了被回退的新增行：

```js
const currentToggle = panel.querySelector('#globeMoonToggle');
// A soft refresh must preserve the node that owns a drag or keyboard focus.
if (currentToggle && (currentToggle.classList.contains('is-dragging') ||
    document.activeElement === currentToggle)) return;
```

`E/hit-solver-codex-20260925/brief-v18-remove-moonpanel-residue.md:15–18,25–36,131–148` 说明其未提交改动已回退及裁定理由；`W/evidence/dashboard-moon-panel-20261005/route-b/report.md:46–48` 记录最终不恢复守卫。

机制：若每十秒调用渲染器，`panel.innerHTML` 会替换当前 toggle，打断该节点持有的 pointer capture / 拖拽状态及原生键盘焦点。原模块的 pointerdown、document 级 move/up/cancel 监听分别见 `sunMoonEntry.js:54–65,132–143`；键盘入口见 71–76、145–149 行。守卫针对的是“刷新期间替换交互节点”。移除最后调用后已经没有这条触发路径，给死模块恢复守卫没有运行价值。将来若有新组件需要软刷新，应让交互节点保持身份、正确清理 capture/监听并测试焦点保持，不能直接复活这套函数。

这是删除说明，应以**本文本节为长期记录，F-10 实现提交正文写简短原因并引用本节**。不在现役 SolarSystem 或 overview 代码里留下大段不存在 API 的墓碑注释。建议提交正文：

```text
Remove the unused sun/moon DOM renderers, their uncalled overview mount,
and styles owned only by those nodes. Keep the live overview summaries.

The rejected October 5 renderer-injection attempt guarded active drag and
keyboard focus because innerHTML refresh replaced the interaction node.
That attempt was reverted; 26c32be removed the last dashboard caller.
See docs/solar-hit-gap-closure-f09-f10-f03.md, F-10 history and scope.
```

仓库是 partial clone，部分更早 tree/blob 不在本地，禁用 lazy fetch 后 `git show` 报缺对象；网络也不可用。以上明确区分了实际读到的提交正文/diff、已读历史文件和回退备份；不虚构一个“最早加入守卫”的提交号。

### 3. 改动清单（未来实现）

| 操作 | 文件与函数/规则块 |
| --- | --- |
| 删除文件 | `src/ui/sunMoonEntry.js` 全文件。dashboard globals 已由 `serverTable.js:1` 导入，不需要另补副作用 import。 |
| 删除函数 | `src/pages/overviewPage.js` 仅私有 `mountDisplayPage()`（当前 83–99 行）；`summarizeMoonPanel()`、`renderPublicOverviewPage()` 及其 helpers 不变。 |
| 删除/裁剪规则 | `src/styles/globe.css`、`src/globe.css`、`src/styles/starfleet-theme.css` 按上述 token 集合逐 selector 分支操作；不动混合规则的活分支。 |
| 新增 | `scripts/lib/legacySolarDom.mjs`：旧 API/ID/selector 集合、JS/JSX AST 扫描和 `assertLegacySunMoonRemoval()`；仅开发门禁导入。 |
| 修改 | `scripts/verify-solar-system-home.mjs` 删除 `entry` 文件读取、141 行两个存在断言，改为调用 removal 检查；9–10 行旧负向断言在这一提交仍保留。 |
| 新增 | `test/unit/legacySunMoonRemoval.test.js`：删除与防恢复、混合 CSS 活分支、真实 overview 输出的有限回归检查。 |
| 保留 | `test/unit/dashboardMoonPanel.test.js` 当前全部行为测试和两条负向断言；后者在 F-03 提交才换成更广的检查。 |

### 4. 验收断言及其变异

`assertLegacySunMoonRemoval({ files })` 接受以仓库相对路径为键的只读源码集合；真实门禁从磁盘枚举，单测可传 Map 副本。范围是 `src/**/*.{js,jsx,mjs}` 中的声明、overview 私有旧模板，以及 `src/**/*.css` 中上述 selector token。既不读 docs/evidence，也不执行产品模块。定义扫描包含函数声明、命名函数表达式、变量绑定、导出别名；避免把换文件的同名定义漏掉。F-03 再负责首页图中的所有引用。

| 直接断言 / 落点 | 必杀变异与失败信息 |
| --- | --- |
| `assert.equal(files.has('src/ui/sunMoonEntry.js'), false, 'F10_LEGACY_FILE_EXISTS')` | 即使只恢复一个空旧文件，也失败；不能仅靠“目前无调用”放过存在。 |
| `assert.deepEqual(findLegacyDefinitions(allSourceAsts), [], 'F10_LEGACY_DEFINITION')` | 把 `renderMoonPanel` 搬到新文件、写成 const 函数或导出别名：具体 file:line 伴随 `F10_LEGACY_DEFINITION`。正常 `summarizeMoonPanel` 不匹配。 |
| `assert.equal(hasLocalFunction(overviewAst,'mountDisplayPage'), false, 'F10_DEAD_MOUNT_EXISTS')` | 只恢复 overview 的死函数，即使还没接调用：失败。限定 overview 文件，不能禁掉 serverTable 的活同名函数。 |
| `assert.deepEqual(findLegacyDomIds(overviewAst), [], 'F10_OLD_OVERVIEW_TEMPLATE')` | 把旧三 ID 模板塞进一个改名函数：失败。注释不算模板，模板字符串和普通字符串均检查。 |
| `assert.deepEqual(findLegacySelectors(allCssAsts), [], 'F10_LEGACY_SELECTOR')` | 只恢复 `.globe-moon-drawer` 基规则、后置 `.moon-solar-core` 或另一个 CSS 文件中的旧 ID 规则：给出文件/selector 的 `F10_LEGACY_SELECTOR`。基础块删了但移动覆盖留下也必须失败。 |
| 对 `.globe-hint` / `.globe-focus-badge` 的保留分支，`assert.deepEqual(declarations, [{prop:'z-index',value:'40',important:true}], 'F10_SHARED_LAYER_LOST')` | 误删整个 1467–1473 混合规则，或漏保留其中一个活分支：`F10_SHARED_LAYER_LOST`。应按 selector token 查分支，不要求某种逗号排版。 |
| `assert.match(html, /<span>totalNodes<\/span><strong>3<\/strong>/, 'F10_OVERVIEW_STATS')` | fixture 固定三个价格 10/20/30、在线/告警/离线各一的节点，t mock 返回 key，货币转换固定。误删 summary 调用或改成空列表：`F10_OVERVIEW_STATS`（若 renderer 直接抛错，测试须把渲染失败包装为该错误前缀）。 |
| `assert.equal(monthlyKpi(html), '¥60', 'F10_OVERVIEW_COST:total')`；`assert.match(panelByTitle(html,'monthlyByRegion'), /<b>region-A<\/b><span>¥60<\/span>/, 'F10_OVERVIEW_COST:region')`；`assert.match(panelByTitle(html,'monthlyByProvider'), /<b>provider-A<\/b><span>¥60<\/span>/, 'F10_OVERVIEW_COST:provider')` | 三节点设同一 region/provider；删除总成本、地区列表或供应商列表分别失败。检查限定相应 KPI/摘要 section，不能让节点卡片中也有 region/provider 文字而假绿。 |
| `assert.match(panelByData(html,'expiry'), /node-expiring/, 'F10_OVERVIEW_ALERTS:expiry')`；`assert.match(panelByData(html,'abnormal'), /node-offline/, 'F10_OVERVIEW_ALERTS:abnormal')` | 在线节点 node-expiring 固定两天后到期，离线节点 node-offline 无到期日。保留总数却误删到期/异常渲染：对应前缀失败。固定时钟，避免日期变化导致假失败。 |
| `assert.equal(legacyTokensInRenderedHtml(html).length, 0, 'F10_RENDERED_LEGACY_DOM')` | 误把死模板内容合进活 renderer：`F10_RENDERED_LEGACY_DOM`。正向 summary 断言同时阻止拿空 HTML 通过。 |

overview 测试必须执行真正的 `renderPublicOverviewPage()`：可以 mock 翻译、货币转换、服务器归一化及浏览器外壳，但不得 mock summary 或 renderer。最小 DOM 外壳提供 `pageRoot.innerHTML`、`querySelectorAll()=>[]`、`querySelector()=>null` 和 `documentElement.getAttribute`；存储和时间固定。测试捕获真实 HTML；`monthlyKpi` 按翻译 key 对应的 KPI 提取 strong 文本，`panelByTitle` / `panelByData` 按该标题或 data-panel 提取所在 section（缺失返回空串）。它们只定位实际输出，不重算业务数据。已有 dashboard 测试的 `renderOverview` 是 mock，不能拿它替代此处验证。

另保留 `dashboardMoonPanel.test.js:81–128` 的当前行为契约：用 serverTable 实际六项参数构造 tab，refresh 后 loadServers / setServers / 条件 overview 更新成立，10 秒一次且 stop 后停止，detail 分支不启动 timer。恢复已删除的参数与调用会再次出现 `TypeError: renderMoonPanel is not a function`，使现有 resolves 断言失败；遗漏 setServers、overview 更新或 timer 清理分别使现有调用次数/定时器断言失败。这些测试不要求 F-04 的拒绝处理保持原样。

### 5. 风险与回滚

删除 JS 死链不改变首页 hit 几何。实际风险是 CSS 的混合选择器及 overview 的存续业务；以 selector 分支操作、共享层级断言和真实 overview 输出验证约束。需跑 overview 页面（含非首页直达）以及 Earth→Esc 一次，覆盖 globe.css 懒加载后的活样式；F-09 的 modifier 尚未实施时，太阳系仍按原来的 z 写入运行。

四个原有门禁的其它正则锚点都不改：尤其保留 serverTable 的 `mountDisplayPage()` 与紧邻的 `renderPublicOverviewPage()` 定义（`verify-single-renderer-home.mjs:10–14`），以及 detail boot 分支（`verify-detail-page-regressions.mjs:13,38–43`）。误删活同名函数会触发 `mountDisplayPage must exist`，误改 detail 分支会触发原有 detail 断言。

回滚必须恢复整个 F-10 提交（包括旧文件读取/存在检查的配套），不能只恢复一个旧 renderer 再尝试接入。若 F-03 已采用“删除完成、零例外”策略，先回滚/调整 F-03，再回滚 F-10；恢复旧链即重新打开 F-10，不能用加白名单冒充关闭。

## F-03：按真实首页入口覆盖旧入口引用

### 1. 现状证据与可枚举边界

`scripts/verify-solar-system-home.mjs:4,9–10` 只读取/扫描 `serverTable.js`。真正曾抛错的 `dashboardTab.js` 没有被这两条包含；当前 `dashboardTab.js:11–23,25–30` 已移除旧调用，但 async `refresh()` 和 `setInterval(refresh,10000)` 仍在。

首页路径不能按“名字里有 home”或执行过哪些函数判断，而采用**入口的本地模块可达闭包**：

```text
index.html:49 → /src/main.js
src/main.js:1–5 → serverForm, groupForm, globeInit, settingsPanel, serverTable
src/main.js:11 → mountServerTableApp()
src/modules/serverTable.js:8,14,27–31
    → SolarSystem.js, overviewPage.js, dashboardTab.js,
      detailTab.js, assetManager.js, chartInit.js, eventHandlers.js
src/modules/serverTable.js:2749–2757 → createDashboardTab(实际六参)
src/modules/serverTable.js:2788–2794 → overview/home 分支 → startSoftRefresh()
src/modules/dashboardTab.js:28 → 每 10000ms 调用 refresh()
```

本次用当前 Acorn + acorn-jsx 在内存中遍历，纯静态 ESM 闭包 **H₀=55 个本地 JS/JSX 模块**；加上可静态解析的本地 `import('…')` 后 **H=71 个**，解析/解析路径错误为零。用户列出的十个 modules 文件**全部属于 H₀**，没有“其余四个 factory 是首页不用所以可豁免”的依据：main 已静态 import 它们。

```text
src/modules/{assetManager,chartInit,dashboardTab,detailTab,eventHandlers,
             globeInit,groupForm,serverForm,serverTable,settingsPanel}.js
```

`overviewPage.js` 属于 H₀；`sunMoonEntry.js` 当前不属于 H。图中 JSX 入口为 `serverTable.js:9 → GlobeStarmapMount.jsx:3 → GlobeStarmap.jsx`。本地懒加载边包括 `globeInit.js:2 → CesiumGlobe.js`，`serverTable.js:47–48 → TrafficChart.js/detailCharts.js`，466 行到 CesiumGlobe，500/553 行到 StarshipShowcase。第三方包的 import 为终点，不遍历 node_modules。55/71 是本次盘点结果，未来不能把恰好这个数量固化成阻止合理模块增减的断言。

H 是保守的首页模块边界，不是函数调用覆盖率：同一模块内的所有函数体都检查，包括未执行分支和未来 F-04 的 catch 块。首页同时承载 overview/detail 路由，因此闭包包含它们是有意的，不通过字符串切片剔除路由分支。

### 2. 选择：图遍历 + 精确 AST 禁用节点

实现 `scripts/lib/homeImportGraph.mjs`，复用 F-10 的旧标识符定义；`assertHomeLegacyContract({ indexSource, root, readFile, exists })` 返回排序后的 `reachable` 与 `edges`，遇到错误抛带 file:line 和入口路径链的 Error。只分析源文本，不 import/执行产品模块。

规则如下：

1. 验证 `index.html` 当前模块入口唯一且为 `/src/main.js`；入口增加/换名时明确失败 `F03_HOME_ENTRY`，要求同步维护边界，不可悄悄仍只扫旧入口。普通非 module 的 preboot 内联脚本不作为 ESM 根；若新增 inline module，当前检查失败而非忽略。同时检查入口 HTML 的 id 属性不含旧三 ID（剔除 HTML 注释后读取标签属性），避免把旧挂载点移到根 HTML 绕开模块扫描。
2. Acorn `Parser.extend(jsx())`，`sourceType:'module', ecmaVersion:'latest', locations:true`。递归访问 AST 的所有子节点。跟随 `ImportDeclaration`、带 source 的 `ExportNamedDeclaration` / `ExportAllDeclaration`、以及字符串字面量或无插值模板字符串的 `ImportExpression`。
3. 解析相对路径、`/src/…` 及当前 Vite `@/…`（`vite.config.js:118–120` 映射到 src）。只读解析 Vite 配置的 alias AST，当前接受 `resolve(__dirname,'src')` 这种静态形式；验证 `@` 仍映射 src 后再使用该映射，未知计算形式失败，不能另藏一份未经核对的映射。规范化路径并确保落在仓库 src 内；当前文件用显式扩展名，可支持唯一命中的 `.js/.jsx/.mjs` 和 `index` 形式，歧义时报错。用 visited 集合处理环。任何失败都不得 catch 后 continue。
4. CSS、图片、字体、JSON 等非执行资源作为有记录的终点；JS 模块不能按“非 .js 就跳过”过滤。第三方 bare specifier 须对应 package.json 中实际包名；先识别 `@/`，不能将它误当 npm scope。与 `@` 映射不符或新 alias 无法解析时抛 `F03_UNSUPPORTED_IMPORT`。
5. 非常量 `import(expr)`、尚未支持的 `import.meta.glob` / 本地执行资源加载形式均抛 `F03_UNRESOLVED_GRAPH`，不得生成一个不完整但 PASS 的图。当前 H 中没有这种非常量动态 import，不需要为既有代码加例外。图检查不是任意 eval/运行时拼接代码的安全证明。
6. 每个源模块在解析完、跟随依赖前检查旧引用。命中旧模块路径时先报 `F03_LEGACY_IMPORT`，即使 F-10 已把目标文件删掉，也不能仅用 ENOENT / import error 当有效变异失败。
7. 引用匹配按精确 AST 节点：`renderSunBadge` / `renderMoonPanel` 的 Identifier（含 import 名、参数绑定、对象成员/键、声明）、计算成员的同名字面量，以及含旧三个 DOM ID token 的 Literal / TemplateElement。覆盖别名导入、namespace 成员和 `window['renderMoonPanel']()`；跳过注释，允许 `summarizeMoonPanel`，不做笼统 `/MoonPanel/` 搜索。模板插值中的表达式继续递归检查。
8. 报错包含标识符、文件、行号和可达链，例如 `F03_LEGACY_REFERENCE:renderMoonPanel at src/modules/dashboardTab.js:24 via src/main.js -> src/modules/serverTable.js -> src/modules/dashboardTab.js`。诊断链只是定位信息，不能作为被允许/被禁止的依据。

不选只扫十个 `src/modules/*.js`：会漏 pages、ui、新子目录及 JSX。不选只沿静态 ImportDeclaration：会把未来搬进懒加载模块的同一缺陷漏掉。不选全仓文本正则：会扫描测试、文档、历史证据，也无法在保留定义方案下表达精确例外。删除后递归扫 `src/**/*.{js,jsx,mjs}` 是合法的更保守备选，但本设计选 H，使“首页路径”与诊断可达链一致；F-10 的全 src 定义/selector 禁止存在检查另行保留。

### 3. F-10 两种结果对应的作用域策略

| 前提 | F-03 规则 | 例外如何避免变成盲区 |
| --- | --- | --- |
| **选定方案：F-10 全部删除完成** | H 中所有模块统一零旧引用；旧模块路径、两个 API、三个 DOM ID 都无例外。F-10 额外保证旧定义、旧文件、旧 selector 不存在。 | 无定义处误报问题，不提供可随手添加的路径白名单。 |
| **替代方案：暂时保留旧定义和 overview 死模板** | 旧 `sunMoonEntry.js` 仍可物理存在，但它不可从首页根到达；所有指向它的 import/re-export/动态 import 都失败。仅允许定义文件内既有两个导出本身；在其它 src 中禁止新增这些 API 的引用。overview 仍在 H，不能整文件豁免。 | 对 overview 的唯一例外限于那个本地 `mountDisplayPage` 中含三个旧 ID 的模板节点；要求该函数未 export、除声明名外无绑定引用，且无调用/取别名/导出。增加 `const f=mountDisplayPage` 也使 `F03_RETAINED_MOUNT_REACHABLE` 失败。函数内其它引用（尤其旧 renderer）不在例外内。 |

替代方案的节点级允许集合应显式列出 `(file, localSymbol, nodeKind, legacyId)`，并验证数目/内容与既有模板一致；不允许忽略整个文件、函数体或任意 `src/ui/**`。定义文件也须锁住“仅这两个既有定义、零外部引用”的事实，不能通过改名别名导出获得豁免。该方案只为用户要求的“未删除时怎样扫描”给出可实施说明，**选定实现不携带开关或长期 allowlist**。

所以用户的依赖推测成立，但需细化：F-10 **JS 模块/模板是否删除**决定 F-03 是否需要 AST 例外；CSS 删除并非 import 图的前置条件。保留模式也能先实现 F-03，只是成本更高。本设计通过先删 JS 死链消除这些例外。

### 4. 改动清单（未来实现）

| 操作 | 文件与范围 |
| --- | --- |
| 新增 | `scripts/lib/homeImportGraph.mjs`：入口验证、解析/遍历、路径解析、旧引用检查和诊断；复用 `legacySolarDom.mjs` 的名字集合。 |
| 修改 | `scripts/verify-solar-system-home.mjs`：以真实 H 检查替换原 9–10 行两条仅 table 的 doesNotMatch。`table` 仍供该脚本其它既有断言使用，不移除。 |
| 修改 | `test/unit/dashboardMoonPanel.test.js:61–64`：原 table 文本测试改为调用同一个真实文件图检查器；81–128 行 refresh/timer 行为测试保留。 |
| 新增 | `test/unit/solarHomeImportScope.test.js`：图作用域、JSX、别名/re-export/懒加载、反例及 F-04 兼容性测试。 |
| 不需要产品改动 | `dashboardTab.js`、`serverTable.js`、`main.js` 都不因 F-03 修改。package.json/lockfile 不增加依赖。 |

### 5. 验收断言及其变异

测试夹具是源文本 Map：`readFile(path)` 返回 Map 内容；不存在则由检查器抛路径错误。`run(files)` 调用真实 `assertHomeLegacyContract()`；`withSource(files,path,text)` 返回只替换/新增一个文件的 Map 副本。每个 fixture 都是有效 JS/JSX，先验证干净版本能通过，再注入；不会执行其中的 timer、网络或业务函数。

| 可直接落到测试文件的断言 | 必杀变异与失败信息 |
| --- | --- |
| `assert.deepEqual(moduleEntries(indexSource), ['/src/main.js'], 'F03_HOME_ENTRY')` | 入口换成另一个模块、删入口或增加第二个未纳入根的 module 脚本：`F03_HOME_ENTRY`，不能空集 PASS。 |
| `assert.deepEqual(legacyHtmlIds(indexSource), [], 'F03_HOME_MARKUP')` | 只在 index.html 加 `<div id="globeMoonPanel"></div>`，import 图不变也必须报 `F03_HOME_MARKUP`。 |
| 对实际图，逐个 `assert.ok(reachable.has(path), 'F03_REQUIRED_PATH:'+path)`；path 包括 main、serverTable、dashboardTab、overviewPage、SolarSystem 及十个 modules | 把遍历退回 table 单文件、漏主入口的一条 factory 边：`F03_REQUIRED_PATH:<path>`。这是当前关键路径断言，不固定整个图数量。 |
| `assert.throws(() => run(withSource(base,'src/modules/dashboardTab.js', badDashboard)), /F03_LEGACY_REFERENCE:renderMoonPanel/)` | 在 dashboard 的任意函数或 try/catch 中恢复 `renderMoonPanel()` / 解构参数。若检查器退回只扫 table，单测自身报 `Missing expected exception`，实现提交不得通过。 |
| 对只恢复旧参数读取、`window['renderMoonPanel']()`、`ns.renderSunBadge()` 三种有效代码逐个要求 `F03_LEGACY_REFERENCE` | 将规则错误实现成只匹配 `renderMoonPanel();` 这一调用文本：有一种变异存活，对应 `assert.throws` 失败。 |
| `assert.throws(() => run(aliasImport), /F03_LEGACY_IMPORT/)`，aliasImport 使用 `import {renderMoonPanel as repaint} from '../ui/sunMoonEntry.js'` | 旧文件已删也必须是 `F03_LEGACY_IMPORT`，不能仅以加载错误作 RED。namespace / side-effect import 同样检查路径。 |
| 对 `entry → newFeature.js → nested/adapter.js`，只在 adapter 加旧 ID/调用，要求带 adapter 路径的 `F03_LEGACY_REFERENCE` | 将 scope 写死成十文件名单或只递归一层：变异不抛预期错误，测试失败。 |
| 对 `export {x} from`、`export * from`、`import('./lazy.js')` 三种边分别放入含旧引用的模块，要求 `F03_LEGACY_REFERENCE` | 遍历器遗漏任一种边：该项 `assert.throws` 失败。这些 fixture 的目标文件都存在且可解析，排除 ENOENT 假 RED。 |
| `assert.throws(() => run(jsxFixture), /F03_LEGACY_REFERENCE:globeMoonRoot/)`，JSX 为 `<div id="globeMoonRoot"/>` | 错误跳过 `.jsx`：没有期望错误；用裸 Acorn 不能解析 JSX：得到解析错误而非此专属错误，也判测试失败。另保留干净 JSX PASS 对照。 |
| 对 `@/pages/extra.jsx` 和 `/src/pages/extra.jsx` 两种边要求能到达目标，注入旧引用后要求 `F03_LEGACY_REFERENCE` | 把 `@/` 当第三方包或错误解析根路径：reachability / 专属异常断言失败。 |
| `assert.equal(readViteAlias(viteAst,'@'), 'src', 'F03_ALIAS_BINDING')` | 只把 Vite 的 `@` 改指其它目录、扫描器仍解析到 src：`F03_ALIAS_BINDING`；不可静态求值时抛 `F03_UNSUPPORTED_IMPORT`，也有对应异常断言。fixture Map 必须提供合法的最小 Vite alias 配置。 |
| `assert.throws(() => run(missingLocal), /F03_IMPORT_UNRESOLVED/)`；`assert.throws(() => run(dynamicExpression), /F03_UNRESOLVED_GRAPH/)` | 路径缺失或 `import(variable)` 时 catch 后 continue：没有预期失败。不能把“不知道扫描到哪里”当全部干净。 |
| 在 `a→b→a` 的环中 b 含旧调用，仍要求 `F03_LEGACY_REFERENCE`；无旧调用的同一环 `assert.doesNotThrow(...)` | 用错误 visited 时机跳过 b 会漏报；不用 visited 会超时/递归溢出，均不满足断言。 |
| `assert.doesNotThrow(() => run(cleanWithCommentsAndSummary), 'F03_FALSE_POSITIVE')` | 干净代码包含注释 `renderMoonPanel` 及真实 `summarizeMoonPanel()`。错误扫描注释或用 `/MoonPanel/`：意外抛错，失败为 `F03_FALSE_POSITIVE`。 |
| `assert.doesNotThrow(() => run(cleanRefreshWithTryCatch), 'F03_F04_COMPAT')`；同一 catch 内插入旧调用则要求 `F03_LEGACY_REFERENCE` | 把 refresh 的完整源码/函数末句钉死，或检查器只看 try 不看 catch：前者误拒绝干净 F-04 修复，后者漏旧调用，分别失败。 |
| 仅在选择保留模式时：`assert.throws(() => run(takeLegacyMountAlias), /F03_RETAINED_MOUNT_REACHABLE/)` | 在 overview 新增 `const oldMount=mountDisplayPage` 或导出该函数：例外前提破坏；整文件忽略会使测试报缺少预期异常。选定删除模式不实现此开关。 |

同时在 `dashboardMoonPanel.test.js` 中对当前磁盘文件图直接调用检查器，保证 `npm run test:unit` / quality 和 `test:solar-system-home` 都执行同一政策。fixture 测试不可替代真实源码调用。将真实检查改成常量空 Map 或禁用扫描时，“关键路径”断言和 dashboard 源码变异必须至少各失败一次。

### 6. F-04 兼容、风险与回滚

F-03 只判断旧入口引用和图完整性，不判断 `refresh()` 是否有 try/catch，不断言它的最后一条语句，也不匹配 `setInterval` 的源码写法。未来可以在 refresh 内捕获、在 timer 回调 `.catch()`、增加错误报告依赖；新增本地模块会自然进入 H。干净错误处理通过、catch 中旧引用失败，已在上表设计配对断言，尚未实施。若 F-04 合理增加第七项工厂依赖，应由 F-04 一并更新实际调用者和现有六参 harness；这不是 F-03 新增的限制。

当前网络失败的未捕获 rejection 风险依旧存在（`dashboardTab.js:13,28`）。F-03 通过仅表示旧 DOM API 不会沿这条源码图重新接回，**不表示所有 async rejection 已消失**。不在本项里修 F-04 或新增 rejection 的产品语义约束。

本项没有产品运行时改动，不影响 C0–C4 / C6–C9。主要风险是图检查假阴性（漏边、静默跳过、JSX）和假阳性（定义/注释/合法 summary）；上表的双向对照针对这些风险。保留原 `verify-single-renderer-home`、`verify-detail-page-regressions`、`verify-sw-precache-solar` 内容不变，并运行它们。

F-03 可单独回滚，F-10 删除仍可保留；回滚重新打开“只扫 table”的盲区。如果需要恢复 F-10 死链，先处理 F-03 的零例外前提，不能随意加目录白名单。不得以吞掉 parser/resolver 错误作为回滚手段。

## 实现顺序、依赖与完成标准

| 顺序 | 独立提交建议 | 前置条件与完成标准 |
| --- | --- | --- |
| 1 | `refactor(solar): remove unused sun and moon DOM entries`（F-10） | 删除链及“必须存在”门禁一起提交；现役 overview/共享 CSS 验证通过。保留 table 原负向断言，使这一提交单独可验收。 |
| 2 | `test(solar): guard legacy entries across the home import graph`（F-03） | 采用 F-10 已删除结果，零定义/模板例外；真实图与所有专属作用域变异通过。 |
| 3 | `fix(solar): make body classes own hit target stacking`（F-09） | 和 F-10/F-03 逻辑独立；原子包含 CSS 类、创建绑定、删除内联一行、新导出、交叉检查与更新后的层级验收。 |

F-10 与 F-09 都编辑 `starfleet-theme.css`，这是文件合并顺序关系，不是几何或运行时依赖：F-10 只删旧入口选择器，F-09 只改 412 行附近的现役 hit 规则。按此顺序实现时，重新定位规则，不套旧行号盲贴补丁。

每个实现提交均须独立通过适用的 unit、quality、solar-system-home、single-renderer-home、detail-page-regressions，以及新 build 后的 sw-precache-solar。已有门禁不能只“看源码应当通过”。F-09 另跑新增 stacking 脚本，并用原有验收驱动在新构建复验 C0–C4 / C6–C9；保留 C5/C10 的未关闭状态。F-10/F-03 的源码/图变异在内存完成，F-09 浏览器变异恢复后重复基线，任何缺样本、加载错误、NOT_MEASURED 不算 PASS。

三项都不允许顺手修改冻结几何或解决 F-02/F-04。实现时先记录当时工作树已有改动，仅暂存本项文件的本项差异；完整跑通对应变异后再记录关闭。本次文档提交只提交 `docs/solar-hit-gap-closure-f09-f10-f03.md`，不把设计断言的示例误认为已经落地的测试。
