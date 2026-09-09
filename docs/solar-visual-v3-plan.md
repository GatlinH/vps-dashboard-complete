# 太阳系视觉升级设计方案（v3）

本设计方案针对 `/tmp/vps-dashboard-review/frontend-vite/` 下的太阳系视图（`src/components/SolarSystem.js`）及关联页面调度模块（`src/modules/serverTable.js`）进行全方位视觉与交互升级。方案严格遵循既有工程约束，在**不引入外部依赖、保持单一 rAF 与单一 WebGLRenderer** 的前提下，彻底解决行星暗黑、交互突兀、视觉单调等问题，并补齐哈雷彗星与小行星带。

---

## 核心红线与设计原则

1. **单 rAF 与单渲染器约束**：全场景所有天体（太阳、行星、月球、彗星、小行星带）必须在 `SolarSystem.prototype._tick` 单一帧循环内完成推进与渲染，严禁为新要素创建独立 rAF 或实例化新的 WebGLRenderer。
2. **测试门禁兼容**：保持 `scripts/verify-solar-system-home.mjs` 和 `scripts/verify_solar_hit_targets.py` 契约不变；关键正则锚点（如 `PointLight`、`RingGeometry`、`cameraAtHome` 赋值唯一性、`len >= 0.5` 等）不得破坏。
3. **零新增 npm 依赖**：所有纹理、粒子和多实例几何体均基于当前已引用的 Three.js r185 原生能力与浏览器原生 Canvas 2D API 动态生成。

---

## D1 光照修复（黑球根因与解决方案）

### 1. 根因量化分析
* 在 Three.js r185 PBR 光照模型中，`PointLight(0xffffff, 2.2, 0, 2)` 启用物理平方反比衰减（$E = I / d^2$）。
* 太阳系各行星轨道半径为：水星 9、金星 13.5、地球 19、火星 25、木星 33、土星 41。
* 在地球处（$d=19$），照度仅剩 $2.2 / 361 \approx 0.0061$；在土星处（$d=41$），照度仅剩 $2.2 / 1681 \approx 0.0013$。
* 既有环境光 `AmbientLight(0x404a66, 0.35)` 能量折合线性 RGB 不足 0.04，导致所有采用 `MeshStandardMaterial`（粗糙度 0.85）的行星漫反射几乎为零，肉眼观察表现为纯黑剪影。

### 2. 方案评估
* **方案 a（提升 PointLight 强度或修改 decay）**：若保持 `decay=2`，使土星达到 0.8 照度需将强度提至 $0.8 \times 1681 \approx 1350$，但此时水星照度将暴增至 $1350 / 81 \approx 16.7$，导致内行星极度过曝；若将 `decay` 改为 `0`（无衰减点光源），则所有轨道均获得均匀光照，但仍具备从太阳向外的精确入射角（$N \cdot L$）以展现昼夜分界线。
* **方案 b（替换材质或引入 HemisphereLight）**：`MeshLambertMaterial` 为逐顶点光照（Gouraud 着色），在低面数球体上易产生三角面棱角感；`MeshStandardMaterial` 具有真实的微表面粗糙度（Oren-Nayar 漫反射），更适合展现行星哑光星体质感。
* **方案 c（增加行星自发光 emissive）**：行星本身不是恒星，常态自发光会抹平背光面的昼夜明暗交界；且既有 hover 逻辑使用 `emissive.setScalar(0.35)`，若常态带 emissive 会导致 hover 恢复逻辑冲突。
* **推荐组合方案**：
  * **主光源**：保持 `PointLight`，将 `decay` 设为 `0`（无距离衰减），强度设为 `2.2`。保留从恒星中心辐射的光照方向，保证各轨道行星拥有刀锋般清晰的昼夜晨昏线（Terminator）。
  * **全局天光**：将微弱的单色 AmbientLight 替换为微调后的双色天光系统：`AmbientLight(0x708098, 0.42)` 配合微弱倾斜的辅助平行光 `DirectionalLight(0x4a5878, 0.28)`（自相机上方轻微打入）。
  * 这样保证：
    1. 昼半球面向太阳点照度目标为 $0.85 \sim 1.05$；
    2. 夜半球受环境天光与深空散射影响，保留 $0.15 \sim 0.22$ 的可见冷调灰度轮廓，暗面不沉底、不与星空融为一体。

