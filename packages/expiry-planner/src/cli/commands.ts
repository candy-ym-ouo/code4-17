import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTION_LABEL,
  DEFAULT_PLANNER_CONFIG,
  PlannerError,
  PlannerRepository,
  activeExemption,
  canonicalJSON,
  extendExemption,
  fingerprint,
  grantExemption,
  plan,
  revokeExemption,
  riskLabel,
  todayUtc,
  validateAllChains
} from "../index.js";
import type {
  BatchInput,
  ExemptionChainEntry,
  PlanItem,
  PlannerConfig,
  RiskLevel
} from "../types.js";
import { paint, compactRate, renderTable, type TableColumn } from "./format.js";

interface GlobalOptions {
  store: string;
  color: boolean;
}

export function defaultStorePath(): string {
  return process.env.EXPIRY_PLANNER_STORE ?? resolve(process.cwd(), "expiry-planner.json");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseConfigOverrides(raw: string | undefined): Partial<PlannerConfig> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Partial<PlannerConfig>;
  return parsed;
}

function resolveAsOf(value: string | undefined): string {
  return value ?? todayUtc();
}

const RISK_COLOR: Record<RiskLevel, keyof ReturnType<typeof palette>> = {
  EXPIRED: "red",
  CRITICAL: "red",
  HIGH: "yellow",
  MEDIUM: "yellow",
  LOW: "green",
  SAFE: "green"
};

function palette(enabled: boolean) {
  return {
    red: (text: string) => paint("red", text, enabled),
    yellow: (text: string) => paint("yellow", text, enabled),
    green: (text: string) => paint("green", text, enabled),
    gray: (text: string) => paint("gray", text, enabled),
    cyan: (text: string) => paint("cyan", text, enabled),
    magenta: (text: string) => paint("magenta", text, enabled)
  };
}

export interface CommandContext {
  options: GlobalOptions;
  args: { positionals: string[]; flags: Set<string>; values: Map<string, string> };
}

function materialLabel(item: Pick<PlanItem, "materialName" | "materialCode" | "batchCode">): string {
  const code = item.materialCode ? `${item.materialCode}/` : "";
  const batch = item.batchCode ? `（${item.batchCode}）` : "";
  return `${code}${item.materialName}${batch}`;
}

function ratioText(item: PlanItem): string {
  if (item.projectedWasteRatio === null) return "—";
  return `${(item.projectedWasteRatio * 100).toFixed(1)}%`;
}

function daysText(value: number | null): string {
  if (value === null) return "∞";
  if (value < 0) return `已过期${-value}天`;
  return `${value}天`;
}

/** batch:add <jsonFile> —— 从 JSON 读入一个批次快照（或数组）。 */
export function cmdBatchAdd(ctx: CommandContext): number {
  const file = ctx.args.positionals[0];
  if (!file) throw new PlannerError("USAGE", "用法: batch:add <batch.json>");
  const payload = readJson(file);
  const list = Array.isArray(payload) ? (payload as BatchInput[]) : [payload as BatchInput];
  const repo = PlannerRepository.open(ctx.options.store);
  for (const input of list) repo.upsertBatch(input);
  repo.save();
  process.stdout.write(`已保存 ${list.length} 个批次到 ${ctx.options.store}\n`);
  return 0;
}

/** batch:list */
export function cmdBatchList(ctx: CommandContext): number {
  const repo = PlannerRepository.open(ctx.options.store);
  const rows = repo.listBatches();
  const columns: TableColumn<(typeof rows)[number]>[] = [
    { header: "批次ID", width: 36, render: (row) => row.batchId },
    { header: "材料", width: 30, render: (row) => materialLabel(row) },
    { header: "状态", width: 9, render: (row) => row.status },
    { header: "剩余量", width: 14, align: "right", render: (row) => `${row.remainingQuantity} ${row.unit}` },
    { header: "开封日", width: 12, render: (row) => row.openedOn ?? "未开封" },
    { header: "硬效期", width: 12, render: (row) => row.expiryOn ?? "—" }
  ];
  process.stdout.write(`${renderTable(rows, columns)}\n共 ${rows.length} 个批次\n`);
  return 0;
}

