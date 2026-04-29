import updateNotifier from "update-notifier";
import { isInteractive } from "~/lib/tty.ts";
import pkg from "../../package.json" with { type: "json" };

/**
 * Light-weight wrapper around `update-notifier`. Disabled in non-TTY
 * and when `PHOTON_NO_UPDATE_NOTIFIER=1` is set. Caches lookups for
 * 24h. Posts the standard boxed notification on the next run after a
 * new version is detected — does not block the current run.
 *
 * Call this once at startup, BEFORE invoking commander. The notifier
 * spawns a detached child process to do the npm registry lookup, so
 * there's no perceptible startup cost.
 */
export function startUpdateNotifier(): void {
  if (!isInteractive()) return;
  if (process.env.PHOTON_NO_UPDATE_NOTIFIER === "1") return;

  const notifier = updateNotifier({
    pkg: { name: pkg.name, version: pkg.version },
    updateCheckInterval: 1000 * 60 * 60 * 24, // 24h
  });

  // .notify() prints (on the NEXT invocation, after a fresh fetch
  // landed in the cache). The first call schedules the background
  // lookup and returns immediately.
  notifier.notify({ defer: true, isGlobal: true });
}
