# Sun realism and atomic startup: source-bound design record

Baseline source: `7f3570bb16dc4d32cc0475e6449cd492ee4d6844`.

Precedence: Codex remaining-clause supplement overrides correction2, which overrides conflicting design1 clauses. These are authored design records, not proof of runtime acceptance. Codex design closure and implementation are not independent; Hermes must exercise real tests and falsification controls. Claude review is task-scoped WAIVED, not APPROVED. Current-turn endpoint is local implementation/acceptance only; this record does not authorize deployment.


## Retained agy main design

Source SHA256: `d2e4573c122ee921fbb6a66e097b241834fb36376237ec1c6e0021d63917df30`

## 1. 太阳拟真渲染决策与参数体系

### 1.1 路线采纳与架构决策
- **核心路线**：在保留现有 `SphereGeometry(radius 3.4)` 物理几何前提下，采用自研轻量级单通道程序化着色器 (`ShaderMaterial`) 替换现行纯色 `MeshBasicMaterial(0xffcf40)`；将外层遮盖日面的过大 Sprite 眩光（原 scale 28）收敛为受控的内在日冕光晕层（scale 9.0），在 17.67 GPU 像素半径尺度下建立清晰的光球表面结构与对比度。
- **噪声算法**：采用合规开源的无纹理 3D Simplex 噪声（Ashima MIT 保留署名），禁止外挂重型位图纹理或实时数据流。
- **驳回方案**：
  - 驳回多通道体积光线步进 (Raymarching) 与 MHD 等离子体磁流体数值模拟（GPU 开销过大，破坏单 rAF 与轻量底线）。
  - 驳回全屏后处理 Bloom 与全局 ToneMapping 调整（违反渲染器全局参数冻结边界）。
  - 驳回外部实时太阳卫星观测拉流（避免引入不可控网络依赖与跨域脆弱性）。

### 1.2 关键参数表
| 参数名称 | 设定值与单位 | 属性分类 | 设计意图与驳回变异 |
| :--- | :--- | :--- | :--- |
| **几何半径** | `3.4` (无量纲场景单位) | 物理冻结 | 严格保持射线拾取与天体比例一致，拒绝几何缩放变异 |
| **细分分段 (Desktop)** | `40 x 28` | 渲染开销 | 维持原顶点规模，计算完全在 Fragment 阶段完成 |
| **细分分段 (Mobile)** | `20 x 14` | 性能分级 | 移动端降低顶点与采样负担，防止丢帧 |
| **光球底色与色温** | 核心 `0xffe49a`，外缘 `0xff7a18` | 视觉启发式 | 模拟可见光色球渐变，拒绝单色塑料质感 |
| **临边昏暗系数 $u$** | `0.60` (标准 Eddington 近似) | 物理来源 | 遵循可见光光球层光学厚度物理衰减，拒绝均匀球体 |
| **对流米粒空间频率** | `22.0 rad⁻¹` | 视觉启发式 | 匹配桌面 17.67 像素核径，呈现微细斑驳而不是大块斑块 |
| **太阳黑子带纬度** | `[-35°, +35°]`，阈值截断 | 视觉启发式 | 仅作太阳活动带示意性呈现，声明非实时测绘数据 |
| **内日冕 Sprite 尺度**| `scale 9.0` (原为 28) | 视觉边界 | 约束发光层在半径约 2.6 倍母球内快速衰减，防止眩光吞噬日面细节 |
| **视觉自转角速度** | 等效 `25.4天/周` (依流速联动) | 物理启发式 | 动态展示表面等离子体漂移，与轨道历元时钟解耦仅作视效呈现 |

### 1.3 开销与 LOD 策略
- **Desktop (LOD 0)**：2 阶八度 Simplex 噪声 + 临边昏暗 + 动态时间漂移。Fragment 着色器指令 < 45 条，每帧 GPU 开销控制在 0.15ms 以内。
- **Mobile (LOD 1)**：通过 DPR/UserAgent 判定；降为 1 阶基底噪声 + 静态黑子掩模 + 临边昏暗，关闭高频微粒计算。若移动端像素比极高，直接采样预生成程序化紧凑查找表。

