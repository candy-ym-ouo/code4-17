import { describe, expect, it } from "vitest";
import { deriveUsageRate } from "../src/rate.js";
import { formatQuantity } from "../src/decimal.js";

describe("usage rate derivation", () => {
  const samples = [
    { consumedOn: "2026-09-01", quantity: "30" },
    { consumedOn: "2026-09-15", quantity: "30" },
    { consumedOn: "2026-08-01", quantity: "999" } // 落在 30 天窗口外
  ];

  it("uses a fixed window denominator so cross-day recomputation stays stable", () => {
    const derived = deriveUsageRate(samples, "2026-09-22", 30);
    expect(derived.sampleCount).toBe(2);
    expect(formatQuantity(derived.windowQuantity)).toBe("60");
    // 60/30 = 2 g/天（窗口固定为 30 天，而非按最近消耗日漂移）
    expect(derived.rate).toBe(2_000_000_000n);
    expect(derived.windowFrom).toBe("2026-08-24");
  });

  it("ignores future-dated samples", () => {
    const derived = deriveUsageRate(
      [...samples, { consumedOn: "2026-09-30", quantity: "500" }],
      "2026-09-22",
      30
    );
    expect(derived.sampleCount).toBe(2);
  });

  it("returns zero rate when the window has no consumption", () => {
    const derived = deriveUsageRate([{ consumedOn: "2026-01-01", quantity: "100" }], "2026-09-22", 30);
    expect(derived.rate).toBe(0n);
    expect(derived.sampleCount).toBe(0);
  });
});
