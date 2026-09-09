# 详情页 1h 遥测图表 X 轴「初始点来回跳」修复设计契约

---

## 冲突取证与根因复核

经过对 `frontend-vite/src/pages/detailCharts.js`、`frontend-vite/src/modules/serverTable.js` 与 `frontend-vite/src/detail/telemetryAxis.js` 的源码审计，已完全证实双轴规则冲突的存在及其机理：

1. **A 路径（20s 重建，`renderDetailMonitorCharts`）**：
   - 依赖 [`detailCharts.js:L710-716`](file:///tmp/vps-dashboard-review/frontend-vite/src/pages/detailCharts.js#L710-L716) 中的 `seriesOwnBounds(points)`，调用 `coldStartAxisBounds(xs, fullSpan, Date.now())`。
   - 当样本跨度 $< 1\text{h}$ 时，命中 `accumulating-from-first-sample` 分支：
     $$\text{min} = \text{dataFirst},\quad \text{max} = \text{dataFirst} + 1\text{h}$$
   - **表现**：折线起始点被固定在图表最左侧（0% 处），折线向右生长。

2. **B 路径（5s live 追加，`appendDetailLiveMetrics`）**：
   - 依赖 [`detailCharts.js:L540-544, L577`](file:///tmp/vps-dashboard-review/frontend-vite/src/pages/detailCharts.js#L540-L577) 中的 `hasSubstantialHistory` 判断：
     ```javascript
     const hasSubstantialHistory = mode === 'update'
       && points.length > 10
       && Number.isFinite(firstTimestamp)
       && Number.isFinite(lastTimestamp)
       && lastTimestamp - firstTimestamp > 30_000;
     ```
   - 当样本点数 $> 10$ 且时间跨度 $> 30\text{s}$ 时，B 路径刻意向 `coldStartAxisBounds` 传入空数组 `[]`：
     ```javascript
     coldStartAxisBounds(hasSubstantialHistory ? [] : points.map((p) => Number(p?.x)), fullSpan, timestamp)
     ```
   - 命中 `fixed-window-ending-now` 分支：
     $$\text{min} = \text{timestamp} - 1\text{h},\quad \text{max} = \text{timestamp}$$
   - **表现**：当前 1 分钟的数据被强行压缩到图表最右侧（98.5% ~ 100% 处）。

3. **交替覆写振荡（来回跳）**：
   - 新接 Agent 在前 1 小时内（只要点数 $> 10$ 且跨度 $> 30\text{s}$），必然处于冲突窗口：
     - **T=0s（5s live）**：B 写入 $\text{min} = \text{now}-1\text{h}$，首点瞬间跳到最右缘；
     - **T=20s（重绘）**：A 写入 $\text{min} = \text{dataFirst}$，首点瞬间被拉回最左缘；
     - **T=25s（5s live）**：B 再次写入 $\text{min} = \text{now}-1\text{h}$，首点再次跳到最右缘。
   - 这正是用户所见「初始点来回跳」的直接技术根因。

---

## 核心裁决与契约规范

### 1. 统一锚定规则选型裁决

#### 候选方案权衡对比

| 评估维度 | 方案一：`anchored-to-data`（紧贴数据） | 方案二：`accumulating 双端对齐`（推荐裁决） |
| :--- | :--- | :--- |
| **计算公式** | $\text{min} = \max(\text{first}, \text{last} - 1\text{h})$<br>$\text{max} = \text{last}$ | $\text{span} < 1\text{h}: [\text{first}, \text{first} + 1\text{h}]$<br>$\text{span} \ge 1\text{h}: [\text{last} - 1\text{h}, \text{last}]$ |
| **冷启动表现（2 样本，跨度 10s）** | 致命缺陷：X 轴总宽度仅 10s，2 个点被拉伸占满 100% 宽度。 | 优秀：X 轴总宽度固定为 1h，2 个点位于最左侧，向右生长。 |
| **刻度标签（Tick Collision）** | 致命缺陷：`formatHourTick` 仅输出 `HH:mm`（无秒），10s 跨度内的 5 个刻度将输出 5 个完全相同的字符串（如 `14:30, 14:30...`），直接引发视觉 bug。 | 优秀：4 个区间固定步长为 15 分钟（`1h / 4`），刻度永远为 `14:00, 14:15, 14:30, 14:45, 15:00`，绝对无重叠。 |
| **实时更新视觉稳定性** | 极差（手风琴挤压）：前 1 小时内，每 5s 追加一个点，X 轴总跨度就扩大 5s，导致既有全部折线点每 5s 向左压缩变形一次。 | 优秀（绝对稳定）：前 1 小时内，左缘 $\text{first}$ 与右缘 $\text{first}+1\text{h}$ 绝对静止，新样本只在右侧填补，既有像素位置纹丝不动。 |
| **图表语义一致性** | 卡片标题明确写着 `1h`（1小时），轴范围却显示 10s 或 2 分钟，语义不一致。 | 完美吻合 `1h` 窗口语义，右侧留白自然表达「系统正在持续积累 1 小时数据中」。 |
| **现有测试与回归基线** | 破坏现有 `telemetryAxis.test.js` 和 `verify-detail-page-regressions.mjs` 中的累积生长断言。 | 完全兼容既有单元测试与系统契约。 |

#### 裁决结论
**正式裁定采纳方案二：`accumulating 双端对齐`（冷启动首样本向右生长，满窗后单向滚动）**。
- 禁止 1h 小图使用无底线的 `anchored-to-data`，杜绝刻度重合与手风琴抖动。
- network 与 ping 图系 24h ~ 90d 大跨度图表（且已受红线保护），维持现状不变。

---

### 2. `hasSubstantialHistory` 分支裁决

#### 裁决结论
- **完全废弃在 X 轴 bounds 计算中使用 `hasSubstantialHistory ? [] : points` 的欺骗式传参技巧**。
- A 路径与 B 路径必须无条件传入真实的样本时间戳数组 `points.map(p => Number(p?.x))`。
- 在 `appendDetailLiveMetrics` 的追加队列管理中：
  - 数据点采纳逻辑统一为：若距离上一个点 $> 4000\text{ms}$ 则 `points.push(point)`，若在同一个 4s 周期内（$\ge \text{lastTimestamp}$）则替换更新末尾点 `points[length-1] = point`，时钟回退点（$<\text{lastTimestamp}$）丢弃。
  - 此逻辑无需依赖 `hasSubstantialHistory`，对冷启动首样本与长期运行节点同样安全适用。
  - `hasSubstantialHistory` 变量本身彻底从 X 轴决策链路中剥离。

---

### 3. mode 与调试字段语义统一

统一规范 `coldStartAxisBounds` 返回的 `mode` 与挂载在 `window.__DBG__` 上的调试字段语义：

| 运行状态 | `coldStartAxisBounds.mode` 规范值 | `window.__DBG__.DETAIL_LIVE_AXIS[id].mode` | 说明 |
| :--- | :--- | :--- | :--- |
| **无任何有效样本** | `'fixed-window-ending-now'` | `'fixed-window'` | 暂无数据，展示以当前时间结束的 1h 虚位窗口 |
| **冷启动数据积累中** ($\text{span} < 1\text{h}$) | `'accumulating-from-first-sample'` | `'accumulate'` | 锚定首样本，向右生长，步长固定 15m |
| **满窗平滑滚动中** ($\text{span} \ge 1\text{h}$) | `'rolling-after-full-window'` | `'rolling'` | 锚定最新样本，随数据流单向向左推移 |

> 并在 `DETAIL_LIVE_AXIS` 中增加字段 `axisMode: axisBounds.mode`，原汁原味反映核心函数输出。  
> `adaptiveRollingBounds`（位于 [`serverTable.js:L887-915`](file:///tmp/vps-dashboard-review/frontend-vite/src/modules/serverTable.js#L887-L915)）保留现有模式字符串 `'rolling-after-full-window'` / `'accumulating-from-first-sample'`，保持与回归脚本正则一致。

---

### 4. span ≥ 1h 时重建路径与 live 路径的时间对齐机制

#### 取证与机制验证
1. 在 5s live 追加时，[`serverTable.js:L2422-2426`](file:///tmp/vps-dashboard-review/frontend-vite/src/modules/serverTable.js#L2422-L2426) 已通过 `resourceTimelineRows` 将 live 样本立即追加合并进 `detailCache.resourceRows`。
2. 在 20s heavy 刷新时，[`serverTable.js:L2534`](file:///tmp/vps-dashboard-review/frontend-vite/src/modules/serverTable.js#L2534) 先执行 `await refreshDetailLivePoint(serverId)`，随后通过 [`resourceTimeline.js:L54-65`](file:///tmp/vps-dashboard-review/frontend-vite/src/detail/resourceTimeline.js#L54-L65) 的 `mergeResourceTimelineHistory` 保留最新的 live 行。
3. 重建时传入 `renderDetailMonitorCharts` 的 `probeRows` 即为包含最新 live 行的 `resourceRows`（[`serverTable.js:L2574, L2604`](file:///tmp/vps-dashboard-review/frontend-vite/src/modules/serverTable.js#L2574)）。
4. **结论**：
   - 统一规则下 $\text{max} = \text{dataLast}$。由于 `probeRows` 中已经合并了 5s live 样本，**A 路径重建拿到的 `dataLast` 与 B 路径追加的 `dataLast` 完全一致**，不会发生「右缘被向后拉回 20s」的现象。
   - `coldStartAxisBounds` 在有数据时完全由 `dataFirst` 与 `dataLast` 决定范围，第三参数 `nowMs` 仅用于空集兜底。因此即使 A 传 `Date.now()`、B 传 `timestamp`，计算得出的 `min` 与 `max` 也是 100% 逐毫秒相同的。

---

## 唯一函数签名契约 (`telemetryAxis.js`)

导出唯一标准计算函数，供 A 路径与 B 路径共同调用：

```typescript
export interface TelemetryAxisBounds {
  min: number;         // X 轴起点毫秒戳
  max: number;         // X 轴终点毫秒戳
  step: number;        // X 轴刻度步长毫秒戳（固定 fullSpan / 4）
  mode: 'fixed-window-ending-now' | 'accumulating-from-first-sample' | 'rolling-after-full-window';
  spanMs: number;      // 窗口总毫秒跨度（固定 fullSpan）
  dataFirst?: number;  // 第一个有效样本时间戳（无样本时为 null）
  dataLast?: number;   // 最后一个有效样本时间戳（无样本时为 null）
}

/**
 * 详情页 1h 遥测图表 X 轴唯一锚定契约函数
 *
 * @param xs 样本时间戳数组（无序或有序均可，内部自动清洗与排序）
 * @param fullSpanMs 视窗标准跨度（1 小时即 3,600,000 ms）
 * @param nowMs 当前基准时钟（仅在 xs 为空集时用于生成当前 1h 视窗）
 * @returns TelemetryAxisBounds 严格不可变的轴配置
 */
export function coldStartAxisBounds(
  xs: number[] = [],
  fullSpanMs: number,
  nowMs: number = Date.now()
): TelemetryAxisBounds;
```

### 契约行为准则
1. **空集保护**：当 `times.length === 0`，返回 `[nowMs - fullSpan, nowMs]`，`mode = 'fixed-window-ending-now'`。
2. **冷启动增长期**：当 `dataLast < dataFirst + fullSpan`，返回 `[dataFirst, dataFirst + fullSpan]`，`mode = 'accumulating-from-first-sample'`。
3. **满窗滚动期**：当 `dataLast >= dataFirst + fullSpan`，返回 `[dataLast - fullSpan, dataLast]`，`mode = 'rolling-after-full-window'`。
4. **步长恒定**：无论处于哪种状态，`step` 恒等于 `fullSpan / 4`（1h 对应 15 分钟），保证刻度文本永不重叠。
5. **禁止外部篡改**：A 路径与 B 路径禁止在调用后对 `min`、`max`、`step` 进行二次加减或手写 fallback。

---

## 改动清单（文件与行为契约）

### 1. [`frontend-vite/src/detail/telemetryAxis.js`](file:///tmp/vps-dashboard-review/frontend-vite/src/detail/telemetryAxis.js)
- **改动行为**：
  - 确认 `coldStartAxisBounds` 完整符合上述签名与准则。
  - 在返回对象中补充可选的 `dataFirst` 与 `dataLast` 字段，方便调用方调试与取证，保持与 `adaptiveRollingBounds` 对齐。
  - 保持命名为 `coldStartAxisBounds`，确保对既有外部引用的绝对向后兼容。

### 2. [`frontend-vite/src/pages/detailCharts.js`](file:///tmp/vps-dashboard-review/frontend-vite/src/pages/detailCharts.js)
- **改动点 1（B 路径传参修复，L577）**：
  - **现状**：
    ```javascript
    const axisBounds = coldStartAxisBounds(hasSubstantialHistory ? [] : points.map((point) => Number(point?.x)), fullSpan, timestamp);
    ```
  - **契约行为**：
    删除 `hasSubstantialHistory ? [] :`，直接传入实际点集：
    ```javascript
    const axisBounds = coldStartAxisBounds(points.map((point) => Number(point?.x)), fullSpan, timestamp);
    ```
- **改动点 2（B 路径调试状态对齐，L597）**：
  - **现状**：
    ```javascript
    mode: hasSubstantialHistory || axisBounds.mode === 'rolling-after-full-window' ? 'rolling' : 'accumulate',
    ```
  - **契约行为**：
    由 `axisBounds.mode` 直接驱动：
    ```javascript
    mode: axisBounds.mode === 'rolling-after-full-window' ? 'rolling' : (axisBounds.mode === 'fixed-window-ending-now' ? 'fixed-window' : 'accumulate'),
    axisMode: axisBounds.mode,
    ```
- **改动点 3（A 路径调用保证，L710-716）**：
  - **现状**：`seriesOwnBounds` 已在调用 `coldStartAxisBounds`。
  - **契约行为**：保持调用 `coldStartAxisBounds`，确保传入 `series` 的实际时间戳集合与 `telemetryHours * 3600 * 1000`。
- **改动点 4（注释纠偏，L793-796）**：
  - **现状**：注释声称 network/ping 与 CPU/RAM/process「same contract」。
  - **契约行为**：修正注释描述，明确区分：1h 遥测小图使用 `coldStartAxisBounds`（首点固定 + 累积满 1h 滚动，杜绝 15m 刻度折叠），而 24h+ 的 network/ping 图使用 `anchored-to-data`（紧贴真实大跨度数据）。

### 3. [`frontend-vite/src/modules/serverTable.js`](file:///tmp/vps-dashboard-review/frontend-vite/src/modules/serverTable.js)
- **改动行为**：
  - 保留 `adaptiveRollingBounds` 源码结构与函数体，确保满足 `scripts/verify-detail-page-regressions.mjs:L72` 的源码静态匹配检查。
  - 确认 `refreshDetailRealtime` 的合并顺序：5s live 点持续并入 `detailCache.resourceRows`，保证 20s 重建传入的 `probeRows` 包含最新点。

---

## 回归测试清单 (`frontend-vite/test/unit/telemetryAxis.test.js`)

测试文件需包含以下 5 类场景，彻底锁死「来回跳」缺陷并杜绝任何未来劣化：

```javascript
import { describe, expect, test } from 'vitest';
import { coldStartAxisBounds } from '../../src/detail/telemetryAxis.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

describe('telemetryAxis 修复契约回归验证', () => {

  // 1. 空集断言
  test('空集测试：无数据时回退为以基准时钟结束的完整 1h 视窗', () => {
    const res = coldStartAxisBounds([], HOUR, NOW);
    expect(res).toMatchObject({
      min: NOW - HOUR,
      max: NOW,
      step: HOUR / 4,
      mode: 'fixed-window-ending-now',
      spanMs: HOUR,
    });
  });

  // 2. span < 1h 断言（冷启动期）
  test('span < 1h 测试：稀疏点与多点累积均严格锚定首样本，且刻度为 15 分钟', () => {
    const first = NOW - 20_000;
    // 刚收集 3 个点（10 秒跨度）
    const sparse = coldStartAxisBounds([first, first + 5_000, first + 10_000], HOUR, NOW);
    expect(sparse).toMatchObject({
      min: first,
      max: first + HOUR,
      step: 15 * 60 * 1000,
      mode: 'accumulating-from-first-sample',
      spanMs: HOUR,
    });

    // 收集了 15 个点（跨度 70 秒，进入此前 hasSubstantialHistory 的冲突危险区）
    const fifteenPoints = Array.from({ length: 15 }, (_, i) => first + i * 5_000);
    const accumulated = coldStartAxisBounds(fifteenPoints, HOUR, NOW);
    expect(accumulated).toMatchObject({
      min: first,
      max: first + HOUR,
      step: 15 * 60 * 1000,
      mode: 'accumulating-from-first-sample',
    });
  });

  // 3. span >= 1h 断言（满窗平滑滚动）
  test('span >= 1h 测试：数据跨度填满 1h 后平滑滚动，且视窗恒定为 1h', () => {
    const first = NOW - HOUR - 15_000;
    const last = NOW - 5_000;
    const rolling = coldStartAxisBounds([first, last], HOUR, NOW);
    expect(rolling).toMatchObject({
      min: last - HOUR,
      max: last,
      step: 15 * 60 * 1000,
      mode: 'rolling-after-full-window',
      spanMs: HOUR,
    });
    expect(rolling.max - rolling.min).toBe(HOUR);
  });

  // 4. A/B 路径等价性断言（核心杀虫断言）
  test('A/B 等价性断言：同一组时间戳，A 路径（重建）与 B 路径（追加）必须输出完全相同的 bounds', () => {
    const first = NOW - 50_000;
    // 冲突高危样本：12 个样本，跨度 55s（点数 > 10 且跨度 > 30s）
    const xs = Array.from({ length: 12 }, (_, i) => first + i * 5_000);
    const lastTimestamp = xs[xs.length - 1];

    // A 路径：使用系统时钟作为兜底
    const boundsPathA = coldStartAxisBounds(xs, HOUR, Date.now());
    // B 路径：使用 live payload 上的 timestamp 作为兜底（统一后严禁传空数组 []）
    const boundsPathB = coldStartAxisBounds(xs, HOUR, lastTimestamp);

    expect(boundsPathA.min).toBe(boundsPathB.min);
    expect(boundsPathA.max).toBe(boundsPathB.max);
    expect(boundsPathA.step).toBe(boundsPathB.step);
    expect(boundsPathA.mode).toBe(boundsPathB.mode);
    expect(boundsPathB.mode).toBe('accumulating-from-first-sample');
  });

  // 5. 单调滚动性断言
  test('单调性断言：冷启动期左缘绝对不动；满窗后左缘仅单向平移新样本的时间增量', () => {
    const first = NOW;
    let xs = [first];

    // 冷启动加点：每隔 5s 追加一个点，追加到第 10 个点
    for (let i = 1; i <= 10; i++) {
      xs.push(first + i * 5_000);
      const b = coldStartAxisBounds(xs, HOUR, xs[xs.length - 1]);
      expect(b.min).toBe(first); // 左缘死死锚定在首样本，不发生任何像素抖动
      expect(b.max).toBe(first + HOUR);
    }

    // 推进到满窗之后
    const fullFirst = NOW - HOUR;
    const rollingXs = [fullFirst, fullFirst + 1000, fullFirst + HOUR]; // 恰好 1h
    const b0 = coldStartAxisBounds(rollingXs, HOUR, fullFirst + HOUR);
    expect(b0.min).toBe(fullFirst);
    expect(b0.max).toBe(fullFirst + HOUR);

    // 再加一个点（增量 5s）
    const nextTime = fullFirst + HOUR + 5_000;
    rollingXs.push(nextTime);
    const b1 = coldStartAxisBounds(rollingXs, HOUR, nextTime);
    expect(b1.min).toBe(fullFirst + 5_000); // 左缘单调随真实增量平移 5s
    expect(b1.max).toBe(nextTime);          // 右缘单调平移 5s
  });

});
```

---

## 验证与合规性检查

1. **Y 轴逻辑不变更**：未对 `adaptivePercentYScale`、`processYScale`、`fixedSmallY` 或 Chart.js Y 轴做任何配置修改。
2. **Network / PING 图不变更**：保留现有的 `anchored-to-data` 与多目标采样机制，不介入其计算逻辑。
3. **数据流契约不变更**：`resourceTimeline.js` 的所有时间解析、去重以及双向合并逻辑保持原样。
4. **自动化验证指令保障**：
   - 运行 `npm run test:unit`（Vitest），现有及新增测试用例将全绿通过。
   - 运行 `npm run test:solar-system-home`，确保无星图首页回归。
   - 运行 `npm run build`，确保 Vite 构建与 Chunk 预算全绿。
EXIT=0
