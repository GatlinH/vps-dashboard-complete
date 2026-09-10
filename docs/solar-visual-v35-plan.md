# 太阳系 v3.5 视觉与布局增强设计方案（设计方案 · 不写实现）

---

## 概述与版本定位

本方案基于上一版 `docs/solar-visual-v3-plan.md`（已实现 D1 光照修复、D2 拖拽 2.8s 延时恢复、D3 去除文字标签保留 hover 高亮、D4 星舰视图生命周期隔离、D5 哈雷彗星、D6 土星环升级、D7 陨石带）进行增量演进。

### 核心升级目标
1. **多行星环系统**：补齐木星极暗主环；深度评估并规划天王星（$97.8^\circ$ 极度倾斜环）与海王星特征环，重构星环纹理生成器为通用参数化工厂；
2. **WebGL 真实感跃升**：在**单 rAF、单 Renderer、零外部依赖**绝对红线下，引入内存 Canvas 程序化地表纹理、轻量化双半球大气边缘辉光、多层加色太阳日冕星芒系统以及轨道景深渐隐；
3. **移动端纵版（9:16）视口自适应**：彻底解决竖屏模式下太阳系“上下出画、左右空旷”的痛点，确保竖屏 9:16 下全部行星轨道（含土星 41 + 环外沿 4.4）完整入画且交互热区无缝对齐。

---

## 一、补齐其它行星的星环系统

### 1.1 木星（Jupiter）暗弱主环设计
* **天文依据与视觉定位**：木星主环（Main Ring）主要由微米级深色硅酸盐尘埃粒子构成，反照率仅约 0.05，厚度不足 30 km，常态下极其幽暗透光，具有强烈的后向散射特性。
* **几何与尺度设计**：
  * 木星本体半径在代码中设定为 $R_J = 2.4$；
  * 主环内径设定为 $1.25 \times R_J = 3.00$；
  * 主环外径设定为 $1.72 \times R_J = 4.13$（宽度约 1.13 个世界单位，与木星体量形成舒展比例）；
  * 倾角：木星赤道面与公转轨道夹角极小（仅约 $3.13^\circ$），星环微倾 $X$ 轴旋转 $\pi/2 - 0.055\text{ rad}$，几乎与公转轨道平齐。
* **材质与光学表现**：
  * 材质类型：`MeshStandardMaterial`，配合 `transparent: true, depthWrite: false, side: THREE.DoubleSide`；
  * 必须设定 `depthWrite: false`：由于极度半透明（Alpha 介于 $0.06 \sim 0.14$），关闭深度写入可彻底避免旋转时对背景星空及后方轨道的深度遮挡裁切；
  * 粗糙度 `roughness: 0.95`，金属性 `metalness: 0.0`，漫反射颜色为暗褐灰泥调（`#5a5046`）。

### 1.2 天王星与海王星补全评估与轨道规划
* **评估矩阵**：

| 评估维度 | 补全方案（扩充为 8 大行星） | 保持方案（维持 6 大行星） | 权衡裁决与应对策略 |
| :--- | :--- | :--- | :--- |
| **视觉沉浸与完整度** | **极高**。太阳系全景完整，打破未完工感；天王星拥有全系独一无二的近垂直环。 | **中**。缺少外层冰巨星，外太阳系显得空洞。 | **倾向补全**：天文学拟真度获得决定性质感跃升。 |
| **轨道尺度与视口膨胀** | **高挑战**。海王星轨道若为 62，全景半径由 45.4 扩张至 65（扩大 43%），内行星视距被压缩。 | **低**。全景半径收敛在土星 45.4 内，相机不必过分后拉。 | **采用分级自适应**：桌面端扩充视距，移动端通过过滤裁剪策略防御。 |
| **移动端性能与空间** | **有压力**。小屏幕上多颗外行星会使水星、地球等关键操作目标挤压在中心微小区域。 | **优秀**。现有 6 行星已过滤出核心 3 星，负载极低。 | **移动端剔除**：在 `PLANET_TABLE` 中设定 Uranus/Neptune 为 `mobile: false`，移动端 0 额外渲染。 |
| **特征辨识度** | **极高**。天王星冰青色+垂直环，海王星深海蓝+弧状微环。 | **普通**。现有行星颜色偏暖偏黄，缺乏外层冷色调点缀。 | **采纳补全，设为桌面级可选展示**。 |

