#!/usr/bin/env node
import { PlannerError } from "../types.js";
import {
  cmdBatchAdd,
  cmdBatchList,
  cmdExemptExtend,
  cmdExemptGrant,
  cmdExemptHistory,
  cmdExemptRevoke,
  cmdExplain,
  cmdPlan,
  cmdVerify,
  defaultStorePath,
  type CommandContext
} from "./commands.js";
import { parseArgs } from "./format.js";

const COMMANDS: Record<string, (ctx: CommandContext) => number> = {
  "batch:add": cmdBatchAdd,
  "batch:list": cmdBatchList,
  plan: cmdPlan,
  explain: cmdExplain,
  "exempt:grant": cmdExemptGrant,
  "exempt:extend": cmdExemptExtend,
  "exempt:revoke": cmdExemptRevoke,
  "exempt:history": cmdExemptHistory,
  verify: cmdVerify
};

const HELP = `材料效期风险规划器

用法:
  expiry-plan <command> [参数] [--store PATH] [--no-color]

全局选项:
  --store PATH        仓库 JSON 路径（默认 ./expiry-planner.json，或环境变量 EXPIRY_PLANNER_STORE）
  --no-color          关闭彩色输出

批次:
  batch:add <file.json>              导入一个批次快照（或数组，字段见 README）
  batch:list                         列出在管批次

规划:
  plan [--as-of YYYY-MM-DD] [--config JSON] [--json] [--determinism-check]
  explain <batchId> [--as-of ...]    查看单个批次的完整判定原因链

人工豁免（只追加原因链，重算不丢失、不改写）:
  exempt:grant  <batchId> --reason <原因> --actor <操作人> --valid-until YYYY-MM-DD
  exempt:extend <batchId> --reason <原因> --actor <操作人> --valid-until YYYY-MM-DD
  exempt:revoke <batchId> --reason <撤销原因> --actor <操作人>
  exempt:history <batchId>           查看完整豁免原因链
  verify                             校验所有原因链哈希完整性

规划是纯函数：相同批次、日期、配置和豁免链，重算结果逐字节一致。
`;

function main(): number {
  const argv = process.argv.slice(2);
  const commandName = argv[0];
  if (!commandName || commandName === "-h" || commandName === "--help" || commandName === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const handler = COMMANDS[commandName];
  if (!handler) {
    process.stderr.write(`未知命令: ${commandName}\n\n${HELP}`);
    return 2;
  }

  const parsed = parseArgs(argv.slice(1));
  const store = parsed.values.get("store") ?? defaultStorePath();
  const color = !parsed.flags.has("no-color") && process.stdout.isTTY !== false;
  const ctx: CommandContext = { options: { store, color }, args: parsed };

  try {
    return handler(ctx);
  } catch (error) {
    if (error instanceof PlannerError) {
      process.stderr.write(`错误[${error.code}]: ${error.message}\n`);
      return 1;
    }
    if (error instanceof SyntaxError) {
      process.stderr.write(`错误[BAD_JSON]: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main();