---

## 2. 统一启动与生命周期契约

### 2.1 状态机设计
将原先“首帧裸渲染、背景迟到、纹理逐个热插拔、目标 4 秒后跳出”的混乱割裂状态，重构为显式原子发布的生命周期协调器：
```
[UNINITIALIZED]
       │
       ▼ (开始载入: 启动协调器启动)
  [PREPARING] ──(任一非致命失败 / 超时 5000ms)──► [FALLBACK_READY]
       │                                                 │
       ▼ (背景 + 纹理 + 太阳着色器 + 首历元全齐备)                │
[ATOMIC_READY] ◄────────────────────────────────────────┘
       │
       ▼ (首次执行 renderScene() 且揭开画布)
   [PUBLISHED] ──► [RUNNING] ──► [DISPOSED]
```

### 2.2 首次可见发布门控条件 (All-or-Fallback Gate)
首帧向屏幕揭开（显示 Canvas 或取消 Loading 遮罩）必须**严格同时满足**以下 4 项判定：
1. **太阳材质就绪**：`SunMaterial` 完成编译并生成首帧有效 Uniform。
2. **背景状态就绪**：天球底图加载完成，或捕获错误触发纯色深度备用背景。
3. **主星纹理就绪**：Manifest 及其 Tier-0 关键贴图已全部赋给对应网格，或已超时确定回退到程序化备用材质。
4. **历元对齐与时间刷新**：**必须在门控放行瞬间强制以当前的 `RealTimeClock` 重新采样**，计算 10 个目标的初始精确位置，严禁复用构造函数启动时缓存的陈旧时间戳。

### 2.3 降级与超时语义 (Fallback)
- **绝对超时窗口**：启动协调器设置硬上限超时（桌面 4000ms，弱网/测试注入可配置）。
- **降级原子发布**：任何网络失败或达到超时上限，尚未完成的贴图/背景立即转为降级保底资源，标记 `state = DEGRADED_PUBLISHED`，一次性发布完整画面。**发布后严禁进行未受控的静默热替换**，杜绝材质突兀跳变。

### 2.4 资源归属与销毁安全 (Disposal)
- 引入单调递增的 `lifecycleEpoch` 或 `mountId`，配合 `AbortController` 绑定所有的异步 Fetch 与纹理 Loader。
- 若在 `PREPARING` 期间触发 `dispose()`，立即中断未决网络请求，注销 rAF，清除所有待执行回调；后置回调若发现 `currentId !== boundId` 立即静默销毁已解压显存，防止跨生命周期泄漏与幽灵渲染。

---

## 3. 拟写入范围与冻结边界

### 3.1 精确改动范围
1. `SolarSystem.js`：
   - 改造 `_buildSun`：移除纯色基础材质与过大 Glow，挂载新 Procedural Shader 与约束日冕。
   - 改造 `_buildScene` 与纹理/历元加载：剥离即开即染的散弹式执行流，实现 `_createStartupCoordinator`，统筹背景、太阳、纹理及首个实时历元。
   - 改造渲染主循环入口：在满足发布门控前保持遮罩或暂停物理首帧，在满足门控时刻重新采样 `RealTimeClock`。
   - 完善 `dispose`：添加对着色器 Uniform、自定义材质及异步加载令牌的完整释放。
2. `SunShader.js`（新增独立内联着色器模块，不引入新 npm）：
   - 封装光球对流、临边昏暗与示意黑子 Shader 代码，保留 Ashima MIT 许可注释。

### 3.2 严密冻结边界
- `DustTailRenderer.js` 与 `_buildHalleyComet` 保持字节完全一致。
- 865 项科学轨道数据、Manifest 文件、历元数学算法与坐标映射体系完全一致。
- 太阳物理射线拾取（Hit Testing）区域严格保持半径 3.4 球体，不生成幽灵可拾取层。
- 渲染器全局参数、色调映射（ToneMapping）、曝光、环境光强及相机比例完全一致。

