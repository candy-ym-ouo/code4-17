import { resolveConfig } from "./config.js";
import {
  clampRatio,
  formatQuantity,
  formatRate,
  parseQuantity,
  parseRate,
  quantityDivRate,
  rateTimesDays
} from "./decimal.js";
import { addDays, daysBetween, minDate } from "./dates.js";
import { fingerprint } from "./hash.js";
import { deriveUsageRate } from "./rate.js";
import type {
  BatchInput,
  DispositionAction,
  ExemptionRecord,
  PlanItem,
  PlanResult,
  PlanSummary,
  PlannerConfig,
  ReasonStep,
  RiskAxis,
  RiskLevel
} from "./types.js";

const RISK_RANK: Record<RiskLevel, number> = {
  EXPIRED: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  SAFE: 5
};

const RISK_LABEL: Record<RiskLevel, string> = {
  EXPIRED: "已过期",
  CRITICAL: "极高风险",
  HIGH: "高风险",
  MEDIUM: "中风险",
  LOW: "低风险",
  SAFE: "安全"
};

export function riskLabel(level: RiskLevel): string {
  return RISK_LABEL[level];
}

export const ACTION_LABEL: Record<DispositionAction, string> = {
  DISCARD_NOW: "立即报废",
  FREEZE: "冷冻封存",
  PRIORITIZE: "优先消耗",
  USE_AS_PLANNED: "按计划使用",
  MONITOR: "继续观察",
  OPEN_SOON: "尽快开封",
  REORDER: "补货",
  RETAIN: "人工豁免保留"
} as const satisfies Record<DispositionAction, string>;

export interface PlanOptions {
  asOf: string;
  config?: Partial<PlannerConfig>;
  /** batchId -> 豁免链（可选）；规划只读，绝不修改它。 */
  exemptions?: Record<string, ExemptionRecord>;
}

/**
 * 效期风险规划：纯函数。
 *
 * 相同的 (批次快照, asOf, 配置, 豁免链) 必然得到逐字节一致的结论：
 * 不读取时钟、不写任何状态、不依赖对象键枚举顺序。
 */
export function plan(batches: BatchInput[], options: PlanOptions): PlanResult {
  const config = resolveConfig(options.config);
  const exemptions = options.exemptions ?? {};
  const items: PlanItem[] = [];
  let skippedDepleted = 0;
  let skippedArchived = 0;
  let exemptActive = 0;

  for (const batch of batches) {
    if (batch.status === "ARCHIVED") {
      skippedArchived += 1;
      continue;
    }
    const remaining = parseQuantity(batch.remainingQuantity);
    if (batch.status === "DEPLETED" || remaining === 0n) {
      skippedDepleted += 1;
      continue;
    }
    const item = planBatch(batch, options.asOf, config, remaining, exemptions[batch.batchId] ?? null);
    if (item.exempt) exemptActive += 1;
    items.push(item);
  }

  items.sort(comparePlanItems);

  const summary = buildSummary(options.asOf, items, batches.length, skippedDepleted, skippedArchived, exemptActive);
  return { asOf: options.asOf, items, summary };
}

function comparePlanItems(a: PlanItem, b: PlanItem): number {
  const rankDiff = RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  if (rankDiff !== 0) return rankDiff;
  // 同一客观风险等级内，未豁免批次排在被人工保留的批次之前。
  if (a.exempt !== b.exempt) return a.exempt ? 1 : -1;
  const da = a.daysToHardDeadline ?? Number.POSITIVE_INFINITY;
  const db = b.daysToHardDeadline ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  const wa = a.projectedWasteRatio ?? -1;
  const wb = b.projectedWasteRatio ?? -1;
  if (wa !== wb) return wb - wa;
  return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
}

function buildSummary(
  asOf: string,
  items: PlanItem[],
  totalBatches: number,
  skippedDepleted: number,
  skippedArchived: number,
  exemptActive: number
): PlanSummary {
  const byRisk = { EXPIRED: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, SAFE: 0 } as Record<RiskLevel, number>;
  const byDisposition = {
    DISCARD_NOW: 0,
    FREEZE: 0,
    PRIORITIZE: 0,
    USE_AS_PLANNED: 0,
    MONITOR: 0,
    OPEN_SOON: 0,
    REORDER: 0,
    RETAIN: 0
  } as Record<DispositionAction, number>;
  for (const item of items) {
    byRisk[item.riskLevel] += 1;
    byDisposition[item.disposition] += 1;
  }
  return {
    asOf,
    totalBatches,
    planned: items.length,
    skippedDepleted,
    skippedArchived,
    exemptActive,
    byRisk,
    byDisposition
  };
}

interface RateResolution {
  rate: bigint;
  source: "SAMPLES" | "MANUAL" | "NONE";
  sampleCount: number;
  windowFrom: string | null;
  steps: ReasonStep[];
}

