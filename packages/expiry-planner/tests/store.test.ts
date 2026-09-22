import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlannerRepository,
  emptyStore,
  grantExemption,
  loadStore,
  saveStore,
  validateAllChains
} from "../src/index.js";
import type { PlannerStoreFile } from "../src/types.js";
import { makeBatch } from "./fixtures.js";

let dir = "";

function tempStore(): string {
  dir = mkdtempSync(join(tmpdir(), "expiry-planner-"));
  return join(dir, "store.json");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("JSON repository", () => {
  it("returns an empty store when the file does not exist", () => {
    expect(loadStore(join(tempStore(), "missing.json"))).toEqual(emptyStore());
  });

  it("persists batches with incrementing versions and stable key order", () => {
    const path = tempStore();
    const repo = PlannerRepository.open(path);
    const batch = makeBatch({ batchId: "b1" });
    const first = repo.upsertBatch(batch);
    repo.save();
    expect(first.version).toBe(1);
    expect(existsSync(path)).toBe(true);

    const reopened = PlannerRepository.open(path);
    const second = reopened.upsertBatch({ ...batch, remainingQuantity: "900" });
    reopened.save();
    expect(second.version).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);

    // 规范化序列化：原样重写不应产生字节抖动。
    const rawOnce = readFileSync(path, "utf8");
    saveStore(path, loadStore(path));
    expect(readFileSync(path, "utf8")).toBe(rawOnce);
  });

  it("leaves no temp file after an atomic save", () => {
    const path = tempStore();
    const repo = PlannerRepository.open(path);
    repo.upsertBatch(makeBatch({ batchId: "b1" }));
    repo.save();
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("tamper-evident persistence", () => {
  it("flags a reason edited directly in the file", () => {
    const path = tempStore();
    const store: PlannerStoreFile = emptyStore();
    const repo = new PlannerRepository(path, store);
    repo.upsertBatch(makeBatch({ batchId: "b1" }));

    grantExemption(store.exemptions, {
      batchId: "b1",
      reason: "原始",
      actor: "林染",
      validUntil: "2026-12-31",
      grantedOn: "2026-09-22",
      snapshot: null
    });
    saveStore(path, store);
    expect(validateAllChains(loadStore(path).exemptions).ok).toBe(true);

    const tampered = loadStore(path);
    (tampered.exemptions.b1?.entries[0] as { reason: string }).reason = "绕过界面改动";
    saveStore(path, tampered);
    expect(validateAllChains(loadStore(path).exemptions).ok).toBe(false);
  });
});
