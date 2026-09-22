/**
 * 材料效期风险规划器领域模型。
 *
 * 设计原则：
 * - 数量与速率全部使用十进制字符串（与 @handcraft/contracts 的 numeric(18,6) 约定一致），
 *   内部用定标 bigint 计算，杜绝浮点误差。
 * - 日期只使用 ISO `YYYY-MM-DD`，按 UTC 整日比较，结果与时区无关。
 * - 规划（plan）是纯函数：相同输入永远得到相同输出，不读取时钟、不写状态。
 * - 人工豁免（exemption）只追加、不改写，通过 prevHash 形成原因链，规划重算不会改动它。
 */

/** 批次在主库存系统中的生命周期状态。 */
export const batchStatuses = ["ACTIVE", "DEPLETED", "ARCHIVED"] as const;
export type BatchStatus = (typeof batchStatuses)[number];

/** 库存单位（与 contracts.stockUnits 保持同一集合）。 */
export const stockUnits = ["g", "kg", "ml", "l", "mm", "cm", "m", "m2", "pcs"] as const;
export type StockUnit = (typeof stockUnits)[number];

/**
 * 处置建议（机器可执行的主动作）。
 * DISCARD_NOW       立即报废（硬效期已过 / 开封后寿命已尽）
 * FREEZE            冷冻封存（赶不上使用窗口，可通过冷冻延长寿命时）
 * PRIORITIZE        优先消耗（临近效期或预计产生损耗）
 * USE_AS_PLANNED    按计划正常使用（无显著风险）
 * MONITOR           继续观察（缺少使用速率、无法判断是否会浪费时）
 * OPEN_SOON         尽快开封启用（未开封且封存寿命将尽）
 * REORDER           补货（本批次将耗尽，且低于安全库存）
 * RETAIN            人工豁免保留（操作员在保留期内豁免自动处置结论）
 */
export const dispositionActions = [
  "DISCARD_NOW",
  "FREEZE",
  "PRIORITIZE",
  "USE_AS_PLANNED",
  "MONITOR",
  "OPEN_SOON",
  "RETAIN",
  "REORDER"
] as const;
export type DispositionAction = (typeof dispositionActions)[number];

/** 风险等级，按严重程度从高到低。 */
export const riskLevels = ["EXPIRED", "CRITICAL", "HIGH", "MEDIUM", "LOW", "SAFE"] as const;
export type RiskLevel = (typeof riskLevels)[number];

/** 风险来源轴：硬效期紧迫度 / 预计损耗比例 / 两者同级 / 无到期约束，取更严重者。 */
export const riskAxes = ["EXPIRY", "WASTE", "BOTH", "NONE"] as const;
export type RiskAxis = (typeof riskAxes)[number];

/** 豁免原因链事件类型。 */
export const exemptionEventTypes = ["GRANT", "EXTEND", "REVOKE"] as const;
export type ExemptionEventType = (typeof exemptionEventTypes)[number];

/** 一条用于推导使用速率的历史消耗样本（取自主库存系统的 CONSUMPTION 流水/记录）。 */
export interface ConsumptionSample {
  /** 消耗发生日期（ISO YYYY-MM-DD，按本地工作日口径记录）。 */
  consumedOn: string;
  /** 该次总扣减量（实际使用 + 损耗），与批次同一单位。 */
  quantity: string;
}

/** 规划输入的单个批次快照。 */
export interface BatchInput {
  batchId: string;
  materialCode: string | null;
  materialName: string;
  batchCode: string | null;
  unit: StockUnit;
  status: BatchStatus;
  /** 当前剩余量（十进制字符串，非负）。 */
  remainingQuantity: string;
  /** 入库日期 ISO YYYY-MM-DD。 */
  receivedOn: string;
  /** 未开封（硬）效期 ISO YYYY-MM-DD；材料本身无明确效期时为 null。 */
  expiryOn: string | null;
  /** 开封日期 ISO YYYY-MM-DD；null 表示尚未开封。 */
  openedOn: string | null;
  /** 开封后允许使用的天数（开封寿命）；未提供时不计算开封后截止日。 */
  openedShelfDays: number | null;
  /** 最近消耗样本（可乱序，规划器自行按窗口过滤）。 */
  consumptionSamples: ConsumptionSample[];
  /** 手工指定的日均使用速率；提供时覆盖由样本推导的速率。 */
  usageRatePerDay: string | null;
  /** 材料低库存阈值（用于补货建议），与批次同一单位。 */
  lowStockThreshold: string | null;
  /** 采购提前期（天），决定补货触发点。 */
  reorderLeadDays: number;
}

