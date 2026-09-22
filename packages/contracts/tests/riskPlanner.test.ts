import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  DEFAULT_LOOKBACK_DAYS,
  planBatchRisk,
  summarizePlans,
  type PlannerBatchInput
} from "../src/index.js";

function baseBatch(overrides: Partial<PlannerBatchInput> = {}): PlannerBatchInput {
  return {
    id: "b1",
    remainingQuantity: "500.000000",
    stockUnit: "g",
    expiryAt: null,
    openedAt: null,
    openShelfLifeDays: null,
    consumptions: [],
    ...overrides
  };
}

const AS_OF = "2026-09-22";
const options = { asOf: AS_OF, lookbackDays: DEFAULT_LOOKBACK_DAYS };

describe("date helpers are deterministic", () => {
  it("computes day differences and additions on calendar dates", () => {
    expect(daysBetween("2026-09-22", "2026-10-02")).toBe(10);
    expect(daysBetween("2026-10-02", "2026-09-22")).toBe(-10);
    expect(addDays("2026-09-22", 10)).toBe("2026-10-02");
    expect(addDays("2026-02-25", 5)).toBe("2026-03-02");
    expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
  });
});

describe("planBatchRisk determinism", () => {
  it("returns identical results across repeated and reordered calls", () => {
    const batch = baseBatch({
      expiryAt: "2026-10-15",
      openedAt: "2026-09-01",
      openShelfLifeDays: 60,
      consumptions: [
        { consumedAt: "2026-09-20T10:00:00+08:00", totalQuantity: "30.000000" },
        { consumedAt: "2026-09-10T08:00:00+08:00", totalQuantity: "20.000000" },
        { consumedAt: "2026-09-15T09:00:00+08:00", totalQuantity: "10.000000" }
      ]
    });
    const first = planBatchRisk(batch, options);
    const second = planBatchRisk({ ...batch, consumptions: [...batch.consumptions].reverse() }, options);
    expect(second).toEqual(first);
    expect(planBatchRisk(batch, options)).toEqual(first);
  });

  it("does not depend on wall-clock time when asOf is fixed", () => {
    const batch = baseBatch({ expiryAt: AS_OF });
    const plan = planBatchRisk(batch, options);
    expect(plan.sealedDaysRemaining).toBe(0);
    expect(plan.riskLevel).not.toBe("CRITICAL");
    const expired = planBatchRisk(baseBatch({ expiryAt: addDays(AS_OF, -1) }), options);
    expect(expired.riskLevel).toBe("CRITICAL");
    expect(expired.reasons.some((r) => r.code === "SEALED_EXPIRED")).toBe(true);
  });
});

describe("usage rate and coverage", () => {
  it("estimates a daily rate from in-window active consumptions only", () => {
    const batch = baseBatch({
      remainingQuantity: "300.000000",
      consumptions: [
        { consumedAt: "2026-09-21T10:00:00Z", totalQuantity: "100.000000" },
        { consumedAt: "2026-09-19T10:00:00Z", totalQuantity: "100.000000" },
        { consumedAt: "2026-08-01T10:00:00Z", totalQuantity: "9999.000000" }
      ]
    });
    const plan = planBatchRisk(batch, options);
    // 窗口边界：窗口起点（asOf-30）当天不计入
    expect(plan.consumptionCount).toBe(2);
    expect(plan.consumedQuantity).toBe("200.000000");
    expect(plan.rateBasisDays).toBe(3); // asOf 距窗口内首次消耗 3 天
    expect(plan.dailyUsageRate).toBe("66.666667"); // round(200/3)
    expect(plan.coverageDays).toBe(4); // floor(300 / 66.666667)
  });

  it("uses days since opening as the rate denominator when shorter", () => {
    const plan = planBatchRisk(
      baseBatch({
        openedAt: "2026-09-20",
        consumptions: [{ consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "10.000000" }]
      }),
      options
    );
    expect(plan.rateBasisDays).toBe(1);
    expect(plan.dailyUsageRate).toBe("10.000000");
  });

  it("reports no usage and cannot project coverage without consumptions", () => {
    const plan = planBatchRisk(baseBatch({ expiryAt: "2026-12-01" }), options);
    expect(plan.consumptionCount).toBe(0);
    expect(plan.dailyUsageRate).toBeNull();
    expect(plan.coverageDays).toBeNull();
    expect(plan.reasons.some((r) => r.code === "NO_USAGE")).toBe(true);
    expect(plan.riskLevel).toBe("MEDIUM");
  });
});