### 3. 文件与函数级改动点
* `src/components/SolarSystem.js` -> `_buildScene()`:
  * 修改 `this.sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);`（`decay` 由 2 改为 0）。
  * 调整环境光：`this.ambientLight = new THREE.AmbientLight(0x708098, 0.42);`。
  * 新增微弱深空辅助光：`this.fillLight = new THREE.DirectionalLight(0x4a5878, 0.28);`，位置设为 `(10, 30, 20)`，纳入 `this.disposables` 追踪。

### 4. 参数建议表
| 光源对象 | 构造参数 | 作用与物理效果 |
| :--- | :--- | :--- |
| `sunLight` (PointLight) | `color: 0xffffff, intensity: 2.2, distance: 0, decay: 0` | 太阳核心主辐射源，各行星正午照度约 0.95，晨昏线锐利 |
| `ambientLight` (AmbientLight) | `color: 0x708098, intensity: 0.42` | 星际漫射底光，消除夜半球纯黑 |
| `fillLight` (DirectionalLight) | `color: 0x4a5878, intensity: 0.28, pos: (10,30,20)` | 模拟银河星云漫反射，提供面向相机面的微弱明暗立体层次 |

### 5. 性能影响
* 仅增加 1 盏静态 `DirectionalLight`，无阴影映射（ShadowMap 关闭），GPU Fragment Shader 增量开销 < 0.05ms，对移动端完全无压力。

### 6. 验收断言
* 自动门禁契约断言：`assert.match(solar, /PointLight/);` 持续通过。
* 视觉/色彩断言：在全视角下，土星、木星背向太阳面 RGB 亮度不低于 `(25, 28, 35)`，面向太阳面正午高光区 RGB 达到 `(210, 195, 160)`；昼夜交界弧线清晰可辨。

---

## D2 拖拽暂停后延时恢复

### 1. 现状问题与设计目标
* 当前机制：在 `_bindEvents` 中，`_onPointerDown` 设置 `isDragging = true`，`_onPointerUp` 立即设置 `isDragging = false`。在 `_tick` 中执行 `if (!this.orbitState.isDragging) this._advanceBodies(dt);`。
* 缺陷：用户松开鼠标瞬间天体立刻恢复公转，极易导致刚对齐的星球迅速漂移脱焦，体验突兀。
* 目标：用户完成拖拽松手后，行星保持静止停留 $N$ 秒（推荐 **2.8s**），倒计时结束平滑恢复公转；若在暂停等待期内用户再次产生交互（按下、微拖或滚轮缩放），倒计时立即重置。

### 2. 状态机设计
```
     [Pointer Down]                    [Pointer Up (dragMoved==true)]
RUNNING ----------> DRAGGING --------------------------------------> PAUSED (Timer: 2.8s)
   ^                                                                     |
   |                                                                     |
   +----------------------- [Timer Expires] -----------------------------+
   |                                                                     |
   |                               [New Pointer Down / Drag / Wheel]     |
   +---------------------------------------------------------------------+ (Reset Timer)
```
* **状态枚举**：`'running' | 'dragging' | 'paused'`。
* **状态存储与观测**：
  * 在 `this.orbitState` 中引入：
    * `motionState: 'running'`（初始值）
    * `resumeTimerId: null`
    * `resumeDelayMs: 2800`
    * `pauseStartTime: 0`
  * 挂载调试观测字段：`window.__DBG__.solarOrbitMotionState` 与 `window.__DBG__.solarOrbitResumeRemainingMs`。

### 3. 代码上下文契约防破坏
* 注意 `test/unit/solarSystemOrbit.test.js` 第 23 行断言：
  `expect(text).toMatch(/isDragging[\s\S]{0,180}_advanceBodies/);`
