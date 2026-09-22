/** 极简命令行参数解析：支持 --flag、--key=value、--key value 以及位置参数。 */
export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equalAt = body.indexOf("=");
      if (equalAt >= 0) {
        values.set(body.slice(0, equalAt), body.slice(equalAt + 1));
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          values.set(body, next);
          index += 1;
        } else {
          flags.add(body);
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags, values };
}

const RESET = "\x1b[0m";
const COLORS: Record<string, string> = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

export function paint(color: keyof typeof COLORS, text: string, enabled: boolean): string {
  return enabled ? `${COLORS[color]}${text}${RESET}` : text;
}

/** 按显示宽度（东亚全角字符算 2）截断补白。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

function padEndDisplay(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/** 紧凑速率展示：保留最多 4 位小数，避免 9 位定标小数撑爆表格；完整精度走 --json。 */
export function compactRate(value: string | null): string {
  if (value === null) return "—";
  if (!value.includes(".")) return value;
  const [whole, fraction] = value.split(".") as [string, string];
  const trimmed = (fraction ?? "").replace(/0+$/, "");
  if (trimmed === "") return whole;
  return `${whole}.${trimmed.slice(0, 4)}${trimmed.length > 4 ? "…" : ""}`;
}

export interface TableColumn<T> {
  header: string;
  width: number;
  render: (row: T) => string;
  align?: "left" | "right";
}

export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  const header = columns.map((column) => padEndDisplay(column.header, column.width)).join("  ");
  const separator = columns.map((column) => "-".repeat(column.width)).join("  ");
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const text = column.render(row);
        return column.align === "right" ? text.padStart(column.width) : padEndDisplay(text, column.width);
      })
      .join("  ")
  );
  return [header, separator, ...body].join("\n");
}