describe("expiry decision chain", () => {
  it("flags sealed expiry as critical DISCARD_NOW", () => {
    const plan = planBatchRisk(baseBatch({ expiryAt: "2026-09-20" }), options);
    expect(plan.action).toBe("DISCARD_NOW");
    expect(plan.reasons.map((r) => r.code)).toContain("SEALED_EXPIRED");
  });

  it("treats the earlier of sealed expiry and open shelf life as binding", () => {
    const plan = planBatchRisk(
      baseBatch({
        expiryAt: "2027-01-01",
        openedAt: "2026-09-10",
        openShelfLifeDays: 20, // 开封效期 2026-09-30，更早
        consumptions: [{ consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "1.000000" }]
      }),
      options
    );
    expect(plan.bindingDeadline?.kind).toBe("OPEN_SHELF_LIFE");
    expect(plan.bindingDeadline?.date).toBe("2026-09-30");
    expect(plan.openDaysRemaining).toBe(8);
    expect(plan.reasons.map((r) => r.code)).toContain("OPEN_WATCH");
  });

  it("flags open shelf life overdue as critical even if sealed expiry is far away", () => {
    const plan = planBatchRisk(
      baseBatch({
        expiryAt: "2027-06-01",
        openedAt: "2026-08-01",
        openShelfLifeDays: 30,
        consumptions: [{ consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "1.000000" }]
      }),
      options
    );
    expect(plan.riskLevel).toBe("CRITICAL");
    expect(plan.action).toBe("DISCARD_NOW");
    expect(plan.reasons.map((r) => r.code)).toContain("OPEN_EXPIRED");
  });

  it("recommends prioritize use when more than a week of stock survives past deadline", () => {
    const plan = planBatchRisk(
      baseBatch({
        remainingQuantity: "1000.000000",
        expiryAt: "2026-10-20", // 28 天后
        consumptions: [
          { consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "100.000000" },
          { consumedAt: "2026-09-20T00:00:00Z", totalQuantity: "100.000000" }
        ] // 100/天 → 覆盖 10 天，到期肯定用完？不：覆盖 < 剩余天数
      }),
      options
    );
    expect(plan.coverageDays).toBe(10);
    expect(plan.riskLevel).toBe("LOW");
    expect(plan.reasons.map((r) => r.code)).toContain("RUNS_OUT_BEFORE_DEADLINE");
  });

  it("flags large surplus past deadline as medium with planning advice", () => {
    const plan = planBatchRisk(
      baseBatch({
        remainingQuantity: "10000.000000",
        expiryAt: "2026-10-20", // 28 天
        consumptions: [{ consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "100.000000" }]
      }), // 100/天，覆盖 100 天，盈余 72 天
      options
    );
    expect(plan.projectedLeftover).toBe("7200.000000");
    expect(plan.riskLevel).toBe("MEDIUM");
    expect(plan.action).toBe("USE_OR_PLAN");
    expect(plan.reasons.map((r) => r.code)).toContain("SURPLUS_OVER_30D");
  });

  it("surfaces opened batches without configured open shelf life", () => {
    const plan = planBatchRisk(
      baseBatch({ openedAt: "2026-09-01", consumptions: [{ consumedAt: "2026-09-21T00:00:00Z", totalQuantity: "1.000000" }] }),
      options
    );
    expect(plan.reasons.map((r) => r.code)).toContain("OPENED_NO_SHELF_LIFE");
  });

  it("reports no binding deadline when neither expiry nor open shelf life exists", () => {
    const plan = planBatchRisk(baseBatch(), options);
    expect(plan.bindingDeadline).toBeNull();
    expect(plan.reasons.map((r) => r.code)).toContain("NO_BINDING_DEADLINE");
  });
});