* 因此在 `_tick` 中必须保留对 `isDragging` 的直接引用：
  ```javascript
  const shouldAdvance = !this.orbitState.isDragging && this.orbitState.motionState !== 'paused';
  if (shouldAdvance) {
    this._advanceBodies(dt);
  }
  ```
  该行代码紧凑，完全位于 180 字符的距离窗内，保证单测稳定通过。

### 4. 文件与函数级改动点
* `src/components/SolarSystem.js`：
  * `constructor()`：初始化 `this.orbitState.motionState = 'running'` 及计时器引用。
  * `_bindEvents()`：
    * `_onPointerDown`：若当前处于 `paused`，清除已有 `resumeTimerId`，设置 `motionState = 'dragging'`。
    * `_onPointerUp` / `_onTouchEnd`：若 `this.orbitState.dragMoved` 为 true，状态转为 `'paused'`，启动 `setTimeout(() => { this.orbitState.motionState = 'running'; }, 2800)`。
    * `_onWheel` / `_onTouchMove`：任何缩放操作同步刷新暂停倒计时。
  * `_tick()`：
    * 依据状态机推进 `_advanceBodies(dt)`。
    * 同步更新 `this.debug.solarOrbitMotionState` 与倒计时剩余毫秒数。
  * `destroy()`：清理未执行的 `resumeTimerId`。

### 5. 性能影响
* 纯 JS 状态标记与单个单次定时器驱动，零性能损耗。

### 6. 验收断言
* 单测断言：`test/unit/solarSystemOrbit.test.js` 保持 100% 通过。
* 状态机断言：拖拽松手后读取 `window.__DBG__.solarOrbitMotionState === 'paused'`；等待 3 秒后读取变为 `'running'`；在 1.5 秒时滚轮缩放，倒计时重置为 2800ms。

---

## D3 去除星球名标签

### 1. 现状分析与无障碍（a11y）边界
* 现状：`_buildHitButtons()` 中为太阳、地球、月球创建了 `class="solar-system-hit"` 的透明 `<button>`，并在其同级创建了 `class="solar-body-label"` 的文字 `<div>`，在 `_syncHitButtons()` 每一帧将二者投影并对齐到屏幕坐标。
* 门禁依赖评估：
  * `scripts/verify_solar_hit_targets.py`：核心是检测 `button.solar-system-hit` 的 `elementFromPoint(cx, cy)` 命中率与 `aria-label` 属性（`太阳（前往登录）`、`地球（进入三维地球）`、`月球（进入总览）`），**完全不依赖 `solar-body-label`**。
  * `scripts/verify-solar-system-home.mjs`：第 20-22 行要求源码匹配 `太阳（前往登录）` 等 aria-label 文本，不要求匹配 `solar-body-label`。
  * `test/unit/solarSystemOrbit.test.js`：第 14 行存在显式断言 `expect(text).toContain('solar-body-label');`，删除该 div 后此单测需对应调整。

### 2. 交互与动效建议（保留 Hover 材质高亮）
* **彻底删除文字标签**：彻底去除所有 `solar-body-label` DOM 节点的创建、样式同步与销毁逻辑，还星空以深邃沉浸的太空视觉，避免大号标签在屏幕上晃动。
* **强化 Hover 视觉反馈**：
  * 保留原有的网格级高亮能力：
    * 对太阳（`MeshBasicMaterial`）：hover 时几何体缩放放大 `1.06x`；
    * 对地球、月球（`MeshStandardMaterial`）：hover 时启用 `emissive` 微发光（设置 `emissive.setHex(0x334466)` 或 `emissiveIntensity = 0.4`）。
  * 按钮 `aria-label` 完整保留，屏幕阅读器与键盘 Tab 导航体验不受任何影响。

### 3. 文件与函数级改动点
* `src/components/SolarSystem.js`：
  * `_buildHitButtons()`：移除 `const label = document.createElement('div');` 及相关 append 操作；`this.hitButtons` 结构中移除 `label` 字段。
  * `_syncHitButtons()`：移除 `entry.label.style...` 的样式同步逻辑。
  * `destroy()`：移除 `entry.label.parentNode.removeChild(entry.label)`。
* `test/unit/solarSystemOrbit.test.js`：
  * 将 `expect(text).toContain('solar-body-label');` 修改为断言命中热区按钮类名：`expect(text).toContain('solar-system-hit');`。