/** 规划阈值，全部可覆盖；缺省值见 DEFAULT_PLANNER_CONFIG。 */
export interface PlannerConfig {
  /** 推导使用速率回看的天数窗口。 */
  rateWindowDays: number;
  /** CRITICAL：剩余可用天数小于该值。 */
  criticalDays: number;
  /** HIGH：剩余可用天数小于该值。 */
  highDays: number;
  /** MEDIUM：剩余可用天数小于该值。 */
  mediumDays: number;
  /** CRITICAL：预计损耗比例 >= 该值（0~1）。 */
  criticalWasteRatio: number;
  /** HIGH：预计损耗比例 >= 该值。 */
  highWasteRatio: number;
  /** MEDIUM：预计损耗比例 >= 该值。 */
  mediumWasteRatio: number;
  /** 无使用速率时，距效期多少天内给出 OPEN_SOON/提示。 */
  unopenedSoonDays: number;
}

/** 单个豁免原因链条目（不可变，只追加）。 */
export interface ExemptionChainEntry {
  /** 链内序号，从 1 开始且连续。 */
  seq: number;
  /** 事件类型。 */
  type: ExemptionEventType;
  /** 人工填写的原因（REVOKE 时可说明撤销理由）。 */
  reason: string;
  /** 操作人标识（如操作员显示名或 id），用于责任追溯。 */
  actor: string;
  /** 豁免保留至 ISO YYYY-MM-DD（含当日）；REVOKE 事件为 null。 */
  validUntil: string | null;
  /** 授权/操作发生日期 ISO YYYY-MM-DD。 */
  grantedOn: string;
  /** 本事件发生时，规划器对该批次算出的风险快照（原因链的客观依据）。 */
  captured: {
    riskLevel: RiskLevel;
    disposition: DispositionAction;
    daysToHardExpiry: number | null;
    projectedWasteRatio: number | null;
    basisHash: string;
  };
  /** 上一条目的 entryHash；首条为固定创世前缀。 */
  prevHash: string;
  /** 本条目的内容哈希：sha256(prevHash + canonicalJSON(除 hash 外字段))。 */
  entryHash: string;
}

/** 规划结果中携带的豁免摘要（规划重算不会修改链本身）。 */
export interface ExemptionSummary {
  active: boolean;
  validUntil: string | null;
  reason: string;
  actor: string;
  grantedOn: string;
  /** 豁免已超出厂商硬效期（继续保留有安全风险）。 */
  beyondHardExpiry: boolean;
  /** 整条链最新哈希，可用于离线比对链是否被改动。 */
  chainHash: string;
  chainLength: number;
}

/** 一条人类可读的判定依据（中文），构成处置建议的原因链。 */
export interface ReasonStep {
  code: string;
  message: string;
}

/** 单个批次的规划结果。 */
export interface PlanItem {
  batchId: string;
  materialCode: string | null;
  materialName: string;
  batchCode: string | null;
  unit: StockUnit;
  opened: boolean;
  /** 当前剩余量（回显，十进制字符串）。 */
  remainingQuantity: string;
  /** 生效硬截止日：未开封取 expiryOn；已开封取 min(expiryOn, openedOn + openedShelfDays)。 */
  hardDeadlineOn: string | null;
  daysToHardDeadline: number | null;
  /** 推导/指定使用的日均使用速率（十进制字符串）；无法判断为 null。 */
  usageRatePerDay: string | null;
  rateSource: "SAMPLES" | "MANUAL" | "NONE";
  /** 按当前速率预计耗尽日期；速率缺失为 null。 */
  projectedDepletionOn: string | null;
  daysToDepletion: number | null;
  /** 截止日前预计消耗量；速率缺失或已过期为 null。 */
  projectedConsumption: string | null;
  /** 截止日预计剩余（潜在浪费量）；速率缺失或已过期为 null。 */
  projectedWaste: string | null;
  projectedWasteRatio: number | null;
  riskLevel: RiskLevel;
  /** 决定最终风险等级的判定轴。 */
  riskAxis: RiskAxis;
  disposition: DispositionAction;
  /** 附带动议（如同时需要补货/冷冻），不替代主动作。 */
  secondaryActions: DispositionAction[];
  reasons: ReasonStep[];
  /** 豁免覆盖：存在生效豁免时，建议被人工保留，base* 字段保留客观结论。 */
  exempt: boolean;
  exemption: ExemptionSummary | null;
  baseRiskLevel: RiskLevel;
  baseDisposition: DispositionAction;
  /** 该规划项全部确定性输入的指纹，便于比对两次重算是否一致。 */
  basisHash: string;
}

export interface PlanSummary {
  asOf: string;
  totalBatches: number;
  planned: number;
  skippedDepleted: number;
  skippedArchived: number;
  exemptActive: number;
  byRisk: Record<RiskLevel, number>;
  byDisposition: Record<DispositionAction, number>;
}

export interface PlanResult {
  asOf: string;
  items: PlanItem[];
  summary: PlanSummary;
}

/** JSON 文件仓库中每个批次的持久记录。 */
export interface BatchRecord extends BatchInput {
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** 豁免原因链仓库记录：每个批次一条只追加的链。 */
export interface ExemptionRecord {
  batchId: string;
  entries: ExemptionChainEntry[];
}

export interface PlannerStoreFile {
  schemaVersion: 1;
  batches: Record<string, BatchRecord>;
  exemptions: Record<string, ExemptionRecord>;
}

export class PlannerError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
