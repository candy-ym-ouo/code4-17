import { createHash } from "node:crypto";

/**
 * 规范化 JSON：对象键按 UTF-16 码点排序，无空白，保证
 * “同样的数据无论怎么构造，序列化字节完全一致”，从而哈希可复现。
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 对任意可 JSON 化的数据求稳定指纹。 */
export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJSON(value));
}