---

## 4. TDD 与 Native 验收契约

### 4.1 核心测试用例与断言信号
1. **太阳特征信号断言 (WebGl Readback)**：
   - **临边昏暗比率**：在视口正交投影视角下，采样日面中心像素亮度 $L_{center}$ 与 $0.85R$ 处亮度 $L_{limb}$，断言 $L_{limb} / L_{center} \in [0.45, 0.70]$。
   - **表面对流方差**：采集日面有效像元亮度标准差 $\sigma$，断言 $\sigma > 0.04$。
   - **外围溢光抑制**：在距离中心 $> 2.8R$ 处采样，断言背景光晕亮度 $< 0.15$。
   - **隐藏对照组**：设置 `sun.visible = false` 时，日面 ROI 区域完全回归背景色。
2. **原子发布与首帧断言**：
   - 监听首个 `PUBLISHED` 帧，断言：场景背景非初始黑屏（`scene.background !== null`）；10 个天体可见且全量具备物理坐标（`validTargets === 10`）；不存在中间未上色单球渲染状态。
3. **新鲜历元对齐断言**：
   - 断言首帧发布时的 Julian Date / UTC 历元与触发瞬间系统时钟偏差 $\Delta t < 50\text{ms}$，证明未沿用构造函数时的初始挂载时间。
4. **网络降级与销毁断言**：
   - **慢速/故障测试**：注入 404 或超时，验证在 4000ms 内触发 `DEGRADED_PUBLISHED`，一次性呈现降级场景，后续无静默纹理刷新。
   - **竞态销毁测试**：在启动后 150ms 立即调用 `destroy()`，断言未产生任何异步 Uncaught 异常，GPU 内存几何体与材质计数回落归零。

### 4.2 失败前缀与变异体对照 (Mutant Pairing)
- `[ERR_SUN_FEATURE_FLAT]`：若回退为 BasicMaterial 纯黄球，光球面像素标准差断言失败 ($\sigma = 0$)。
- `[ERR_SUN_GLOW_OVERFLOW]`：若复用原 scale 28 眩光导致日面被纯黄吞没，外围溢光抑制与临边反差测试断言失败。
- `[ERR_STARTUP_STAGGERED]`：若恢复散装异步渲染，首帧捕获到的有效星体数为 0 或背景未绑定，原子门控断言失败。
- `[ERR_EPOCH_STALE]`：若在发布首帧未重新抓取当前时间，时钟对齐偏差 $> 50\text{ms}$ 断言失败。
- `[ERR_DISPOSAL_LEAK]`：若销毁未阻断图片回调，销毁后触发未受控上下文调用报错。


## Retained agy corrected contract

Source SHA256: `ac1e65d179cd0b5f35dace6da3ee810dc4b37fe32100384e31111a118daaa781`

# 太阳拟真与统一生命周期修正规范契约 (Canonical Contract)

## 1. 核心决策与精确数学公式 (Decisions & Exact Formulas First)

### 1.1 临边昏暗与辐射测量标定
- **模型定标**：Eddington 灰体近似明确定义为一维辐射传输理论参考模型（非实时测绘物性）。
- **理论剖面**：在线性空间正交探针（去除 Glow/ToneMapping）下，归一化物理辐亮度满足：
  $$I(\mu)/I(1) = 1 - u + u\mu \quad (u = 0.60,\ \mu = \sqrt{1 - (r/R)^2})$$
- **解析基准点**：当 $r = 0.85R$ 时，$\mu = \sqrt{1 - 0.85^2} = \sqrt{0.2775} \approx 0.526783$；
  理论比值：$I(0.85R)/I(0) = 1 - 0.60 + 0.60 \times 0.526783 = 0.716070$。
