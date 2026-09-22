import { describe, expect, it } from "vitest";
import {
  batchCreateSchema,
  colorChangeInputSchema,
  consumptionInputSchema,
  convertQuantity,
  exemptionCreateSchema,
  exemptionRevokeSchema,
  materialInputSchema,
  riskPlannerQuerySchema
} from "@handcraft/contracts";

describe("API business validation contracts", () => {
  it("normalizes a valid batch payload", () => {
    const result = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-13",
      initialQuantity: "1.5",
      entryUnit: "kg"
    });
    expect(result.entryUnit).toBe("kg");
  });

  it("requires at least one consumption quantity", () => {
    const base = {
      projectId: "00000000-0000-0000-0000-000000000001",
      batchId: "00000000-0000-0000-0000-000000000002",
      usedQuantity: "0",
      wasteQuantity: "0",
      unit: "g"
    };
    expect(consumptionInputSchema.safeParse(base).success).toBe(false);
    expect(consumptionInputSchema.safeParse({ ...base, wasteQuantity: "10" }).success).toBe(true);
  });

  it("rejects zero affected quantity for color changes", () => {
    const result = colorChangeInputSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changeType: "OTHER",
      afterColorName: "Test",
      affectedQuantity: "0",
      unit: "g",
      occurredAt: "2026-09-13T10:00:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("keeps inventory units in compatible families", () => {
    expect(convertQuantity("2.5", "l", "ml")).toBe("2500.000000");
    expect(() => convertQuantity("2.5", "l", "kg")).toThrow();
  });

  it("accepts open shelf life days and opened date on materials and batches", () => {
    const material = materialInputSchema.parse({
      name: "苏木",
      craftTypes: ["DYEING"],
      stockUnit: "g",
      openShelfLifeDays: 90
    });
    expect(material.openShelfLifeDays).toBe(90);
    expect(materialInputSchema.safeParse({
      name: "x", craftTypes: ["OTHER"], stockUnit: "g", openShelfLifeDays: 0
    }).success).toBe(false);

    const batch = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-01",
      expiryAt: "2027-09-01",
      openedAt: "2026-09-10",
      initialQuantity: "1",
      entryUnit: "g"
    });
    expect(batch.openedAt).toBe("2026-09-10");
  });

  it("validates risk planner query and exemption payloads", () => {
    expect(riskPlannerQuerySchema.parse({ lookbackDays: "14", asOf: "2026-09-22" }).lookbackDays).toBe(14);
    expect(riskPlannerQuerySchema.safeParse({ lookbackDays: "2" }).success).toBe(false);
    expect(exemptionCreateSchema.safeParse({ reason: "供应商确认", validUntil: "2026-12-31" }).success).toBe(true);
    expect(exemptionCreateSchema.safeParse({ reason: "太短", validUntil: "2026-12-31" }).success).toBe(false);
    expect(exemptionRevokeSchema.safeParse({ reason: "复检不合格，立即停用" }).success).toBe(true);
  });
});
