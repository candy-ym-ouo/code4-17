import { describe, expect, it } from "vitest";
import { canonicalJSON, fingerprint, plan } from "../src/index.js";
import { makeBatch, resetIds } from "./fixtures.js";
import type { BatchInput, ExemptionRecord } from "../src/types.js";

const AS_OF = "2026-09-22";

function planOne(batch: BatchInput, exemptions?: Record<string, ExemptionRecord>) {
  const result = plan([batch], { asOf: AS_OF, exemptions });
  const item = result.items[0];
  if (!item) throw new Error("expected a plan item");
  return item;
}

describe("hard deadline resolution", () => {
  it("takes the unopened expiry when not opened", () => {
    const item = planOne(makeBatch({ expiryOn: "2026-12-01", openedOn: null }));
    expect(item.hardDeadlineOn).toBe("2026-12-01");
    expect(item.opened).toBe(false);
  });

  it("takes the earlier of vendor expiry and opened shelf life", () => {
    const item = planOne(
      makeBatch({
        expiryOn: "2026-12-01",
        openedOn: "2026-08-01",
        openedShelfDays: 60 // 2026-09-30
      })
    );
    expect(item.hardDeadlineOn).toBe("2026-09-30");
  });

  it("prefers vendor expiry when the opened life is longer", () => {
    const item = planOne(
      makeBatch({
        expiryOn: "2026-10-15",
        openedOn: "2026-08-01",
        openedShelfDays: 365
      })
    );
    expect(item.hardDeadlineOn).toBe("2026-10-15");
  });
});

describe("risk classification and disposition", () => {
  it("flags expired batches for immediate discard regardless of rate", () => {
    const item = planOne(
      makeBatch({
        expiryOn: "2026-09-01",
        openedOn: "2026-09-01",
        openedShelfDays: 365,
        usageRatePerDay: "100"
      })
    );
    expect(item.riskLevel).toBe("EXPIRED");
    expect(item.disposition).toBe("DISCARD_NOW");
    expect(item.daysToHardDeadline).toBe(-21);
  });

  it("marks expiry CRITICAL inside seven days", () => {
    const item = planOne(
      makeBatch({
        remainingQuantity: "10",
        expiryOn: "2026-09-28",
        usageRatePerDay: "100" // 会提前耗尽，损耗为 0
      })
    );
    expect(item.riskLevel).toBe("CRITICAL");
    expect(item.disposition).toBe("PRIORITIZE");
  });

  it("treats material finished before deadline as no projected waste", () => {
    const item = planOne(
      makeBatch({
        remainingQuantity: "100",
        expiryOn: "2026-10-22", // 30 天
        usageRatePerDay: "10" // 100 / 10 = 10 天耗尽
      })
    );
    expect(item.projectedWaste).toBe("0");
    expect(item.projectedWasteRatio).toBe(0);
    expect(item.projectedDepletionOn).toBe("2026-10-02");
    expect(item.daysToDepletion).toBe(10);
  });

  it("raises risk from projected waste even when the deadline is distant", () => {
    const item = planOne(
      makeBatch({
        remainingQuantity: "1000",
        expiryOn: "2026-12-31", // 100 天，效期轴 LOW
        usageRatePerDay: "1" // 100 天仅用 100，预计浪费 900 => 90%
      })
    );
    expect(item.projectedWaste).toBe("900");
    expect(item.projectedWasteRatio).toBeCloseTo(0.9, 5);
    expect(item.riskLevel).toBe("CRITICAL");
    expect(item.riskAxis).toBe("WASTE");
    expect(item.secondaryActions).toContain("FREEZE");
  });

  it("suggests opening soon for unopened stock near deadline with unknown rate", () => {
    const item = planOne(
      makeBatch({
        remainingQuantity: "1000",
        expiryOn: "2026-10-01", // 9 天
        openedOn: null,
        consumptionSamples: []
      })
    );
    expect(item.rateSource).toBe("NONE");
    expect(item.disposition).toBe("OPEN_SOON");
  });

  it("monitors opened near-expiry stock whose rate is unknown", () => {
    const item = planOne(
      makeBatch({
        expiryOn: "2026-09-30",
        openedOn: "2026-09-01",
        openedShelfDays: 365
      })
    );
    expect(item.disposition).toBe("MONITOR");
  });

  it("is SAFE / use-as-planned when there is no expiry constraint", () => {
    const item = planOne(makeBatch({ expiryOn: null, openedOn: "2026-01-01", openedShelfDays: null }));
    expect(item.riskLevel).toBe("SAFE");
    expect(item.disposition).toBe("USE_AS_PLANNED");
    expect(item.hardDeadlineOn).toBeNull();
    expect(item.daysToHardDeadline).toBeNull();
  });

  it("adds a REORDER hint when projected stock crosses the low threshold", () => {
    const item = planOne(
      makeBatch({
        remainingQuantity: "100",
        expiryOn: null,
        usageRatePerDay: "10",
        lowStockThreshold: "50",
        reorderLeadDays: 10 // 10 天后预计 0 <= 50
      })
    );
    expect(item.secondaryActions).toContain("REORDER");
  });

  it("flags REORDER immediately when stock already sits at/below threshold and rate is unknown", () => {
    const item = planOne(
      makeBatch({ expiryOn: null, remainingQuantity: "40", lowStockThreshold: "50" })
    );
    expect(item.secondaryActions).toContain("REORDER");
  });
});

