import type { BatchInput } from "../src/types.js";

let sequence = 0;

function id(): string {
  sequence += 1;
  return `00000000-0000-0000-0000-${String(sequence).padStart(12, "0")}`;
}

export function makeBatch(overrides: Partial<BatchInput> = {}): BatchInput {
  return {
    batchId: id(),
    materialCode: "MAT-01",
    materialName: "测试材料",
    batchCode: "B-1",
    unit: "g",
    status: "ACTIVE",
    remainingQuantity: "1000",
    receivedOn: "2026-08-01",
    expiryOn: "2026-10-01",
    openedOn: null,
    openedShelfDays: null,
    consumptionSamples: [],
    usageRatePerDay: null,
    lowStockThreshold: null,
    reorderLeadDays: 0,
    ...overrides
  };
}

export function resetIds(): void {
  sequence = 0;
}
