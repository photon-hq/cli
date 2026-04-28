import { treaty } from "@elysiajs/eden";
import type { PublicApp } from "~/types/api";
import { resolveEnv } from "~/lib/config.ts";
import { loadCredentials } from "~/lib/credentials.ts";
import type { Credentials } from "~/lib/credentials.ts";
import { debugHttp } from "~/lib/debug.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { NotAuthenticatedError } from "~/lib/errors.ts";

export interface ApiOptions {
  /** Override the active environment by name. */
  envName?: string;
  /**
   * Bypass env resolution entirely with a raw URL. When set, no
   * credential lookup happens — useful for ping / health checks
   * against an arbitrary host.
   */
  url?: string;
  /**
   * Override stored credentials with an explicit token. Wins over
   * stored creds when both are present. Source: `--token` flag or
   * `PHOTON_TOKEN` env (resolved by the caller; this just accepts
   * the resolved value).
   */
  token?: string;
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
 * Bearer auth injected if available (via `--token` flag, `PHOTON_TOKEN`
 * env, or stored credentials in that order).
 *
 * Use `requireAuth: true` for commands that must be logged in — the
 * helper throws NotAuthenticatedError before any network call.
 */
export async function getApi(opts: ApiOptions = {}): Promise<ApiContext> {
  const env: ResolvedEnv = opts.url
    ? { name: "custom", url: opts.url, builtin: false }
    : await resolveEnv(opts.envName);

  // Token resolution priority:
  //   --token flag > $PHOTON_TOKEN > $DASHBOARD_TOKEN (legacy) > stored creds
  const explicitToken =
    opts.token ?? process.env.PHOTON_TOKEN ?? process.env.DASHBOARD_TOKEN;

  const creds = opts.url || explicitToken
    ? null
    : await loadCredentials(env.name);

  if (opts.requireAuth && !creds && !explicitToken) {
    throw new NotAuthenticatedError(env.name);
  }

  const accessToken = explicitToken ?? creds?.accessToken;
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  // Wrap fetch to log every request when --debug is enabled. The treaty
  // accepts a fetch override via the second argument. We use Object.assign
  // to copy `preconnect` (Bun-specific) from the global fetch onto our
  // wrapper, since Eden expects the full `typeof fetch` shape.
  const tracedFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const start = performance.now();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      try {
        const response = await fetch(input, init);
        debugHttp({
          method,
          url,
          status: response.status,
          durationMs: Math.round(performance.now() - start),
        });
        return response;
      } catch (err) {
        debugHttp({
          method,
          url,
          status: 0,
          durationMs: Math.round(performance.now() - start),
        });
        throw err;
      }
    },
    { preconnect: fetch.preconnect.bind(fetch) }
  ) as typeof fetch;

  return {
    api: treaty<PublicApp>(env.url, {
      headers,
      fetcher: tracedFetch,
    }),
    env,
    creds,
  };
}
