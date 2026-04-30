import { existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The only backend URL ever baked into the public bundle. Other backends
 * (staging, dev, internal previews) are reachable via the `PHOTON_API_HOST`
 * env var or the per-command `--api-host <url>` flag — that way internal
 * URLs never ship to npm or to the standalone binaries.
 */
export const PRODUCTION_URL = "https://app.photon.codes";

export interface ResolvedEnv {
  /** Filesystem-safe key derived from the URL, used for credentials/links files. */
  name: string;
  /** The full base URL (scheme + host [+ port]). */
  url: string;
}

/**
 * Resolve which backend URL to talk to.
 *
 * Priority: explicit override (e.g. from `--api-host`) > $PHOTON_API_HOST
 *   > built-in production.
 */
export function resolveApiHost(override?: string): string {
  return override ?? process.env.PHOTON_API_HOST ?? PRODUCTION_URL;
}

/**
 * Normalize a raw URL string to its `origin` — scheme + host (+ port if
 * non-default), no trailing slash, no path, no query, no fragment. Throws
 * a typed message on parse failure.
 *
 * Exported so URL-mode callers (e.g. `getApi({ url })` for unauth pings)
 * can normalize without triggering `hostKey()`'s credential-key constraints
 * (64-char ceiling, etc.).
 */
export function normalizeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(
      `Invalid API host URL: "${raw}". Must include scheme — e.g. https://your.host.tld.`
    );
  }
}

/**
 * Resolve the active env (URL + filesystem key) for credentials / links.
 * Throws if the URL is malformed or produces a key that would be unsafe
 * to use as a filename.
 *
 * The returned `url` is the normalized origin so persisted `creds.apiUrl`
 * is canonical.
 */
export function resolveActiveEnv(override?: string): ResolvedEnv {
  const url = normalizeOrigin(resolveApiHost(override));
  return { name: hostKey(url), url };
}

/**
 * Convert a backend URL to a stable filesystem-safe key. Used for naming
 * `credentials/<key>.json` and `links/<key>.json` so a user can be logged
 * into multiple backends simultaneously without collisions.
 *
 * Encoding: hostname is lowercased; `.`, `:`, `%` are replaced with `_`
 * (chosen because `_` is not a valid hostname character per RFC 1123, so
 * `a-b.com` → `a-b_com` and `a.b-com` → `a_b-com` produce distinct keys).
 * Non-default ports are appended as `_<port>`.
 *
 * Special case: the production URL maps to the literal string "production"
 * — preserves `~/.config/photon/credentials/production.json` files from
 * prior CLI versions where envs had named identifiers instead of URLs.
 */
export function hostKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid API host URL: "${url}". Must include scheme — e.g. https://your.host.tld.`
    );
  }
  // Compare on origin so trailing slashes / paths / queries don't break
  // the back-compat fallback to "production".
  if (parsed.origin === PRODUCTION_URL) return "production";

  // Strip IPv6 brackets first (some URL parsers preserve them in
  // `hostname`), then normalize remaining unsafe chars to `_`.
  const host = parsed.hostname
    .toLowerCase()
    .replace(/[[\]]/g, "")
    .replace(/[.:%]/g, "_");
  const port = parsed.port ? `_${parsed.port}` : "";
  const key = `${host}${port}`;

  // assertSafeEnvName caps at 64 chars; surface a clearer message before
  // it fires deep inside credentialsPath().
  if (key.length > 64) {
    throw new Error(
      `API host "${url}" produces a key longer than 64 characters (got ${key.length}). ` +
        `Use a shorter hostname or alias the host in your local hosts file / DNS.`
    );
  }
  return key;
}

/**
 * Validate that a key is safe to use as a filesystem path component.
 *
 * `hostKey()` produces only characters from the allowed alphabet, but
 * env-name-shaped strings can also enter via legacy config files or
 * directory listings (`readdir(credentialsDir())`). Without validation, a
 * value like `../../foo` could read/write/delete files outside the
 * credentials dir via `credentialsPath(key)`.
 *
 * Restrict to a conservative alphabet: lowercase letters, digits, hyphen,
 * underscore. Length 1-64.
 */
// First char allows `_` because hostKey() can produce keys like `_3000`
// from IPv6 hostnames (after the leading `::` collapses to empties).
const SAFE_KEY_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

export function assertSafeEnvName(key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(
      `Invalid environment key "${key}" — must be 1-64 chars, ` +
        `start with a-z, 0-9, or '_', and only contain a-z, 0-9, '-', '_'.`
    );
  }
}

/**
 * `~/.config/photon/` (XDG) by default.
 * Overrides (in priority order):
 *   1. $PHOTON_CONFIG_DIR
 *   2. $DASHBOARD_CONFIG_DIR (legacy alias from when bin was `dashboard`)
 *   3. $XDG_CONFIG_HOME/photon
 *   4. ~/.config/photon
 *
 * Migration: if `~/.config/photon-dashboard/` exists from a prior install
 * and the new path doesn't, rename it. Lossless and one-shot.
 */
export function configDir(): string {
  const override =
    process.env.PHOTON_CONFIG_DIR ?? process.env.DASHBOARD_CONFIG_DIR;
  if (override) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const newDir = xdg
    ? path.join(xdg, "photon")
    : path.join(os.homedir(), ".config", "photon");
  const oldDir = xdg
    ? path.join(xdg, "photon-dashboard")
    : path.join(os.homedir(), ".config", "photon-dashboard");

  // Migration is best-effort. If the rename fails (perms, race, partial),
  // keep using the legacy path so existing creds + config aren't silently
  // stranded — the user would otherwise look mysteriously logged out.
  let resolvedDir = newDir;
  if (!existsSync(newDir) && existsSync(oldDir)) {
    try {
      renameSync(oldDir, newDir);
    } catch {
      resolvedDir = oldDir;
    }
  }
  return resolvedDir;
}

export const configPath = (): string => path.join(configDir(), "config.json");

export const credentialsDir = (): string =>
  path.join(configDir(), "credentials");

export const credentialsPath = (key: string): string => {
  assertSafeEnvName(key);
  return path.join(credentialsDir(), `${key}.json`);
};
