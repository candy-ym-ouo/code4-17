import { todayUtc } from "./dates.js";
import { batchInputSchema } from "./schema.js";
import { loadStore, saveStore } from "./store.js";
import type { BatchInput, BatchRecord, PlannerStoreFile } from "./types.js";
import { PlannerError } from "./types.js";

export class PlannerRepository {
  store: PlannerStoreFile;

  constructor(
    private path: string,
    store?: PlannerStoreFile
  ) {
    this.store = store ?? loadStore(path);
  }

  static open(path: string): PlannerRepository {
    return new PlannerRepository(path, loadStore(path));
  }

  save(): void {
    saveStore(this.path, this.store);
  }

  getBatch(batchId: string): BatchRecord | null {
    return this.store.batches[batchId] ?? null;
  }

  listBatches(): BatchRecord[] {
    return Object.values(this.store.batches).sort((a, b) =>
      a.batchId === b.batchId ? 0 : a.batchId < b.batchId ? -1 : 1
    );
  }

  /** 新建或整体覆盖一个批次快照（来源是主库存系统导出），版本自增。 */
  upsertBatch(input: BatchInput): BatchRecord {
    const parsed = batchInputSchema.parse(input);
    const now = todayUtc();
    const existing = this.store.batches[parsed.batchId];
    const record: BatchRecord = {
      ...parsed,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1
    };
    this.store.batches[parsed.batchId] = record;
    return record;
  }

  requireBatch(batchId: string): BatchRecord {
    const record = this.getBatch(batchId);
    if (!record) throw new PlannerError("BATCH_NOT_FOUND", `批次不存在: ${batchId}`);
    return record;
  }
}

