import Table from "cli-table3";
import pc from "picocolors";

/** Color helpers + named status formatters. Centralized to keep tone consistent. */
export const c = {
  bold: pc.bold,
  dim: pc.dim,
  italic: pc.italic,
  underline: pc.underline,
  cyan: pc.cyan,
  green: pc.green,
  yellow: pc.yellow,
  red: pc.red,
  gray: pc.gray,
  blue: pc.blue,
  magenta: pc.magenta,
  success: (s: string): string => pc.green(`✓ ${s}`),
  error: (s: string): string => pc.red(`✗ ${s}`),
  info: (s: string): string => pc.cyan(`◆ ${s}`),
  warn: (s: string): string => pc.yellow(`! ${s}`),
  hint: (s: string): string => pc.dim(s),
};

export function printTable(headers: string[], rows: string[][]): void {
  const table = new Table({
    head: headers.map((h) => c.bold(h)),
    style: {
      head: [],
      border: ["gray"],
    },
  });
  for (const row of rows) {
    table.push(row);
  }
  console.log(table.toString());
}

export function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * Normalize Eden treaty error responses into a single line.
 *
 * Eden's error shape is `{ status, value }`. `value` can be a string,
 * an Elysia validation error, or a custom handler return.
 */
export function formatApiError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const e = error as { status?: number; value?: unknown };
    const status = e.status ? ` [${e.status}]` : "";
    if (typeof e.value === "string") return e.value + status;
    if (typeof e.value === "object" && e.value !== null) {
      const v = e.value as { error?: unknown; message?: unknown };
      if (v.error) return String(v.error) + status;
      if (v.message) return String(v.message) + status;
    }
    return JSON.stringify(e.value ?? error) + status;
  }
  return String(error);
}

export interface DieOptions {
  /** "What to try next" — printed dim under the error line. */
  hint?: string;
  /** Free-form context — env, project id, URL, etc. — printed dim. */
  context?: string;
  /** Override exit code. Defaults to 1. */
  code?: number;
}

/**
 * Print a formatted error and exit non-zero.
 *
 * Output format:
 *   ✗ <message>
 *     Hint: <hint>          (if provided)
 *     <context>             (if provided)
 *
 * Inspired by Rust's compiler messages — terse first line, optional
 * actionable hint, optional context block.
 */
export function die(message: string, opts: DieOptions = {}): never {
  console.error(c.error(message));
  if (opts.hint) console.error(c.hint(`  Hint: ${opts.hint}`));
  if (opts.context) console.error(c.dim(`  ${opts.context}`));
  process.exit(opts.code ?? 1);
}
