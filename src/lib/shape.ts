import { die } from "~/lib/output.ts";

/**
 * Runtime container-shape guards for API list payloads.
 *
 * The generated contract can lag the deployed API: when a list endpoint
 * drifts (array → object or back), the compile-time types stay quiet and
 * the command crashes with `H.map is not a function` — that's how
 * `spectrum users list` broke on CLIs ≤0.4.0 and `spectrum lines list`
 * on ≤1.1.0. These guards check the shape actually being iterated and
 * fail with a message that names the endpoint drift instead.
 */

const SHAPE_HINT =
  "The API response format may have changed — try updating the CLI.";

/** For endpoints whose payload IS the list (e.g. GET /api/projects). */
export function requireArray<T>(
  value: readonly T[] | Record<string, unknown> | null | undefined,
  what: string,
  legacyField?: string
): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  if (legacyField && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>)[legacyField];
    if (Array.isArray(nested)) return nested as T[];
  }
  die(`Unexpected API response: expected an array of ${what}.`, {
    hint: SHAPE_HINT,
  });
}

/**
 * For endpoints whose payload is a plain key→value record (e.g. the
 * platforms toggle map). Arrays are objects too, so reject them
 * explicitly — Object.entries on a drifted array yields index keys and
 * renders a garbage table instead of failing.
 */
export function requireBooleanRecord(
  value: unknown,
  what: string
): Record<string, boolean> {
  if (value == null) return {};
  if (Array.isArray(value)) {
    const entries: [string, boolean][] = [];
    for (const item of value) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { platform?: unknown }).platform !== "string" ||
        typeof (item as { enabled?: unknown }).enabled !== "boolean"
      ) {
        die(`Unexpected API response: expected a ${what} object.`, {
          hint: SHAPE_HINT,
        });
      }
      entries.push([
        (item as { platform: string }).platform,
        (item as { enabled: boolean }).enabled,
      ]);
    }
    return Object.fromEntries(entries);
  }
  if (
    typeof value === "object" &&
    Object.values(value).every((enabled) => typeof enabled === "boolean")
  ) {
    return value as Record<string, boolean>;
  }
  die(`Unexpected API response: expected a ${what} object.`, {
    hint: SHAPE_HINT,
  });
}

/**
 * For endpoints that wrap the list in an envelope (e.g. `{users, total}`,
 * `{lines, pendingRegistrations}`). A null/undefined payload means "no
 * data" and maps to []; an envelope that exists must contain the expected
 * array. A missing, null, or otherwise non-array field means the envelope
 * drifted, so fail loudly rather than render an empty-but-wrong "No X yet."
 */
export function requireArrayField<K extends string, T>(
  container:
    | readonly T[]
    | { readonly [P in K]: readonly T[] }
    | null
    | undefined,
  key: K,
  what: string = key
): T[] {
  if (container == null) return [];
  if (Array.isArray(container)) return container as T[];
  const value = (container as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    die(`Unexpected API response: expected an array of ${what}.`, {
      hint: SHAPE_HINT,
    });
  }
  return value as T[];
}
