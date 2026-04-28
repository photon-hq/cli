import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertSafeEnvName, configDir } from "~/lib/env.ts";

/**
 * Storage: `~/.config/photon/links/<envName>.json` — one file per
 * environment. Mirrors per-env credentials so the active project
 * naturally scopes to env. Switching env via `photon env use <other>`
 * picks up that env's linked project automatically.
 */
export interface ProjectLink {
  projectId: string;
  projectName: string;
  /** Redundant with file path but useful for round-trip / display. */
  envName: string;
  /** ISO timestamp the link was established. */
  linkedAt: string;
}

const linksDir = (): string => join(configDir(), "links");

export const linkPath = (envName: string): string => {
  assertSafeEnvName(envName);
  return join(linksDir(), `${envName}.json`);
};

export async function loadLink(envName: string): Promise<ProjectLink | null> {
  const file = Bun.file(linkPath(envName));
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as ProjectLink;
  } catch {
    return null;
  }
}

export async function saveLink(link: ProjectLink): Promise<void> {
  const path = linkPath(link.envName);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(link, null, 2) + "\n");
  // chmod 600 — link files live alongside credentials/. Not strictly
  // sensitive, but consistency is cheaper than a future audit finding.
  await chmod(path, 0o600);
}

export async function clearLink(envName: string): Promise<void> {
  const path = linkPath(envName);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Read every link file into memory. Used by `link:status`. */
export async function listLinks(): Promise<ProjectLink[]> {
  let entries: string[];
  try {
    entries = await readdir(linksDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const links: ProjectLink[] = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const envName = e.slice(0, -".json".length);
    const link = await loadLink(envName);
    if (link) links.push(link);
  }
  return links.sort((a, b) => a.envName.localeCompare(b.envName));
}
