# 资产页经典 LCARS 实施

基线：`92154294380031f6555c99d615cf41f8a5c6c3d5`。任务绑定：`vps-assets-layout-yydz-20261114` / `b79229bd342c418cb59eed358c746587`。

## 实现边界

- 资产页渲染设置 `#pageRoot[data-theme-style="lcars"]`，现有功能 class 保留；销毁及路由退出清除 marker。
- 独立 `frontend-vite/src/styles/overview-lcars.css`，仅 root 后代及限定资产存在时的原 Dock 视觉；无新依赖或新增 important。
- 经典橙 / 紫 / 桃 / 淡黄、实体黑色面板、弯头横梁和静态侧轨。装饰隐藏于辅助技术且不接收指针事件。
- 旧重要材质声明通过零权重祖先感知排除退出 LCARS；原声明值及非资产分支保留。
- 十张全局 summary、现有 4/2/1 节点网格、移动 summary 前八双列及后两全宽、字段、PING 与原控件事件不变。
- 无表格回归；底距统一 52 + 16 + safe area，不叠加 84px。

## TDD 和验收

先加入真实 `renderPublicOverviewPage` 的 0/1/4/30 节点行为测试，实际 RED 为 marker 缺失（4 cases），非缺模块导入。最小 GREEN 后加入 CSS parser 作用域、实体材质、触控、底距、祖先隔离与颜色 token 对比度测试，以及退出路由 cleanup。

原始运行 stdout 与退出码位于 `../codex-lcars-style-08/`。首次 focused GREEN（六文件）131 cases 通过；后续验证以该目录最新日志为准。

未运行全量矩阵、完整构建、浏览器截图验收及部署。1440×900 NodeGridTop ≤ 436、首卡自然可见高度及 390×844 横向溢出/实际触控/底距仍需 Hermes 浏览器实测；token 对比度不是整页 AA 合规声明。

## 11 轮级联收口实证与限制

本轮绑定：`vps-assets-layout-yydz-20261114` / `c853adfafa3a4ea69c4376731db3a77a`，HEAD 不变。证据目录：`/root/.hermes/plans/vps-assets-layout-yydz-20261114/codex-lcars-cascade-repair-11`。08 轮九条 dirty 路径保留；renderer、templates、业务聚合与所有非允许产品源冻结。

- 父 `npm run quality` 原始结果仍是 47 files 通过 / 1 file 失败、835 passed / 12 failed / total 847，不改写为通过。本轮首先重现 `keeps real overview statistics`：rc 1，`app.setAttribute is not a function`，明确为 adapter compatibility RED。仅给旧 DOM fixture 增加正常 set/get/removeAttribute，保留 111 cases、全部断言、真实生产函数及既有变体。
- 四条新增级联回归先真实 RED：standard reset 被当前 minifier 丢弃、通用 important selector 无祖先排除、手机 34px important geometry 未隔离、桌面 summary 缺少行间距收口。原始日志 `lcars-cascade-red.log` / rc 1；不以 scaffold/解析失败冒充该 RED。
- CSS-only Vite 编译实际 `main.css` 及其生产 imports，采用当前生产配置的 minify 值和 Vite 的默认 CSS minifier/targets，`write: false`、不加载页面 JS、不执行 PWA/Cesium 插件、不输出完整构建。新增断言同时要求编译结果保留 standard 与 WebKit `backdrop-filter: none`；回退声明顺序或删除任一 reset 即失败。
- 通用 `.theme-toggle`、`.currency-switch`、`.currency-btn`、`select` 与 active currency 的旧 important 材质只追加零权重祖先排除；手机旧规则只排除 overview topbar 的 button/select 分支。其余 selector、声明值与 important 标志不变。删除任何这些 guard 会使源/真实编译回归失败；删除 LCARS 36px min-height 也失败。
- 仅桌面 ≥1280px 的 summary `row-gap` 从继承的 16px 收口为 8px，列间距、十张卡的 4+4+2、caption、自然高度和节点内容不变。按父已 settled landmarks 的 450px 与三行估算首节点 top 为 434px；这只是空间预算回归，不是新 native 实测。回退行间距即失败，436px 门槛未放宽。
- root dark/Day、4/2/1 节点网格、手机 summary 编排、52px Dock、统一 68px + safe-area 底距及原 16px 末卡间距均未修补。没有新增 important 或复活 table；没有提交、push、PR、部署、后端/API/数据库/Agent/太阳系/Cesium 或依赖改动。

最终 focused 结果、编译产物、相对本轮源 baseline 的 important/作用域核验与全部 rawlog/rc 以证据目录 `commit-manifest.txt` 为准。父仍负责完整 quality/矩阵、完整 build，以及 dark/light × 1440/1024/390 的 native 触控、实体材质、首屏、底距/overflow 与非资产页面回读；focused GREEN 不代表最终验收。
