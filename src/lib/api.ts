import { treaty } from "@elysiajs/eden";
import type { PublicApp } from "@photon-ai/dashboard-api";
import { resolveEnv } from "~/lib/config.ts";
import { loadCredentials } from "~/lib/credentials.ts";
import type { Credentials } from "~/lib/credentials.ts";
import { debugHttp, isDebug } from "~/lib/debug.ts";
import { normalizeOrigin } from "~/lib/env.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { NotAuthenticatedError } from "~/lib/errors.ts";

export interface ApiOptions {
  /**
   * Override the active backend by URL — typically the value of
   * `--api-host <url>`. When unset, falls back to the `PHOTON_API_HOST`
   * env var, then to the built-in production URL.
   */
  apiHost?: string;
  /**
   * Bypass env resolution entirely with a raw URL. When set, no
   * credential lookup happens — useful for ping / health checks
   * against an arbitrary host.
   */
  url?: string;
  /**
   * Override stored credentials with an explicit token. If provided,
   * this wins over $PHOTON_TOKEN, $DASHBOARD_TOKEN, and stored creds.
   * If omitted, getApi() falls back to $PHOTON_TOKEN and then
   * $DASHBOARD_TOKEN (legacy alias) before loading stored credentials.
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
  // URL-mode is for arbitrary-host pings (no credential lookup), so we
  // skip hostKey() here — its 64-char ceiling and IPv6 quirks are about
  // safe filenames, not safe HTTP. We still normalize via .origin so the
  // base URL is canonical regardless of trailing slashes.
  const env: ResolvedEnv = opts.url
    ? { name: "custom", url: normalizeOrigin(opts.url) }
    : await resolveEnv(opts.apiHost);

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

  // Only wrap fetch when --debug is enabled. The wrapper has measurable
  // per-request overhead (performance.now() + try/catch + URL/Request
  // unwrapping), and the vast majority of CLI invocations don't need it.
  const fetcher = isDebug() ? buildTracedFetch() : fetch;

  return {
    api: treaty<PublicApp>(env.url, {
      headers,
      fetcher,
    }),
    env,
    creds,
  };
}

/**
 * Build a fetch wrapper that logs each request via debugHttp.
 *
 * Method derivation: prefer init.method, then a Request input's own
 * method, then default to GET. Without the Request fallback,
 * `new Request("url", { method: "POST" })` would be misreported as GET.
 */
function buildTracedFetch(): typeof fetch {
  return Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const start = performance.now();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (
        init?.method ??
        (input instanceof Request ? input.method : undefined) ??
        "GET"
      ).toUpperCase();
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
    typeof fetch.preconnect === "function"
      ? { preconnect: fetch.preconnect.bind(fetch) }
      : {}
  ) as typeof fetch;
}
