# 移动端横屏与加载同步：设计及行为合同记录

此文档原样保留 Codex implementation01 的源码核对合同；它基于 agy design02 的横屏方案，并纠正其成员集及源码接口。合同/实现由同一 Codex 承担，不宣称独立设计批准；本任务 Claude 架构及最终复审为 WAIVED，独立验收由 Hermes 执行。下面的“不 commit”等条款限定实现作业，不撤销当前父流程获授权的本地提交；192/GitHub/镜像发布始终不在本次范围。

来源证据：`solar-comet-upgrade/evidence/mobile-horizontal-sync-20261104/{agy-design-02/parent-source-corrections.json,codex-implementation-01/CONTRACT.md}`。

---

# 手机 viewport / mobile budget 最小行为合同

本次合同与实现由同一Codex承担，独立设计/复审缺口仍存在。Claude 架构与最终复审已由用户 WAIVED；Hermes 负责独立验收。本合同先按已确认的源码观察写入，源码为最终权威；必要核对如发现不可同时满足的约束，保留合同与回归并 STOP，不扩目标、不调阈值。

## 范围与统一规则

- 修复两项：触控手机横屏冷开与同页旋转的 mobile 判定/DPR 预算一致；移动横屏 content box 完整容于实际可用 viewport。优先横屏，竖屏非阻断可用；不强制 OS 方向，不旋转整页。
- 使用一套 content box 驱动 container、canvas CSS 尺寸、现有 camera aspect 与 GL drawing size。移动横屏 844×390 在无额外视觉遮挡时约为完整 844×390；处理 visualViewport 的可用尺寸/偏移及其事件。500px 高度条件来自 AGY 设计，不作为经验验收数字。不能任意调整 FOV 或物理尺寸。
- mobile 判定须覆盖 touch landscape cold 和 portrait→landscape；CSS/JS 触控条件等价，或由 SolarSystem 持有的 scoped data attribute 镜像。fine/hover 与非触控 desktop 保持现有行为。DPR 为 min(deviceDPR, mobile ? 1.5 : 2)，DPR1 不得升至 1.5。
- 保持 desktop 1280×900 → 1280×640 / DPR1、portrait 390×844 → 390×219.375 / DPR1.5 的原有 16:9 行为。旧证据：touch cold 844×390 曾误判 desktop / DPR2，同页旋转为 mobile / DPR1.5，两种横屏 canvas 844×422，溢出32px。
- 仅改 `frontend-vite/src/components/SolarSystem.js` 的 constructor、_detectMobile、resize、destroy 及必要 _mobile*/_viewport* 助手/顶层 MOBILE_QUERY；`frontend-vite/src/styles/starfleet-theme.css` 的太阳系 mobile viewport 块；新增 `frontend-vite/test/unit/solarMobileViewport.test.js`；既有 `solarStartup.test.js`、`solarP2.test.js` 仅作必要 DOM/matchMedia fixture 兼容，不弱化原断言或17个 startup cases。
- 不改 _measure、_fitHomeCamera、全部 _startup*、科学/材质/SunShader/物理半径/PLANET_TABLE/轨道/HitSolver、模板、依赖、后端或运行态；不 commit/reset/push/PR/部署，不增加大型 native 框架。本 run 文件早写并保存真实命令输出和 exit。

## 三个可能被挑战的判断

1. viewport 尺寸不能单独决定移动预算：应使用与 CSS 一致、可随旋转更新的触控/hover 媒体判据；具体组合以必要源码核对及回归确定，不能用全局属性污染其它实例。
2. viewport fitting 只在移动横屏激活；portrait/desktop 沿用原路径。visualViewport 表示当前可用区域，但嵌入容器、偏移和缩放的坐标归属需要声明并独立原生验收，不能把源 CSS 断言当作浏览器 geometry 证明。
3. 保持 _measure/_fitHomeCamera 不动，通过允许的 viewport/helper/resize 路径建立单一盒子应能满足容器、canvas、aspect、GL 一致；若实际源代码证明不能，则 STOP，而非修改禁止区域。

## 保留的加载与生命周期合同

- 复用现有原子加载，不重造状态机。canonical targets 为 Sun + 八行星 + Moon + Halley，不含 Pluto；11 visual slots 为八行星 + moon + earth_clouds + saturn_ring，字段 state/owner，终态 SUCCESS 或 COMMITTED_FALLBACK。
- 保留 _startupCaptureFrame/_startupPublish/_startupExpire 与重试卸载保护。发布要求全部11 visual owned 终态、owned background 与科学10 targets 同一 timeSample/正确物理位置、rate1 freshness ≤16.7ms、Sun 真实 program/GL render；科学 loading/error 挡 publication，hidden rAF 继续 bootstrap/warmup。
- 4秒为 visual maximum deadline，404 可以立即 fallback。rates 60/3600/86400 由 performance.now 锚定，不用 wallDelta。Solar owned active rAF ≤1，paused/destroyed 为0，pause 不销毁 renderer；Cesium 独立组件不计入 Solar 数量。不得复制虚构方法、Pluto、全局 context=1 或等待=kill 条款。