describe("depleted batches", () => {
  it("does not recommend discarding a zero-quantity batch even when expired", () => {
    const plan = planBatchRisk(
      baseBatch({ remainingQuantity: "0", expiryAt: "2026-09-01", openedAt: "2026-08-01", openShelfLifeDays: 30 }),
      options
    );
    expect(plan.riskLevel).toBe("NONE");
    expect(plan.action).toBe("NO_ACTION");
    expect(plan.reasons.map((r) => r.code)).toContain("BATCH_DEPLETED");
    expect(plan.reasons.map((r) => r.code)).not.toContain("SEALED_EXPIRED");
  });
});

describe("manual exemptions", () => {
  const activeExemption = {
    id: "e1",
    reason: "供应商确认延期使用，留样检测合格",
    validFrom: "2026-09-20",
    validUntil: "2026-10-31",
    status: "ACTIVE" as const,
    revokedReason: null,
    revokedAt: null,
    createdAt: "2026-09-20T00:00:00Z"
  };

  it("downgrades an expired batch to HOLD_EXEMPT while keeping the underlying risk and full reason chain", () => {
    const plan = planBatchRisk(baseBatch({ expiryAt: "2026-09-01", latestExemption: activeExemption }), options);
    expect(plan.exempt).toBe(true);
    expect(plan.riskLevel).toBe("NONE");
    expect(plan.action).toBe("HOLD_EXEMPT");
    expect(plan.underlyingRiskLevel).toBe("CRITICAL");
    expect(plan.underlyingAction).toBe("DISCARD_NOW");
    const codes = plan.reasons.map((r) => r.code);
    expect(codes).toContain("SEALED_EXPIRED");
    expect(codes).toContain("EXEMPT_ACTIVE");
  });

  it("warns when the exemption itself expires within three days", () => {
    const plan = planBatchRisk(
      baseBatch({
        expiryAt: "2026-09-01",
        latestExemption: { ...activeExemption, validUntil: "2026-09-24" }
      }),
      options
    );
    expect(plan.reasons.map((r) => r.code)).toContain("EXEMPT_EXPIRING");
  });

  it("restores system recommendation after exemption expiry and records the reason chain", () => {
    const plan = planBatchRisk(
      baseBatch({
        expiryAt: "2026-09-01",
        latestExemption: { ...activeExemption, status: "EXPIRED", validUntil: "2026-09-10" }
      }),
      options
    );
    expect(plan.exempt).toBe(false);
    expect(plan.riskLevel).toBe("CRITICAL");
    expect(plan.action).toBe("DISCARD_NOW");
    const codes = plan.reasons.map((r) => r.code);
    expect(codes).toContain("SEALED_EXPIRED");
    expect(codes).toContain("EXEMPT_EXPIRED");
  });

  it("keeps revoked exemptions in the reason chain without applying them", () => {
    const plan = planBatchRisk(
      baseBatch({
        expiryAt: "2026-09-01",
        latestExemption: { ...activeExemption, status: "REVOKED", revokedReason: "复检不合格" }
      }),
      options
    );
    expect(plan.exempt).toBe(false);
    expect(plan.riskLevel).toBe("CRITICAL");
    const reason = plan.reasons.find((r) => r.code === "EXEMPT_REVOKED");
    expect(reason?.message).toContain("复检不合格");
  });

  it("summarizes exempt and actionable critical counts", () => {
    const exemptCritical = planBatchRisk(baseBatch({ id: "a", expiryAt: "2026-09-01", latestExemption: activeExemption }), options);
    const bareCritical = planBatchRisk(baseBatch({ id: "b", expiryAt: "2026-09-01" }), options);
    const fine = planBatchRisk(baseBatch({ id: "c" }), options);
    const summary = summarizePlans([exemptCritical, bareCritical, fine]);
    expect(summary.total).toBe(3);
    expect(summary.exemptCount).toBe(1);
    expect(summary.criticalBatchIds).toEqual(["b"]);
    expect(summary.byRiskLevel.CRITICAL).toBe(1);
    expect(summary.byRiskLevel.NONE).toBe(1);
  });
});