* **建议轨道半径与物理参数表**：

| 行星名称 | 建议轨道半径 ($r$) | 星体半径 | 公转速度 ($\text{rad/s}$) | 基础星体色 | 特征星环内/外径 | 星环倾角与特征 | 移动端策略 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Uranus（天王星）** | **52.0** | 1.55 | 0.068 | `#55b8c8`（冰青） | 内 2.10，外 2.95 | 倾角 $97.8^\circ$（几近垂直，倒卧公转）；锐利同心窄带；冷青灰 | `mobile: false`（剔除） |
| **Neptune（海王星）** | **62.0** | 1.48 | 0.048 | `#2e58c8`（深海蓝） | 内 2.05，外 2.80 | 倾角 $28.3^\circ$；极暗淡尘埃弧环；深蓝灰 | `mobile: false`（剔除） |

### 1.3 星环参数化纹理生成器重构（`_generateRingTexture`）
* **重构逻辑**：废弃原单一针对土星的写死逻辑 `_generateSaturnRingTexture()`，重构为通用的 `_generateRingTexture(type, config)`，原方法保留作为向下兼容包装。
* **径向 UV 映射标准化**：封装通用算法，遍历 `RingGeometry` 顶点缓冲区，将笛卡尔极径 $r = \sqrt{x^2 + y^2}$ 线性归一化至 $[0, 1]$ 映射到 U 坐标，V 轴锁定 0.5，彻底消除圆环拉伸畸变。
* **各行星星环参数配置规范**：
  * **Saturn**（土星）：Canvas 规格 $512 \times 1$，9 个断点。包含高密度米黄 B 环（Alpha 0.92）、卡西尼环缝（宽度 0.08，Alpha 0.03 深邃镂空）、A 环与恩克环缝。
  * **Jupiter**（木星）：Canvas 规格 $128 \times 1$，4 个断点。平滑高斯衰减，中间主环核心 Alpha 仅 0.12，边缘羽化至 0，灰褐色 `rgba(110, 95, 80, 0.12)`。
  * **Uranus**（天王星）：Canvas 规格 $256 \times 1$，6 个断点。模拟著名的密集细窄环群，背景高度透明（Alpha 0.02），在 $\epsilon$ 环处突变至高对比度 Alpha 0.72，冰青高光 `rgba(190, 230, 245, 0.75)`。
  * **Neptune**（海王星）：Canvas 规格 $128 \times 1$，4 个断点。暗淡弥散，Alpha 峰值 0.16，色调为幽暗冷蓝灰 `rgba(80, 110, 140, 0.16)`。

### 1.4 规范化输出

#### 改动函数
* `_generateRingTexture(type, options)`（新增通用参数化纹理工厂）
* `_generateSaturnRingTexture()`（重构为调用通用工厂，保持兼容）
* `_applyRadialRingUV(geometry, innerRadius, outerRadius)`（新增标准径向 UV 重映射工具函数）
* `_buildPlanets()`（遍历时按行星配置分别挂载星环，并扩展天王星、海王星）
* `PLANET_TABLE`（追加 Uranus、Neptune 元数据定义）

#### 核心参数
* 木星环：内径 3.0，外径 4.13，Canvas $128 \times 1$，最大 Alpha 0.12；
* 天王星：轨道 52.0，星体 1.55，环内径 2.10，环外径 2.95，倾角 $97.8^\circ$（`rotation.z = Math.PI * 0.54`）；
* 海王星：轨道 62.0，星体 1.48，环内径 2.05，环外径 2.80，倾角 $28.3^\circ$。

