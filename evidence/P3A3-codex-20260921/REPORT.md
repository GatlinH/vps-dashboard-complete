P3-A3 已完成：目标测试 110/110，全量单测 209/209（17 个文件，较基线增加 70 项），主页回归与构建通过。生产实现已满足本次合同，因此本次代码改动仅为两个 unit test 文件，另附本目录证据。提交信息为 `test(solar): verify unified ephemeris runtime contracts`。

基线为 `173ca39f242f63348c3290b247899b80db33c69c`，开始时工作树干净。依据 `/root/.hermes/plans/solar-comet-upgrade/evidence/P3A-agy-design.md` §5 与实施简报执行；未访问网络、安装依赖或执行推送、部署。最终受保护文件逐字节核验见 [scope-check.json](scope-check.json)，运行环境与命令见 [run-metadata.json](run-metadata.json)。

TDD 先补全真实 manifest 的 fetch stub，保留旧合同运行目标测试，取得有效 RED；再更新旧断言并增加 P3-A 门禁。未修改生产文件。RED 时的测试差异可由 [red-test-changes.patch](red-test-changes.patch) 在基线上重建，文件范围见 [red-changed-files.txt](red-changed-files.txt)。

| 验证 | 结果 / 退出码 | 原始输出 |
| --- | --- | --- |
| 目标 RED，测试修改后、生产修改前 | 56 通过、4 失败 / 1 | [target-red.txt](target-red.txt) |
| 更新旧合同后的中间检查 | 67/67 / 0 | [intermediate-loader-check.txt](intermediate-loader-check.txt) |
| 最终目标 GREEN，verbose | 110/110 / 0 | [target-green.txt](target-green.txt) |
| `npm run test:unit` | 209/209，17 文件 / 0 | [unit-all.txt](unit-all.txt) |
| `npm run test:solar-system-home` | 通过 / 0 | [solar-system-home.txt](solar-system-home.txt) |
| `npm run build` | 通过 / 0 | [build.txt](build.txt) |

RED 四项精确对应旧合同：`loads only both published P1 targets`、`omits only Mars from generic orbit rings`、`spins Mars without applying the generic circular orbit`、`updates asteroid instances and orients the Halley tail along its direction`。没有语法或 fixture 导致的测试失败。执行准备时另有两次命令使用了错误的相对路径，均已更正；第二次之后的中间检查原始输出也已保留。构建出现插件耗时提示和 `inlineDynamicImports` 弃用警告，退出码为 0；没有其他测试失败。

加载测试使用真实 manifest 的全部 target 构造精确 URL stub；未知 URL 显式抛错，绝不返回 undefined。固定十个必需 key 的集合，并按 manifest 顺序验证 provider 和请求；公共 range 为 `[2446078.5, 2446643.5]`。全部 target 均覆盖缺失定义、range/files/SHA 元数据失败、HTTP 404 与 provider 校验错误；另有完整十目标范围交集和 Uranus/Moon 不相交反例。缺 target 门禁采用简报允许的“冻结十个必需 key”方案，配合空/缺失 targets 与各 target 空定义的通用失败闭合；保持 loader 按 manifest 遍历的生产设计。

独立留出读取原有 `test/fixtures/p3-holdout.json`，8 个目标均检查全部 1050 个有效点，验证与插值节点无交集，明确跳过且仅跳过末点 JD 2446644，并验证 provider 对该点返回 out_of_range。日心位置分母 floor 为 `1e-3 AU`，地月相对位置 floor 为 `1e-4 AU`；相对误差阈值均为 `1e-4`，方向阈值均为 `0.05°`。Mars/Halley 原有独立 Hermite 测试保留。

