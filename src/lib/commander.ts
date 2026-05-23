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
 */
export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`must be a non-negative integer (got "${value}")`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`must be at least 1 (got "${value}")`);
  }
  return parsed;
}
