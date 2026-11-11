import semverSatisfies from "semver/functions/satisfies.js";
import updateNotifier from "update-notifier";
import { c } from "~/lib/output.ts";
import { UPDATE_DIST_TAG } from "~/lib/self-update.ts";
import { isInteractive } from "~/lib/tty.ts";
import pkg from "../../package.json" with { type: "json" };

interface UpdateNotifierDependencies {
  interactive?: () => boolean;
  createNotifier?: typeof updateNotifier;
}

const UPDATE_MESSAGE =
  `Update available ${c.dim("{currentVersion}")} → ${c.green("{latestVersion}")}` +
  `\nRun ${c.cyan("photon update")} to update`;

/**
 * Light-weight wrapper around `update-notifier`. Disabled in non-TTY
 * and when `PHOTON_NO_UPDATE_NOTIFIER=1` is set. Caches lookups for
 * 24h. Posts the standard boxed notification on the next run after a
 * new version is detected — does not block the current run.
 *
 * Releases are looked up on npm's `legacy` dist-tag, never `latest`.
 * Older releases that followed `latest` share the lookup cache, so a
 * cached update outside this major line is ignored.
 *
 * Call this once at startup, BEFORE invoking commander. The notifier
 * spawns a detached child process to do the npm registry lookup, so
 * there's no perceptible startup cost.
 */
export function startUpdateNotifier(
  dependencies: UpdateNotifierDependencies = {}
): void {
  const interactive = dependencies.interactive ?? isInteractive;
  if (!interactive()) return;
  if (process.env.PHOTON_NO_UPDATE_NOTIFIER === "1") return;

  const createNotifier = dependencies.createNotifier ?? updateNotifier;
  const notifier = createNotifier({
    pkg: { name: pkg.name, version: pkg.version },
    distTag: UPDATE_DIST_TAG,
    updateCheckInterval: 1000 * 60 * 60 * 24, // 24h
  });
  const { update } = notifier;
  if (
    update &&
    (typeof update.latest !== "string" ||
      !semverSatisfies(update.latest, `^${pkg.version}`))
  ) {
    return;
  }

  // .notify() prints (on the NEXT invocation, after a fresh fetch
  // landed in the cache). The first call schedules the background
  // lookup and returns immediately.
  notifier.notify({ defer: true, isGlobal: true, message: UPDATE_MESSAGE });
}