| 目标 | 有效点 | 最大相对位置误差 | 最大方向误差（度） |
| --- | --- | --- | --- |
| Mercury | 1050 | 4.357670637e-7 | 1.006584284e-5 |
| Venus | 1050 | 1.692802072e-9 | 1.707547293e-6 |
| Earth | 1050 | 6.642397492e-10 | 1.707547293e-6 |
| Jupiter | 1050 | 9.574742875e-9 | 1.707547293e-6 |
| Saturn | 1050 | 1.470274932e-10 | 1.707547293e-6 |
| Uranus | 1050 | 1.318499356e-10 | 2.091309789e-6 |
| Neptune | 1050 | 7.056655082e-11 | 1.707547293e-6 |
| Moon（日心） | 1050 | 3.348344755e-8 | 2.414836539e-6 |
| Moon − Earth（同 JD） | 1050 | 1.413384425e-5 | 2.129202610e-4 |

运行时门禁直接调用 `updateEphemerisTargets`，比较真实 applyPosition 接收及保存的坐标、原始 sample、可见性、快照与 lastJd；普通目标严格等于同 JD provider，Moon 严格等于 Moon − Earth。十目标逐一覆盖 provider 抛错和返回失败，以及下一帧恢复；Earth 失败允许 Earth 与依赖 Moon 失败，其余继续成功；另覆盖仅 Moon 的 Earth 依赖采样失败。`advanceOrbitalBodies` 对八行星、Moon、Sun 只更新自转，Earth 云层正常转动，角度与 position.set 保持不变。八行星 generic orbit ring 全部 false；土星 RingGeometry 源码合同保留。

实际 `SolarSystem.prototype._advanceBodies` 使用 Three Object3D 在无 DOM/WebGL 环境执行，验证生产展示回调、暂停和时钟跳转，未 mock 被验证的生产函数。全部 1050 个发布节点还逐点核对所有目标的运行时输出。通过真实 provider 动态寻找水星 min/max radius 的发布 epoch：近日点 JD 2446488.1，远日点 JD 2446444.1；1 日位移比 `1.5166436460165962 >= 1.45`。真实 physicalToDisplay 后最大 `|y| = 1.1527991604601247 >= 0.5`，这些实测值未写入测试作为预设结果。

四项反例共用正常运行时测试的 `assertRuntimeFrame` 门禁；错误候选必须抛出真实 AssertionError，再由外层 negative control 捕获，正常候选必须通过。原始拒绝诊断与正常接受输出均在 [target-green.txt](target-green.txt) 的 `[P3-A3 control]` 行中，verbose 同时保留以下完整测试名：

| 反例 | `P3-A counterexample controls at production boundaries` 下的完整测试名 | 注入与实际拒绝依据 |
| --- | --- | --- |
| C1 手写正圆 | `C1 rejects a handwritten Venus circle and accepts real ephemeris output` | fake apply 消费真实 runtime 输出后写 Venus 正圆；即使 status 物理快照正确，实际 applyPosition 坐标门禁仍失败。随后真实输出通过。 |
| C2 时间脱节 | `C2 rejects Mars sampling at simulationTime + 0.5 even though lastJd matches` | wrapper 捕获并实际调用真实 Mars provider 于 JD + 0.5；明确证明 lastJd 仍为请求 JD，实际坐标却不同，由坐标门禁拒绝。原时刻采样通过。 |
| C3 月球日心直连 | `C3 rejects heliocentric Moon wiring and accepts Moon minus Earth` | apply 消费真实 Moon sample 的日心向量，绕过相减，地月向量门禁失败；正常 Moon − Earth 通过。 |
| C4 Uranus 损毁 | `C4 rejects corrupt Uranus as healthy, preserves the other nine and recovers` | 在内存中将 Uranus states 截为 1049，真实 createEphemerisProvider 返回 invalid_states，再经 runtime 采样边界注入；健康门禁拒绝，隔离门禁确认仅 Uranus 隐藏且清空，其余九目标成功并推进，恢复帧十目标通过。 |

可在 `frontend-vite/` 下独立复跑四项反例，无需新脚本或依赖：

```sh
npm run test:unit -- --reporter=verbose test/unit/solarP1.test.js -t 'P3-A counterexample controls'
```

本次验证不包含浏览器渲染、像素截图或真实网络请求；按简报要求的生产 provider/runtime 边界、unit、主页回归与 build 完成验证。全部 stdout/stderr 合并原文保存为 txt，各 `.exit` 保存实际退出码；文件校验值见 [SHA256SUMS](SHA256SUMS)。