function resolveRate(batch: BatchInput, asOf: string, config: PlannerConfig): RateResolution {
  if (batch.usageRatePerDay !== null) {
    const rate = parseRate(batch.usageRatePerDay);
    return {
      rate,
      source: "MANUAL",
      sampleCount: batch.consumptionSamples.length,
      windowFrom: null,
      steps: [
        {
          code: "RATE_MANUAL",
          message: `使用人工指定日均速率 ${formatRate(rate)} ${batch.unit}/天`
        }
      ]
    };
  }
  const derived = deriveUsageRate(batch.consumptionSamples, asOf, config.rateWindowDays);
  if (derived.rate <= 0n) {
    return {
      rate: 0n,
      source: "NONE",
      sampleCount: derived.sampleCount,
      windowFrom: derived.windowFrom,
      steps: [
        {
          code: "RATE_NONE",
          message: `近 ${config.rateWindowDays} 天（自 ${derived.windowFrom}）无消耗记录，无法判断使用速率`
        }
      ]
    };
  }
  return {
    rate: derived.rate,
    source: "SAMPLES",
    sampleCount: derived.sampleCount,
    windowFrom: derived.windowFrom,
    steps: [
      {
        code: "RATE_SAMPLES",
        message: `近 ${config.rateWindowDays} 天 ${derived.sampleCount} 笔消耗共 ${formatQuantity(
          derived.windowQuantity
        )} ${batch.unit}，推导日均速率 ${formatRate(derived.rate)} ${batch.unit}/天`
      }
    ]
  };
}

function levelFromDays(days: number, config: PlannerConfig): RiskLevel {
  if (days < config.criticalDays) return "CRITICAL";
  if (days < config.highDays) return "HIGH";
  if (days < config.mediumDays) return "MEDIUM";
  return "LOW";
}

function levelFromWasteRatio(ratio: number, config: PlannerConfig): RiskLevel {
  if (ratio >= config.criticalWasteRatio) return "CRITICAL";
  if (ratio >= config.highWasteRatio) return "HIGH";
  if (ratio >= config.mediumWasteRatio) return "MEDIUM";
  return "SAFE";
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] <= RISK_RANK[b] ? a : b;
}

