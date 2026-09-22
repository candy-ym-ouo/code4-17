/**
 * 仅按 ISO `YYYY-MM-DD` 处理日期，统一走 UTC，避免运行环境时区影响“剩余天数”。
 */
import { PlannerError } from "./types.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: string): Date {
  if (!ISO_DATE_RE.test(value)) {
    throw new PlannerError("INVALID_DATE", `日期必须是 YYYY-MM-DD 格式: ${value}`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PlannerError("INVALID_DATE", `非法日历日期: ${value}`);
  }
  return date;
}

export function isValidDate(value: string | null | undefined): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

export function todayUtc(): string {
  return formatDate(new Date());
}

export function formatDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

/**
 * 从 from 到 to 的整日差（to - from）。
 * 可为负（to 早于 from，表示已过期天数）。
 */
export function daysBetween(from: string, to: string): number {
  const milliseconds = parseDate(to).getTime() - parseDate(from).getTime();
  return Math.round(milliseconds / 86_400_000);
}

/** 返回两个 ISO 日期中较早者；null 视为“无约束”。 */
export function minDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  // daysBetween(a, b) <= 0 表示 b 不晚于 a，此时较早者是 b。
  return daysBetween(a, b) <= 0 ? b : a;
}
