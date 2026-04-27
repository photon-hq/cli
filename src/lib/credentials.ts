import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialsDir, credentialsPath } from "~/lib/env.ts";

export interface Credentials {
  /** Bearer access token issued by better-auth device-authorization. */
  accessToken: string;
  /** ISO timestamp if the server told us when the token expires. */
  expiresAt?: string;
  /** Cached identity for `whoami` and login confirmation. */
  user: { id: string; email: string; name: string };
  /** Environment this credential belongs to. */
  envName: string;
  /** API base URL pinned at login time (so env URL changes don't strand creds). */
  apiUrl: string;
  /** ISO timestamp of when these credentials were issued locally. */
  issuedAt: string;
}

export async function loadCredentials(
  envName: string
): Promise<Credentials | null> {
  const file = Bun.file(credentialsPath(envName));
  if (!(await file.exists())) {
    return null;
  }
  try {
    return (await file.json()) as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const path = credentialsPath(creds.envName);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(creds, null, 2) + "\n");
  // chmod 600 — only the owner can read this file. Token is sensitive.
  await chmod(path, 0o600);
}

export async function clearCredentials(envName: string): Promise<void> {
  const path = credentialsPath(envName);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** List environments that have stored credentials (logged-in envs). */
export async function listAuthenticatedEnvs(): Promise<string[]> {
  try {
    const entries = await readdir(credentialsDir());
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -".json".length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Convenience: load credentials for a list of env names. */
export async function loadCredentialsBatch(
  envNames: string[]
): Promise<Map<string, Credentials>> {
  const out = new Map<string, Credentials>();
  for (const name of envNames) {
    const c = await loadCredentials(name);
    if (c) out.set(name, c);
  }
  return out;
}

export { credentialsDir, credentialsPath };