#### 性能开销
* 纹理尺寸极小（$128 \times 1 \sim 512 \times 1$），全部离屏 Canvas 内存合计 < 12KB；
* 静态几何体，每颗带环行星增加 1 个网格与 1 个材质，GPU Draw Calls 仅桌面端增加 1~3 个，移动端 0 增量。

#### 移动端差异与降级
* `isMobile === true` 时，`PLANET_TABLE.filter(p => p.mobile)` 严格生效；
* 天王星、海王星及其星环在移动端完全不创建、不计算、不渲染；木星在移动端不渲染环，保障中低端移动设备帧率无损。

#### 验收断言
* 门禁兼容断言：`verify-solar-system-home.mjs` 中 `assert.ok(planetTable.match(...).length >= 4)` 持续通过（8 星完全兼容 `>= 4`）；
* 视觉形态断言：木星周围存在半透明暗环（Alpha $\le 0.15$ 且背光面随点光源呈现暗影）；天王星呈现近乎垂直于公转轨道的青冷细环；
* 深度测试断言：在任意摄像机角度下，透过木星与天王星的星环半透明区域，后方公转经过的行星及背景星空无黑边截断（`depthWrite: false` 生效）。

---

## 二、Three 渲染真实感提升选项评估与设计

### 2.1 整体红线与选型评估准则
* **严禁引入 Post-processing（如 UnrealBloomPass / EffectComposer）**：后处理管线破坏单一 Renderer、增加额外 render pass、拖慢移动端 Fillrate 且破坏既有测试门禁；
* **零外部静态图像资产下载**：禁止引入 NASA 外部贴图，所有增强视觉均由浏览器原生 Canvas 2D 算法程序化实时合成（`CanvasTexture`）；
* **单 rAF 帧更新**：所有脉冲、呼吸动效必须依托 `_tick` 现存的 `dt` 计算。

### 2.2 四大真实感增强选项深度评估

#### 选项 A：行星程序化纹理（Procedural Textures 代替纯色）
* **实现要点**：
  * **地球**（Canvas $512 \times 256$）：利用多频正弦谐波叠加伪噪声算法，合成深蓝大洋（`#0a2850`）、浅海大陆架（`#185585`）、陆地地块（`#386b35`、`#7a6e45`）、白色半透明涡旋云系（Alpha 0.45）与两极白色冰盖；
  * **木星**（Canvas $512 \times 256$）：采用多段纬度水平色带生成交替的深褐与淡米黄云带（Belts & Zones），叠加 $x$ 轴低频余弦波扰动模拟湍流（$y' = y + 4 \sin(6x)$），并在南纬 $22^\circ$ 叠加椭圆梯度大红斑（Great Red Spot）；
  * **火星**（Canvas $256 \times 128$）：铁锈红底色（`#a84525`），叠加低频噪点生成的暗色玄武岩高地（大瑟提斯高原，`#4d2315`）与极冠干冰白色微区；
  * **金星**（Canvas $256 \times 128$）：温和的浓硫酸浅黄条纹（`#d8b870`），以 $V$ 形空气动力学流线羽化展开。
* **性能开销**：
  * CPU：仅在场景初始化时单次执行 Canvas 绘制（总耗时约 8~15ms），逐帧运行期间 CPU 开销为 **0ms**；
  * 显存：4 张低分辨率纹理常驻显存总计仅约 1.5MB。
* **建议取舍与降级**：
  * **强力推荐采纳**。质感跃升最为立竿见影；
  * 移动端降级：移动端仅为核心星体（Earth）生成 $256 \times 128$ 程序化纹理，火星/金星降级为纯色，节省初始化开销。

#### 选项 B：大气边缘辉光（Atmospheric Glow）
* **技术方案对比**：