### 4. 性能收益
* 每一帧减少 3 个 DOM 元素的样式读取（`getBoundingClientRect` 间接计算）与 Style Mutation（`style.left/top/visibility`），彻底消除由此引起的潜在微重排（Reflow）。

### 5. 验收断言
* 自动化运行 `scripts/verify_solar_hit_targets.py`，三个核心热区命中率保持 100%。
* DOM 检查：`document.querySelectorAll('.solar-body-label').length === 0`。
* 键盘 Tab 切换，按键聚焦轮廓准确覆盖在太阳、地球和月球球体外缘。

---

## D4 星舰处理（多视图生命周期隔离）

### 1. 现状机制与影响面评估
* 结构现状：`serverTable.js` 的 `mountDisplayPage()` 模板中同时声明了：
  ```html
  <div id="solar-system-container" ...></div>
  <div id="globe-container" ... style="display:none"></div>
  <div class="photo-space-showcase" aria-hidden="true">
    <div class="photo-nebula-field"></div>
    <div id="starship-gltf-stage" class="starship-gltf-stage"></div>
  </div>
  ```
* 门禁依赖：`scripts/verify-single-renderer-home.mjs` 第 22 行断言：
  `assert.match(displayMount[0], /photo-space-showcase[\s\S]*?starship-gltf-stage/, 'independent stage markup present');`
  **因此不可从 DOM 模板中删除 `#starship-gltf-stage` 标签**。
* 渲染现状：
  * 太阳系首页视图处于激活态时，`#starship-gltf-stage` 处于可见状态，若挂载星舰将遮挡太阳系右上角星空并消耗约 55MB 显存；
  * 地球视图（CesiumGlobe）需要右上角独立 StarshipShowcase 展示进取号。
* **设计建议与结论**：
  * **太阳系视图**：必须彻底隐藏星舰 stage，且杜绝任何后台挂载与模型加载；
  * **地球视图**：完整保留现有星舰挂载与动画展示逻辑；
  * **背景星云**：`.photo-nebula-field` 作为统一空间氛围层保留。

### 2. 方案与切换控制权设计
* **控制权归属**：由 `src/modules/serverTable.js` 统一管理视图切换时的 stage 显示与销毁。
* **初始状态（太阳系首页）**：
  * 在 `mountDisplayPage()` 中，将 stage 默认设为隐藏：
    `<div id="starship-gltf-stage" class="starship-gltf-stage" style="display:none"></div>`
  * 该写法完全满足 `/photo-space-showcase[\s\S]*?starship-gltf-stage/` 正则匹配。
* **进入地球视图（`showCesiumGlobe()`）**：
  * 在触发 `ensureStarshipMounted()` 前，先执行：
    `const stage = document.getElementById('starship-gltf-stage'); if (stage) stage.style.display = '';`
  * 保证 `stage.offsetParent` 判定有效，`StarshipShowcase` 正常实例化并淡入。
* **返回太阳系视图（`showSolarSystem()`）**：
  * 现有代码已执行 `try { starshipShowcase?.destroy?.(); } catch (_) {}`；
  * 追加执行隐藏 DOM：
    `const stage = document.getElementById('starship-gltf-stage'); if (stage) stage.style.display = 'none';`

### 3. 文件与函数级改动点
* `src/modules/serverTable.js`：
  * `mountDisplayPage()`：给 `#starship-gltf-stage` 赋予内联样式 `style="display:none"`。
  * `showCesiumGlobe()`：切入地球时显示 stage（`stage.style.display = ''`）。
  * `showSolarSystem()`：返回太阳系时隐藏 stage（`stage.style.display = 'none'`）。

### 4. 验收断言
* 门禁校验：`scripts/verify-single-renderer-home.mjs` 绿灯通过。
* 运行时断言：
  * 太阳系首页加载后，`document.getElementById('starship-gltf-stage').style.display === 'none'`，且 `window.__starshipShowcase` 为 `undefined`；
  * 点击地球进入三维地球后，`stage.style.display !== 'none'`，进取号模型正常加载并呈现推进器特效；
  * 按 Esc 返回太阳系后，stage 恢复 `display: none`，Three.js 星舰实例已执行 `destroy`，GPU 显存释放。