- **一致性检验包络**：在线性正交探针中采样断言 $L(0.85R) / L(0) \in [0.666, 0.766]$（理论解析值 $\pm 0.05$ 物理容差，包容米粒微扰，彻底废除原矛盾区间 $[0.45, 0.70]$）。

### 1.2 米粒组织鉴别断言与配对差分
- **方差失效解耦**：纯昏暗球体全盘自然方差 $\sigma \approx 0.1414$，导致原全盘 $\sigma > 0.04$ 无法隔离米粒。
- **鉴别公式**：在日面中心核区（$r \le 0.3R$，此时 $\mu \ge 0.954$，昏暗方差贡献 $< 0.002$），对比生产着色器与关闭噪声的同昏暗平滑变异体（$I_{mut\_flat}$），断言差分标准差：
  $$\Delta\sigma_{granule} = \mathrm{StdDev}(I_{prod} - I_{mut\_flat}) \ge 0.035$$

### 1.3 内日冕几何尺度与空间坐标映射
- **几何尺度修正**：Sprite 设定全宽 $W = 9.0$ 场景单位，对应发光外径 $R_{glow} = 4.5$；太阳几何半径 $R_{sun} = 3.4$；实际发光支撑比为 $R_{glow}/R_{sun} = 4.5 / 3.4 \approx 1.3235 R_{sun}$（更正原 $2.6R$ 错误）。
- **无缝坐标输入**：着色器输入为归一化对象空间三维单位球面坐标 $\mathbf{p} = \mathbf{x} / \|\mathbf{x}\| \in \mathbb{S}^2$。空间角频率 $f = 22.0\text{ rad}^{-1}$ 直接调制 $\mathbf{p}$，消除 UV 展开极点接缝与自转滑动畸变。

### 1.4 外围光晕隔离观测公式
- **差分观测法**：受控正交组件探针采集同机位日面开关差分：$\Delta L(r) = L_{sun\_on}(r) - L_{sun\_off}(r)$；在 $r > 2.8R_{sun}$ 处断言 $\Delta L < 0.03$，剥离 HEIC 原生星空底图的高本底亮度干扰。

---

## 2. 状态机与原子生命周期规范

### 2.1 视觉资产截止与科学历元就绪态解耦
- **统一视觉硬超时**：统一设为 4000ms（彻底废除 5000ms 歧义）。
- **星历零伪造原则**：视觉超时仅允许将未就绪贴图/背景转为降级视觉资源；**严禁对 10 颗天体的科学历元进行伪造、历史插值或占位发布**。科学数据未就绪时（实际首个全合法历元差 $\approx 4097.6\text{ms}$，延迟数据可达 $\sim 20\text{s}$），必须显式停留在 `LOADING` 或进入 `DATA_ERROR/RETRY` 态。
- **首帧原子发布门控 (`ATOMIC_PUBLISHED`)**：必须严格且同时满足：
  1. 10 颗天体全量捕获合法实时历元计算采样（`validTargets === 10`）；
  2. 太阳着色器首帧 Uniform 编译就绪；
  3. 背景所有权确证（`bgOwner === activeMountId && bgState === 'READY'`，废除单纯 `scene.background !== null` 非空检查）。

### 2.2 首帧时间新鲜度三元绑定
- 同一次 `renderScene` 调用流水线内，强绑定入口墙钟 $t_{call}$、`RealTimeClock.now()` 采样值 $t_{sample}$ 与 10 天体星历计算历元 $t_{ephem}$：断言 $|t_{sample} - t_{call}| \le 16.7\text{ms}$ 且 $t_{ephem} \equiv t_{sample}$，保留现有实时浏览器网关。

### 2.3 异步代际与销毁安全
- 引入单调递增 `mountGeneration`。网络 Fetch 绑定 `AbortController`；对无法被 Abort 的 `ImageLoader/TextureLoader`，在加载回调中强校验 `loadGen === currentMountId`。若代际不符，立即执行 `texture.dispose()` 并丢弃，严禁调用已销毁场景。

