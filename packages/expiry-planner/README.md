# 材料效期风险规划器 `@handcraft/expiry-planner`

结合**剩余量、开封日（含开封后寿命）和使用速率**，对在管批次给出确定性的效期风险分级与处置建议；支持**人工豁免保留期限**，并以只追加、哈希链校验的**原因链**完整保留每个决定的依据。

它是手工艺材料追踪 monorepo 中的纯领域包：不依赖数据库和时钟，数量沿用主系统的十进制字符串约定（内部定标 bigint 计算），规划过程是纯函数。

## 解决什么问题

- **剩余量**本身不说明风险：5000 g 釉料若 3 天后到期、每天只用 100 g，99% 都将浪费。
- **开封日**会让效期提前：很多材料「未开封效期」很长，但开封后寿命只有几十天，生效截止日应取两者较早者。
- **使用速率**决定「能不能在到期前用完」：没有可信速率时不能假装安全，要明确提示「无法判断」。
- 人工判断（如「这批密封完好，留到周末」）必须被保留，且**重算不能冲掉或改写**它；同时客观风险结论不能被豁免掩盖。

## 规划模型

### 生效硬截止日

```
hardDeadline = min(expiryOn, openedOn + openedShelfDays)
```

- 未开封：取厂商效期 `expiryOn`。
- 已开封且设置了开封后寿命：取厂商效期与开封后截止日的较早者。
- 两者都没有：无硬约束，风险为「安全」。

### 使用速率

- `usageRatePerDay` 非空时使用人工指定速率（标记 `MANUAL`）。
- 否则取近 `rateWindowDays`（默认 30）天的消耗样本，日均速率 = 窗口内合计消耗 / 固定窗口天数。
  分母固定为窗口天数而非「最近消耗距今天数」，跨天重算不会漂移。
- 窗口内无消耗：速率为 `NONE`，只按效期紧迫度判定，不臆造损耗。

### 消耗投影（速率可信且未过期时）

- 截止日前预计消耗 = 速率 × 剩余可用天数
- 预计损耗 = 剩余量 − 预计消耗（不小于 0）
- 预计损耗比例 = 预计损耗 / 剩余量
- 预计耗尽日 = 今天 + ⌈剩余量 / 速率⌉

全部使用定标整数（数量 1e-6、速率 1e-9）计算，无浮点误差。

### 风险等级（取两条轴中更严重者）

| 等级 | 效期轴 | 损耗轴（默认） |
| --- | --- | --- |
| EXPIRED | 已过硬截止日 | — |
| CRITICAL | 剩余 < 7 天 | 损耗 ≥ 50% |
| HIGH | 剩余 < 14 天 | 损耗 ≥ 25% |
| MEDIUM | 剩余 < 30 天 | 损耗 ≥ 10% |
| LOW | 30 天以上 | < 10% |
| SAFE | 无到期约束 | — |

阈值均可通过 `--config` 覆盖（`criticalDays/highDays/mediumDays/criticalWasteRatio/highWasteRatio/mediumWasteRatio/unopenedSoonDays/rateWindowDays`）。

### 处置建议

- `DISCARD_NOW`：已过期，立即报废隔离。
- `PRIORITIZE`：中/高/极高风险，优先排产消耗。
- `FREEZE`（附带动议）：损耗比例 ≥ 25% 且尚有时间，可冷冻封存延寿。
- `OPEN_SOON`：未开封、无速率、临近封存效期，尽快开封启用。
- `MONITOR`：已开封、无速率、中风险以内，继续观察并补录消耗。
- `USE_AS_PLANNED`：无显著风险。
- `REORDER`（附带动议）：提前期末预计跌破 `lowStockThreshold`，或当前已低于阈值。
- `RETAIN`：存在生效人工豁免时显示，客观结论仍保留在 `baseRiskLevel/baseDisposition`。

## 人工豁免与原因链（只追加）

