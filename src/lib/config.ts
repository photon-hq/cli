import { configDir, resolveActiveEnv } from "~/lib/env.ts";
import type { ResolvedEnv } from "~/lib/env.ts";

/**
 * Resolve the active backend (URL + filesystem key) for an HTTP call.
 *
 * `override` is a full URL — typically the value of the per-command
 * `--api-host <url>` flag. When unset, falls back to the `PHOTON_API_HOST`
 * env var, then to the built-in production URL.
 *
 * Async signature is kept for backwards compatibility with existing call
 * sites; the implementation is pure.
 */
export async function resolveEnv(override?: string): Promise<ResolvedEnv> {
  return resolveActiveEnv(override);
}

export { configDir };
