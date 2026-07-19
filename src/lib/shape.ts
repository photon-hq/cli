import { die } from "~/lib/output.ts";

/**
 * Runtime container-shape guards for API list payloads. The generated
 * contract cannot protect a published CLI when a deployed response
 * changes later, so validate the documented shape before iterating it.
 */

const SHAPE_HINT =
  "The API response format may have changed — try updating the CLI.";

/** For endpoints whose documented payload is the list itself. */
export function requireArray<T>(
  value: readonly T[] | null | undefined,
  what: string
): T[];
export function requireArray(value: unknown, what: string): unknown[];
export function requireArray(value: unknown, what: string): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  die(`Unexpected API response: expected an array of ${what}.`, {
    hint: SHAPE_HINT,
  });
}

/**
 * For endpoints whose documented payload is a plain key→value record.
 * Arrays are objects too, so reject them explicitly.
 */
export function requireBooleanRecord(
  value: unknown,
  what: string
): Record<string, boolean> {
  if (value == null) return {};
  if (
    !Array.isArray(value) &&
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
 * For endpoints whose documented payload wraps the list in an envelope.
 * An envelope that exists must contain the expected array.
 */
export function requireArrayField<K extends string, T>(
  container: { readonly [P in K]: readonly T[] } | null | undefined,
  key: K,
  what?: string
): T[];
export function requireArrayField(
  container: unknown,
  key: string,
  what?: string
): unknown[];
export function requireArrayField(
  container: unknown,
  key: string,
  what: string = key
): unknown[] {
  if (container == null) return [];
  if (Array.isArray(container) || typeof container !== "object") {
    die(`Unexpected API response: expected an array of ${what}.`, {
      hint: SHAPE_HINT,
    });
  }
  const value = (container as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    die(`Unexpected API response: expected an array of ${what}.`, {
      hint: SHAPE_HINT,
    });
  }
  return value;
}
