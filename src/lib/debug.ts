import pc from "picocolors";

/**
 * Debug logger. Writes to stderr when `--debug` flag was passed or
 * `PHOTON_DEBUG=1` is set. Silent otherwise.
 *
 * Set the flag once at startup (typically from the global `--debug`
 * commander option) via `setDebug(true)`.
 */
let DEBUG_ENABLED = process.env.PHOTON_DEBUG === "1" ||
  process.env.PHOTON_DEBUG === "true";

export function setDebug(enabled: boolean): void {
  DEBUG_ENABLED = enabled;
}

export function isDebug(): boolean {
  return DEBUG_ENABLED;
}

export function debug(...args: unknown[]): void {
  if (!DEBUG_ENABLED) return;
  const stamp = pc.dim(`[debug ${new Date().toISOString()}]`);
  console.error(stamp, ...args);
}

/**
 * Log an HTTP request with method/url/duration/status. Called from
 * the api wrapper after each fetch. Only fires when debug is enabled.
 */
export function debugHttp(opts: {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}): void {
  if (!DEBUG_ENABLED) return;
  const statusColor =
    opts.status >= 500
      ? pc.red
      : opts.status >= 400
        ? pc.yellow
        : opts.status >= 200
          ? pc.green
          : pc.dim;
  debug(
    pc.bold(opts.method.padEnd(6)),
    statusColor(String(opts.status)),
    opts.url,
    pc.dim(`${opts.durationMs}ms`)
  );
}
