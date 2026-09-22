# API 文档

## 1. 基础约定

- 基础路径：`/api/v1`
- 请求与响应：JSON，附件上传除外。
- 数量：十进制字符串，例如 `"500.000000"`。
- 时间：ISO 8601，推荐包含时区偏移。
- 会话：HttpOnly Cookie `handcraft_session`。
- 分页：`page`、`pageSize`，最大 100。
- 幂等：批次入库、库存调整和材料消耗支持 `Idempotency-Key`。
- 乐观锁：更新请求携带 `version`。

成功响应：

```json
{ "data": {}, "meta": {} }
```

错误响应：

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "批次剩余数量不足",
    "fieldErrors": {},
    "requestId": "..."
  }
}
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/setup/status` | 查询是否完成初始化 |
| POST | `/setup` | 创建唯一操作员 |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 退出 |
| GET | `/auth/me` | 当前操作员 |
| POST | `/auth/password` | 修改密码 |

初始化请求：

```json
{
  "displayName": "工作室操作员",
  "password": "至少10位密码"
}
```

## 3. 来源与位置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/sources` | 查询或创建来源 |
| GET/PATCH | `/sources/:id` | 详情或更新 |
| POST | `/sources/:id/archive` | 归档 |
| POST | `/sources/:id/unarchive` | 取消归档 |
| GET/POST | `/locations` | 查询或创建位置 |
| PATCH | `/locations/:id` | 更新位置 |
| POST | `/locations/:id/archive` | 归档位置 |

## 4. 材料

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/materials` | 聚合库存查询或创建 |
| GET/PATCH | `/materials/:id` | 详情或更新 |
| GET | `/materials/:id/batches` | 材料批次 |
| POST | `/materials/:id/archive` | 归档 |

材料列表查询参数：

- `q`
- `craftType`
- `sourceId`
- `locationId`
- `batchCode`
- `color`
- `stockState=in_stock|low_stock|out_of_stock`
- `expiryBefore`
- `tag`
- `sort`

创建材料：

```json
{
  "code": "DYE-SUMU",
  "name": "苏木染材",
  "craftTypes": ["DYEING"],
  "subtype": "天然染料",
  "stockUnit": "g",
  "lowStockThreshold": "200",
  "openShelfLifeDays": 90,
  "defaultColorName": "原木棕",
  "defaultColorHex": "#8B5A2B",
  "tags": ["天然", "染布"]
}
```

## 5. 批次与库存

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/batches` | 批次查询或入库 |
| GET/PATCH | `/batches/:id` | 详情或非库存字段更新 |
| GET | `/batches/:id/movements` | 库存流水 |
| POST | `/batches/:id/adjustments` | 库存调整 |
| POST | `/batches/:id/archive` | 归档无余额批次 |

创建批次：

```json
{
  "materialId": "uuid",
  "batchCode": "B-20260913-01",
  "sourceId": "uuid",
  "receivedAt": "2026-09-13",
  "expiryAt": "2027-09-13",
  "openedAt": "2026-09-20",
  "initialQuantity": "1",
  "entryUnit": "kg",
  "totalCost": "120.00",
  "currency": "CNY"
}
```

`openedAt` 为实际开封日，不能早于入库日、不能晚于有效期。材料上的
`openShelfLifeDays`（开封后建议使用天数，1-3650）与批次开封日共同计算开封后效期；
PATCH `/batches/:id` 可补录或修正开封日（携带 `version`）。

库存调整：

```json
{
  "direction": "OUT",
  "quantity": "30",
  "unit": "g",
  "reason": "盘点发现包装破损",
  "version": 1
}
```

同一 `Idempotency-Key` 重试不会重复调整。

## 6. 项目与需求

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 查询或创建项目 |
| GET/PATCH | `/projects/:id` | 详情或更新 |
| POST | `/projects/:id/status` | 更新状态 |
| POST | `/projects/:id/archive` | 归档 |
| POST | `/projects/:id/requirements` | 添加材料需求 |
| PATCH | `/projects/:id/requirements/:requirementId` | 更新需求 |
| DELETE | `/projects/:id/requirements/:requirementId` | 删除未使用需求 |

材料需求：

```json
{
  "materialId": "uuid",
  "requiredQuantity": "0.5",
  "unit": "kg",
  "purpose": "染液"
}
```

