import { PlannerError } from "./types.js";

/** 数量定标：6 位小数，与主系统 numeric(18,6) 对齐。 */
const QUANTITY_SCALE = 1_000_000n;
const QUANTITY_DIGITS = 6;
/** 速率定标：9 位小数，日均速率可能很小（如 0.001 g/天）。 */
const RATE_SCALE = 1_000_000_000n;
const RATE_SCALE_DIGITS = 9;

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseQuantity(value: string): bigint {
  if (!DECIMAL_RE.test(value.trim())) {
    throw new PlannerError("INVALID_QUANTITY", `非法数量: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (fraction.length > QUANTITY_DIGITS) {
    throw new PlannerError("INVALID_QUANTITY", `数量小数位不能超过 ${QUANTITY_DIGITS} 位: ${value}`);
  }
  return BigInt(whole) * QUANTITY_SCALE + BigInt((fraction || "").padEnd(QUANTITY_DIGITS, "0"));
}

export function parseRate(value: string): bigint {
  if (!DECIMAL_RE.test(value.trim())) {
    throw new PlannerError("INVALID_RATE", `非法使用速率: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (fraction.length > RATE_SCALE_DIGITS) {
    throw new PlannerError("INVALID_RATE", `速率小数位不能超过 ${RATE_SCALE_DIGITS} 位: ${value}`);
  }
  return BigInt(whole) * RATE_SCALE + BigInt((fraction || "").padEnd(RATE_SCALE_DIGITS, "0"));
}

/** 去掉字符串十进制末尾多余的 0，保留输入风格的精简表示。 */
function trimFraction(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / QUANTITY_SCALE;
  const fraction = (absolute % QUANTITY_SCALE).toString().padStart(QUANTITY_DIGITS, "0");
  return `${negative ? "-" : ""}${trimFraction(`${whole}.${fraction}`)}`;
}

export function formatRate(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / RATE_SCALE;
  const fraction = (absolute % RATE_SCALE).toString().padStart(RATE_SCALE_DIGITS, "0");
  return `${negative ? "-" : ""}${trimFraction(`${whole}.${fraction}`)}`;
}

/**
 * 速率 × 天数，结果按数量定标（1e-6）返回。
 * rate 为 1e-9 定标，乘整数天数后除以 10^3 换算到 1e-6 定标，余数向下取整，
 * 保证“预计消耗”不把不足最小单位的零头虚增为可用量。
 */
export function rateTimesDays(rate: bigint, days: number): bigint {
  if (days <= 0 || rate <= 0n) return 0n;
  return (rate * BigInt(days)) / 1000n;
}

/** 数量 / 速率 = 天数（向上取整）；速率为 0 返回 null。数量 1e-6 定标、速率 1e-9 定标。 */
export function quantityDivRate(quantity: bigint, rate: bigint): number | null {
  if (rate <= 0n) return null;
  // days = quantity(1e-6) / rate(1e-9) = quantity * 1000 / rate，向上取整。
  const numerator = quantity * 1000n;
  const days = (numerator + rate - 1n) / rate;
  return Number(days);
}

/** 比例转百分比数值用于展示（0~100，保留 2 位小数，四舍五入）。 */
export function ratioToPercent(ratio: number): number {
  return Math.round(ratio * 10000) / 100;
}

/** 比例比较：scaledRatio 为 0~RATE 区间的整数表示时不方便，这里直接用 number 阈值。 */
export function clampRatio(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
