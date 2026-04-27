import os from "node:os";
import path from "node:path";

/**
 * Built-in environments. Hardcoded — users cannot override these names,
 * but they can add custom environments via `dashboard env add`.
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
 * `~/.config/photon-dashboard/` (XDG) by default.
 * Overrides: $DASHBOARD_CONFIG_DIR, then $XDG_CONFIG_HOME/photon-dashboard.
 */
export function configDir(): string {
  const override = process.env.DASHBOARD_CONFIG_DIR;
  if (override) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "photon-dashboard");
  }
  return path.join(os.homedir(), ".config", "photon-dashboard");
}

export const configPath = (): string => path.join(configDir(), "config.json");
export const credentialsPath = (envName: string): string =>
  path.join(configDir(), "credentials", `${envName}.json`);
export const credentialsDir = (): string => path.join(configDir(), "credentials");