| 方案 | 原理 | 优点 | 缺点 | 评估结论 |
| :--- | :--- | :--- | :--- | :--- |
| **方案 1：Billboard Sprite** | 在行星中心挂载面向相机的发光 Sprite | 极低消耗，实现简单 | 夜半球背光面也会发光，违背晨昏线光学常识 | 否决 |
| **方案 2：Custom Shader Fresnel** | 独立外壳球体，自定义 Shader 计算 $(1-N\cdot V)^p$ 且乘太阳方向 $N\cdot L$ | 光学极其真实，背光面自然收敛 | 需写内联 GLSL，增加着色器复杂度 | 桌面端首选 |
| **方案 3：BackSide 基础球壳** | 放大 1.04x 球体，材质设为 `BackSide + AdditiveBlending + Canvas 渐变` | 零 GLSL，基于标准原生 Material | 边缘软化度略显生硬 | 移动端降级首选 |

* **推荐落地方式**：采用轻量化 **双层同心球壳方案**（针对 Earth 与 Venus）：
  * 地球外层挂载略大球体（半径 $1.045 \times R_E$）；
  * 材质选用轻量 `ShaderMaterial`（或预制反向半球），顶点着色器提取视角夹角，片元着色器以幂函数输出天蓝（`#4fa8ff`）边缘轮廓光，背光面衰减为 0。
* **性能开销**：
  * 每个开启大气的行星增加 1 个 Draw Call，增加约 380 个顶点，Fragment Shader 开销极低（< 0.04ms）。
* **建议取舍与降级**：
  * **建议采纳**；
  * 移动端降级：移动端仅开启 Earth 大气壳，关闭金星大气；低性能模式下直接隐藏。

#### 选项 C：太阳多层日冕光晕（Corona Glow without Bloom）
* **技术突破点（规避 Bloom）**：
  * 采用 **3 层正交 Billboard Sprite 级联叠加**，材质设置 `blending: THREE.AdditiveBlending, depthWrite: false`，中心与太阳坐标严格对齐：
    1. **Layer 1（核心耀斑 Core Flare）**：尺寸 $14 \times 14$（太阳半径 3.4），Canvas 径向渐变由高亮纯白瞬变至暖金黄，模拟恒星核心过曝感；
    2. **Layer 2（日冕光芒 Chromosphere Halo）**：尺寸 $28 \times 28$，Canvas 绘制带有 8 束微细辐射星芒的柔和光晕，色调为金橙；在 `_tick` 中施加极慢自转（$0.015\text{ rad/s}$）与呼吸微胀（$\pm 3\%$）；
    3. **Layer 3（外层深空紫红弥散 Outer Aura）**：尺寸 $55 \times 55$，极其幽暗的深红/琥珀扩散层（边缘 Alpha 衰减至 0），将太阳能量延展至内行星公转空间。
* **性能开销**：
  * 3 个 Sprite 均为静态 CanvasTexture，合批渲染，GPU 增量 < 0.08ms，对移动端完全无压力。
* **建议取舍与降级**：
  * **极力推荐采纳**。彻底消除太阳“黄色塑料实心球”的生硬外观，带来恒星自发光的空间光照感；
  * 移动端降级：移动端精简为单层 Core Flare，关闭 Layer 2/3 的旋转呼吸 CPU 计算。

#### 选项 D：轨道线层级渐隐与景深衰减（Orbit Line Fading）
* **技术选型权衡**：
  * 否定“每帧重算顶点 Alpha”的动态方案：在 CPU 逐帧遍历几千个顶点做动态距离透明度会消耗宝贵的 JS 线程性能；
  * 采纳 **静态轨道层级与空间色彩分级方案**：
    * 内行星（水/金/地/火）：轨道密集且临近恒星，材质采用高清晰度冰冷钢蓝（`#4a6288`），不透明度设为 `0.26`；
    * 小行星带分界外（木/土/天/海）：轨道半径广阔，材质平滑衰减至深空暗灰青（`#2a384e`），不透明度线性阶梯下调（木星 0.18、土星 0.14、天王 0.10、海王 0.08）；
    * 视觉上远端轨道自然“沉入”黑暗星空，近端聚焦清晰，彻底消除 CAD 线框凌乱感。
