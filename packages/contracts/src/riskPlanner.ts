/**
 * 材料效期风险规划器 —— 纯函数确定性核心。
 *
 * 同样的输入（批次、消耗、豁免和 asOf 日期）永远产生同样的建议，
 * 不依赖当前时间、环境或数据库。服务端按 asOf 重算，结果稳定可复算。
 */

export const RISK_LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const DISPOSAL_ACTIONS = [
  "DISCARD_NOW",
  "PRIORITIZE_USE",
  "USE_OR_PLAN",
  "MONITOR",
  "NO_ACTION",
  "HOLD_EXEMPT"
] as const;
export type DisposalAction = (typeof DISPOSAL_ACTIONS)[number];

/** 开封后效期剩余天数小于该值进入高风险（临期）。 */
export const OPEN_SHELF_WARNING_DAYS = 7;
/** 开封后效期剩余天数小于该值进入中风险。 */
export const OPEN_SHELF_WATCH_DAYS = 14;
/** 速率回看窗口允许的天数范围。 */
export const MIN_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 730;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_OPEN_SHELF_LIFE_DAYS = 3650;

/** 风险原因代码 —— 原因链中的每一环都带 code，便于展示和复核。 */
export const RISK_REASON_CODES = [
  "SEALED_EXPIRED",
  "OPEN_EXPIRED",
  "EXPIRY_WARNING",
  "EXPIRY_WATCH",
  "OPEN_WARNING",
  "OPEN_WATCH",
  "OPENED_NO_SHELF_LIFE",
  "NO_USAGE",
  "USAGE_ESTIMATED",
  "RUNS_OUT_BEFORE_DEADLINE",
  "RUNS_OUT_AT_DEADLINE",
  "SURPLUS_OVER_30D",
  "SURPLUS_OVER_7D",
  "NO_BINDING_DEADLINE",
  "BATCH_DEPLETED",
  "EXEMPT_ACTIVE",
  "EXEMPT_EXPIRING",
  "EXEMPT_EXPIRED",
  "EXEMPT_REVOKED"
] as const;
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];

export type RiskReason = {
  code: RiskReasonCode;
  /** 该环节参与判定的关键数值，全部为可复算的整数天数/数量字符串。 */
  data?: Record<string, string | number>;
  /** 中文原因描述，由确定性模板生成。 */
  message: string;
};

