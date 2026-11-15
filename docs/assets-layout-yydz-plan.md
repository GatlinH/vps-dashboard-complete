# 资产总览最终布局合同

## 来源与范围

设计负责人为 agy，真实来源位于本任务证据目录
`/root/.hermes/plans/vps-assets-layout-yydz-20261114/`：

- `agy-design-02/design.md`：10 卡顺序、真 v2 材质、原生模块与交互保留。
- `agy-design-04/design-addendum.md`：紧凑布局、真实字段、PING 与 wrapper 契约。
- `agy-design-04/parent-design-disposition.json`：按实际算式采用 436px；自然卡高与原始标志口径纠偏。
- `agy-billing-source-05/design-addendum.md`：替代前文价格 0 的计费假设。

仅升级本地 `/?overview=1` 资产页，不改授权端点、首页、详情页或其他业务逻辑。
不新增搜索、主控置顶开关、平面地图、假 PING 数据或独立 i18n 框架。
既有太阳系、Cesium 地球与 Dock 地球入口保留。

## 布局与断点

原生根为 `.public-overview-page.overview-layout-v2`，顺序固定为：紧凑 topbar →
分组 tabs → 10 卡 summary → 状态/排序 → 节点网格 → 原有 4 个 Dock。
按用户本次“删除节点网络详情表”要求，移除网络表 renderer、插值、折叠绑定及其独占私有 helper；
不新增替代 UI、占位节点、CSS 高度或人工留白，节点网格自然连接原 Dock。
节点卡内网速、周期流量（含真实 0）、区域 PING、10 卡 summary、分组状态排序、计算器及语言/币种/主题保持。
不保留旧 hero、aside 或重复分区标题；汇总卡不复用 `.public-overview-card`。
节点与汇总均沿用既有亮暗 v2 材质、20px 圆角及模糊，不更改真实节点材质声明。

| 视口宽度 | Summary | 节点 | 根内边距 |
| --- | --- | --- | --- |
| ≥1280px | 前八卡四列，费用/到期各跨两列，形成 4+4+2 | 四列，间距 16px | `12px 24px 0` |
| 768–1279px | 两列，费用/到期各占整行 | 两列 | `12px 24px 0` |
| <768px | 前八卡两列，后两卡各占整行，间距 12px | 单列 | `12px 12px 0` |

Topbar 自身的 flex 换行仍采用 `<1024px`，不随 summary 断点迁移。
旧根 padding 规则不得匹配新根；详情及其他旧页面的原声明保持。

1440×900 默认态采用既定尺寸：topbar 42px、分组 32px、summary 272px、
状态/排序 38px。节点网格顶部按
`12 + 42 + 12 + 32 + 12 + 272 + 16 + 38 + 0 = 436px` 计算，末端不另加间距。
自然卡不固定高度、不裁切；首卡可见高度要求为 `>= min(400px, 自然高度)`。
完整可见诊断不构成超高自然卡的额外门禁；展开内容允许自然推动后续布局。
手机保留既有 Dock 安全区，不重复新增 76px 留白；末尾距 Dock 至少 16px。

## 默认态、字段与计费

10 卡顺序为节点、架构/系统、CPU 核心、最高负载、内存、存储、网速、
本月周期流量、月度费用、到期。默认明细折叠，但关键 caption 必须可见：
在线数、平台、均载与覆盖、峰值节点名、已用/占比、上下行、流量限额、计费覆盖及年化值。
展开态显示明细与运营视图，异常提醒仅保留一份，不复制面板。

容量使用 `cpu`、`ram`、`disk` 与对应 `__rawPresentFlags`；仅标志为 false 的
默认 1/1/20 排除，同数值的真实上报保留。实时 `cpu_use`、`ram_use`、`disk_use`
须在线且对应 `__liveMetricFlags` 为 true；百分比按同一有效节点集合计算，覆盖独立统计。
`net_up`/`net_down` 真实单位为 KB/s，须在线且 raw 标志有效，不发明 liveFlag 或 Mbps 字段。
真实 0 保留，缺测不填 0；缺架构/系统显示未上报。

流量字段逐字保留 `traffic_used_gb`、`traffic_up_gb`、`traffic_down_gb`、
`traffic_limit_gb`：已用优先 direct，缺失时仅双方有效才求和；限额 0 为未设置，
缺失为未上报，只有正限额且同实例已用有效才算比例，不推定无限流量。

价格沿用规范化 `server.price`，且要求 `server.__rawPresentFlags.price === true`。
`__rawPresentFlags.price` 仅为 boolean 存在标志，不是数值回退来源。
周期路径为 `server.period || server.agent_config?.billing?.period || server.agent_config?.billing?.period_months`。
系统保留值：`price === 0` 隐藏为“—”，不计费用或已知覆盖；合法负免费值
`[-1, 0)` 确认月费/年化为 0，不依赖周期，计入已知覆盖，不调用月化函数处理负价。
正价仅在已知合法周期下调用既有 `getMonthlyPrice(server)`，参数为单个 server 对象；
缺失、非有限、低于 -1 或正价周期无效均不入账。
币种转换沿用原生工具；到期沿用 `expiry`，缺失不视为永久。

## 原生交互与验收责任

默认排序沿用 `compareOverviewNodes`；六种排序为默认、CPU、内存、网速、到期、本月用量。
分组/状态/排序保持既有存储、真实指标缺测保护及主控徽标，不新增功能。
`overviewPage` 的重绘请求交给 `serverTable` 原生 wrapper 回调，wrapper 继续绑定
topbar 与 `mountMobileBottomNav('overview')`；主题、语言、币种、刷新和页脚保持可用。
PING 继续使用真实 `renderOverviewPing` 及 controller，保留地区与 1h/6h/24h、
pending/empty/error/disabled；无样本不伪造点、线或成功状态。

Codex 写代码，Hermes 独立验收；Claude 复核永久取消，不设替代代码审查门禁。
本轮仅运行 focused 回归及必要格式/差异检查。最终全量、build、浏览器、截图、
390×844 无横溢出、Dock/命中及 0/1/4/30 节点验收由 Hermes 执行，本文件不声称最终验收通过。
