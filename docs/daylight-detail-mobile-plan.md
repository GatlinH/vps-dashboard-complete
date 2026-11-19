# 日间可读性与手机详情布局设计（agy）

设计源绑定：`14b5607f6ab21c14d544d5004b34ccbeca971885` + 既有资产候选6文件。本补正覆盖前合同的硬限高、首图740/750/850门槛、亮青选中态与桌面DOM移动要求。正文/长值自然撑开，不以缩字或隐藏信息达到高度；170px图卡只作最小参考，标题/控件需要时自然增高，不得裁切。仅手机重排，桌面结构保留；坐标字阶与数据轴/采样/隐私语义分别验收。

## 原方案（已补正条目不可单独执行）

DAYLIGHT_DETAIL_MOBILE_DESIGN_CONTRACT

### 一、核心架构与设计决策

1. **可验证冷白底色与文本对比度（Anti-Warm-Paper）**
   - **底色锁定**：日间（Light）模式统一锁定为冷白纯实底。Page 背景 `--hud-bg: #ecf2f8`，卡片表面 `--hud-panel: #ffffff`（禁止半透明叠加导致对比度测不准）。
   - **文字阶梯**：主文本 `--hud-text-primary: #0f172a`（对比度 >13:1）；次级与辅助文本 `--hud-text-muted: #334155`（对比度 7.2:1，严格符合 AA 4.5+ 标准，全面废弃旧 `#7289a5`、`#8ab5bd`）；高亮深青 `--hud-cyan-primary: #0e7490`（白底对比度 4.6:1）。
2. **全 5 图 Canvas 真实主题重绘（Active Canvas Repaint）**
   - 彻底废除 Canvas 内部硬编码色（`#8ab5bd/#6fa4ad/#45676c`）。所有 Canvas 刻度文字、网格线、tooltip 及空态文案全部接入动态主题 Token。
   - 监听系统与手动主题切换（`themeToggle` / `data-theme` 变更），触发 5 图 Canvas 实例即时重绘，禁止沿用暗色帧缓存。
3. **Legacy CSS 隔离与退休策略（Zero New !important）**
   - 严禁引入任何新的 `!important` 覆盖规则。
   - 针对 `detail-starfleet-console.css` 现存的 1841 处 legacy 规则：建立命名空间隔离，通过提高容器级属性特异性挂载，或原地修剪/收敛旧 `@media (max-width: 640px)` 与 `@media (max-width: 520px)` 冲突规则。
4. **Loading Shell 与 Loaded Console 骨架同构**
   - `detailLoadingShell` 与 `renderDetailConsole` 严格对齐容器类名与尺寸配比，杜绝首屏数据加载完成时发生布局抖动（CLS < 0.05）。

---

### 二、Slice 1：日间字体可读性、资产 Caption 与全 5 图 Canvas 主题重绘

#### 1. 资产页（Overview）字阶与对比度规范
- **文件**：`frontend-vite/src/styles/overview-lcars.css`
- **样式规则与 Token**：
  - `.overview-summary-captions`, `.overview-summary-details`, `.public-overview-card small`：字号由 10px 提升至 **12px**，行高 1.4，日间字色锁定为 `#334155`。
  - `.overview-summary-title`：手机端（<768px）字号由 11px 提升至 **12px**（font-weight: 600），字色 `#0e7490`。
  - 4/2/1 列栅格、10 摘要卡（费用/到期跨两格）、对称 24/12 padding 与 16/12 gap 严格维持不变。

#### 2. 详情页文本与 Canvas 刻度字阶提升
- **文件**：`frontend-vite/src/styles/detail-starfleet-console.css`、`frontend-vite/src/pages/detailCharts.js`
- **DOM 文本**：
  - 淘汰 9~10px 状态小字，`.fleet-micro`、状态标签说明提升至 **11px ~ 12px**；数值与关键状态提升至 **13px ~ 14px**。
  - 健康摘要辅注 `em` 提升至 **12px**，日间颜色 `#334155`。
- **Canvas 绘制（5 图覆盖）**：
  - 覆盖图表：`detailNetworkChart`, `detailPingChart`, `detailCpuChart`, `detailMemoryChart`, `detailProcessCountChart`。
  - **坐标轴文字**：字号统一从 7~8px 提升至 **11px**（Font: `'JetBrains Mono', monospace`）。日间字色 `#334155`，暗色字色 `#94a3b8`。
  - **网格线**：日间 `rgba(15, 23, 42, 0.08)`，暗色 `rgba(255, 255, 255, 0.08)`。
  - **缺省与空态文案**：字号提升至 **12px**，日间统一绘制 `#475569`，暗色绘制 `#94a3b8`，彻底消除浅灰隐形现象。
  - **数据完整性**：空样本合法保持断流，禁止伪造 0 曲线；CPU/RAM/Process 维持 1h 独立坐标轴与整数进程 Y 轴。

---

### 三、Slice 2：手机端详情页布局重排与历史 Toolbar 前置（≤768px）