export type PlannerExemption = {
  /** GRANT 事件 ID。 */
  id: string;
  reason: string;
  validFrom: string;
  validUntil: string;
  /** ACTIVE：窗口覆盖 asOf 且未撤销；EXPIRED：窗口已过；REVOKED：已被 REVOKE 事件撤销。 */
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
  revokedReason: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type PlannerConsumption = {
  /** 消耗发生时刻（ISO 8601）。仅统计状态为 ACTIVE 的消耗。 */
  consumedAt: string;
  /** 该笔消耗总扣减量（使用 + 损耗），批次库存单位、最多 6 位小数。 */
  totalQuantity: string;
};

export type PlannerBatchInput = {
  id: string;
  remainingQuantity: string;
  stockUnit: string;
  expiryAt: string | null;
  openedAt: string | null;
  /** 材料档案配置的开封后建议使用天数。 */
  openShelfLifeDays: number | null;
  consumptions: PlannerConsumption[];
  /** 最新一条豁免（含已过期/已撤销），可为空。 */
  latestExemption?: PlannerExemption | null;
};

export type PlannerOptions = {
  /** 评估基准日（YYYY-MM-DD），传入则重算结果与运行时间无关。 */
  asOf: string;
  /** 速率回看窗口天数。 */
  lookbackDays: number;
};

export type BindingDeadline = {
  kind: "SEALED_EXPIRY" | "OPEN_SHELF_LIFE";
  date: string;
  daysRemaining: number;
  source?: string;
};

export type BatchRiskPlan = {
  batchId: string;
  stockUnit: string;
  asOf: string;
  lookbackDays: number;
  remainingQuantity: string;
  openedAt: string | null;
  sealedExpiryAt: string | null;
  /** 同时起约束作用的到期日：密封有效期与开封后效期中最早者。 */
  bindingDeadline: BindingDeadline | null;
  sealedDaysRemaining: number | null;
  openDaysRemaining: number | null;
  /** 速率统计窗口内 ACTIVE 消耗的总量与笔数。 */
  consumedQuantity: string;
  consumptionCount: number;
  /** 速率实际采用的分母天数（回看窗口、开封后天数、窗口内首次消耗后天数的最小值）。 */
  rateBasisDays: number;
  /** 平均日使用速率（库存单位/天），6 位小数字符串；无样本为 null。 */
  dailyUsageRate: string | null;
  /** 按当前剩余量与速率估算的耗尽天数（向下取整），无速率为 null。 */
  coverageDays: number | null;
  /** 到达约束到期日时的预计剩余量（可能为负），无约束或无速率为 null。 */
  projectedLeftover: string | null;
  /** 豁免叠加前的原始风险与建议。 */
  underlyingRiskLevel: RiskLevel;
  underlyingAction: DisposalAction;
  /** 对外生效的风险与建议（有效豁免时降为 NONE/HOLD_EXEMPT）。 */
  riskLevel: RiskLevel;
  action: DisposalAction;
  exempt: boolean;
  exemption: PlannerExemption | null;
  reasons: RiskReason[];
};

const RATE_SCALE = 1_000_000n;

export function parseDateParts(value: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`INVALID_DATE:${value}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** 以 UTC 纪元天数计算的确定性日期差：right - left。 */
export function daysBetween(left: string, right: string): number {
  const epochDays = (value: string) => {
    const { y, m, d } = parseDateParts(value);
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  };
  return epochDays(right) - epochDays(left);
}

export function addDays(value: string, days: number): string {
  const ms = Date.UTC(parseDateParts(value).y, parseDateParts(value).m - 1, parseDateParts(value).d) + days * 86_400_000;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function toScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("INVALID_QUANTITY");
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * RATE_SCALE + BigInt(fraction);
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / RATE_SCALE;
  const fraction = (absolute % RATE_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** 整除并向下取整（对负数同样向负无穷取整）。 */
function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  if ((remainder !== 0n) && ((value < 0n) !== (divisor < 0n))) return quotient - 1n;
  return quotient;
}

function usageInt(message: string, data?: Record<string, string | number>): RiskReason {
  return { code: "USAGE_ESTIMATED", data, message };
}

/**
 * 评估单个批次。结果仅由入参决定：同一输入多次调用结果完全一致，
 * 与输入数组顺序无关（消耗先按时间排序后再统计）。
 */
export function planBatchRisk(batch: PlannerBatchInput, options: PlannerOptions): BatchRiskPlan {
  if (!Number.isInteger(options.lookbackDays) || options.lookbackDays < MIN_LOOKBACK_DAYS || options.lookbackDays > MAX_LOOKBACK_DAYS) {
    throw new Error(`INVALID_LOOKBACK_DAYS:${options.lookbackDays}`);
  }
  if (!batch.stockUnit) throw new Error("INVALID_STOCK_UNIT");

  const reasons: RiskReason[] = [];
  const sealedDaysRemaining = batch.expiryAt ? daysBetween(options.asOf, batch.expiryAt) : null;
  let openDaysRemaining: number | null = null;
  if (batch.openedAt && batch.openShelfLifeDays !== null) {
    openDaysRemaining = daysBetween(options.asOf, addDays(batch.openedAt, batch.openShelfLifeDays));
  }

  // 开封本身（即使没配置开封效期）就是需要暴露的事实。
  if (batch.openedAt && batch.openShelfLifeDays === null) {
    reasons.push({
      code: "OPENED_NO_SHELF_LIFE",
      data: { openedAt: batch.openedAt },
      message: `批次已于 ${batch.openedAt} 开封，但材料未配置开封后建议使用天数，无法计算开封效期`
    });
  }

  // ---- 确定性速率：窗口内 ACTIVE 消耗，按 consumedAt 早到晚排序 ----
  const windowStart = addDays(options.asOf, -options.lookbackDays);
  const inWindow = batch.consumptions
    .filter((item) => {
      const day = item.consumedAt.slice(0, 10);
      return day > windowStart && day <= options.asOf;
    })
    .slice()
    .sort((a, b) => (a.consumedAt < b.consumedAt ? -1 : a.consumedAt > b.consumedAt ? 1 : 0));
  let consumedScaled = 0n;
  for (const item of inWindow) consumedScaled += toScaled(item.totalQuantity);

  // 速率分母：回看窗口、开封后天数、首次消耗后天数三者最小，避免用零消耗天数稀释速率。
  let rateBasisDays = options.lookbackDays;
  if (batch.openedAt) {
    const sinceOpened = Math.max(daysBetween(batch.openedAt, options.asOf), 0);
    if (sinceOpened > 0 && sinceOpened < rateBasisDays) rateBasisDays = sinceOpened;
  }
  if (inWindow[0]) {
    const sinceFirst = Math.max(daysBetween(inWindow[0].consumedAt.slice(0, 10), options.asOf), 1);
    if (sinceFirst < rateBasisDays) rateBasisDays = sinceFirst;
  }
  const hasUsage = inWindow.length > 0 && consumedScaled > 0n;
  let dailyRateScaled: bigint | null = null;
  if (hasUsage) {
    // consumed、rate 均以 6 位小数定点表示（scaled = 单位 × 1e6）。
    // rate_scaled = round(consumed_scaled / basis)。
    const basis = BigInt(rateBasisDays);
    dailyRateScaled = (consumedScaled + basis / 2n) / basis;
  }

  const remainingScaled = toScaled(batch.remainingQuantity);
  let coverageDays: number | null = null;
  if (dailyRateScaled !== null && dailyRateScaled > 0n) {
    coverageDays = Number(floorDiv(remainingScaled, dailyRateScaled));
  }

  // ---- 约束到期日：密封有效期与开封后效期同时生效，取更早者 ----
  const deadlines: BindingDeadline[] = [];
  if (batch.expiryAt) {
    deadlines.push({ kind: "SEALED_EXPIRY", date: batch.expiryAt, daysRemaining: sealedDaysRemaining ?? 0 });
  }
  if (batch.openedAt && batch.openShelfLifeDays !== null) {
    deadlines.push({
      kind: "OPEN_SHELF_LIFE",
      date: addDays(batch.openedAt, batch.openShelfLifeDays),
      daysRemaining: openDaysRemaining ?? 0,
      source: batch.openedAt
    });
  }
  deadlines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind.localeCompare(b.kind)));
  const binding = deadlines[0] ?? null;

  let projectedLeftover: string | null = null;
  if (binding && dailyRateScaled !== null) {
    const horizon = Math.max(binding.daysRemaining, 0);
    projectedLeftover = fromScaled(remainingScaled - dailyRateScaled * BigInt(horizon));
  }

  // ---- 豁免叠加前的基础判定 ----
  let riskLevel: RiskLevel;
  let action: DisposalAction;

  // 已耗尽批次没有需要处置的实物，不产生报废/优先使用类紧急建议。
  const isDepleted = remainingScaled === 0n;

  const expired = deadlines.filter((deadline) => deadline.daysRemaining < 0);
  if (!isDepleted) {
    for (const deadline of expired) {
      if (deadline.kind === "SEALED_EXPIRY") {
        reasons.push({
          code: "SEALED_EXPIRED",
          data: { expiryAt: deadline.date, daysOverdue: -deadline.daysRemaining },
          message: `密封有效期 ${deadline.date} 已过期 ${-deadline.daysRemaining} 天`
        });
      } else {
        reasons.push({
          code: "OPEN_EXPIRED",
          data: { openedAt: deadline.source ?? "", openShelfDeadline: deadline.date, daysOverdue: -deadline.daysRemaining },
          message: `开封后效期至 ${deadline.date}，已过期 ${-deadline.daysRemaining} 天`
        });
      }
    }
  }

  if (isDepleted) {
    reasons.push({ code: "BATCH_DEPLETED", message: "批次剩余量为 0，无实物需要处置" });
    riskLevel = "NONE";
    action = "NO_ACTION";
  } else if (expired.length > 0) {
    riskLevel = "CRITICAL";
    action = "DISCARD_NOW";
    if (hasUsage) {
      reasons.push(usageInt(`近 ${rateBasisDays} 天平均日使用 ${fromScaled(dailyRateScaled ?? 0n)} ${batch.stockUnit}/天，已过期批次不得继续使用，立即报废`, { rateBasisDays }));
    }
  } else if (binding) {
    // 临期阈值原因（区分密封有效期与开封后效期）
    const isOpen = binding.kind === "OPEN_SHELF_LIFE";
    const deadlineLabel = isOpen ? "开封后效期" : "有效期";
    if (binding.daysRemaining < OPEN_SHELF_WARNING_DAYS) {
      reasons.push({
        code: isOpen ? "OPEN_WARNING" : "EXPIRY_WARNING",
        data: { daysRemaining: binding.daysRemaining, deadline: binding.date },
        message: `距${deadlineLabel} ${binding.date} 仅剩 ${binding.daysRemaining} 天`
      });
    } else if (binding.daysRemaining < OPEN_SHELF_WATCH_DAYS) {
      reasons.push({
        code: isOpen ? "OPEN_WATCH" : "EXPIRY_WATCH",
        data: { daysRemaining: binding.daysRemaining, deadline: binding.date },
        message: `距${deadlineLabel} ${binding.date} 还有 ${binding.daysRemaining} 天`
      });
    }

    if (!hasUsage) {
      reasons.push({ code: "NO_USAGE", data: { lookbackDays: options.lookbackDays }, message: `近 ${options.lookbackDays} 天没有实际消耗记录，无法估算使用速率` });
      if (binding.daysRemaining < OPEN_SHELF_WARNING_DAYS) {
        riskLevel = "HIGH";
        action = "PRIORITIZE_USE";
      } else {
        riskLevel = "MEDIUM";
        action = "USE_OR_PLAN";
      }
    } else if (coverageDays === null) {
      reasons.push({ code: "NO_USAGE", message: "使用速率为零，剩余量预计无法耗尽" });
      riskLevel = "MEDIUM";
      action = "USE_OR_PLAN";
    } else {
      const horizon = Math.max(binding.daysRemaining, 0);
      const surplusDays = coverageDays - horizon;
      if (surplusDays < 0) {
        reasons.push({
          code: "RUNS_OUT_BEFORE_DEADLINE",
          data: { coverageDays, horizon, shortageDays: -surplusDays },
          message: `按当前速率约 ${coverageDays} 天耗尽，早于到期日 ${-surplusDays} 天，到期前可正常用完`
        });
        riskLevel = "LOW";
        action = "NO_ACTION";
      } else if (surplusDays === 0) {
        reasons.push({
          code: "RUNS_OUT_AT_DEADLINE",
          data: { coverageDays, horizon },
          message: `按当前速率恰好在到期日前后耗尽（约 ${coverageDays} 天）`
        });
        riskLevel = "LOW";
        action = "MONITOR";
      } else if (surplusDays > 30) {
        reasons.push({
          code: "SURPLUS_OVER_30D",
          data: { coverageDays, horizon, surplusDays, projectedLeftover: projectedLeftover ?? "" },
          message: `按当前速率到期后仍可用 ${surplusDays} 天，预计到期剩余 ${projectedLeftover ?? ""} ${batch.stockUnit}，建议减量采购或优先调拨使用`
        });
        riskLevel = "MEDIUM";
        action = "USE_OR_PLAN";
      } else if (surplusDays > 7) {
        reasons.push({
          code: "SURPLUS_OVER_7D",
          data: { coverageDays, horizon, surplusDays, projectedLeftover: projectedLeftover ?? "" },
          message: `按当前速率到期后仍可用 ${surplusDays} 天，预计到期剩余 ${projectedLeftover ?? ""} ${batch.stockUnit}，建议优先安排项目消耗`
        });
        riskLevel = "HIGH";
        action = "PRIORITIZE_USE";
      } else {
        reasons.push({
          code: "RUNS_OUT_AT_DEADLINE",
          data: { coverageDays, horizon, surplusDays },
          message: `到期后余量约 ${surplusDays} 天用量，临近到期请留意`
        });
        riskLevel = "LOW";
        action = "MONITOR";
      }
      reasons.push(usageInt(`近 ${rateBasisDays} 天消耗 ${fromScaled(consumedScaled)} ${batch.stockUnit}（${inWindow.length} 笔），平均 ${fromScaled(dailyRateScaled ?? 0n)} ${batch.stockUnit}/天`, { rateBasisDays, consumptionCount: inWindow.length }));
    }
  } else {
    // 没有任何约束到期日
    reasons.push({ code: "NO_BINDING_DEADLINE", message: "未设置有效期或开封后效期，到期风险无法判定" });
    if (!hasUsage) {
      reasons.push({ code: "NO_USAGE", data: { lookbackDays: options.lookbackDays }, message: `近 ${options.lookbackDays} 天没有实际消耗记录，无法估算使用速率` });
      riskLevel = "MEDIUM";
      action = "USE_OR_PLAN";
    } else {
      reasons.push(usageInt(`近 ${rateBasisDays} 天平均日使用 ${fromScaled(dailyRateScaled ?? 0n)} ${batch.stockUnit}/天，无到期约束`, { rateBasisDays }));
      riskLevel = "LOW";
      action = "NO_ACTION";
    }
  }

  // ---- 人工豁免叠加：原因链保留，建议与风险级别按豁免状态调整 ----
  const exemption = batch.latestExemption ?? null;
  let exempt = false;
  const underlyingRiskLevel = riskLevel;
  const underlyingAction = action;

  if (exemption) {
    const withinWindow = options.asOf >= exemption.validFrom && options.asOf <= exemption.validUntil;
    if (exemption.status === "REVOKED") {
      reasons.push({
        code: "EXEMPT_REVOKED",
        data: { exemptionId: exemption.id },
        message: `人工豁免已撤销：${exemption.revokedReason || "未填写撤销原因"}`
      });
    } else if (!withinWindow) {
      reasons.push({
        code: "EXEMPT_EXPIRED",
        data: { exemptionId: exemption.id, validFrom: exemption.validFrom, validUntil: exemption.validUntil },
        message: `人工豁免窗口 ${exemption.validFrom} 至 ${exemption.validUntil} 已结束，恢复系统建议：${exemption.reason}`
      });
    } else {
      const daysToExemptionEnd = daysBetween(options.asOf, exemption.validUntil);
      reasons.push({
        code: "EXEMPT_ACTIVE",
        data: { exemptionId: exemption.id, validFrom: exemption.validFrom, validUntil: exemption.validUntil, daysRemaining: daysToExemptionEnd },
        message: `人工豁免生效至 ${exemption.validUntil}（剩余 ${daysToExemptionEnd} 天）：${exemption.reason}`
      });
      exempt = true;
      if (daysToExemptionEnd <= 3) {
        reasons.push({
          code: "EXEMPT_EXPIRING",
          data: { validUntil: exemption.validUntil, daysRemaining: daysToExemptionEnd },
          message: `豁免将于 ${daysToExemptionEnd} 天后到期，到期后自动恢复系统判定`
        });
      }
      riskLevel = "NONE";
      action = "HOLD_EXEMPT";
    }
  }

  return {
    batchId: batch.id,
    stockUnit: batch.stockUnit,
    asOf: options.asOf,
    lookbackDays: options.lookbackDays,
    remainingQuantity: batch.remainingQuantity,
    openedAt: batch.openedAt,
    sealedExpiryAt: batch.expiryAt,
    bindingDeadline: binding,
    sealedDaysRemaining,
    openDaysRemaining,
    consumedQuantity: fromScaled(consumedScaled),
    consumptionCount: inWindow.length,
    rateBasisDays,
    dailyUsageRate: dailyRateScaled === null ? null : fromScaled(dailyRateScaled),
    coverageDays,
    projectedLeftover,
    underlyingRiskLevel,
    underlyingAction,
    riskLevel,
    action,
    exempt,
    exemption,
    reasons
  };
}

export type PlannerSummary = {
  total: number;
  byRiskLevel: Record<RiskLevel, number>;
  exemptCount: number;
  criticalBatchIds: string[];
};

export function summarizePlans(plans: BatchRiskPlan[]): PlannerSummary {
  const byRiskLevel = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 } as Record<RiskLevel, number>;
  let exemptCount = 0;
  const criticalBatchIds: string[] = [];
  for (const plan of plans) {
    byRiskLevel[plan.riskLevel] += 1;
    if (plan.exempt) exemptCount += 1;
    if (plan.underlyingRiskLevel === "CRITICAL" && !plan.exempt) criticalBatchIds.push(plan.batchId);
  }
  return { total: plans.length, byRiskLevel, exemptCount, criticalBatchIds };
}
