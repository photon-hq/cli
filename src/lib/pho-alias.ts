import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
 * Approach: walk up from the running script's path to the package root, then
 * try the standard bin-dir layouts adjacent to it. First match wins.
 *
 *   <root>/node_modules/.bin                          (local install)
 *   <prefix>/bin            with <prefix>/lib/node_modules/...  (npm/yarn/pnpm -g)
 *   ~/.bun/bin              with ~/.bun/install/global/node_modules/...  (bun -g)
 *
 * Cost is two stat calls per launch after `pho` exists. Errors are swallowed
 * — `pho` is convenience, never load-bearing.
 */
export function ensurePhoAlias(): void {
  try {
    const me = process.argv[1];
    if (!me) return;

    // Guard: only run when launched from an installed package layout.
    // Source-mode runs (`bun run src/index.ts`) skip this entirely.
    const installedShape = new RegExp(
      `${escapeForRegex(sep)}node_modules${escapeForRegex(sep)}.+${escapeForRegex(sep)}dist${escapeForRegex(sep)}photon\\.js$`,
    );
    if (!installedShape.test(me)) return;

    // process.argv[1] resolves symlinks → me is `<pkg>/dist/photon.js`.
    // pkgRoot is two levels up.
    const pkgRoot = resolve(me, "..", "..");

    const candidates = [
      resolve(pkgRoot, "..", "..", ".bin"),                    // local: node_modules/.bin
      resolve(pkgRoot, "..", "..", "..", "..", "bin"),         // npm/yarn/pnpm global: <prefix>/bin
      resolve(pkgRoot, "..", "..", "..", "..", "..", "bin"),   // bun global: ~/.bun/bin
    ];

    for (const dir of candidates) {
      const photon = join(dir, "photon");
      const pho = join(dir, "pho");
      if (!existsSync(photon)) continue;

      // lstatSync detects ANY entry at `pho` — including broken symlinks
      // that existsSync would miss (existsSync follows the link target).
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

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
