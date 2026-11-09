# 手机竖屏有效 AGY 方案

## 来源与本次范围

- 原始设计：`/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/agy-portrait-design-02/design.md`。
- 原始文件 SHA-256：`2fb47446b81f18a26f18c397f67f3d4cbd46bf4bd0c8b267438ded61419a983c`。
- 下列仅保留 design-02 的 I/II/III 有效设计，不重复完整修订历史；代码示例用于记录既有设计，不要求重写已落地实现。
- Claude 架构审查与最终复审：**WAIVED**，仅限本次任务的用户明确豁免，不代表审查批准。
- 不采纳原始设计 IV 中未请求的整体 `_initialSnapshot` 提案；当前 `SolarSystem.js`、ownership 与 cleanup 保持字节不变。
- 本次 finalize 仅修复重复测试声明、格式化两份单元测试并补本文档；生产 CSS、`TimeControls.js` 和既有原生 Python 验证器均冻结。
- 原生浏览器与 falsification 验收：**PENDING**，由父流程在 sandbox 外独立执行；本文不将其记为 PASS。

## 有效设计摘录

### 一、尺寸公式与容器布局收敛（纠正缺陷 A）

废除原设计中冲突的 `max-height: calc(100svh - 140px)` 与 `min-height: 420px`。采用**视口高度收窄宽度的严格 9/16 联合宽高公式**，彻底杜绝高宽比失真与视口溢出：

```css
/* 仅在手机竖屏生效 */
@media (max-width: 720px) and (orientation: portrait) {
  #solar-system-container[data-solar-viewport] {
    position: relative;
    inset: auto;
    /* 取容器可用宽度与满屏高度对应 9/16 宽度的较小值，严格锁定 9/16，无溢出 */
    width: min(100%, calc(100svh * (9 / 16)));
    height: auto;
    aspect-ratio: 9 / 16;
    margin-inline: auto;
    overflow: visible;
  }
}
```

**数学收敛验证（均严格满足 $\text{width}/\text{height} = 9/16 = 0.5625$ 且高度 $\le \text{svh}$）：**

- **390×844**：`min(390, 474.75) = 390px` $\rightarrow$ 宽 390px，高 693.33px（未超 844px）。
- **390×600**：`min(390, 337.5) = 337.5px` $\rightarrow$ 宽 337.5px，高 600px（严格贴合可用高度）。
- **360×500**：`min(360, 281.25) = 281.25px` $\rightarrow$ 宽 281.25px，高 500px。
- **720×800**：`min(720, 450) = 450px` $\rightarrow$ 宽 450px，高 800px（保持纵向视口，不再横置）。

---

### 二、度量契约与 Buffer 预测断言（纠正缺陷 B）

保留既有 `_measure()` 实现，严禁在度量阶段 `floor` 截断分数像素：

- **相机视锥比**：严格以实测浮点数计算：$\text{aspect} = \text{rect.width} / \text{rect.height}$。
- **WebGL Backing Store**：由 `WebGLRenderer.setSize(width, height, false)` 配合 `effectiveDPR`（Mobile 截断至 1.5，Desktop 截断至 2.0）由引擎底层对齐量化。
- **无猜定断言契约**：
  $$\text{expectedAspect} = \text{rect.width} / \text{rect.height}$$
  $$\left|\text{canvas.width} - \lfloor\text{rect.width} \times \text{effectiveDPR}\rfloor\right| \le 1,\quad \left|\text{canvas.height} - \lfloor\text{rect.height} \times \text{effectiveDPR}\rfloor\right| \le 1$$

---

### 三、TimeControls 作用域围栏与零 `!important` 改造（纠正缺陷 C）

`TimeControls` 实例是 `container.appendChild(nav)` 的直接子节点，废除不存在的兄弟选择器 `~`。为避免破坏 `check:css-important` 预算，采用 **CSS 变量默认值回退** 模式：

1. **`TimeControls.js` 最小化构造改造**：
   将原固定行内样式修改为支持 CSS 变量注入（未声明变量时 100% 回退原值，桌面零侵入）：
   ```javascript
   this.element.style.cssText =
     "position:absolute;left:var(--solar-tc-left,12px);top:var(--solar-tc-top,12px);bottom:var(--solar-tc-bottom,auto);transform:var(--solar-tc-transform,none);z-index:20;max-width:calc(100% - 24px);padding:8px;background:rgba(5,12,25,.9);color:#fff;font:12px/1.5 sans-serif;pointer-events:auto;border-radius:6px;";
   ```
2. **作用域样式（0 个 `!important`）**：
   ```css
   @media (max-width: 720px) and (orientation: portrait) {
     #solar-system-container {
       --solar-tc-top: auto;
       --solar-tc-bottom: 12px;
       --solar-tc-left: 50%;
       --solar-tc-transform: translateX(-50%);
     }
   }
   ```
   保留控件内所有按钮点击、summary 折叠展开交互及原本的 `stopEvent` 冒泡阻断。

---

### 四、AGY 窄幅时间控件修正（2026-11-09）

- 采纳来源：`/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/agy-width-amendment-06/design.md`。
- 来源 SHA-256：`748e6c91c2db36cb19085018018c3917f0021e9c4d5a03a165934df41b6b2fbf`。
- 真实 native 缺陷由父级验收发现：仅 360×500 窗口中，绝对定位的 nav 在 `left: 50%` 与 `width: auto` 下 shrink-to-fit 至 140.625px，控件高 334px，遮挡 Earth/Moon；既有 9/16 容器几何不变，不重做竖屏。
- 本次生产修正仅两行：`TimeControls` 既有 `style.cssText` 增加 `width:var(--solar-tc-width,auto);`；唯一 portrait `#solar-system-container[data-solar-viewport]` 规则增加 `--solar-tc-width: max-content;`。桌面与横屏仍回退 `auto`；既有 `max-width`、padding、top/bottom、transform、clock、events、summary 均保持不变。
- `max-content` 避免半宽折行，并继续受既有 `max-width: calc(100% - 24px)` 约束。父级私有浏览器已对同一验收作 width max-content 对照，9-cell 全 PASS，未修改产品源码；此结果仅引用父级报告，不是本次实现的 native PASS。
- 本次验证仅运行指定 focused unit：先新增 CSS 变量及 style fallback 契约获得真实 RED，再应用两行生产修正并运行同一命令获得 GREEN。原始 runner 日志及实际退出码保存于 `/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/codex-time-width-07/focused-red.log`、`/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/codex-time-width-07/focused-red.exit`、`/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/codex-time-width-07/focused-green.log`、`/root/.hermes/plans/vps-mobile-portrait-node-detail-20261108/codex-time-width-07/focused-green.exit`。
- 本轮未运行 native 验收、全量 quality/tests、build 或部署；产品源码的独立全量、native 验收及重建由父级执行。Claude 本轮 WAIVED，不再请求审查。
