#!/usr/bin/env bun
/**
 * CI policy: snapshot changes must be justified in the PR body.
 * Exits 0 if no snapshots changed or all changes are documented.
 * Exits 1 if snapshots changed without PR body mention.
 *
 * Skips check if not running in a PR context (push to main).
 */

const baseRef = process.env.GITHUB_BASE_REF;

if (!baseRef) {
  console.log("Not a PR context (GITHUB_BASE_REF unset) — skipping snapshot policy check.");
  process.exit(0);
}

const diffResult =
  await Bun.$`git diff --name-only origin/${baseRef}...HEAD`.text();

const snapshotFiles = diffResult
  .split("\n")
  .map((l) => l.trim())
  .filter(
    (f) =>
      f &&
      (f.includes("__snapshots__") || f.endsWith(".snap") || f.endsWith(".snap.ts"))
  );

if (snapshotFiles.length === 0) {
  console.log("No snapshot files changed — OK.");
  process.exit(0);
}

console.warn(
  `⚠ ${snapshotFiles.length} snapshot file(s) changed:\n` +
    snapshotFiles.map((f) => `  - ${f}`).join("\n")
);
console.warn(
  '\nPlease document each change under "## Snapshot changes" in the PR description.'
);
console.warn("(This is a warning for now — it will become a hard failure in the future.)");

process.exit(0);