* **性能开销**：0 额外开销（仅调整材质初始参数）。
* **建议取舍与降级**：**全端统一采纳**。

### 2.3 规范化输出

#### 改动函数
* `_buildProceduralTextures()`（新增：离屏 Canvas 生成地球、木星、火星地表纹理）
* `_buildAtmosphere(planetMesh, type)`（新增：构建地球与金星的大气边缘辉光球壳）
* `_buildSun()`（改动：在原太阳 Mesh 外追加 3 层 AdditiveBlending 光晕 Sprite）
* `_buildOrbitRing(radius, planetIndex)`（改动：引入轨道层级色彩与渐进透明度梯度）
* `_tick()`（改动：在现有 rAF 循环中追加太阳中层光晕的极轻量自转与呼吸变换）

#### 核心参数
* 太阳光晕：Core 尺寸 14、Corona 尺寸 28、Aura 尺寸 55，`depthWrite: false`；
* 地球大气：外层球体缩放 1.045x，色值 `#5cb3ff`，菲涅尔幂次 3.2；
* 行星纹理：地球 $512 \times 256$、木星 $512 \times 256$、火星 $256 \times 128$；
* 轨道透明度梯度：水星 0.28 $\rightarrow$ 地球 0.24 $\rightarrow$ 木星 0.18 $\rightarrow$ 海王星 0.08。

#### 性能开销
* 纹理显存合计 < 2.5MB；
* 全局 Draw Calls 桌面端仅增加约 5~7 个，移动端仅增加 2 个；全场景 60 FPS 稳定运行。

#### 移动端差异与降级
* 移动端仅生成地球程序化贴图，木星/火星使用轻量色块；
* 太阳光晕仅保留内层单层 Core Sprite；
* 大气辉光仅保留地球微弱外壳，杜绝任何移动端过度绘制（Overdraw）掉帧。

#### 验收断言
* 依赖与渲染器契约：`grep "WebGLRenderer" SolarSystem.js` 计数恒等于 1；`grep "requestAnimationFrame" SolarSystem.js` 计数恒等于 1；
* 太阳光晕视觉断言：太阳视觉外径在深色背景下呈现平滑光雾扩散，无生硬几何球体边缘；
* 地球与行星视觉断言：地球表面清晰可辨大陆、海洋与极地白色反光；背向太阳面大气发光自然隐匿于阴影中。

---

## 三、移动端纵版（9:16）全景自适应布局设计

### 3.1 现状缺陷根因剖析
1. **视锥几何失配**：Three.js `PerspectiveCamera` 默认设定参数为 **垂直视场角（Vertical FOV, vfov = $52^\circ$）**。
2. **计算盲区**：既有 `_fitHomeCamera` 实现：
   $$hfovHalf = \arctan\left(\tan\left(\frac{HOME\_FOV \cdot \pi}{360}\right) \cdot aspect\right)$$
   其目标是将 `TARGET_RADIUS = (19 + 2.6 + 1.25) * 1.1 = 25.135` 适配至水平视场。
3. **出画根因**：
   * 既有设计仅针对以地球轨道（19）为边界；
   * 在竖屏（如典型手机比例 $9:16 \approx 0.5625$）下，水平视场角剧烈收缩至 $hfov \approx 30.7^\circ$；
   * 土星实际轨道半径高达 41，星环外延更达 $45.4$。在竖屏下土星及其星环在水平方向被严重裁切移出屏幕两翼；
   * 若直接按普通逻辑缩小，又会导致上下两侧产生大量无用深空空白。

### 3.2 方案选型与对比评估