## 回归、真实 RED/GREEN 与原生正负验收

- 单测必须调用生产 SolarSystem 方法/构造器；仅按既有模式替身 DOM/media/GL。覆盖 touch landscape cold 与 rotation、DPR1/3、touch vs fine/hover desktop、scope ownership/cleanup、旧 portrait/desktop；RED 期望 mobile true、正确 DPR1.5 和零 overflow，不把旧32px写成通过期望。
- 在 frontend-vite 执行 `npm run test:unit -- --configLoader runner test/unit/solarMobileViewport.test.js test/unit/solarStartup.test.js test/unit/solarP2.test.js`，保存真实 RED/GREEN 原始 stdout、stderr、exit；再跑必要全 unit 与 scoped format/lint。正常 config loader 的 EROFS 是 setup 问题，使用已支持 runner，不改依赖。不执行 build 或全量 native。
- `/root/.hermes/plans/solar-comet-upgrade/evidence/mobile-horizontal-sync-20261104/baseline-native-01/` 为真实旧32px CSS 行为前测，仅引用，不修改、不冒充本轮 runner。源码 CSS 静态断言仅为回归约束，不是浏览器 geometry 验收。
- Hermes 原生正控：真实构建的 touch 冷开、双向 rotation、visualViewport 尺寸/偏移，完整 content box、canvas/aspect/GL 同步及正确 DPR；非触控 desktop、portrait16:9；旧 startup22/Sun/Halley/science/三入口与生命周期恢复。
- Hermes 原生负控：临时撤销 CSS fitting 应捕获旧32px overflow；撤销 mobile predicate 应捕获 cold misclassification/DPR2。独立验证 guard-removal nonkill，并恢复所有负控修改；本轮不伪造这些结果。
- 交付 `handoff.md`：实际允许文件变更、真实 runner 结果、未完成原生项、HEAD/源码 hash、建议 scoped commit manifest（不 commit）。任何未执行/失败/环境限制均如实保留。

## 必要源码核对后的精确决策

- HEAD 已实读为 `76b3ba267b23758363f2e78a0819b566d722a037`，初始 `git status --short` 为空。_detectMobile 原为单一 `(max-width: 720px)`；_buildRenderer 已正确使用 min(deviceDPR, cap)，但 resize 不刷新 mobile/DPR。_measure 读取 container rect，_buildScene/resize 已把该盒送入 camera 与 renderer。
- 保留旧720px宽度分支；新增 `(max-height: 500px) and (pointer: coarse) and (hover: none)` 分支覆盖触控冷横屏。fitting 另要求 layout viewport landscape、同一500px设计条件及同一 coarse/no-hover 触控条件，以 owned `data-solar-mobile-landscape` 镜像到当前 container；不使用 maxTouchPoints 作为 desktop 混合设备启发式。
- CSS 拥有 landscape box，JS 仅持有该 scoped attribute 与四项 `--solar-viewport-{width,height,left,top}` 参数，并在首次 scene measure 前和每次 resize/media/visualViewport 事件更新。position 的 scoped优先级需兼容禁止修改的 _buildHitButtons 所写 inline relative。window resize 沿用现有绑定；新的 MediaQueryList/visualViewport 监听在 destroy 或 renderer construction failure 释放。
- visualViewport 有有效正尺寸时使用其 CSS像素 width/height 与 layout-relative offsetLeft/offsetTop；否则回退 window innerWidth/innerHeight 与0偏移。500px/方向判据仍取 layout media，不能因 portrait 键盘缩小 visual viewport 而强制 portrait 横屏。scale 不乘入 DPR、不调整 FOV/物理大小；浏览器 fixed containing block、祖先 transform、页面滚动/缩放仍需 Hermes 原生验证。本切片假定每个 container 同时仅一个 Solar owner，多个不同 container 独立。
- 新单测构造真实 SolarSystem，复用既有 THREE/DOM 替身模式；DOM rect 将 scoped CSS参数投射为盒，旧布局替身保留既有2:1/portrait16:9。独立静态 CSS 断言约束参数连接，但这两者均不提供真实浏览器 geometry 证明；原生正负控保持待验。
- 全unit的真实RED暴露既有轻量/headless DOM调用边界：Realtime constructor替身无getAttribute/CSSOM，VisualFeedback直接调用未初始化的生产resize且无window。只在允许的_viewportInit/resize中保留这些旧路径，不改这些测试或断言；真实Element仍在constructor创建owned viewport state并执行完整新行为。该兼容边界不涉及startup/publication guard，也不是 native geometry 的豁免。