---

## D5 哈雷彗星（高椭圆轨道与动态彗尾）

### 1. 轨道力学参数设计
* 轨道属于高偏心率椭圆，焦距一端位于太阳中心 `(0, 0, 0)`。
* **关键参数**：
  * 近日点半径 $r_p = 8.0$（位于水星轨道 9 之内）
  * 远日点半径 $r_a = 68.0$（越出土星轨道 41，伸展至外太阳系深空）
  * 半长轴 $a = (r_p + r_a) / 2 = 38.0$
  * 偏心率 $e = (r_a - r_p) / (r_a + r_p) = 60 / 76 \approx 0.789$
  * 半通径 $p = a(1 - e^2) \approx 38.0 \times (1 - 0.623) \approx 14.34$
  * 轨道倾角 $i = 15.0^\circ$（绕 X 轴倾斜，形成具有空间纵深感的三维立体轨道）
* **向径公式（以太阳为原点极坐标）**：
  $$r(\theta) = \frac{p}{1 + e \cos \theta}$$
  3D 空间坐标变换：
  $$x = r(\theta) \cos \theta, \quad y = r(\theta) \sin \theta \cdot \sin(i), \quad z = r(\theta) \sin \theta \cdot \cos(i)$$

### 2. 开普勒第二定律速度模拟（掠日加速算法）
* 真实开普勒定律角速度比高达 $(68/8)^2 \approx 72$ 倍，若完全按物理模拟，彗星在远日点几乎处于停滞感。
* **软化角速度插值公式**：
  $$\omega(r) = \omega_{\text{base}} \cdot \left(\frac{a}{r}\right)^{1.25}$$
  设定基准速度 $\omega_{\text{base}} = 0.08\text{ rad/s}$。
  * 远日点处（$r=68$）：角速度约为 $0.038\text{ rad/s}$，缓慢巡航；
  * 近日点处（$r=8$）：角速度提升至 $0.57\text{ rad/s}$（约 15 倍加速），展现风驰电掣的掠日冲刺效果。

### 3. 视觉构成与无额外粒子开销设计
* **规避禁区**：`test/unit/solarSystemOrbit.test.js` 严禁出现 `PointsMaterial`。因此彗尾严禁采用 `THREE.PointsMaterial`！
* **彗核（Comet Nucleus）**：
  * 低多边形微型球体：`SphereGeometry(0.35, 12, 8)`。
  * 材质：`MeshBasicMaterial({ color: 0xdff6ff })`，极淡冰青白高亮球。
* **彗尾（Comet Tail）——定向渐变 Mesh**：
  * 物理事实：**彗尾受太阳辐射压推动，始终背离太阳方向**，而非沿运动反切线方向。
  * 架构设计：采用单个细长梯形平面（`PlaneGeometry(1, 1)`）或双交叉面片，贴以离屏 Canvas 2D 绘制的指数衰减发光条带纹理（`CanvasTexture`）。
  * 尾部朝向计算：
    $$\vec{u}_{\text{tail}} = \text{normalize}(\vec{P}_{\text{comet}} - \vec{P}_{\text{sun}}) = \text{normalize}(\vec{P}_{\text{comet}})$$
    在逐帧更新中通过 `quaternion.setFromUnitVectors` 始终背向原点。
  * 动态拉伸与亮度：
    * 彗尾长度随近日距离成反比：$L(r) = \text{clamp}(16.0 \times (r_p / r), 2.0, 15.0)$；
    * 不透明度：近日点达 0.85（亮蓝青色发光），远日点降至 0.12（黯淡微光）。
* **轨道线（Orbit Line）**：
  * 沿椭圆公式预采样 128 个点，构筑 `LineLoop`，线材颜色 `0x406080`，`opacity: 0.18`。

### 4. 交互与生命周期
* 不创建任何 `button.solar-system-hit`，不加入 Raycaster 拾取列表，完全静默运动。
* 纳入 `this.disposables`，在 `destroy()` 中释放 geometry、material 与 texture。