| 选型方案 | 实现机制 | 优缺点分析 | 判定结论 |
| :--- | :--- | :--- | :--- |
| **方案 1：场景整体缩放 (`scene.scale`)** | 在纵屏下根据 aspect 将场景缩放至 $0.5 \sim 0.6x$ | **致命缺陷**：破坏点光源真实衰减半径、破坏 Raycaster 距离判定、导致三维坐标与单测及 DOM 热区映射失准。 | **坚决否决** |
| **方案 2：动态物理压缩轨道半径** | 竖屏下将行星轨道半径乘以压缩系数（如 $0.6x$） | **致命缺陷**：破坏开普勒速度关系与轨道力学，破坏 `_advanceBodies` 中 `Math.cos/sin` 位置驱动测试契约。 | **坚决否决** |
| **方案 3：扩展 `_fitHomeCamera` 的双轴视锥动态拉距算法** | 严格保持物理坐标与世界比例不变，基于包围球与纵横视锥自动推导最适摄像机回退距离 $k$ | **完美**：零几何侵入、物理完全保真、完美对齐 `verify_solar_hit_targets.py` 各种视口下的热区判定与 resize 门禁。 | **唯一推荐方案** |

### 3.3 数学建模与精确公式推导
* **最大包围盒半径定义**：
  * 要确保竖屏 9:16 下全部行星轨道与星环可见，系统特征外径 $R_{\text{fit}}$ 必须锚定最外层轨道：
    * 若场景维持至土星：$R_{\text{fit}} = (R_{\text{saturn\_orbit}} + R_{\text{saturn\_ring\_outer}}) \cdot 1.08 = (41.0 + 4.4) \cdot 1.08 \approx 49.0$；
    * 若扩展天王星/海王星：桌面端横屏按海王星 $R_{\text{fit}} \approx 67.0$ 计算，竖屏因移动端过滤天王海王，自动收敛为土星的 $49.0$。
* **双轴视锥约束方程**：
  * 水平约束：需容纳 $R_{\text{fit}}$，要求摄像机距离 $D_h \ge \frac{R_{\text{fit}}}{\tan(hfovHalf)}$；
  * 垂直约束（相机仰角 $\alpha \approx 28.44^\circ$）：轨道在屏幕垂直方向的投影受视线俯角压缩，垂直投影视距需满足 $D_v \ge \frac{R_{\text{fit}} \cdot \cos(\alpha)}{\tan(vfovHalf)}$；
  * 综合回退比例因子 $k$：
    $$k = \max\left(1.0, \frac{R_{\text{fit}}}{\tan(hfovHalf) \cdot D_{\text{base}}}, \frac{R_{\text{fit}} \cdot \cos(\alpha)}{\tan(vfovHalf) \cdot D_{\text{base}}}\right)$$
  * 在 9:16 竖屏下，水平约束成为主控瓶颈，代入参数：
    $$\tan(hfovHalf) = \tan(26^\circ) \cdot 0.5625 \approx 0.27435$$
    $$D_{\text{required}} = \frac{49.0}{0.27435} \approx 178.6$$
    $$k = \frac{178.6}{54.59} \approx 3.27$$
  * 此时土星（45.4）在横向占据屏幕宽度的 $92\%$，两边留有各 $4\%$ 的优雅安全边距；在垂直方向占据屏幕高度的约 $46\%$，完全在视野之内，不越界、不重叠、无任何压迫感！

### 3.4 严密兼容门禁契约
* `verify-solar-system-home.mjs` 行 62~63 明确要求：
  * 必须匹配 `Math.max(1, requiredDist / baseDistance)`
  * 必须匹配 `aspect[^\n]*hfovHalf|hfovHalf[^\n]*aspect`
* 因此重构代码必须严格维持原有命名模式：
  ```javascript
  const hfovHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * aspect);
  // requiredDist 结合水平与垂直综合约束
  const requiredDist = Math.max(fitTargetRadius / Math.tan(hfovHalf), (fitTargetRadius * 0.88) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  const k = Math.max(1, requiredDist / baseDistance);
  ```
  该数学形式与测试正则 100% 精确吻合。

