import { describe, expect, it } from "vitest";
import { batchInputSchema, grantInputSchema } from "../src/schema.js";

describe("input validation", () => {
  it("accepts a well-formed batch and applies defaults", () => {
    const parsed = batchInputSchema.parse({
      batchId: "b1",
      materialName: "染液",
      remainingQuantity: "500.25",
      receivedOn: "2026-09-01",
      expiryOn: null,
      unit: "ml"
    });
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.reorderLeadDays).toBe(0);
    expect(parsed.consumptionSamples).toEqual([]);
  });

  it("rejects over-precise quantities, bad dates and bad units", () => {
    expect(batchInputSchema.safeParse({
      batchId: "b1", materialName: "x", remainingQuantity: "1.0000001",
      receivedOn: "2026-09-01", unit: "g"
    }).success).toBe(false);
    expect(batchInputSchema.safeParse({
      batchId: "b1", materialName: "x", remainingQuantity: "1",
      receivedOn: "2026-9-1", unit: "g"
    }).success).toBe(false);
    expect(batchInputSchema.safeParse({
      batchId: "b1", materialName: "x", remainingQuantity: "1",
      receivedOn: "2026-09-01", unit: "ton"
    }).success).toBe(false);
  });

  it("requires a non-empty exemption reason and ISO date", () => {
    expect(grantInputSchema.safeParse({ reason: "x", actor: "林染", validUntil: "2026-12-31" }).success).toBe(false);
    expect(grantInputSchema.safeParse({ reason: "合理原因", actor: "林染", validUntil: "12/31/2026" }).success).toBe(false);
  });
});
