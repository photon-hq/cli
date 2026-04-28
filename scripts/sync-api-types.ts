#!/usr/bin/env bun
/**
 * Sync the bundled public API type definition from the dashboard repo.
 *
 * Maintainers run this when the dashboard's API surface changes.
 * External contributors do NOT need to run it — `types/api.d.ts` is
 * committed and ready to use after `git clone`.
 *
 * Default source is a sibling `dashboard` checkout. Override with:
 *   PHOTON_TYPES_SRC=/path/to/index.d.ts bun run sync:api
 */
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_SRC = resolve(
  REPO_ROOT,
  "../dashboard/packages/api-public/dist/index.d.ts"
);
const SRC =
  process.env.PHOTON_TYPES_SRC ??
  process.env.DASHBOARD_TYPES_SRC ??
  DEFAULT_SRC;
const DEST = resolve(REPO_ROOT, "types/api.d.ts");

const srcFile = Bun.file(SRC);
if (!(await srcFile.exists())) {
  console.error(`✗ Source not found: ${SRC}`);
  console.error(
    `\nRun in the dashboard repo first:\n` +
      `  bun run --filter @photon-dashboard/api-public build\n\n` +
      `Or set PHOTON_TYPES_SRC to the bundled .d.ts location.`
  );
  process.exit(1);
}

await Bun.write(DEST, srcFile);
const bytes = Bun.file(DEST).size;
console.log(`✓ ${SRC}\n  → ${DEST} (${(bytes / 1024).toFixed(1)} KB)`);
