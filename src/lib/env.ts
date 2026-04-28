import { existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Built-in environments. Hardcoded — users cannot override these names,
 * but they can add custom environments via `photon env add`.
 */
export const BUILTIN_ENVS = {
  production: "https://app.photon.codes",
  staging: "https://staging-app.photon.codes",
  dev: "http://localhost:3001",
} as const;

export type BuiltinEnvName = keyof typeof BUILTIN_ENVS;

export const DEFAULT_ENV: BuiltinEnvName = "production";

export interface ResolvedEnv {
  name: string;
  url: string;
  builtin: boolean;
}

export function isBuiltin(name: string): name is BuiltinEnvName {
  return name in BUILTIN_ENVS;
}

/**
 * Validate that an env name is safe to use as a filesystem path component.
 *
 * Env names come from CLI args (`--env`), env vars (`PHOTON_ENV`), and
 * config.json (`customEnvs` keys). Without validation, a name like
 * `../../foo` could read/write/delete files outside the credentials dir
 * via `credentialsPath(envName)`.
 *
 * Restrict to a conservative alphabet that's also nice in shell + UI:
 * lowercase letters, digits, hyphen, underscore. Length 1-64.
 */
const SAFE_ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSafeEnvName(name: string): void {
  if (!SAFE_ENV_NAME_RE.test(name)) {
    throw new Error(
      `Invalid environment name "${name}" — must be 1-64 chars, ` +
        `start with a-z or 0-9, and only contain a-z, 0-9, '-', '_'.`
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

export const credentialsPath = (envName: string): string => {
  assertSafeEnvName(envName);
  return path.join(configDir(), "credentials", `${envName}.json`);
};

export const credentialsDir = (): string => path.join(configDir(), "credentials");
