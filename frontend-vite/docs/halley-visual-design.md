# agy：哈雷35AU远景与彗核缩减方案最终设计裁决

本裁决为交付 Codex 实现的前端设计基准。前序数学门禁反例成立，Opus 超时作废，不再引入新宽景评分体系。严禁破坏原星历、UTC1x/倍率、FP/worker、导航及 865 项科学资产（21,065,706 字节）。未经实测不宣称视觉与耗时达标，交付物范围锁定为 [`DustTailRenderer`](file:///root/.hermes/cache/scratch/solar-now-no-halo-20261026/src/renderers/DustTailRenderer.ts)、[`SolarSystem`](file:///root/.hermes/cache/scratch/solar-now-no-halo-20261026/src/core/SolarSystem.ts) 中彗核与必要的 render 前装配逻辑，以及对应测试。

---

### 一、 三项有限方案裁决

1. **32×32 程序化径向 Alpha 纹理：【批准】**
   - 构造 32×32 `THREE.DataTexture`（RGBA、线性过滤 `LinearFilter`），全白 RGB 搭配紧支集径向函数 $\alpha(r) = \cos^2(\pi r / 2)$（$r < 1$ 时递减，$r \ge 1$ 严格为 0）。
   - 废除固定 kappa 与 RGB 255 像素计数门禁。纹理挂载于全局或单例材质，其生命周期严格跟随组件销毁并在 `dispose()` 中完整释放显存。

2. **局部重叠归一化与顶点 Alpha（$1/M_i$）：【修订批准】**
   - 保持基础材质 `opacity = 0.55`，采用 `itemSize = 4` 的 RGBA 顶点色属性。
   - **替代与简化设计**：为规避复杂 3D 网格每帧重算与 GC 压力，采用**预分配紧凑屏幕空间网格（Screen-Space Binning）**：
     在实际 render 调用前，利用复用的 `Vector3` 缓存将各尾点投至相机视口屏幕坐标，网格桶尺寸取当前点片最大像素直径。
     统计点 $i$ 所在格及 3×3 邻域粒子总数作为保守重叠数 $M_i$（$M_i \ge 1$），则该点顶点色 alpha 赋值为 $1/M_i$。
     - **数学保障**：对任意像素贡献集 $A$，由于网格覆盖点片足迹，必有 $M_i \ge |A|$，满足 $\sum_{i \in A} (0.55 / M_i) \le 0.55$；
     - **极值表现**：35AU 远景下全量粒子退化投射于极小像元簇，$M_i \to N_{\text{tail}}$，总亮度被严格钳制在 0.55；近景粒子发散时 $M_i = 1$，完整保留原有单点半透明度。不修改原始 position 与 FP 底层。

3. **彗核几何与彗发形态：【批准】**
   - 彗核最长半轴维持 0.35，次轴与短轴收缩为 $0.35 / 1.9 \approx 0.184$。利用确定性三角基底或固定种子噪声对顶点进行微扰，生成轻微拉长且非对称的不规则网格；材质仅作深灰哑光视觉示意。
   - 彗发严格维持居中圆形及原始 1..4.8 缩放比例，包络直径恒大于彗核长轴 0.7，主诉求交由点片材质修复，杜绝人为拉扯成伪方向尾。

---

### 二、 Codex TDD 门禁规范与独立突变前缀

测试必须覆盖以下行为，断言失败时必须抛出对应大写错误前缀：

1. **纹理几何与紧支集测试**
   - 生成纹理必须满足中心 $\alpha > 0$ 且四角 $(u, v) \in \{(0,0), (1,0), (0,1), (1,1)\}$ 像素 $\alpha \equiv 0$。
   - 材质丢失 map 报 `MASK_MISSING`；纹理角部泄漏非零透明度报 `SQUARE_SUPPORT`。
2. **密度归一化函数测试**
   - 804 个点同心重叠极端用例，合成总 alpha 必须 $\le 0.55 + \epsilon$；孤立单点 alpha 严格等于 0.55。
   - 移除归一化导致超标报 `DENSE_UNBOUNDED`；粗暴采用全局常数除以 804 导致孤立点变暗报 `SPARSE_ATTENUATED`。
3. **真实 WebGL 探针与信号测试**
   - 生产材质点片渲染至 32GPUpx，外角差分必须呈现圆形衰减。
   - 真实帧冻结下，尾部层开关对比 `readPixels` 必须存在非零贡献。粒子 alpha 全零或 `visible = false` 导致有效信号消失报 `LAYER_SIGNAL_MISSING`。
4. **彗核形变与生命周期测试**
   - 彗核局部包围盒主短轴比需在 1.9 标称范围（$\pm 0.15$），且最长半轴 $\le 0.35$；若退化为对称球体报 `NUCLEUS_SPHERE`。
   - 顶点属性更新需递增 [`BufferAttribute.version`](file:///root/.hermes/cache/scratch/solar-now-no-halo-20261026/)。组件重复创建/卸载必须回到显存基线，未清理几何体或贴图报 `RESOURCE_LEAK`。

---

### 三、 验收裁决说明

坐标换算严格绑定实际 canvas buffer 与设备像素，宽景外观由 Hermes 独立抓取真实 PNG 进行人工与差分比对判定，测试套件内不设虚假 500/220 像素经验阈值。Codex 应立即按上述规约开展 TDD 编写。