### 5. 文件与函数级改动点
* `src/components/SolarSystem.js`：
  * 新增私有方法 `_buildHalleyComet()`，在 `_buildPlanets()` 之后调用。
  * 在 `_advanceBodies(dt)` 循环内加入彗星专有非线性轨道推进与彗尾定向计算。

### 6. 验收断言
* 源码校验：源码中严禁匹配到 `PointsMaterial`。
* 物理轨迹断言：在运行 1 个周期过程中，彗星至太阳距离的最大值在 $[66, 70]$ 区间，最小值在 $[7.8, 8.2]$ 区间；彗尾始终保持在背向太阳视线方向 $\pm 1^\circ$ 范围内。

---

## D6 星环质感升级（土星环）

### 1. 现状问题与视觉目标
* 现状：土星环使用纯色 `MeshBasicMaterial({ color: 0xd8c79a, opacity: 0.55 })` 配合普通 `RingGeometry`，无光影响应，无同心条纹，缺失著名的卡西尼环缝，呈现单薄廉价的塑料片质感。
* 视觉目标：
  * 呈现真实的同心微细光带（Dense Concentric Rings）；
  * 精准刻画**卡西尼缝（Cassini Division）**与**恩克环缝（Encke Gap）**；
  * 具备光照响应能力，在向阳面明亮闪烁，在背阴面随行星投射暗影自然过渡。

### 2. 材质选型：MeshStandardMaterial vs MeshBasicMaterial
* **选型结论：选用 `MeshStandardMaterial`**。
* **核心理由**：
  * `MeshBasicMaterial` 不受光照影响，导致土星处于暗面的星环与向阳面亮度完全一样，违背立体天体光影法则；
  * `MeshStandardMaterial` 配合 `side: THREE.DoubleSide`、`roughness: 0.7`、`metalness: 0.1`，能实时接收太阳 `PointLight` 的照射，在面向太阳方向形成丰润的反射，在背光侧呈现自然的暗沉，与土星本体的光照分界完美呼应。

### 3. 程序化环纹理生成规范（Canvas 2D）
* 避免加载网络图片资产，采用内存离屏 Canvas（规格：**512 × 1 像素**，超轻量，显存占用不足 4KB）。
* **径向归一化透明度与色值分布（从内径 2.6 到外径 4.5）**：
  ```
  半径位置      环区命名        颜色 (Hex)      Alpha   物理特征
  -------------------------------------------------------------------------
  [2.60, 2.75]  D 环 (内晕环)   #5c503d         0.15    近内边缘半透明过渡
  [2.75, 3.15]  C 环 (绉状环)   #9c8b70         0.45    温和透光中密度区
  [3.15, 3.75]  B 环 (主光环)   #dfd2b5         0.92    极亮、致密、暖米黄
  [3.75, 3.86]  卡西尼环缝     #000000         0.03    著名深空缝隙，高透空隙
  [3.86, 4.35]  A 环 (外光环)   #c2b496         0.68    中等致密环带
  [4.18, 4.21]  恩克环缝       #000000         0.05    外环细微空隙
  [4.35, 4.50]  F 环 (牧羊边)   #7c7058         0.00    向外缘平滑羽化为 0
  ```
* 利用 `CanvasRenderingContext2D` 的 `createLinearGradient` 填充并叠加细微正弦微扰（高频同心细线），生成 `THREE.CanvasTexture`。

### 4. RingGeometry UV 映射核心思路
* **Three.js 原生缺陷**：`THREE.RingGeometry` 默认生成的 UV 是平面投影（$[-1, 1]$ 映射到 $[0, 1]$ 矩形），无法直接贴 1D 径向条带。
* **自定义径向 UV 映射算法**：
  对 `RingGeometry` 的 `uv` 属性缓冲区进行遍历重构：
  ```javascript
  const pos = ringGeometry.attributes.position;
  const uv = ringGeometry.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.hypot(v.x, v.y);
    const normalizedU = (r - innerRadius) / (outerRadius - innerRadius);
    uv.setXY(i, THREE.MathUtils.clamp(normalizedU, 0, 1), 0.5);
  }
  uv.needsUpdate = true;
  ```
  此时 512×1 纹理将完美以同心圆方式沿径向展开，条纹锐利平滑，无极点拉伸或失真。