/** plan [--as-of YYYY-MM-DD] [--config JSON] [--json] [--determinism-check] */
export function cmdPlan(ctx: CommandContext): number {
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const config = parseConfigOverrides(ctx.args.values.get("config"));
  const repo = PlannerRepository.open(ctx.options.store);
  const batches = repo.listBatches().map((record) => {
    const { createdAt: _c, updatedAt: _u, version: _v, ...input } = record;
    return input;
  });

  const run = () => plan(batches, { asOf, config, exemptions: repo.store.exemptions });
  const result = run();

  // 稳定性自检：同一输入连算两次，所有 basisHash 与规范化结论必须完全一致。
  if (ctx.args.flags.has("determinism-check")) {
    const second = run();
    const firstJSON = canonicalJSON(result.items);
    const secondJSON = canonicalJSON(second.items);
    if (firstJSON !== secondJSON || fingerprint(firstJSON) !== fingerprint(secondJSON)) {
      throw new PlannerError("NONDETERMINISTIC", "规划重算结果不一致，规划器不满足稳定性要求");
    }
    process.stdout.write(ctx.options.color ? palette(true).gray("✔ 稳定性自检通过：两次重算结果逐字节一致\n\n") : "稳定性自检通过\n\n");
  }

  if (ctx.args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  printPlanTable(result.items, ctx.options.color);
  printSummary(result.summary, ctx.options.color);
  return 0;
}

function printPlanTable(items: PlanItem[], colorEnabled: boolean): void {
  const colors = palette(colorEnabled);
  const columns: TableColumn<PlanItem>[] = [
    {
      header: "风险",
      width: 10,
      render: (item) => colors[RISK_COLOR[item.riskLevel]](riskLabel(item.riskLevel))
    },
    { header: "材料/批次", width: 34, render: (item) => materialLabel(item) },
    { header: "剩余量", width: 14, align: "right", render: (item) => `${item.remainingQuantity ?? "—"} ${item.unit}` },
    { header: "日速率", width: 12, align: "right", render: (item) => compactRate(item.usageRatePerDay) },
    { header: "截止日", width: 12, render: (item) => item.hardDeadlineOn ?? "无" },
    { header: "剩余", width: 12, render: (item) => daysText(item.daysToHardDeadline) },
    { header: "预计损耗", width: 10, align: "right", render: ratioText },
    {
      header: "处置建议",
      width: 20,
      render: (item) => {
        const label = ACTION_LABEL[item.disposition];
        const text = item.exempt ? colors.magenta(label) : label;
        const extra = item.secondaryActions.length ? ` +${item.secondaryActions.map((action) => ACTION_LABEL[action]).join("/")}` : "";
        return text + (extra ? colors.gray(extra) : "");
      }
    }
  ];
  process.stdout.write(`${renderTable(items, columns)}\n`);
}

function printSummary(summary: ReturnType<typeof plan>["summary"], colorEnabled: boolean): void {
  const colors = palette(colorEnabled);
  process.stdout.write(
    [
      "",
      `截至 ${summary.asOf}：在管 ${summary.totalBatches}，纳入规划 ${summary.planned}，跳过已耗尽 ${summary.skippedDepleted}、已归档 ${summary.skippedArchived}，生效豁免 ${summary.exemptActive}`,
      `风险分布：${Object.entries(summary.byRisk)
        .filter(([, count]) => count > 0)
        .map(([level, count]) => `${riskLabel(level as RiskLevel)} ${count}`)
        .join("，") || "无"}`,
      colors.gray(`阈值默认：${DEFAULT_PLANNER_CONFIG.criticalDays}/${DEFAULT_PLANNER_CONFIG.highDays}/${DEFAULT_PLANNER_CONFIG.mediumDays} 天，损耗 ${DEFAULT_PLANNER_CONFIG.criticalWasteRatio * 100}/${DEFAULT_PLANNER_CONFIG.highWasteRatio * 100}/${DEFAULT_PLANNER_CONFIG.mediumWasteRatio * 100}%`)
    ].join("\n") + "\n"
  );
}

/** explain <batchId> [--as-of] —— 打印单个批次的完整原因链。 */
export function cmdExplain(ctx: CommandContext): number {
  const batchId = ctx.args.positionals[0];
  if (!batchId) throw new PlannerError("USAGE", "用法: explain <batchId>");
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const config = parseConfigOverrides(ctx.args.values.get("config"));
  const repo = PlannerRepository.open(ctx.options.store);
  const record = repo.requireBatch(batchId);
  const { createdAt: _c, updatedAt: _u, version: _v, ...input } = record;
  const result = plan([input], { asOf, config, exemptions: repo.store.exemptions });
  const item = result.items[0];
  if (!item) throw new PlannerError("NO_PLAN", "该批次已耗尽或归档，无规划结论");
  const colors = palette(ctx.options.color);

  process.stdout.write(
    [
      colors.cyan(materialLabel(item)),
      `客观风险：${colors[RISK_COLOR[item.baseRiskLevel]](riskLabel(item.baseRiskLevel))}（${item.riskAxis}）  处置：${ACTION_LABEL[item.baseDisposition]}${
        item.secondaryActions.length ? `，附带 ${item.secondaryActions.map((action) => ACTION_LABEL[action]).join("、")}` : ""
      }`,
      item.exempt ? colors.magenta(`当前被人工豁免：保留至 ${item.exemption?.validUntil}，超出硬效期=${item.exemption?.beyondHardExpiry ? "是" : "否"}`) : "当前无生效豁免",
      `basisHash: ${item.basisHash}`,
      "",
      "判定原因链：",
      ...item.reasons.map((step, index) => `  ${index + 1}. [${step.code}] ${step.message}`)
    ].join("\n") + "\n"
  );
  return 0;
}

/** exempt:grant <batchId> --reason --actor --valid-until [--as-of] */
export function cmdExemptGrant(ctx: CommandContext): number {
  const batchId = ctx.args.positionals[0];
  const reason = ctx.args.values.get("reason");
  const actor = ctx.args.values.get("actor");
  const validUntil = ctx.args.values.get("valid-until");
  if (!batchId || !reason || !actor || !validUntil) {
    throw new PlannerError("USAGE", "用法: exempt:grant <batchId> --reason <原因> --actor <操作人> --valid-until YYYY-MM-DD");
  }
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const repo = PlannerRepository.open(ctx.options.store);
  const record = repo.requireBatch(batchId);
  const { createdAt: _c, updatedAt: _u, version: _v, ...input } = record;
  const snapshot = plan([input], { asOf, exemptions: repo.store.exemptions }).items[0] ?? null;

  const { entry, duplicated } = grantExemption(repo.store.exemptions, {
    batchId,
    reason,
    actor,
    validUntil,
    grantedOn: asOf,
    snapshot
  });
  repo.save();
  process.stdout.write(
    `${duplicated ? "已存在相同生效豁免（幂等，未新增）" : "已追加豁免事件"} #${entry.seq} ${entry.type}，保留至 ${entry.validUntil}\nchainHash: ${entry.entryHash}\n`
  );
  return 0;
}

/** exempt:extend —— 参数同 grant */
export function cmdExemptExtend(ctx: CommandContext): number {
  const batchId = ctx.args.positionals[0];
  const reason = ctx.args.values.get("reason");
  const actor = ctx.args.values.get("actor");
  const validUntil = ctx.args.values.get("valid-until");
  if (!batchId || !reason || !actor || !validUntil) {
    throw new PlannerError("USAGE", "用法: exempt:extend <batchId> --reason <原因> --actor <操作人> --valid-until YYYY-MM-DD");
  }
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const repo = PlannerRepository.open(ctx.options.store);
  const record = repo.requireBatch(batchId);
  const { createdAt: _c, updatedAt: _u, version: _v, ...input } = record;
  const snapshot = plan([input], { asOf, exemptions: repo.store.exemptions }).items[0] ?? null;
  const { entry, duplicated } = extendExemption(repo.store.exemptions, {
    batchId,
    reason,
    actor,
    validUntil,
    grantedOn: asOf,
    snapshot
  });
  repo.save();
  process.stdout.write(`${duplicated ? "续期参数相同（幂等）" : "已追加续期事件"} #${entry.seq} ${entry.type}，保留至 ${entry.validUntil}\nchainHash: ${entry.entryHash}\n`);
  return 0;
}

/** exempt:revoke <batchId> --reason --actor */
export function cmdExemptRevoke(ctx: CommandContext): number {
  const batchId = ctx.args.positionals[0];
  const reason = ctx.args.values.get("reason");
  const actor = ctx.args.values.get("actor");
  if (!batchId || !reason || !actor) {
    throw new PlannerError("USAGE", "用法: exempt:revoke <batchId> --reason <撤销原因> --actor <操作人>");
  }
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const repo = PlannerRepository.open(ctx.options.store);
  repo.requireBatch(batchId);
  const { entry } = revokeExemption(repo.store.exemptions, { batchId, reason, actor, revokedOn: asOf });
  repo.save();
  process.stdout.write(`已追加撤销事件 #${entry.seq}，豁免即刻失效\nchainHash: ${entry.entryHash}\n`);
  return 0;
}

/** exempt:history <batchId> —— 打印完整只追加原因链。 */
export function cmdExemptHistory(ctx: CommandContext): number {
  const batchId = ctx.args.positionals[0];
  if (!batchId) throw new PlannerError("USAGE", "用法: exempt:history <batchId>");
  const repo = PlannerRepository.open(ctx.options.store);
  repo.requireBatch(batchId);
  const record = repo.store.exemptions[batchId];
  const asOf = resolveAsOf(ctx.args.values.get("as-of"));
  const active = record ? activeExemption(record, asOf) : null;
  if (!record || record.entries.length === 0) {
    process.stdout.write("该批次暂无豁免原因链\n");
    return 0;
  }
  const colors = palette(ctx.options.color);
  process.stdout.write(
    [
      colors.cyan(`批次 ${batchId} 豁免原因链（共 ${record.entries.length} 条，只追加）`),
      active ? colors.magenta(`当前生效：保留至 ${active.validUntil}（${active.actor}：${active.reason}）`) : "当前无生效豁免",
      "",
      ...record.entries.map(formatChainEntry)
    ].join("\n") + "\n"
  );
  return 0;
}

function formatChainEntry(entry: ExemptionChainEntry): string {
  const validUntil = entry.type === "REVOKE" ? "—" : (entry.validUntil ?? "—");
  return [
    `#${entry.seq} ${entry.type}  ${entry.grantedOn}  保留至 ${validUntil}  操作人 ${entry.actor}`,
    `   原因：${entry.reason}`,
    `   当时客观结论：${riskLabel(entry.captured.riskLevel)}/${ACTION_LABEL[entry.captured.disposition]}  距硬效期 ${
      entry.captured.daysToHardExpiry === null ? "∞" : `${entry.captured.daysToHardExpiry}天`
    }  损耗 ${entry.captured.projectedWasteRatio === null ? "—" : `${(entry.captured.projectedWasteRatio * 100).toFixed(1)}%`}`,
    `   prevHash ${entry.prevHash.slice(0, 16)}…  entryHash ${entry.entryHash.slice(0, 16)}…`
  ].join("\n");
}

/** verify —— 校验全部豁免原因链完整性。 */
export function cmdVerify(ctx: CommandContext): number {
  const repo = PlannerRepository.open(ctx.options.store);
  const { ok, results } = validateAllChains(repo.store.exemptions);
  let total = 0;
  for (const [batchId, result] of Object.entries(results)) {
    total += result.checked;
    process.stdout.write(`${batchId}: ${result.ok ? `OK（${result.checked} 条）` : `异常 ${result.errors.join("; ")}`}\n`);
  }
  process.stdout.write(ok ? `全部原因链完整，共校验 ${total} 条\n` : "存在被篡改或断裂的原因链\n");
  return ok ? 0 : 1;
}
