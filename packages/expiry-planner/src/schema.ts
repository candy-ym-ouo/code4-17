import { z } from "zod";
import { stockUnits } from "./types.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须是 YYYY-MM-DD 格式");
const nonNegativeDecimal = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, "数量必须是最多 6 位小数的非负十进制数");
const positiveDecimal = nonNegativeDecimal.refine((value) => Number(value) > 0, "必须大于 0");
const nonNegativeRate = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/, "速率必须是最多 9 位小数的非负十进制数");

export const consumptionSampleSchema = z.object({
  consumedOn: isoDate,
  quantity: positiveDecimal
});

export const batchInputSchema = z.object({
  batchId: z.string().trim().min(1).max(80),
  materialCode: z.string().trim().max(64).nullable().default(null),
  materialName: z.string().trim().min(1).max(120),
  batchCode: z.string().trim().max(64).nullable().default(null),
  unit: z.enum(stockUnits),
  status: z.enum(["ACTIVE", "DEPLETED", "ARCHIVED"]).default("ACTIVE"),
  remainingQuantity: nonNegativeDecimal,
  receivedOn: isoDate,
  expiryOn: isoDate.nullable().default(null),
  openedOn: isoDate.nullable().default(null),
  openedShelfDays: z.number().int().min(0).max(100000).nullable().default(null),
  consumptionSamples: z.array(consumptionSampleSchema).default([]),
  usageRatePerDay: nonNegativeRate.nullable().default(null),
  lowStockThreshold: nonNegativeDecimal.nullable().default(null),
  reorderLeadDays: z.number().int().min(0).max(100000).default(0)
});

export const plannerConfigSchema = z.object({
  rateWindowDays: z.number().int().positive(),
  criticalDays: z.number().int().nonnegative(),
  highDays: z.number().int().nonnegative(),
  mediumDays: z.number().int().nonnegative(),
  criticalWasteRatio: z.number().min(0).max(1),
  highWasteRatio: z.number().min(0).max(1),
  mediumWasteRatio: z.number().min(0).max(1),
  unopenedSoonDays: z.number().int().nonnegative()
});

export const grantInputSchema = z.object({
  reason: z.string().trim().min(2, "豁免原因至少 2 个字符").max(1000),
  actor: z.string().trim().min(1).max(80),
  validUntil: isoDate
});

export const revokeInputSchema = z.object({
  reason: z.string().trim().min(2, "撤销原因至少 2 个字符").max(1000),
  actor: z.string().trim().min(1).max(80)
});

export type BatchInputParsed = z.infer<typeof batchInputSchema>;
export type GrantInputParsed = z.infer<typeof grantInputSchema>;
