import { describe, expect, it } from "vitest";
import {
  CHAIN_GENESIS,
  activeExemption,
  grantExemption,
  extendExemption,
  revokeExemption,
  validateChain
} from "../src/index.js";
import { plan } from "../src/index.js";
import type { ExemptionRecord, PlanItem } from "../src/types.js";
import { PlannerError } from "../src/types.js";
import { makeBatch } from "./fixtures.js";

const BATCH = "batch-chain";

function snapshotOf(asOf: string): PlanItem {
  const item = plan(
    [makeBatch({ batchId: BATCH, expiryOn: "2026-09-25", remainingQuantity: "5000" })],
    { asOf }
  ).items[0];
  if (!item) throw new Error("snapshot expected");
  return item;
}

describe("exemption append-only reason chain", () => {
  it("grants, extends and revokes while replaying to the current state", () => {
    const records: Record<string, ExemptionRecord> = {};
    grantExemption(records, {
      batchId: BATCH,
      reason: "留待周末使用",
      actor: "林染",
      validUntil: "2026-09-27",
      grantedOn: "2026-09-22",
      snapshot: snapshotOf("2026-09-22")
    });
    expect(activeExemption(records[BATCH] as ExemptionRecord, "2026-09-22")?.validUntil).toBe("2026-09-27");

    extendExemption(records, {
      batchId: BATCH,
      reason: "窑炉检修",
      actor: "林染",
      validUntil: "2026-10-10",
      grantedOn: "2026-09-26",
      snapshot: snapshotOf("2026-09-26")
    });
    expect(activeExemption(records[BATCH] as ExemptionRecord, "2026-09-26")?.reason).toBe("窑炉检修");

    revokeExemption(records, {
      batchId: BATCH,
      reason: "复检不合格",
      actor: "林染",
      revokedOn: "2026-09-28"
    });
    expect(activeExemption(records[BATCH] as ExemptionRecord, "2026-09-28")).toBeNull();

    const record = records[BATCH] as ExemptionRecord;
    expect(record.entries.map((entry) => entry.type)).toEqual(["GRANT", "EXTEND", "REVOKE"]);
    expect(record.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    // 历史条目绝不被改写：第一条原因依旧保留
    expect(record.entries[0]?.reason).toBe("留待周末使用");
  });

  it("captures the objective risk snapshot at grant time", () => {
    const records: Record<string, ExemptionRecord> = {};
    grantExemption(records, {
      batchId: BATCH,
      reason: "密封完好",
      actor: "林染",
      validUntil: "2026-10-10",
      grantedOn: "2026-09-26",
      snapshot: snapshotOf("2026-09-26")
    });
    const captured = records[BATCH]?.entries[0]?.captured;
    expect(captured?.riskLevel).toBe("EXPIRED");
    expect(captured?.disposition).toBe("DISCARD_NOW");
    expect(captured?.basisHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent for identical grant requests", () => {
    const records: Record<string, ExemptionRecord> = {};
    const input = {
      batchId: BATCH,
      reason: "同因同期限",
      actor: "林染",
      validUntil: "2026-09-30",
      grantedOn: "2026-09-22",
      snapshot: null
    };
    const first = grantExemption(records, input);
    const second = grantExemption(records, input);
    expect(second.duplicated).toBe(true);
    expect(records[BATCH]?.entries).toHaveLength(1);
    expect(second.entry.entryHash).toBe(first.entry.entryHash);
  });

  it("rejects a conflicting grant while one is active and rejects extend/revoke without one", () => {
    const records: Record<string, ExemptionRecord> = {};
    grantExemption(records, {
      batchId: BATCH,
      reason: "首次",
      actor: "林染",
      validUntil: "2026-09-30",
      grantedOn: "2026-09-22",
      snapshot: null
    });
    expect(() =>
      grantExemption(records, {
        batchId: BATCH,
        reason: "不同原因",
        actor: "林染",
        validUntil: "2026-10-01",
        grantedOn: "2026-09-22",
        snapshot: null
      })
    ).toThrow(PlannerError);
    try {
      revokeExemption(records, { batchId: "other", reason: "无生效豁免", actor: "林染", revokedOn: "2026-09-22" });
      throw new Error("应当抛出异常");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerError);
      expect((error as PlannerError).code).toBe("EXEMPTION_NOT_ACTIVE");
    }
  });

  it("treats an expired validity window as no longer active", () => {
    const records: Record<string, ExemptionRecord> = {};
    grantExemption(records, {
      batchId: BATCH,
      reason: "短期保留",
      actor: "林染",
      validUntil: "2026-09-20",
      grantedOn: "2026-09-18",
      snapshot: null
    });
    expect(activeExemption(records[BATCH] as ExemptionRecord, "2026-09-22")).toBeNull();
  });

  it("links hashes from genesis and validates an intact chain", () => {
    const records: Record<string, ExemptionRecord> = {};
    const first = grantExemption(records, {
      batchId: BATCH,
      reason: "a",
      actor: "x",
      validUntil: "2026-09-30",
      grantedOn: "2026-09-22",
      snapshot: null
    });
    expect(first.entry.prevHash).toBe(CHAIN_GENESIS);
    const second = extendExemption(records, {
      batchId: BATCH,
      reason: "b",
      actor: "x",
      validUntil: "2026-10-10",
      grantedOn: "2026-09-25",
      snapshot: null
    });
    expect(second.entry.prevHash).toBe(first.entry.entryHash);
    expect(validateChain(records[BATCH] as ExemptionRecord).ok).toBe(true);
  });

  it("detects any mutation of a historical entry", () => {
    const records: Record<string, ExemptionRecord> = {};
    grantExemption(records, {
      batchId: BATCH,
      reason: "原始原因",
      actor: "x",
      validUntil: "2026-09-30",
      grantedOn: "2026-09-22",
      snapshot: null
    });
    const record = records[BATCH] as ExemptionRecord;
    (record.entries[0] as { reason: string }).reason = "被篡改的原因";
    const validation = validateChain(record);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(" ")).toContain("哈希不匹配");
  });
});