### 3.5 窗口变化与旋转屏幕（Resize）平滑过渡
* **平滑过渡状态机**：
  * 当用户旋转屏幕（Landscape $\leftrightarrow$ Portrait）或调整窗口大小时，`resize()` 会被高频调用；
  * **非 Home 保护（保持既有核心契约）**：
    `verify_solar_hit_targets.py` 行 130~135 及 190 断言：**若处于地球缩放 Tween 中或非 Home 状态，`resize()` 绝不可强制重置相机位置（`assert post['pos'] == pre['pos']`）**；
  * **Home 状态自适应**：
    当 `this.cameraAtHome === true` 时，无缝更新 `homeCameraPosition`，并平滑更新相机位置；
  * 为避免翻转屏幕产生瞬间视差跳变，在 `this.cameraAtHome` 状态下执行自适应阻尼缓动（插值因子 0.25），180ms 内迅速收敛至新的最佳纵横全景视口。

### 3.6 规范化输出

#### 改动函数
* `_fitHomeCamera(width, height)`（升级为双轴视锥包围球推导，动态适配外行星星环边界）
* `resize()`（保持既有 `cameraAtHome` 保护不变式前提下，平滑更新视口投影矩阵）
* `_syncHitButtons()`（校验纵屏大拉距下 `Math.max(24, ...)` 热区最小尺寸与无重叠推斥）

#### 核心参数
* 特征适配半径：桌面横屏自适应外缘，竖屏（$aspect < 1$）锁定 $R_{\text{fit}} = 49.0$；
* 竖屏 9:16 拉距系数：$k \approx 3.27$；视口边距：左右各 $4\%$，上下充足。

#### 性能开销
* 纯标量三角几何计算，在 `resize` 时触发一次，每秒 0 开销。

#### 移动端差异与降级
* 竖屏为移动端专属高频场景，该算法确保移动端无论直握（9:16）还是横握（16:9），全系天体自适应完整可见。

#### 验收断言
* 自动化尺寸断言：在模拟宽度 480、高度 850（9:16 竖屏）视口下：
  * 土星及土星环最远顶点在屏幕空间归一化坐标满足：$NDC_x \in [-0.94, 0.94]$ 且 $NDC_y \in [-0.94, 0.94]$，**全周 360 度旋转无一帧出画**；
* 核心热区断言：运行 `verify_solar_hit_targets.py`，在 `(480, 850)` 视口下，太阳、地球、月球热区点击命中率持续满足 $\ge 99.5\%$，Earth/Moon 按钮绝对不产生几何重叠（`overlap == 0`）。

---

## 四、红线审查与既有资产保护验证

| 红线 / 契约项目 | 现状要求 | v3.5 设计保护方案 | 审查结论 |
| :--- | :--- | :--- | :--- |
| **单 rAF 约束** | 源码仅允许存在 1 个 `requestAnimationFrame` | 所有太阳日冕旋转呼吸、行星公转、相机补间均集中于 `_tick` 中统一驱动，严禁新建循环。 | **PASS** |
| **单 Renderer 约束** | 源码仅允许存在 1 个 `new THREE.WebGLRenderer` | 不引入后处理 Composer，全场景共用既有 renderer 实例。 | **PASS** |
| **零新增 npm 依赖** | 无三方新库 | 纹理全离屏 Canvas 2D 动态生成，大气与日冕纯依赖 Three.js 原生 API。 | **PASS** |
| **哈雷彗星系统 (D5)** | 高偏心率掠日加速、背向太阳彗尾定向 | `_buildHalleyComet()` 与 `_advanceBodies` 中彗尾定向姿态计算原封不动保留。 | **PASS** |
| **小行星带系统 (D7)** | `InstancedMesh` 单 Draw Call 差速公转 | 陨石带矩阵数组更新逻辑原封不动保留，不破坏 `instanceMatrix.needsUpdate`。 | **PASS** |
| **测试正则锚点** | `PointLight`、`cameraAtHome` 赋值唯一性、`len >= 0.5` 等 | 关键函数签名、变量命名及正则锚点代码 100% 保留。 | **PASS** |

---

