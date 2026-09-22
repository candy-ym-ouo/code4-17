import { daysBetween } from "./dates.js";
import { canonicalJSON, sha256Hex } from "./hash.js";
import { activeExemption } from "./planner.js";
import type {
  DispositionAction,
  ExemptionChainEntry,
  ExemptionEventType,
  ExemptionRecord,
  PlanItem,
  RiskLevel
} from "./types.js";
import { PlannerError } from "./types.js";

/** 创世前缀：每条链第一个条目的 prevHash 都指向它，使链首也可被校验。 */
export const CHAIN_GENESIS = "genesis:exemption-chain:v1";

export interface GrantInput {
  batchId: string;
  reason: string;
  actor: string;
  /** 豁免保留至 ISO YYYY-MM-DD（含当日）。 */
  validUntil: string;
  grantedOn: string;
  /** 可选：本次授权时该批次的规划结论快照，作为客观依据写入链。 */
  snapshot?: PlanItem | null;
}

export interface RevokeInput {
  batchId: string;
  reason: string;
  actor: string;
  revokedOn: string;
}

function emptyRecord(batchId: string): ExemptionRecord {
  return { batchId, entries: [] };
}

/** 计算单个条目的内容哈希（entryHash 字段本身不参与）。 */
export function hashEntry(entry: Omit<ExemptionChainEntry, "entryHash">): string {
  return sha256Hex(canonicalJSON({ prevHash: entry.prevHash, payload: entry }));
}

function appendEntry(
  record: ExemptionRecord,
  type: ExemptionEventType,
  reason: string,
  actor: string,
  validUntil: string | null,
  occurredOn: string,
  snapshot: PlanItem | null
): ExemptionChainEntry {
  const seq = record.entries.length + 1;
  const prevHash = record.entries[record.entries.length - 1]?.entryHash ?? CHAIN_GENESIS;
  const base: Omit<ExemptionChainEntry, "entryHash"> = {
    seq,
    type,
    reason,
    actor,
    validUntil,
    grantedOn: occurredOn,
    captured: snapshot
      ? {
          riskLevel: snapshot.baseRiskLevel,
          disposition: snapshot.baseDisposition,
          daysToHardExpiry: snapshot.daysToHardDeadline,
          projectedWasteRatio: snapshot.projectedWasteRatio,
          basisHash: snapshot.basisHash
        }
      : {
          riskLevel: "SAFE" as RiskLevel,
          disposition: "USE_AS_PLANNED" as DispositionAction,
          daysToHardExpiry: null,
          projectedWasteRatio: null,
          basisHash: ""
        },
    prevHash
  };
  const entry: ExemptionChainEntry = { ...base, entryHash: hashEntry(base) };
  record.entries.push(entry);
  return entry;
}

/**
 * 授予豁免。若当前已存在同（validUntil、reason、actor）的生效豁免，则幂等返回既有条目，
 * 不新增原因链事件；其余冲突按业务错误拒绝，避免静默覆盖人工决定。
 */
export function grantExemption(
  records: Record<string, ExemptionRecord>,
  input: GrantInput
): { record: ExemptionRecord; entry: ExemptionChainEntry; duplicated: boolean } {
  const record = records[input.batchId] ?? emptyRecord(input.batchId);
  const existing = activeExemption(record, input.grantedOn);
  if (existing) {
    if (
      existing.validUntil === input.validUntil &&
      existing.reason === input.reason &&
      existing.actor === input.actor
    ) {
      const last = record.entries[record.entries.length - 1] as ExemptionChainEntry;
      return { record, entry: last, duplicated: true };
    }
    throw new PlannerError(
      "EXEMPTION_ACTIVE",
      `批次 ${input.batchId} 已有生效豁免（保留至 ${existing.validUntil}），如需变更请使用续期（EXTEND）`
    );
  }
  if (daysBetween(input.grantedOn, input.validUntil) < 0) {
    throw new PlannerError("EXEMPTION_EXPIRED_DATE", "豁免保留期限不能早于授权日期");
  }
  const entry = appendEntry(record, "GRANT", input.reason.trim(), input.actor.trim(), input.validUntil, input.grantedOn, input.snapshot ?? null);
  records[input.batchId] = record;
  return { record, entry, duplicated: false };
}