### 2.4 显存真实指标断言
- 针对 `renderer.info.memory` 实存指标，仅断言几何体与纹理归零：`info.memory.geometries === 0 && info.memory.textures === 0`。
- 材质销毁追踪：通过全局 Material 注册表注入 `dispose` 事件监听探针，断言 `disposedMaterials === allocatedMaterials`。

### 2.5 预算与环境判定
- 2 阶 Simplex 噪声 Fragment 指令 < 45 与每帧耗时 < 0.15ms 明确定义为“待基准实测的设计预算目标”，非既得保底。
- 端侧分级严格复用现有 `this.isMobile` 及视口尺寸判定，禁止单凭 UserAgent 判定移动端；移动端光栅化定量指标需经实测后冻结。

---

## 3. 验收断言信号与配对变异体矩阵 (Assertions & Paired Mutants)

| 失败前缀 | 检验断言与判定阈值 | 配对变异体设计 (Mutant) |
| :--- | :--- | :--- |
| `[ERR_SUN_LIMB_RATIO]` | 正交线性探针 $L(0.85R)/L(0) \in [0.666, 0.766]$ | 纯色无昏暗变异体 ($L_{ratio} = 1.0$) 或原错误区间变异体 |
| `[ERR_SUN_GRANULE_FLAT]` | 核区差分 $\mathrm{StdDev}(I_{prod} - I_{mut\_flat})_{r \le 0.3R} \ge 0.035$ | 禁用 Simplex 噪声但保留 $u=0.6$ 昏暗变异体 ($\Delta\sigma \equiv 0$) |
| `[ERR_SUN_GLOW_OVERFLOW]`| $r > 2.8R$ 差分 $\Delta L_{sun\_on - off} < 0.03$ 且全宽 $W = 9.0$ | 恢复 scale 28 眩光变异体 ($\Delta L > 0.15$) |
| `[ERR_STARTUP_STALE_EPHEM]`| 首帧时钟差 $\|t_{sample} - t_{call}\| \le 16.7\text{ms}$ 且 $t_{ephem} \equiv t_{sample}$ | 沿用构造函数缓存时间戳变异体 ($\Delta t > 100\text{ms}$) |
| `[ERR_STARTUP_FAKED_DATA]`| 视觉超时 (4000ms) 时数据未就绪保持 LOADING/RETRY，拒绝假数据发布 | 超时后使用伪造/历史历元强行揭开画布变异体 |
| `[ERR_BG_OWNERSHIP_UNSET]`| 显式所有权 `bgOwner === activeMountId && bgState === 'READY'` | 继承初始固态底色 `0x05060d` 即判定就绪变异体 |
| `[ERR_DISPOSAL_GPU_LEAK]` | `info.memory.geometries === 0 && textures === 0 && disposedMats === totalMats` | 销毁时遗漏 ShaderMaterial 或未消耗贴图变异体 |
| `[ERR_ASYNC_RACE_ORPHAN]` | 快速销毁后延迟回调未抛出未捕获异常且无显存残留 | 卸载后未按代际丢弃并释放迟到贴图变异体 |


## Codex authored remaining3 supplement

Source SHA256: `c49748860cf7868a7d8bf2a5eac570f101c311aea81382072628214c7efbc9ee`

# Sun/loading 剩余三条 Canonical 补充

本补充由后续实施者 Codex 制定，**不是独立设计批准**；Hermes 独立验收，Claude 仅本任务 WAIVED。保留 agy design1，以 correction2 覆盖其冲突；第三次 FILTER_BLOCK 不构成设计。

