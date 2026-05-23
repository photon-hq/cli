/**
 * Shared commander argParser helpers. Extracted so that multiple
 * commands using the same option type (e.g. `--qty <n>`) emit identical
 * validation messages.
 */
import { InvalidArgumentError } from "commander";

/**
 * Parser for "must be a positive integer" options like `--qty <n>`.
 * Throws InvalidArgumentError on bad input so commander shows a clean
 * parse error instead of NaN reaching the API.
 *
 * Uses `Number.isSafeInteger` rather than `Number.isFinite` — long
 * digit strings like "99999999999999999999" parse to values past
 * Number.MAX_SAFE_INTEGER via IEEE-754 rounding and would otherwise
 * silently propagate to the API as a different number than the user
 * typed. Fail fast on the client instead.
 */
export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`must be a non-negative integer (got "${value}")`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`must be a safe integer >= 1 (got "${value}")`);
  }
  return parsed;
}