/**
 * 续期豁免：必须存在生效豁免。先产生一条 REVOKE 语义不需要（续期直接追加 EXTEND 覆盖），
 * 回放时 EXTEND 与 GRANT 一样覆盖当前状态。若参数与现有豁免完全相同则幂等返回。
 */
export function extendExemption(
  records: Record<string, ExemptionRecord>,
  input: GrantInput
): { record: ExemptionRecord; entry: ExemptionChainEntry; duplicated: boolean } {
  const record = records[input.batchId] ?? emptyRecord(input.batchId);
  const existing = activeExemption(record, input.grantedOn);
  if (!existing) {
    throw new PlannerError("EXEMPTION_NOT_ACTIVE", `批次 ${input.batchId} 没有生效豁免，无法续期`);
  }
  if (
    existing.validUntil === input.validUntil &&
    existing.reason === input.reason &&
    existing.actor === input.actor
  ) {
    const last = record.entries[record.entries.length - 1] as ExemptionChainEntry;
    return { record, entry: last, duplicated: true };
  }
  if (daysBetween(input.grantedOn, input.validUntil) < 0) {
    throw new PlannerError("EXEMPTION_EXPIRED_DATE", "续期保留期限不能早于授权日期");
  }
  const entry = appendEntry(record, "EXTEND", input.reason.trim(), input.actor.trim(), input.validUntil, input.grantedOn, input.snapshot ?? null);
  records[input.batchId] = record;
  return { record, entry, duplicated: false };
}

/** 撤销生效豁免：向链尾追加 REVOKE 事件，回放后状态清空。 */
export function revokeExemption(
  records: Record<string, ExemptionRecord>,
  input: RevokeInput
): { record: ExemptionRecord; entry: ExemptionChainEntry } {
  const record = records[input.batchId] ?? emptyRecord(input.batchId);
  if (!activeExemption(record, input.revokedOn)) {
    throw new PlannerError("EXEMPTION_NOT_ACTIVE", `批次 ${input.batchId} 没有生效豁免，无需撤销`);
  }
  const entry = appendEntry(record, "REVOKE", input.reason.trim(), input.actor.trim(), null, input.revokedOn, null);
  records[input.batchId] = record;
  return { record, entry };
}

export interface ChainValidation {
  ok: boolean;
  checked: number;
  brokenAt: number | null;
  errors: string[];
}

/**
 * 校验原因链：序号连续、prevHash 首尾相接、entryHash 重算一致。
 * 只追加策略意味着任何删除/篡改都会让后续哈希全部失配。
 */
export function validateChain(record: ExemptionRecord): ChainValidation {
  const errors: string[] = [];
  let prevHash = CHAIN_GENESIS;
  record.entries.forEach((entry, index) => {
    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) errors.push(`第 ${expectedSeq} 条序号不连续（实际 ${entry.seq}）`);
    if (entry.prevHash !== prevHash) errors.push(`第 ${expectedSeq} 条 prevHash 与上一条不衔接`);
    const { entryHash, ...rest } = entry;
    const recomputed = sha256Hex(canonicalJSON({ prevHash: rest.prevHash, payload: rest }));
    if (recomputed !== entryHash) errors.push(`第 ${expectedSeq} 条内容哈希不匹配（记录被改动）`);
    prevHash = entryHash;
  });
  return { ok: errors.length === 0, checked: record.entries.length, brokenAt: errors.length ? record.entries.length : null, errors };
}

/** 校验仓库中全部原因链。 */
export function validateAllChains(records: Record<string, ExemptionRecord>): {
  ok: boolean;
  results: Record<string, ChainValidation>;
} {
  const results: Record<string, ChainValidation> = {};
  let ok = true;
  for (const [batchId, record] of Object.entries(records)) {
    const result = validateChain(record);
    results[batchId] = result;
    if (!result.ok) ok = false;
  }
  return { ok, results };
}
