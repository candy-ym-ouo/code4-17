import { parseQuantity } from "./decimal.js";
import { addDays, daysBetween } from "./dates.js";
import type { ConsumptionSample } from "./types.js";

export interface DerivedRate {
  /** 日均使用速率，1e-6 定标的 bigint（与数量同定标，单位/天）。 */
  rate: bigint;
  /** 实际纳入窗口的样本数。 */
  sampleCount: number;
  /** 窗口起点（含），便于解释原因链。 */
  windowFrom: string;
  /** 窗口内合计消耗。 */
  windowQuantity: bigint;
}

/**
 * 由历史消耗样本推导日均使用速率。
 *
 * 取 (asOf - windowDays + 1) 至 asOf 的完整窗口（含端点），分母固定为 windowDays，
 * 这样分母不随最近一次消耗日期漂移，结果在跨天重算时保持稳定、可比。
 * 样本日期晚于 asOf 的（未来数据）不计入。
 */
export function deriveUsageRate(
  samples: ConsumptionSample[],
  asOf: string,
  windowDays: number
): DerivedRate {
  const windowFrom = addDays(asOf, -(windowDays - 1));
  let total = 0n;
  let count = 0;
  for (const sample of samples) {
    const age = daysBetween(asOf, sample.consumedOn);
    // age <= 0：样本日不晚于今天；age >= -(windowDays-1)：样本日不早于窗口起点。
    if (age <= 0 && age >= -(windowDays - 1)) {
      total += parseQuantity(sample.quantity);
      count += 1;
    }
  }
  // total（1e-6 定标）/ windowDays，精确到 1e-9 定标：total*1e3/windowDays，向下取整。
  const rate = windowDays > 0 ? (total * 1000n) / BigInt(windowDays) : 0n;
  return { rate, sampleCount: count, windowFrom, windowQuantity: total };
}