## 核对与纠错
- 两个工作树均干净，HEAD 均为 `7f3570bb16dc4d32cc0475e6449cd492ee4d6844`；`../frozen-solar-methods.json:1` 的七个 AST 方法哈希全部匹配。
- `../startup-diagnosis/results.json:7` 确认首次记录已有 Sun，但背景未到、有效/可见目标均零、无发布贴图；后续差值分别为 **2682.5、3380.8、4097.6ms**。半径为 **17.66637569 GPU 像素**。这是所记录帧的时间差；慢响应臂约20秒受同步测试回调串行化影响，不是网络基准。
- correction2 的核区“临边方差贡献 `<.002`”错误：均匀面积采样下，`r≤.3R` 的线性临边标准差约 **.007977**；配对差分仍有效，不修改 `.035` 门槛。`.85R` 比率 **.7160696126**、全盘标准差 **.141421**、光晕支撑比 **1.323529** 均复算成立。
- 源码使用 `RealTimeClock.sample()` 和 `_tick → renderer.render`，没有所述 `now()/renderScene`：`frontend-vite/src/components/solar/RealTimeClock.js:41`、`frontend-vite/src/components/SolarSystem.js:760`。按实际调用闭合，冻结 `_advanceBodies`。
- 调度边界：STATE 遗留 commit/192 endpoint 不授权本轮操作。`../sources-ledger.json:40` 只有上游 URL，没有正文/版本；本轮不能认证上游许可版本或 GPU 预算已达标。

## 1. FIRST_VISIBLE：终态与所有权

协调器开始时，以单调时钟固定 `deadline=start+4000ms`；保持画布不可见，但维持原单 rAF，允许真实科学加载继续。

任务集合不能靠“manifest 中成功解析的项目”决定。源码实际包含 **11 个相关槽位**：八行星、Moon 的 map，Earth clouds 的 alphaMap、Saturn ring 的 map。manifest 缺失/非法项目必须明确回退，不能 `continue` 后漏过门控。

每个槽位只能由 PENDING 单向进入：
- `SUCCESS`：资源已验证、归属本代、绑定最终槽位；
- `COMMITTED_FALLBACK`：明确保留现有程序化资源，记录所有者与原因。

截止后未决项目全部提交回退；每个回调也检查截止时间，防止定时器延迟造成超期成功。manifest 迟到不得新增任务或改变选择。迟到资源不绑定，释放其独占资源。

背景统一使用 `state=READY`，另有 `kind=TEXTURE|FALLBACK`、`owner=activeMountId`、资源引用和原因。即使采用原固态底色，也必须显式提交 FALLBACK；初始非空背景不算就绪。

FIRST_VISIBLE 同时要求：本代未销毁、11 槽全部终态、背景所有权成立、生产 Sun 编译/Uniform 就绪，以及**当前消费样本的十目标全部合法并已应用**。先完成实际渲染，返回无错误后才揭开画布。4000ms 只冻结视觉选择；科学未就绪继续 LOADING，错误进入 DATA_ERROR/RETRY，不发布历史、零值或伪造位置。发布后禁止迟到热替换。

## 2. 同生产材质的线性探针与时钟绑定

探针使用当前 `sun`、原几何、**同一个生产 ShaderMaterial 和 limb 函数**；禁止另写测试着色器。生产 Sun 自身 `toneMapped=false`，正常输出仍作颜色空间编码，不改全局 renderer。

使用同 renderer 的临时正交场景与 **1024² RGBA8、LinearSRGB、无 MSAA** RenderTarget；视域边界为 `±4R`，太阳半径128像素。通过 `readRenderTargetPixels` 读取并检查 GL 错误，RGB 除255，亮度采用线性 Rec.709 权重；禁止二次 gamma 解码或逐图最大值归一化。

临边探针临时关闭色阶、噪声、黑子及 glow，底色为线性白 `.8`，保留生产 `u=.6`。中心 ROI `r≤.02R`，边缘环 `.845R≤r≤.855R`；比率必须在 `[.666,.766]`。

米粒探针恢复生产色阶/噪声/黑子，仅双方关闭 glow；固定同机位、姿态与相位，第二张**只把噪声幅度置零**。以固定参考亮度 `.8` 归一化，核区 `StdDev(Lprod−LnoiseOff)≥.035`。不得复用隐藏图自身作特征信号。

