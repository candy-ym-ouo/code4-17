import { describe, expect, it } from "vitest";
import { addDays, daysBetween, minDate, parseDate } from "../src/dates.js";
import {
  formatQuantity,
  formatRate,
  parseQuantity,
  parseRate,
  quantityDivRate,
  rateTimesDays
} from "../src/decimal.js";
import { PlannerError } from "../src/types.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PlannerError);
    expect((error as PlannerError).code).toBe(code);
    return;
  }
  throw new Error(`expected PlannerError(${code})`);
}

describe("UTC date arithmetic", () => {
  it("computes whole-day differences independent of time zone", () => {
    expect(daysBetween("2026-09-22", "2026-09-25")).toBe(3);
    expect(daysBetween("2026-09-25", "2026-09-22")).toBe(-3);
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-08-01", 60)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("rejects impossible calendar dates", () => {
    expectCode(() => parseDate("2026-02-30"), "INVALID_DATE");
  });

  it("returns the earlier date with null meaning unconstrained", () => {
    expect(minDate("2026-09-25", "2026-10-31")).toBe("2026-09-25");
    expect(minDate("2026-10-31", "2026-09-25")).toBe("2026-09-25");
    expect(minDate(null, "2026-10-31")).toBe("2026-10-31");
    expect(minDate("2026-10-31", null)).toBe("2026-10-31");
  });
});

describe("fixed-point decimal arithmetic", () => {
  it("parses and formats six-decimal quantities", () => {
    expect(formatQuantity(parseQuantity("1000"))).toBe("1000");
    expect(formatQuantity(parseQuantity("0.000001"))).toBe("0.000001");
    expect(formatQuantity(parseQuantity("12.500000"))).toBe("12.5");
  });

  it("rejects precision beyond the scale", () => {
    expectCode(() => parseQuantity("1.0000001"), "INVALID_QUANTITY");
    expectCode(() => parseRate("1.0000000001"), "INVALID_RATE");
  });

  it("projects consumption without floating point drift", () => {
    // 速率 3.333333333 g/天，30 天 => 99.999999990 => 99.999999 g
    expect(formatQuantity(rateTimesDays(parseRate("3.333333333"), 30))).toBe("99.999999");
    // 速率 0.001 g/天，7 天 => 0.007 g
    expect(formatQuantity(rateTimesDays(parseRate("0.001"), 7))).toBe("0.007");
  });

  it("divides quantity by rate, rounding days up", () => {
    // 10 g / 3.333... g/天 = 3.000... 天向上取整 4
    expect(quantityDivRate(parseQuantity("10"), parseRate("3.333333333"))).toBe(4);
    expect(quantityDivRate(parseQuantity("100"), parseRate("0"))).toBeNull();
  });

  it("formats rates with nine-decimal scale", () => {
    expect(formatRate(parseRate("3.333333333"))).toBe("3.333333333");
  });
});