function planBatch(
  batch: BatchInput,
  asOf: string,
  config: PlannerConfig,
  remaining: bigint,
  exemptionRecord: ExemptionRecord | null
): PlanItem {
  const reasons: ReasonStep[] = [];
  const opened = batch.openedOn !== null;

  // 1) 生效硬截止日。
  let openedDeadline: string | null = null;
  if (opened && batch.openedShelfDays !== null) {
    openedDeadline = addDays(batch.openedOn as string, batch.openedShelfDays);
  }
  const hardDeadline = minDate(batch.expiryOn, openedDeadline);
  const daysToDeadline = hardDeadline === null ? null : daysBetween(asOf, hardDeadline);
  const expired = hardDeadline !== null && daysToDeadline !== null && daysToDeadline < 0;

  if (hardDeadline === null) {
    reasons.push({ code: "DEADLINE_NONE", message: "未设置效期与开封后寿命，不存在硬截止日" });
  } else if (openedDeadline !== null && hardDeadline === openedDeadline && batch.expiryOn !== openedDeadline) {
    reasons.push({
      code: "DEADLINE_OPENED",
      message: `已于 ${batch.openedOn} 开封，开封后 ${batch.openedShelfDays} 天到期，生效截止日 ${hardDeadline}`
    });
  } else {
    reasons.push({
      code: "DEADLINE_HARD",
      message: `${opened ? "已开封" : "未开封"}，硬效期截止日 ${hardDeadline}`
    });
  }
  if (expired) {
    reasons.push({
      code: "ALREADY_EXPIRED",
      message: `已超过生效截止日 ${-(daysToDeadline as number)} 天，剩余 ${formatQuantity(remaining)} ${
        batch.unit
      } 不得继续使用`
    });
  }

  // 2) 使用速率。
  const rateResolution = resolveRate(batch, asOf, config);
  reasons.push(...rateResolution.steps);
  const rateKnown = rateResolution.source !== "NONE";

  // 3) 消耗投影。
  const usableDays = expired || hardDeadline === null ? null : Math.max(daysToDeadline as number, 0);
  let projectedConsumption: bigint | null = null;
  let projectedWaste: bigint | null = null;
  let wasteRatio: number | null = null;
  let depletionOn: string | null = null;
  let daysToDepletion: number | null = null;

  if (rateResolution.rate > 0n) {
    const depleteDays = quantityDivRate(remaining, rateResolution.rate);
    daysToDepletion = depleteDays;
    depletionOn = depleteDays === null ? null : addDays(asOf, depleteDays);
  }
  if (usableDays !== null && rateKnown) {
    projectedConsumption = rateTimesDays(rateResolution.rate, usableDays);
    if (projectedConsumption >= remaining) {
      projectedConsumption = remaining;
      projectedWaste = 0n;
      wasteRatio = 0;
      reasons.push({
        code: "PROJECTION_FINISH",
        message: `预计 ${daysToDepletion} 天耗尽（${depletionOn}），早于截止日，无到期损耗`
      });
    } else {
      projectedWaste = remaining - projectedConsumption;
      wasteRatio = clampRatio(Number(projectedWaste) / Number(remaining));
      reasons.push({
        code: "PROJECTION_WASTE",
        message: `截止日前预计使用 ${formatQuantity(projectedConsumption)} ${batch.unit}，剩余 ${formatQuantity(
          projectedWaste
        )} ${batch.unit}（约 ${(wasteRatio * 100).toFixed(1)}%）将到期损耗`
      });
    }
  }

  // 4) 客观风险等级。
  let riskLevel: RiskLevel;
  let riskAxis: RiskAxis;
  if (expired) {
    riskLevel = "EXPIRED";
    riskAxis = "EXPIRY";
    reasons.push({ code: "RISK_EXPIRED", message: "风险等级：已过期（硬截止日已过，最高优先级）" });
  } else if (hardDeadline === null) {
    riskLevel = "SAFE";
    riskAxis = "NONE";
    reasons.push({ code: "RISK_NONE", message: "风险等级：安全（无到期约束）" });
  } else {
    const expiryLevel = levelFromDays(daysToDeadline as number, config);
    if (rateKnown && rateResolution.rate > 0n && wasteRatio !== null) {
      const wasteLevel = levelFromWasteRatio(wasteRatio, config);
      riskLevel = maxRisk(expiryLevel, wasteLevel);
      riskAxis = RISK_RANK[wasteLevel] < RISK_RANK[expiryLevel] ? "WASTE" : "EXPIRY";
      if (wasteLevel === expiryLevel) riskAxis = "BOTH" as RiskAxis;
      reasons.push({
        code: "RISK_COMBINED",
        message: `效期紧迫度=${RISK_LABEL[expiryLevel]}，损耗风险=${RISK_LABEL[wasteLevel]}，综合为「${RISK_LABEL[riskLevel]}」`
      });
    } else {
      riskLevel = expiryLevel;
      riskAxis = "EXPIRY";
      reasons.push({
        code: "RISK_EXPIRY_ONLY",
        message: `缺少可信使用速率，仅按效期紧迫度判定为「${RISK_LABEL[expiryLevel]}」`
      });
    }
  }

  // 5) 处置建议（主动作 + 附带动议）。
  let disposition: DispositionAction;
  const secondaryActions: DispositionAction[] = [];

  if (expired) {
    disposition = "DISCARD_NOW";
  } else if (!rateKnown) {
    if (
      !opened &&
      hardDeadline !== null &&
      (daysToDeadline as number) <= config.unopenedSoonDays
    ) {
      disposition = "OPEN_SOON";
    } else if (hardDeadline !== null && RISK_RANK[riskLevel] <= RISK_RANK.MEDIUM) {
      disposition = "MONITOR";
    } else {
      disposition = "USE_AS_PLANNED";
    }
  } else if (riskLevel === "CRITICAL" || riskLevel === "HIGH" || riskLevel === "MEDIUM") {
    disposition = "PRIORITIZE";
  } else {
    disposition = "USE_AS_PLANNED";
  }

  // 冷冻建议：高损耗且尚有时间窗口时，作为优先消耗之外的备选动议。
  if (
    !expired &&
    wasteRatio !== null &&
    wasteRatio >= config.highWasteRatio &&
    hardDeadline !== null &&
    (daysToDeadline as number) > 0
  ) {
    secondaryActions.push("FREEZE");
  }

  // 补货动议：提前期末预计跌破低库存阈值。
  const threshold = batch.lowStockThreshold === null ? null : parseQuantity(batch.lowStockThreshold);
  if (threshold !== null) {
    let projectedAtLead: bigint;
    if (rateResolution.rate > 0n) {
      projectedAtLead = remaining - rateTimesDays(rateResolution.rate, Math.max(batch.reorderLeadDays, 0));
      if (projectedAtLead < 0n) projectedAtLead = 0n;
    } else {
      projectedAtLead = remaining;
    }
    if (projectedAtLead <= threshold) {
      secondaryActions.push("REORDER");
      reasons.push({
        code: "REORDER_HINT",
        message:
          rateResolution.rate > 0n
            ? `提前期 ${batch.reorderLeadDays} 天后预计库存 ${formatQuantity(projectedAtLead)} ${batch.unit}，不高于安全库存 ${formatQuantity(
                threshold
              )} ${batch.unit}，建议补货`
            : `当前库存 ${formatQuantity(remaining)} ${batch.unit} 已不高于安全库存 ${formatQuantity(
                threshold
              )} ${batch.unit}，建议补货`
      });
    }
  }

  reasons.push({ code: `ACTION_${disposition}`, message: `处置建议：${ACTION_LABEL[disposition]}` });
  for (const secondary of secondaryActions) {
    reasons.push({ code: `ACTION_${secondary}`, message: `附带动议：${ACTION_LABEL[secondary]}` });
  }

  // 6) 确定性指纹：只依赖影响结论的输入与生效配置。
  const basisHash = fingerprint({
    asOf,
    config,
    batch: {
      batchId: batch.batchId,
      remainingQuantity: batch.remainingQuantity,
      receivedOn: batch.receivedOn,
      expiryOn: batch.expiryOn,
      openedOn: batch.openedOn,
      openedShelfDays: batch.openedShelfDays,
      usageRatePerDay: batch.usageRatePerDay,
      lowStockThreshold: batch.lowStockThreshold,
      reorderLeadDays: batch.reorderLeadDays,
      samples: [...batch.consumptionSamples]
        .map((sample) => ({ consumedOn: sample.consumedOn, quantity: sample.quantity }))
        .sort((a, b) => (a.consumedOn === b.consumedOn ? 0 : a.consumedOn < b.consumedOn ? -1 : 1))
    }
  });

  const item: PlanItem = {
    batchId: batch.batchId,
    materialCode: batch.materialCode,
    materialName: batch.materialName,
    batchCode: batch.batchCode,
    unit: batch.unit,
    opened,
    remainingQuantity: formatQuantity(remaining),
    hardDeadlineOn: hardDeadline,
    daysToHardDeadline: daysToDeadline,
    usageRatePerDay: rateResolution.rate > 0n || rateResolution.source === "MANUAL" ? formatRate(rateResolution.rate) : null,
    rateSource: rateResolution.source,
    projectedDepletionOn: depletionOn,
    daysToDepletion,
    projectedConsumption: projectedConsumption === null ? null : formatQuantity(projectedConsumption),
    projectedWaste: projectedWaste === null ? null : formatQuantity(projectedWaste),
    projectedWasteRatio: wasteRatio,
    riskLevel,
    riskAxis,
    disposition,
    secondaryActions,
    reasons,
    exempt: false,
    exemption: null,
    baseRiskLevel: riskLevel,
    baseDisposition: disposition,
    basisHash
  };

  applyExemption(item, exemptionRecord, asOf, hardDeadline);
  return item;
}