原 home 默认输出还必须拍实际配对图：噪声关闭、临边关闭、flat、Sun 隐藏及 glow28。要求对应效果确实改变原视图，并由独立人员检查；外围采用匹配 Sun-on/off 的 `|ΔL|<.03`，不是 HEIC 原始亮度。移动端保留实际微小日面的可见性/差异检查，不套用桌面 `.035`，不宣称已有手机包络。

探针独占运行：暂停唯一 rAF，保存并在 `finally` 恢复 Uniform、可见性、父节点/顺序、变换、相机、RenderTarget、viewport/scissor/clear 状态；释放临时资源。不要用会重置相机的 `resume()` 破坏恢复；原运行态仅重新排一个 rAF。

首可见候选流水线入口记录原生墙钟；冻结 `_advanceBodies` 消费 `sample()` 后，**同一次实际 renderer 调用**捕获样本、十目标历元/位置与调用 ID。1x 要求采样距入口≤16.7ms，所有 `lastJd=sample.jdTdb`，应用 UTC 相等。途中不得 await；后来 RPC 时间不能补证。显式加速采用现有单调锚点契约。

## 3. 固定有界噪声与合成

以下为新增技术选择，不重调已采纳参数：

令 `p=normalize(localPosition)`；3D Simplex 每次输出先限于 `[-1,1]`：
- 桌面 `q=(2·snoise(22p)+snoise(44p))/3`；
- 移动端 `q=snoise(22p)`；
- 两端 `N=clamp(2q,−1,1)`，幅度固定 **A=.24**。

22 是无量纲坐标缩放，不宣称物理频率。固定空间采样、无 UV、无时间平移；仅网格示意自转，因此无接缝或表面滑动。

两底色先转线性；`B=mix(edge,core,smoothstep(0,.8,mu))`。黑子 `S∈[0,1]` 用对象空间两个固定球冠：纬度±15°、经度±60°，内外角半径 `.025/.055rad`，平滑并集，35°纬度外严格为零。最终：

`C=.8·B·(1+.24N)·(1−.55S)·(.4+.6mu)`，alpha=1。

顺序为底色→米粒→黑子→临边→输出编码。无黑子时倍率范围 `.608… .992`，不靠裁剪制造方差。关闭噪声只改变 `.24` 项，其他项不变。

在固定初始 home 朝向、无黑子的核区，线性 core 亮度 `.790799`；上述配对差分达到 `.035` 的充分噪声标准差约 `.20101`。这是可复核的条件，**不是未经测量的达标保证**。下一阶段必须实测生产 shader；失败不得筛选相位、加噪声或降低门槛，应报告失败及最小取舍。

Glow 全宽9，径向 alpha 在归一化半径≥1严格为零，峰值≤.18；保留 additive、depthTest，关闭 depthWrite。支撑为1.3235R，不把方形角点当径向支撑。无全局光照、曝光、相机或几何改造。表面、黑子、自转均非实时太阳观测；指令/耗时预算仍待测。

## 下一阶段与精确拟写路径

下一阶段先取得真实 RED，再修改源码并取得同案例 GREEN；运行445既有测试加新增测试、quality/build、源与 dist 科学 manifest 门禁、实时/native Halley 门禁及新增加载/销毁/变异门禁。既有科学模块、865资产、七冻结方法与现有门禁不改。

拟授权仅以下路径；新增文件行号从1开始：
- `frontend-vite/src/components/SolarSystem.js:34`
- `frontend-vite/src/components/solar/SunShader.js:1`
- `frontend-vite/test/unit/solarSunShader.test.js:1`
- `frontend-vite/test/unit/solarStartup.test.js:1`
- `frontend-vite/test/helpers/sunNativeProbe.js:1`
- `frontend-vite/scripts/verify-sun-startup.py:1`

本轮零写入，未运行构建、安装或验收测试；此输出仅为设计补充，不是测试通过声明。