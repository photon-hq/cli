import { treaty } from "@elysiajs/eden";
import type { PublicApp } from "~/types/api";
import { resolveEnv } from "~/lib/config.ts";
import { loadCredentials } from "~/lib/credentials.ts";
import type { Credentials } from "~/lib/credentials.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { NotAuthenticatedError } from "~/lib/errors.ts";

export interface ApiOptions {
  /** Override the active environment by name. */
  envName?: string;
  /** Bypass env resolution entirely with a raw URL. Skips credential loading. */
  url?: string;
  /** Throw NotAuthenticatedError if no credentials are stored for this env. */
  requireAuth?: boolean;
}

export interface ApiContext {
  api: ReturnType<typeof treaty<PublicApp>>;
  env: ResolvedEnv;
  creds: Credentials | null;
}

/**
 * Build an Eden treaty client targeting the resolved environment, with
 * Bearer auth injected if credentials are stored for that env.
 *
 * Use `requireAuth: true` for commands that must be logged in — the helper
 * throws NotAuthenticatedError before any network call.
 */
export async function getApi(opts: ApiOptions = {}): Promise<ApiContext> {
  const env: ResolvedEnv = opts.url
    ? { name: "custom", url: opts.url, builtin: false }
    : await resolveEnv(opts.envName);

  const creds = opts.url ? null : await loadCredentials(env.name);

  if (opts.requireAuth && !creds) {
    throw new NotAuthenticatedError(env.name);
  }

  const headers: Record<string, string> = {};
  if (creds) {
    headers.Authorization = `Bearer ${creds.accessToken}`;
  }

  return {
    api: treaty<PublicApp>(env.url, { headers }),
    env,
    creds,
  };
}
