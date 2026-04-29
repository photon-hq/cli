import { existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * try the standard bin-dir layouts adjacent to it (local node_modules/.bin,
 * bun-global `<root>/bin`, npm-global `<prefix>/bin`). First match wins.
 *
 * Cost is two `existsSync` calls per launch after `pho` exists. Errors are
 * swallowed: this is convenience, never load-bearing.
 */
export function ensurePhoAlias(): void {
  try {
    const me = process.argv[1];
    if (!me) return;

    // process.argv[1] resolves symlinks → me is `<pkg>/dist/photon.js`.
    // pkgRoot is two levels up.
    const pkgRoot = resolve(me, "..", "..");

    const candidates = [
      resolve(pkgRoot, "..", "..", ".bin"),              // local: node_modules/.bin
      resolve(pkgRoot, "..", "..", "..", "bin"),         // bun global: <bun-root>/bin
      resolve(pkgRoot, "..", "..", "..", "..", "bin"),   // npm global: <prefix>/bin
    ];

    for (const dir of candidates) {
      const photon = join(dir, "photon");
      const pho = join(dir, "pho");
      if (!existsSync(photon)) continue;
      if (existsSync(pho)) return;
      symlinkSync("./photon", pho);
      return;
    }
  } catch {
    // best-effort
  }
}