#### 1. 历史控制器前置与触摸优化
- **文件**：`frontend-vite/src/pages/detailPage.js`
- **调整规则**：
  - 将 `.history-range-bar` 从图表下方的 `.fleet-right-zone` 中移出，**前置布局至 `<main class="fleet-chart-matrix">` 之前**。
  - `.detail-history-range` 采用单排弹性横向平滑滚动（`overflow-x: auto; -webkit-overflow-scrolling: touch;`）。
  - `.detail-history-btn` 高度由 18.5px 提升至 **36px**（触控标准最小可用高度），左右内边距 10px，字体 12px，激活状态高亮高对比显示。
  - 完整保留 0/1/4/7/30/90 全部选项及用户已选持久化状态。

#### 2. 手机端纵向空间紧缩标准（针对 390×844 实测）
- **文件**：`frontend-vite/src/styles/detail-starfleet-console.css`（或专用新建 `frontend-vite/src/styles/detail-mobile-layout.css`，由 main.css 引入）
- **布局分段控制（≤768px）**：
  1. **TopBar 工具栏**：由垂直堆叠 197px 压缩至 **≤ 48px**。
     - 返回按钮与功能组（主题、语言、币种 CNY/USD/EUR、汇率）采用紧凑横向 flex 排布，溢出时自适应弹性双排，单控件高度 36px，严禁多余上下 margin。
  2. **Node Header（节点标识与状态区）**：由 468.3px 压缩至 **≤ 140px**。
     - 装饰舰船徽标缩小至 48×28px，与节点名称横向混排；
     - 状态 5-tiles（区域/系统/运行/到期/Agent）从 5 行单列串联改为 **2 列紧凑栅格**（网格 `grid-template-columns: 1fr 1fr`），内边距压缩为 6px 8px，卡片标题 11px，内容 13px。
  3. **Health Summary（健康摘要）**：由 379.1px 压缩至 **≤ 80px**。
     - 4 tiles 改为 2×2 网格或单排横向流动，取消冗余内外边距。
  4. **Probe Observability Grid（4 监控卡片）**：整体由 1038.2px 压缩至 **≤ 440px**。
     - 单列排布，每张卡片（环境、分配、资源、带宽）取消冗余上下空间，内边距统一 10px，高度控制在 100~110px 范围。
  5. **5 图表 Matrix 与第一图可见高度**：
     - 单图容器高度设定为 **170px**（Canvas 绘制高度固定 130px，留 40px 给标题与 PING 地区下拉框）。
     - PING 下拉控件保持独立点击与无裁切显示。
     - 经过紧凑优化后，第一张网络吞吐量图的纵向 Y 坐标从 **top 2210.9px 前移至 top ≤ 740px**，用户在 390×844 首屏只需轻微下滑即可直接进入图表监控核心。

---

### 四、真正工程文件 Manifest

| 文件路径 | 职责范围与修改策略 |
| :--- | :--- |
| `frontend-vite/src/pages/detailPage.js` | 调整 DOM 顺序，将 `.history-range-bar` 前置至 `.fleet-chart-matrix` 前；保持所有语义属性、语言翻译包与事件挂载一致；同步调整 `detailLoadingShell`。 |
| `frontend-vite/src/pages/detailCharts.js` | 封装 `getChartThemeTokens(isLight)`；全 5 图配置解绑旧硬编码色；坐标文字提升至 11px，空态提升至 12px；暴露 `refreshChartsTheme()`。 |
| `frontend-vite/src/modules/serverTable.js` | 在主题切换回调中挂载图表重绘触发（`refreshChartsTheme`），确保生命周期内实时响应，无数据/网络层逻辑改动。 |
| `frontend-vite/src/styles/overview-lcars.css` | 资产页 Day 模式 token 修正（`#334155` / `#0e7490`），正文/说明文本升至 12px。 |
| `frontend-vite/src/styles/detail-starfleet-console.css` | 修剪退休已失效的 640px/520px 孤岛规则；引入 ≤768px 移动端容器规则（TopBar ≤48px、Header ≤140px、Health ≤80px、图表 170px）。 |

---

### 五、验收指标与多端多态反变异矩阵

#### 1. 严格量化验收指标
- **对比度指标**：所有正文、辅助说明（`em`, `small`）、按钮文字、Canvas 坐标文字及提示语对比度均 **≥ 4.5:1**（WCAG AA）。
- **移动触控指标**：历史按钮（0/1/4/7/30/90）、返回星图、主题/币种切换高度 **≥ 36px**，无重叠，无横向溢出破页。
- **纵向空间节省**：390×844 视口下，第一张网络图 top 坐标由旧版 2210.9px 优化至 **≤ 750px**。

#### 2. 多端多态反变异矩阵（Mutation Guards）

