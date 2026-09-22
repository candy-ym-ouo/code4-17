import type { PlannerConfig } from "./types.js";

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  rateWindowDays: 30,
  criticalDays: 7,
  highDays: 14,
  mediumDays: 30,
  criticalWasteRatio: 0.5,
  highWasteRatio: 0.25,
  mediumWasteRatio: 0.1,
  unopenedSoonDays: 14
};

export const PLANNER_CONFIG_KEYS: (keyof PlannerConfig)[] = [
  "rateWindowDays",
  "criticalDays",
  "highDays",
  "mediumDays",
  "criticalWasteRatio",
  "highWasteRatio",
  "mediumWasteRatio",
  "unopenedSoonDays"
];

/** 用部分覆盖值构造完整配置，未提供的键取缺省值。 */
export function resolveConfig(overrides?: Partial<PlannerConfig>): PlannerConfig {
  return { ...DEFAULT_PLANNER_CONFIG, ...(overrides ?? {}) };
}