## 7. 消耗与撤销

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/consumptions` | 查询或创建消耗 |
| GET | `/consumptions/:id` | 消耗详情 |
| POST | `/consumptions/:id/reverse` | 撤销 |

首次为计划中的项目创建消耗时，项目会自动转为 `IN_PROGRESS` 并记录审计日志。

创建消耗：

```json
{
  "projectId": "uuid",
  "projectRequirementId": "uuid",
  "batchId": "uuid",
  "usedQuantity": "450",
  "wasteQuantity": "50",
  "unit": "g",
  "consumedAt": "2026-09-13T10:00:00+08:00",
  "purpose": "染液"
}
```

撤销：

```json
{
  "reason": "录入批次错误"
}
```

## 8. 颜色变化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/color-changes` | 查询或记录 |
| GET/PATCH | `/color-changes/:id` | 详情或更新备注 |
| DELETE | `/color-changes/:id` | 删除最新误录记录 |

颜色变化：

```json
{
  "batchId": "uuid",
  "projectId": "uuid",
  "changeType": "DYE_BATH",
  "afterColorName": "深红棕",
  "afterColorHex": "#6B2F1F",
  "affectedQuantity": "450",
  "unit": "g",
  "occurredAt": "2026-09-13T10:05:00+08:00",
  "phValue": 5.5
}
```

颜色变化不扣库存。

## 9. 效期风险规划与人工豁免

规划器是确定性纯计算：同一 `asOf`、速率窗口以及同一批次/消耗/豁免快照，
无论何时重算都得到完全相同的风险级别、处置建议和原因链。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/risk-plans` | 批量重算全部在库批次 |
| GET | `/batches/:id/risk-plan` | 单个批次重算 |
| GET | `/batches/:id/exemptions` | 批次豁免事件链 |
| POST | `/batches/:id/exemptions` | 授予人工豁免 |
| POST | `/exemptions/:id/revoke` | 撤销豁免（只追加事件） |

重算查询参数：

- `asOf`：评估基准日 `YYYY-MM-DD`，默认服务器当天；传入历史日期即可复算历史结果。
- `lookbackDays`：速率回看窗口，7-730，默认 30。
- `riskLevel=CRITICAL|HIGH|MEDIUM|LOW|NONE`：按叠加豁免后的级别筛选。
- `includeExempt=false`：隐藏生效豁免批次，默认包含。
- `includeDepleted=true`：包含已耗尽批次，默认排除。

计算口径：

- 约束到期日取密封有效期与开封后效期（`openedAt + openShelfLifeDays`）中更早者。
- 日使用速率只统计窗口内状态为 `ACTIVE` 的消耗（撤销的消耗不计），
  分母取回看窗口天数、开封后天数与窗口内首次消耗后天数的最小值，避免零消耗天数稀释速率。
- 数量运算使用 6 位小数定点数，速率四舍五入，耗尽天数向下取整，不使用浮点。
- 处置建议：`DISCARD_NOW`（立即报废）、`PRIORITIZE_USE`（优先使用）、
  `USE_OR_PLAN`（安排使用/减量采购）、`MONITOR`（持续观察）、
  `NO_ACTION`（无需处理）、`HOLD_EXEMPT`（豁免保留）。
- 响应同时给出 `underlyingRiskLevel`/`underlyingAction`（豁免前的系统判定）
  和 `reasons` 原因链；每个原因含稳定 `code`（如 `OPEN_EXPIRED`、`SURPLUS_OVER_30D`、
  `EXEMPT_ACTIVE`）、关键数值 `data` 和中文描述。

授予豁免：

```json
{
  "reason": "供应商书面确认延期，留样检测合格",
  "validUntil": "2026-12-31",
  "note": "检测报告编号 AR-202609-18"
}
```

- 豁免只把处置建议改为 `HOLD_EXEMPT`、级别改为 `NONE`，系统原始判定与完整原因链保留。
- 一个批次同一时间至多一条生效豁免；到期后自动恢复系统判定，并在原因链追加 `EXEMPT_EXPIRED`。
- 撤销通过新增 `REVOKE` 事件实现，历史不更新不删除，原因链追加 `EXEMPT_REVOKED`。
- 授予和撤销都写入只追加的审计日志（`GRANT_EXEMPTION` / `REVOKE_EXEMPTION`）。

## 10. 附件和导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments` | multipart 上传 |
| GET | `/attachments/:id` | 受保护下载 |
| DELETE | `/attachments/:id` | 删除 |
| GET | `/exports/materials.csv` | 材料 CSV |
| GET | `/exports/batches.csv` | 批次 CSV |
| GET | `/exports/workspace.json` | 完整 JSON |
| GET | `/audit-logs` | 审计日志 |
| GET | `/dashboard` | 仪表盘 |

附件表单字段：

- `ownerType`：`BATCH`、`COLOR_CHANGE`、`PROJECT` 或 `CONSUMPTION`
- `ownerId`
- `file`

支持 JPEG、PNG、WebP，默认最大 10 MB。