describe("exemption overlay in planning", () => {
  it("retains the item but keeps the objective base conclusion visible", () => {
    const records: Record<string, ExemptionRecord> = {};
    const batch = makeBatch({ batchId: BATCH, expiryOn: "2026-09-20", remainingQuantity: "800" });
    grantExemption(records, {
      batchId: BATCH,
      reason: "继续观察一周",
      actor: "林染",
      validUntil: "2026-09-29",
      grantedOn: "2026-09-22",
      snapshot: plan([batch], { asOf: "2026-09-22" }).items[0] ?? null
    });
    const item = plan([batch], { asOf: "2026-09-22", exemptions: records }).items[0];
    expect(item?.exempt).toBe(true);
    expect(item?.disposition).toBe("RETAIN");
    expect(item?.baseDisposition).toBe("DISCARD_NOW");
    expect(item?.baseRiskLevel).toBe("EXPIRED");
    expect(item?.exemption?.beyondHardExpiry).toBe(true);
  });

  it("does not mutate the chain during recomputation", () => {
    const records: Record<string, ExemptionRecord> = {};
    const batch = makeBatch({ batchId: BATCH, expiryOn: "2026-10-01" });
    const granted = grantExemption(records, {
      batchId: BATCH,
      reason: "保留",
      actor: "林染",
      validUntil: "2026-10-05",
      grantedOn: "2026-09-22",
      snapshot: null
    });
    plan([batch], { asOf: "2026-09-22", exemptions: records });
    plan([batch], { asOf: "2026-09-23", exemptions: records });
    expect(records[BATCH]?.entries).toHaveLength(1);
    expect(records[BATCH]?.entries[0]?.entryHash).toBe(granted.entry.entryHash);
  });
});