## 五、改动文件清单与实施顺序建议

### 5.1 改动文件清单总览

| 文件路径 | 改动属性 | 关联模块 | 改动内容摘要 |
| :--- | :--- | :--- | :--- |
| `frontend-vite/src/components/SolarSystem.js` | **核心** | 模块一、二、三 | 重构星环纹理生成器为通用工厂；新增木星环与径向 UV；重构 `_fitHomeCamera` 实现 9:16 纵版双轴视锥包围球自适应；构建太阳三层日冕 Sprite；构建行星程序化纹理与大气辉光；分级轨道景深衰减。 |
| `frontend-vite/src/styles/starfleet-theme.css` | **辅助** | 模块二、三 | 优化移动端竖屏下 `#solar-system-container` 的触控手势防颤样式，微调透明热区在移动端激活时的 outline 发光对比度。 |
| `frontend-vite/test/unit/solarSystemOrbit.test.js` | **测试** | 模块一、二、三 | 补充对通用星环参数、太阳光晕 Sprite、纵版相机回退系数的单元测试契约断言，保持不含 `PointsMaterial`。 |

---

### 5.2 实施顺序路线图（五阶段递进）

```
[阶段一：星环参数化重构与木星暗环构建] (模块一)
  -> 提取通用 _generateRingTexture(type, config) 与径向 UV 重映射
  -> 为 Jupiter 挂载低不透明度主环，配置 depthWrite: false
  -> 验证木星昼夜晨昏线与暗环受光立体感
       |
       v
[阶段二：移动端 9:16 纵版视口算法重构] (模块三)
  -> 改造 _fitHomeCamera：推导双轴视锥最大包围球拉距算法（满足正则锚点契约）
  -> 保持 resize() 中对 cameraAtHome 与 cameraTween 的严格保护
  -> 运行 verify_solar_hit_targets.py 确保 480x850 竖屏下土星全入画且热区 100% 命中
       |
       v
[阶段三：太阳多层日冕光晕与轨道景深分级] (模块二)
  -> 挂载 Core / Corona / Aura 三层加色混合 Sprite
  -> 接入 _tick 内微速星芒自转与呼吸动效（移动端自动静态化降级）
  -> 设置内外行星轨道线色彩分级与透明度景深梯次
       |
       v
[阶段四：地表程序化纹理与大气辉光] (模块二)
  -> 离屏 Canvas 生成地球（海陆云冰）、木星（云带红斑）、火星地表纹理
  -> 为地球挂载 1.045x 半透明天蓝双半球大气辉光球壳（移动端按需保留地球）
  -> 验证整体帧率与内存无泄漏释放（destroy 追踪）
       |
       v
[阶段五：天王星与海王星扩充及全套门禁回归] (模块一、模块四)
  -> PLANET_TABLE 扩充天王星（垂直环）与海王星（深海蓝），移动端标记为 false
  -> 全量回归：node verify-solar-system-home.mjs
  -> 全量回归：python3 verify_solar_hit_targets.py
  -> 产出最终上线交付物
```

### 5.3 门禁回归核验清单
1. `node frontend-vite/scripts/verify-solar-system-home.mjs`：确保单 rAF、单 Renderer、`PointLight`、`RingGeometry`、`cameraAtHome` 赋值点唯一性、`Math.max(1, requiredDist / baseDistance)` 等 20+ 项正则契约 100% 绿灯；
2. `python3 frontend-vite/scripts/verify_solar_hit_targets.py`：确保 `(1400,913)`、`(900,800)`、`(760,900)`、`(480,850)` 四大分辨率（尤其 480x850 竖屏）下，太阳、地球、月球热区点击命中率均 $\ge 99.5\%$，Earth/Moon 按钮绝对无几何重叠；
3. `vitest run frontend-vite/test/unit/solarSystemOrbit.test.js`：确保无 `PointsMaterial`，小行星与彗星推进逻辑正常，拖拽 2.8s 延时恢复状态机完好。
EXIT=0
