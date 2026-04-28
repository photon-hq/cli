import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BUILTIN_ENVS,
  DEFAULT_ENV,
  configDir,
  configPath,
  isBuiltin,
} from "~/lib/env.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { UnknownEnvError } from "~/lib/errors.ts";

export interface DashboardConfig {
  currentEnv: string;
  customEnvs: Record<string, string>;
}

const DEFAULT_CONFIG: DashboardConfig = {
  currentEnv: DEFAULT_ENV,
  customEnvs: {},
};

export async function loadConfig(): Promise<DashboardConfig> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = (await file.json()) as Partial<DashboardConfig>;
    return {
      currentEnv: raw.currentEnv ?? DEFAULT_CONFIG.currentEnv,
      customEnvs: raw.customEnvs ?? {},
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: DashboardConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await Bun.write(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export function listEnvs(config: DashboardConfig): ResolvedEnv[] {
  const builtin: ResolvedEnv[] = Object.entries(BUILTIN_ENVS).map(
    ([name, url]) => ({ name, url, builtin: true })
  );
  const custom: ResolvedEnv[] = Object.entries(config.customEnvs).map(
    ([name, url]) => ({ name, url, builtin: false })
  );
  return [...builtin, ...custom];
}

/**
 * Resolve which environment to use for a command.
 *
 * Priority: explicit override > $DASHBOARD_ENV > config.currentEnv > DEFAULT.
 */
export async function resolveEnv(override?: string): Promise<ResolvedEnv> {
  const config = await loadConfig();
  const name =
    override ?? process.env.DASHBOARD_ENV ?? config.currentEnv ?? DEFAULT_ENV;

  if (isBuiltin(name)) {
    return { name, url: BUILTIN_ENVS[name], builtin: true };
  }
  const customUrl = config.customEnvs[name];
  if (customUrl) {
    return { name, url: customUrl, builtin: false };
  }

  const available = [
    ...Object.keys(BUILTIN_ENVS),
    ...Object.keys(config.customEnvs),
  ];
  throw new UnknownEnvError(name, available);
}

export async function setCurrentEnv(name: string): Promise<void> {
  const config = await loadConfig();
  // Validate before saving.
  if (!isBuiltin(name) && !(name in config.customEnvs)) {
    throw new UnknownEnvError(name, [
      ...Object.keys(BUILTIN_ENVS),
      ...Object.keys(config.customEnvs),
    ]);
  }
  await saveConfig({ ...config, currentEnv: name });
}

export async function addCustomEnv(name: string, url: string): Promise<void> {
  if (isBuiltin(name)) {
    throw new Error(
      `"${name}" is a built-in environment and cannot be overridden.`
    );
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`URL must start with http:// or https:// (got "${url}").`);
  }
  const config = await loadConfig();
  await saveConfig({
    ...config,
    customEnvs: { ...config.customEnvs, [name]: url },
  });
}

export async function removeCustomEnv(name: string): Promise<void> {
  if (isBuiltin(name)) {
    throw new Error(`"${name}" is built-in and cannot be removed.`);
  }
  const config = await loadConfig();
  if (!(name in config.customEnvs)) {
    const customNames = Object.keys(config.customEnvs);
    if (customNames.length === 0) {
      throw new Error("No custom environments configured.");
    }
    throw new UnknownEnvError(name, customNames);
  }
  const { [name]: _drop, ...rest } = config.customEnvs;
  let nextCurrent = config.currentEnv;
  if (nextCurrent === name) {
    nextCurrent = DEFAULT_ENV;
  }
  await saveConfig({ currentEnv: nextCurrent, customEnvs: rest });
}

export { configDir };
