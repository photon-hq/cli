import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "~/lib/env.ts";
import { c } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";
import pkg from "../../package.json" with { type: "json" };

/**
 * Self-contained update notifier.
 *
 * This used to wrap `update-notifier`, which does its registry lookup by
 * spawning `<pkg-dir>/check.js` as a detached child. We bundle the CLI
 * into a single `dist/photon.js`, so that file never shipped and the
 * child died on MODULE_NOT_FOUND with stdio ignored — no published
 * version ever showed the update box. The replacement keeps the same
 * shape (24h-cached background check, notice on a later run) but spawns
 * THIS same entry file with a hidden argv flag as the checker, so
 * bundling can't break it, and drops the dependency entirely.
 *
 * Opt-outs honored: non-interactive sessions and PHOTON_NO_UPDATE_NOTIFIER=1.
 */

const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24; // 24h
const PROBE_ARG = "__photon-update-probe";

interface UpdateCache {
  lastCheck: number;
  latest?: string;
}

interface SpawnedProbe {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

type SpawnProcess = (
  executable: string,
  args: string[],
  options: { detached: true; stdio: "ignore" }
) => SpawnedProbe;

interface UpdateNotifierDependencies {
  interactive?: () => boolean;
  now?: () => number;
  spawnProbe?: (executable: string, entry: string) => void;
  spawnProcess?: SpawnProcess;
  writeError?: (message: string) => void;
}

const cachePath = (): string => path.join(configDir(), "update-check.json");

// Test hook + escape hatch for self-hosted registries.
const registryUrl = (): string =>
  process.env.PHOTON_UPDATE_REGISTRY ?? "https://registry.npmjs.org";

const parseVersion = (version: string): [bigint, bigint, bigint] | null => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    version
  );
  if (!match) return null;
  return [
    BigInt(match[1] as string),
    BigInt(match[2] as string),
    BigInt(match[3] as string),
  ];
};

export function readUpdateCache(): UpdateCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { lastCheck: 0 };
    }
    const { lastCheck, latest } = parsed as Record<string, unknown>;
    if (
      typeof lastCheck !== "number" ||
      !Number.isFinite(lastCheck) ||
      lastCheck < 0
    ) {
      return { lastCheck: 0 };
    }
    if (typeof latest === "string" && parseVersion(latest)) {
      return { lastCheck, latest };
    }
    return { lastCheck };
  } catch {
    return { lastCheck: 0 };
  }
}

function writeCache(cache: UpdateCache): void {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
}

/**
 * Dotted-numeric semver compare. Prerelease/garbage segments compare as
 * "not newer" — a notifier must never nag someone off a stable release
 * onto something it can't parse.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as bigint) > (b[i] as bigint);
  }
  return false;
}

/** True when this process was launched as the detached background probe. */
export const isUpdateProbeInvocation = (argv: string[]): boolean =>
  argv[2] === PROBE_ARG;

/**
 * The detached child's job: stamp lastCheck first (so an offline probe
 * doesn't retry-storm on every invocation), then fetch the dist-tag and
 * cache it for the next interactive run to display.
 */
export async function runUpdateProbe(): Promise<void> {
  try {
    writeCache({ ...readUpdateCache(), lastCheck: Date.now() });
    const res = await fetch(
      `${registryUrl()}/${encodeURIComponent(pkg.name)}/latest`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      }
    );
    if (!res.ok) return;
    const info = (await res.json()) as { version?: unknown };
    if (typeof info.version === "string" && parseVersion(info.version)) {
      writeCache({ lastCheck: Date.now(), latest: info.version });
    }
  } catch {
    // Cache I/O, offline, and registry failures are all best-effort.
  }
}

/**
 * Call once at startup, before commander. Prints to stderr so `--json`
 * pipelines never see it.
 */
export function startUpdateNotifier(
  dependencies: UpdateNotifierDependencies = {}
): void {
  const interactive = dependencies.interactive ?? isInteractive;
  if (!interactive()) return;
  if (process.env.PHOTON_NO_UPDATE_NOTIFIER === "1") return;

  const cache = readUpdateCache();
  const writeError =
    dependencies.writeError ?? ((message: string) => console.error(message));
  if (cache.latest && isNewerVersion(cache.latest, pkg.version)) {
    writeError(c.warn(`Update available: ${pkg.version} → ${cache.latest}`));
    writeError(
      c.hint(
        `  Run \`npm update -g ${pkg.name}\`, or use the installer you originally chose.`
      )
    );
  }

  const now = dependencies.now ?? Date.now;
  const elapsed = now() - cache.lastCheck;
  if (elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) return;
  const entry = process.argv[1];
  if (!entry) return;
  const spawnProbe =
    dependencies.spawnProbe ??
    ((executable: string, entryFile: string) => {
      const spawnProcess = dependencies.spawnProcess ?? spawn;
      try {
        const child = spawnProcess(executable, [entryFile, PROBE_ARG], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => undefined);
        child.unref();
      } catch {
        // Update checks are best-effort and must never break the CLI.
      }
    });
  spawnProbe(process.execPath, entry);
}