describe("skip rules", () => {
  it("excludes depleted and archived batches from planning", () => {
    resetIds();
    const batches = [
      makeBatch({ status: "DEPLETED" }),
      makeBatch({ status: "ARCHIVED" }),
      makeBatch({ remainingQuantity: "0" }), // 余额为 0 视同耗尽
      makeBatch({ remainingQuantity: "50" })
    ];
    const result = plan(batches, { asOf: AS_OF });
    expect(result.items).toHaveLength(1);
    expect(result.summary.skippedDepleted).toBe(2);
    expect(result.summary.skippedArchived).toBe(1);
  });
});

describe("deterministic recomputation", () => {
  const batches: BatchInput[] = [
    makeBatch({
      batchId: "zzz",
      materialName: "Z 材料",
      expiryOn: "2026-10-01",
      consumptionSamples: [
        { consumedOn: "2026-09-20", quantity: "3" },
        { consumedOn: "2026-09-10", quantity: "7" }
      ]
    }),
    makeBatch({ batchId: "aaa", materialName: "A 材料", expiryOn: "2026-09-26" }),
    makeBatch({ batchId: "mmm", materialName: "M 材料", expiryOn: null })
  ];

  it("produces byte-identical results across repeated runs and shuffled inputs", () => {
    const first = canonicalJSON(plan(batches, { asOf: AS_OF }).items);
    const second = canonicalJSON(plan([...batches].reverse(), { asOf: AS_OF }).items);
    expect(second).toBe(first);
    // 再算一次，确认与前两次都一致
    expect(fingerprint(canonicalJSON(plan(batches, { asOf: AS_OF }).items))).toBe(fingerprint(first));
  });

  it("orders items by severity then deadline then waste then batch id", () => {
    const result = plan(batches, { asOf: AS_OF });
    expect(result.items.map((item) => item.batchId)).toEqual(["aaa", "zzz", "mmm"]);
  });

  it("basis hash changes when an input changes but is stable otherwise", () => {
    const base = planOne(makeBatch({ batchId: "fixed", expiryOn: "2026-10-01" }));
    const same = planOne(makeBatch({ batchId: "fixed", expiryOn: "2026-10-01" }));
    const changed = planOne(makeBatch({ batchId: "fixed", expiryOn: "2026-10-02" }));
    expect(same.basisHash).toBe(base.basisHash);
    expect(changed.basisHash).not.toBe(base.basisHash);
  });
});