| 视口规格 | 主题状态 | 数据状态 | 预期正向表现 | 明确反变异判定（出现即失败） |
| :--- | :--- | :--- | :--- | :--- |
| **360×780** (小屏) | Day / Light | 空样本 | 历史 Bar 横向可滑无截断；5 图 Canvas 空态文字清晰（≥4.5:1）；TopBar 无遮挡 | 出现文本换行截断；空态绘制硬编码 `#8ab5bd`；产生横向全局滚条 |
| **390×844** (典型) | Day / Light | 正样本 | 历史 Bar 处于图表正上方；第一图 top ≤ 750px；状态卡 2 列排布紧凑 | 第一图 top > 850px；状态卡单列长条堆叠；Canvas 残留 Dark 缓存色 |
| **430×932** (大屏机) | Dark / Bridge | 正样本 | 历史 Bar 位于图表前；暗色文字高亮清晰，网格线纯净微光 | 历史 Bar 掉回页面底端；按钮高度被压回 18.5px |
| **768×1024** (平板) | Day / Light | 正样本 | 导航与工具栏保持单排；资源卡自适应 2 列；图表字号 11px 清晰 | 错误触发桌面端全屏拉伸或错乱 wrap；出现文字重叠 |
| **1440×900** (桌面) | Dark / Light | 空/正样本 | 桌面原有经典 Starfleet 布局完整保留；仅字阶与主题色清晰度同步优化 | 手机紧凑布局错误渗漏至桌面；桌面图表高度被锁死为 170px |

#### 3. 核心功能不变性守则（Semantic Untouched）
- 严禁通过 `display: none` 抹除任何现有业务指标或元数据。
- 严禁假造数据点或伪造 0 采样连线；空样本保持真实空白呈现。
- 严禁篡改当前默认选择、数据轮询生命周期、持久化配置或多语言词典。

## 可满足性补正（优先）

DAYLIGHT_DETAIL_FEASIBLE_AMENDMENT

### 一、决策与最终约束（首要裁决）

1. **废弃硬限高与假定指标**：全面废除 TopBar ≤48px、Health ≤80px、资源卡 ≤110px、Header ≤140px 等不切实际限高；放弃 CLS<0.05 与 top 740/750/850 冲突门槛。第一图位置仅作为布局优化对比参考，非硬性验收指标。允许纵向自由滚动，秩序优先于一屏塞入。
2. **禁止业务截断**：严禁对已有业务数据使用 `display: none`、`ellipsis` 裁切隐藏或缩小字阶，确保所有字段与长值完整可读。
3. **真实对比度达标（≥4.5:1）**：文本与激活/选中态高亮统一采用深青色 `#0b6b82`（实测白底 6.11:1、日间底 5.41:1、active 白底 5.05:1、active 日间底 4.53:1，全态均严格符合 AA 标准）。暗色资产旧 palette（含 `#7289a5`）完整保留，绝不当作日间遗留全站误删。
4. **CSS 隔离与零 !important 增量**：不整站退库，全站 !important 总数只减不增。通过**原地修改当前活跃 detail-scoped 中的旧 !important 值**，或对旧 mobile 规则增加**局部 media guard 排除**；新增移动端专属层实现 0 !important。桌面端与夜间几何完全不变。
5. **历史栏前置机制（最低生命周期复杂度）**：采用**纯 CSS Grid / `display: contents` 与 `order: -1` 分层**在 ≤768px 将历史栏视觉置于图表前。桌面端 DOM 与渲染流保留原处，不触发 JS 节点换位与事件重挂载。

---

### 二、响应式分端与自然布局规范

1. **768px 断点**：资源卡自适应 2 列并排；TopBar 紧凑单排。
2. **≤430px 断点（360/390/430 手机端）**：
   - **TopBar**：弹性 flex 自适应双排展开（热区均 ≥36px），高度随内容自然延展。
   - **Header（5-tiles）**：2 列栅格自适应 3 行，长字段自然换行撑高。
   - **Health（4-tiles）**：2×2 栅格，完整容纳 label/strong/em 3 行自然高度。
   - **4 资源卡**：单列纵向排布，环境（4 字段）、分配（3 meter+extras）、资源（4 行）、带宽流量依内容自然撑开，卡片间维持紧凑间距。
   - **History 控制器**：单排横滑，保留 0/1/4/7/30/90 全部选项，触控高度 ≥36px。

---

### 三、骨架同构与 5 图全量重绘

1. **Loading/Loaded 同构**：手机端 pending 与 loaded 遵循同一网格与容器分区；加载完成后彻底清除骨架占位类，杜绝残留干扰。不改动任何 fetch、定时器、状态与存储数据。
2. **5 图原生全量重绘**：主题切换时，直接触发 Network、Ping、Cpu、Memory、ProcessCount 全部 5 图基于原生主题 Token 实际重绘（含网格、刻度、11px 轴字、12px `#475569` 空态），不依赖新样本到达，保持 1h raw 轴与整数刻度。

---

### 四、最终两个 Slice 边界

- **Slice 1（日间与字阶）**：`overview-lcars.css` 辅助文本升至 12px，字色 `#334155`，高亮 `#0b6b82`；保持 10 摘要卡、栅格、padding/gaps。5 图 Canvas 完成全量主题 Token 绑定与实时重绘。
- **Slice 2（手机分组与前置）**：修剪/原地替换旧 mobile 冲突，引入零 !important 移动层；实现 ≤768px 历史栏前置、768px 2 列与小屏单列自然高度；完整保持货币、语言、计算器、PING 下拉、Dock 及全部业务元数据。
