#!/usr/bin/env bun
/**
 * CI policy: forbidden dependencies must never be added.
 * Reads .agent-flow/forbidden-deps.json and checks package.json.
 * Exits 1 if any forbidden dep is found in dependencies or devDependencies.
 */

const forbiddenConfig = await Bun.file(".agent-flow/forbidden-deps.json").json() as {
  forbidden: string[];
};

const pkg = await Bun.file("package.json").json() as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const allDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const violations = forbiddenConfig.forbidden.filter((dep) => allDeps.has(dep));

if (violations.length > 0) {
  console.error(
    `✗ Found ${violations.length} forbidden dependency(ies):\n` +
      violations.map((d) => `  - ${d}`).join("\n")
  );
  console.error("\nSee .agent-flow/forbidden-deps.json for the full deny-list.");
  process.exit(1);
}

console.log(`deps-policy: all clean (checked ${forbiddenConfig.forbidden.length} forbidden names against ${allDeps.size} installed).`);
