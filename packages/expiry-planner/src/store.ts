import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJSON } from "./hash.js";
import type {
  BatchInput,
  BatchRecord,
  ExemptionRecord,
  PlannerStoreFile
} from "./types.js";
import { PlannerError } from "./types.js";

export const STORE_SCHEMA_VERSION = 1 as const;

export function emptyStore(): PlannerStoreFile {
  return { schemaVersion: STORE_SCHEMA_VERSION, batches: {}, exemptions: {} };
}

export function loadStore(path: string): PlannerStoreFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<PlannerStoreFile>;
  if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new PlannerError("STORE_VERSION", `不支持的仓库版本: ${String(parsed.schemaVersion)}`);
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    batches: parsed.batches ?? {},
    exemptions: parsed.exemptions ?? {}
  };
}

/** 原子保存：先写临时文件再 rename，避免崩溃/并发读到半截文件。键序固定保证 diff 稳定。 */
export function saveStore(path: string, store: PlannerStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${canonicalJSON(store)}\n`, "utf8");
  renameSync(tmp, path);
}

export function listBatchInputs(store: PlannerStoreFile): BatchInput[] {
  return Object.values(store.batches)
    .map((record: BatchRecord) => stripRecord(record))
    .sort((a, b) => (a.batchId === b.batchId ? 0 : a.batchId < b.batchId ? -1 : 1));
}

export function stripRecord(record: BatchRecord): BatchInput {
  return {
    batchId: record.batchId,
    materialCode: record.materialCode,
    materialName: record.materialName,
    batchCode: record.batchCode,
    unit: record.unit,
    status: record.status,
    remainingQuantity: record.remainingQuantity,
    receivedOn: record.receivedOn,
    expiryOn: record.expiryOn,
    openedOn: record.openedOn,
    openedShelfDays: record.openedShelfDays,
    consumptionSamples: record.consumptionSamples,
    usageRatePerDay: record.usageRatePerDay,
    lowStockThreshold: record.lowStockThreshold,
    reorderLeadDays: record.reorderLeadDays
  };
}

export function exemptionRecords(store: PlannerStoreFile): Record<string, ExemptionRecord> {
  return store.exemptions;
}
