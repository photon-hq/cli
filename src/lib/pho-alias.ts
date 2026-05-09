import { lstatSync, realpathSync, symlinkSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

/**
 * Lazily install `pho` as a sibling of `photon` in whichever bin directory
 * we were launched from.
 *
 * Why not declare both bins in package.json? npm 11's `npx <scoped-pkg>`
 * (no version) skips bin auto-resolve when `bin` has multiple keys. Keeping
 * `bin` as a single string preserves clean `npx @photon-ai/photon` usage.
 *
 * Why not a `postinstall` script? Bun blocks postinstall by default — that
 * would silently strip `pho` from `bun add -g` (our primary install path).
 *
 * Approach: scan $PATH (plus well-known global bin fallbacks) for a
 * `photon` entry whose realpath matches ours, then drop a `pho → ./photon`
 * symlink next to it. Package-manager agnostic — works for bun, npm, pnpm,
 * yarn, and `bun link` without hardcoding directory layouts.
 *
 * Cost after `pho` exists: ~3 fast syscalls per launch (one realpathSync
 * for argv[1], one for the matching photon entry, one lstatSync for pho).
 * Errors are swallowed — `pho` is convenience, never load-bearing.
 */
export function ensurePhoAlias(): void {
  try {
    const me = process.argv[1];
    if (!me) return;

    // Only act on built artifacts. Source-mode (`bun run src/index.ts`)
    // and compiled binaries (`dist/photon`) skip entirely.
    if (!me.endsWith(`${sep}dist${sep}photon.js`)) return;

    const myReal = realpathSync(resolve(me));
    const home = process.env.HOME || process.env.USERPROFILE || "";

    // PATH entries first, then well-known global bin directories that may
    // be absent in restricted shells (IDE terminals, CI, etc.).
    const dirs = (process.env.PATH || "").split(delimiter);
    if (home) {
      dirs.push(
        join(home, ".bun", "bin"),
        join(home, ".local", "share", "pnpm"),
        join(home, ".yarn", "bin"),
      );
    }
    dirs.push("/usr/local/bin");

    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);

      const photon = join(dir, "photon");

      // Verify this `photon` ultimately resolves to the same file as us.
      // realpathSync throws for non-existent paths → cheap existence check.
      try {
        if (realpathSync(photon) !== myReal) continue;
      } catch {
        continue;
      }

      // Found our bin directory — create `pho` if absent.
      const pho = join(dir, "pho");
      try {
        lstatSync(pho);
        return; // something already lives here; leave it alone
      } catch {
        // pho doesn't exist; safe to create
      }

      symlinkSync("./photon", pho);
      return;
    }
  } catch {
    // best-effort
  }
}