function applyExemption(
  item: PlanItem,
  record: ExemptionRecord | null,
  asOf: string,
  hardDeadline: string | null
): void {
  if (!record) return;
  const active = activeExemption(record, asOf);
  if (!active) return;

  item.exempt = true;
  item.baseRiskLevel = item.riskLevel;
  item.baseDisposition = item.disposition;
  item.disposition = "RETAIN";
  item.exemption = {
    active: true,
    validUntil: active.validUntil,
    reason: active.reason,
    actor: active.actor,
    grantedOn: active.grantedOn,
    beyondHardExpiry: hardDeadline !== null && daysBetween(hardDeadline, active.validUntil as string) > 0,
    chainHash: record.entries[record.entries.length - 1]?.entryHash ?? "",
    chainLength: record.entries.length
  };
  item.reasons.push({
    code: "EXEMPT_ACTIVE",
    message: `人工豁免保留至 ${active.validUntil}（操作人 ${active.actor}，原因：${active.reason}）；客观结论仍为「${
      RISK_LABEL[item.baseRiskLevel]
    }/${ACTION_LABEL[item.baseDisposition]}」`
  });
  if (item.exemption.beyondHardExpiry) {
    item.reasons.push({
      code: "EXEMPT_BEYOND_HARD",
      message: `豁免保留期 ${active.validUntil} 已超过硬截止日 ${hardDeadline}，继续使用存在安全/品质风险，需重新检验`
    });
  }
}

interface ActiveExemptionState {
  validUntil: string | null;
  reason: string;
  actor: string;
  grantedOn: string;
}

/** 顺序回放原因链，求当前生效的豁免状态（REVOKE 清空，GRANT/EXTEND 覆盖）。 */
export function activeExemption(record: ExemptionRecord, asOf: string): ActiveExemptionState | null {
  let state: ActiveExemptionState | null = null;
  for (const entry of [...record.entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.type === "REVOKE") {
      state = null;
    } else {
      state = { validUntil: entry.validUntil, reason: entry.reason, actor: entry.actor, grantedOn: entry.grantedOn };
    }
  }
  if (state && state.validUntil !== null && daysBetween(asOf, state.validUntil) >= 0) {
    return state;
  }
  return null;
}