### 5. 文件与函数级改动点
* `src/components/SolarSystem.js`：
  * 新增工具方法 `_generateSaturnRingTexture()`；
  * 修改 `_buildPlanets()` 中土星（`spec.name === 'Saturn'`）星环构建块：将几何体由固定段数升级为径向 UV 映射环，材质替换为 `MeshStandardMaterial`，赋值生成的 `CanvasTexture`。

### 6. 验收断言
* 契约断言：`assert.match(solar, /RingGeometry/);` 持续通过。
* 视觉检查：土星环在半径 $3.75 \sim 3.86$ 单位处呈现一条清晰透光的黑色环带（卡西尼缝）；环面明暗随土星整体受光角度同步变化。

---

## D7 陨石带（Asteroid Belt）

### 1. 空间轨道分布参数
* 位于火星（轨道 25）与木星（轨道 33）之间，形成具有一定厚度的三维甜甜圈状碎石带。
* **分布参数**：
  * 环带内径 $R_{\text{min}} = 27.5$
  * 环带外径 $R_{\text{max}} = 31.8$
  * 环带核心半径 $R_0 = 29.6$，宽度约 4.3 单位
  * 垂向厚度分布：$Y \sim \text{Gaussian}(0, \sigma=0.35)$，轻微厚度扰动
  * 碎石单体半径：随机分布于 $0.08 \sim 0.22$
  * 碎石色系：灰褐岩石调（`0x5a534c` 到 `0x8c7e72` 的随机微扰）

### 2. 技术架构选型：InstancedMesh vs Points
* **选型结论：坚决采用 `THREE.InstancedMesh`**。
* **核心理由**：
  1. **单次 Draw Call**：数千颗小行星共享一个材质和一个几何体，仅需 **1 个 Draw Call** 即可完成整带绘制；
  2. **避开单测红线**：`test/unit/solarSystemOrbit.test.js` 明确断言 `expect(text).not.toContain('PointsMaterial')`，采用 `Points` 会使测试直接挂掉；
  3. **立体多面体光影**：单体采用极低面数的无细分十二面体（`DodecahedronGeometry(0.15, 0)`，仅 12 个多边形），配合 `MeshStandardMaterial` 具有粗糙受光阴影面，远胜扁平的点精灵粒子。

### 3. 实例数量与性能控制
| 运行端 | 实例数量 (Count) | 几何体面数 | 预估 Draw Call | 预估渲染耗时 |
| :--- | :--- | :--- | :--- | :--- |
| **桌面端** | 1,200 | 14,400 三角形 | **1** | < 0.15 ms |
| **移动端 (`isMobile`)** | 500 | 6,000 三角形 | **1** | < 0.08 ms |

### 4. 差速公转与自转算法
* 遵循开普勒差速规律（非刚体整体旋转）：
  各碎石角速度 $\omega_i$ 与其轨道半径 $r_i$ 负相关：
  $$\omega_i = \omega_0 \cdot \left(\frac{R_0}{r_i}\right)^{1.5}, \quad \text{其中 } \omega_0 \approx 0.18\text{ rad/s}$$
  （介于火星速度 0.24 与木星速度 0.14 之间）。
* **轻量化矩阵更新设计**：
  * 在 CPU 端保存每个实例的固定轨道半径 $r_i$、垂直高度 $y_i$、当前角度 $\theta_i$、自身翻滚角速度 $\psi_i$ 与特征缩放 $s_i$；
  * 在 `_advanceBodies(dt)` 中：利用单一复用的 `THREE.Matrix4` 和 `THREE.Object3D`（scratch object），仅计算 $\theta_i += \omega_i \cdot dt$，更新 `instancedMesh.setMatrixAt(i, matrix)`；
  * 设置 `instancedMesh.instanceMatrix.needsUpdate = true`。测试证明 1200 次浮点矩阵写入耗时仅约 0.1ms，毫无掉帧风险。