豁免链按批次保存，事件只能追加、不能改写：

- `GRANT` 授予保留期（含原因、操作人、保留至日期，以及授权当时的客观风险快照）。
- `EXTEND` 续期，回放时覆盖当前生效状态。
- `REVOKE` 撤销，回放后豁免失效。

保证措施：

- **哈希链**：`entryHash = sha256(prevHash + canonicalJSON(本条目))`，首条指固定创世前缀；任何对历史条目的删除/篡改都会让后续哈希失配，`verify` 立即发现。
- **幂等**：完全相同的授予/续期请求不会新增事件。
- **冲突拒绝**：已有生效豁免时再次授予不同参数会报错，需显式 `EXTEND`，避免静默覆盖人工决定。
- **重算不触碰链**：`plan` 只读豁免记录，绝不写入；豁免到期自动失效但事件仍保留。
- **超期警示**：豁免保留日晚于硬截止日时，规划明确标注 `beyondHardExpiry` 并要求复检。

## 重算稳定性

`plan` 是纯函数：相同的（批次快照、`asOf`、配置、豁免链）必然得到逐字节一致的结果——不读系统时钟、不写状态、输出先按风险等级再按截止日/损耗/批次 ID 排序，与输入数组顺序无关。每个规划项含 `basisHash`（影响结论输入的 SHA-256 指纹）。

CLI 提供 `--determinism-check`，内部连算两次比对，另有测试固化该性质。

## CLI 使用

```bash
pnpm --filter @handcraft/expiry-planner build

# 仓库默认在 ./expiry-planner.json，可用 --store 或 EXPIRY_PLANNER_STORE 覆盖
node packages/expiry-planner/dist/cli/bin.js --help

expiry-plan batch:add examples/batch.example.json
expiry-plan batch:list
expiry-plan plan --as-of 2026-09-22 --determinism-check
expiry-plan plan --as-of 2026-09-22 --json          # 完整结构化结果
expiry-plan explain <batchId>                       # 单个批次的完整判定原因链

expiry-plan exempt:grant <batchId> --reason "密封完好留到周末" --actor 林染 --valid-until 2026-09-27
expiry-plan exempt:extend <batchId> --reason "窑炉检修推迟" --actor 林染 --valid-until 2026-10-10
expiry-plan exempt:revoke <batchId> --reason "复检结块" --actor 林染
expiry-plan exempt:history <batchId>
expiry-plan verify                                  # 校验所有原因链
```

批次 JSON 字段见 `examples/batch.example.json`；日期均为 `YYYY-MM-DD`，数量为最多 6 位小数的非负十进制字符串，速率最多 9 位小数。

## 编程接口

```ts
import { plan, grantExemption, validateChain } from "@handcraft/expiry-planner";

const result = plan(batches, { asOf: "2026-09-22", exemptions: chains });
// result.items: 风险、截止日、速率、损耗投影、处置建议、reasons[]、basisHash、豁免覆盖
```

## 目录

```text
packages/expiry-planner/
├── src/
│   ├── types.ts        领域模型与枚举
│   ├── decimal.ts      定标 bigint 数量/速率运算
│   ├── dates.ts        UTC 整日日期运算
│   ├── hash.ts         规范化 JSON 与 SHA-256
│   ├── rate.ts         消耗窗口推导日均速率
│   ├── config.ts       风险阈值与缺省值
│   ├── planner.ts      纯函数规划引擎（风险/建议/原因链）
│   ├── exemptions.ts   只追加豁免原因链、回放与校验
│   ├── store.ts        JSON 原子读写仓库
│   ├── repository.ts   批次 upsert / 版本
│   ├── schema.ts       zod 输入校验
│   └── cli/            命令行
├── tests/              Vitest（44 个用例）
└── examples/
```

## 测试

```bash
pnpm --filter @handcraft/expiry-planner test
pnpm --filter @handcraft/expiry-planner typecheck
```