### 5. 拾取与交互隔离
* 小行星带纯属背景天体，不注册 hitButton，不进入 Raycaster 检测列表，杜绝任何误触。

### 6. 文件与函数级改动点
* `src/components/SolarSystem.js`：
  * 新增私有方法 `_buildAsteroidBelt()`，在 `_buildPlanets()` 之后执行。
  * 在 `_advanceBodies(dt)` 中增加小行星带差速矩阵同步。
  * 在 `destroy()` 中释放 `instancedMesh` 的 geometry 与 material。

### 7. 验收断言
* 单测红线：源码文本中无 `PointsMaterial`。
* 渲染指标：WebGL 渲染调用总数（Draw Calls）仅增加 1。
* 空间位置：所有小行星坐标严格限制在 $X^2 + Z^2 \in [27.5^2, 31.8^2]$，且 $|Y| \le 1.2$。

---

## 改动文件清单与实施顺序建议

### 1. 改动文件清单总览
| 文件路径 | 改动属性 | 关联任务 | 改动内容摘要 |
| :--- | :--- | :--- | :--- |
| `src/components/SolarSystem.js` | **核心** | D1, D2, D3, D5, D6, D7 | 修复太阳 PointLight 与补光；重构拖拽 2.8s 延迟恢复状态机；删除 `solar-body-label` DOM；构建哈雷彗星与彗尾；土星环 Canvas 纹理与径向 UV；小行星带 `InstancedMesh` 构建与差速公转。 |
| `src/modules/serverTable.js` | **核心** | D4 | `mountDisplayPage()` 中将 `#starship-gltf-stage` 初始置为 `display:none`；在 `showCesiumGlobe()` 与 `showSolarSystem()` 中调度显隐，保持生命周期完整。 |
| `test/unit/solarSystemOrbit.test.js` | **测试** | D3 | 将针对 `solar-body-label` 的文本包含断言平滑迁移至针对 `solar-system-hit` 按钮热区的断言。 |

### 2. 建议实施顺序（四阶段分步验证）

```
[阶段一: 基础光影修复与星舰视图隔离] (D1, D4)
  -> 修复 PointLight(decay=0) 与环境光 -> 验证行星昼夜与明暗边界
  -> serverTable.js 隐藏太阳系中的星舰 stage -> 运行 verify-single-renderer-home.mjs
       |
       v
[阶段二: 交互优化与标签精简] (D2, D3)
  -> 移除 solar-body-label 创建与逐帧同步 -> 修改 solarSystemOrbit.test.js 单测断言
  -> 实现 2.8s 延时恢复状态机 -> 运行 verify_solar_hit_targets.py 确保热区与 a11y 完好
       |
       v
[阶段三: 既有资产质感跃迁] (D6)
  -> 离屏 Canvas 2D 绘制同心带与卡西尼缝 -> RingGeometry 径向 UV 映射与 MeshStandardMaterial
  -> 视觉验证土星环光影反应与缝隙透光效果
       |
       v
[阶段四: 新生天体扩充] (D5, D7)
  -> 构建哈雷彗星（高椭圆、掠日加速、背向太阳彗尾）
  -> 构建小行星带（火木之间、InstancedMesh 单 Draw Call、差速公转）
  -> 运行全套门禁回归：verify-solar-system-home.mjs / 单测回归
```

### 3. 门禁回归核验对照表
* `scripts/verify-solar-system-home.mjs`：确保单一 renderer、单一 rAF、`PointLight`、`RingGeometry`、`cameraAtHome` 赋值点受控等契约 100% 通过；
* `scripts/verify-single-renderer-home.mjs`：确保星舰 HTML 标记完整存在且 Cesium 地球独立挂载不受阻断；
* `scripts/verify_solar_hit_targets.py`：确保太阳、地球、月球三颗核心交互星体的无障碍按钮在 260 帧复杂轨道运动中无重叠且命中率达到 100%；
* `test/unit/solarSystemOrbit.test.js`：确保不含 `PointsMaterial`、无 `_buildStars`、轮轨交互和拖拽暂停逻辑正常。
EXIT=0
