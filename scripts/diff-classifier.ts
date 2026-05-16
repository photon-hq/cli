#!/usr/bin/env bun
/**
 * Classify an upstream API diff as TRIVIAL (exit 0) or NON-TRIVIAL (exit 1).
 *
 * TRIVIAL = additive only, no existing CLI commands affected.
 * NON-TRIVIAL = routes removed/renamed, response shapes changed, or very
 *               large diff.
 *
 * Usage:
 *   bun run scripts/diff-classifier.ts                     # auto-diff HEAD vs working tree
 *   bun run scripts/diff-classifier.ts --old a.d.ts --new b.d.ts
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_NEW = resolve(REPO_ROOT, "types/api.d.ts");
const LARGE_DIFF_THRESHOLD = 500; // lines of type-level change

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    old: { type: "string" },
    new: { type: "string" },
  },
  strict: false,
});

// ---------------------------------------------------------------------------
// Read sources
// ---------------------------------------------------------------------------

async function readOldTypes(path?: string): Promise<string> {
  if (path) {
    const f = Bun.file(path);
    if (!(await f.exists())) {
      console.error(`✗ --old file not found: ${path}`);
      process.exit(2);
    }
    return f.text();
  }
  try {
    return await Bun.$`git show HEAD:types/api.d.ts`.cwd(REPO_ROOT).text();
  } catch {
    return "";
  }
}

async function readNewTypes(path?: string): Promise<string> {
  const target = path ?? DEFAULT_NEW;
  const f = Bun.file(target);
  if (!(await f.exists())) {
    console.error(`✗ new types file not found: ${target}`);
    process.exit(2);
  }
  return f.text();
}

// ---------------------------------------------------------------------------
// Route extraction (same logic as summarize-api-diff.ts, inlined to
// keep each script self-contained)
// ---------------------------------------------------------------------------

interface Route {
  path: string;
  method: string;
  responseFingerprint: string;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function extractRoutes(source: string): Route[] {
  const routes: Route[] = [];
  const chunks = source.split(/\}\s*&\s*\{/);
  for (const chunk of chunks) {
    const route = parseChunk(chunk);
    if (route) routes.push(route);
  }
  return routes;
}

function parseChunk(chunk: string): Route | null {
  const keyLineRe = /^\s*(?:"([^"]+)"|(\w[\w-]*))\s*:\s*\{/gm;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = keyLineRe.exec(chunk)) !== null) {
    keys.push(match[1] ?? match[2]!);
  }
  if (keys.length === 0) return null;

  let methodIdx = -1;
  for (let i = keys.length - 1; i >= 0; i--) {
    if (HTTP_METHODS.has(keys[i]!)) {
      methodIdx = i;
      break;
    }
  }
  if (methodIdx < 0) return null;

  const method = keys[methodIdx]!;
  const pathKeys = keys.slice(0, methodIdx);
  if (pathKeys.length === 0) return null;
  const path = pathKeys.join(".");

  const responseMatch = chunk.match(/response:\s*\{([^}]*)\}/s);
  const paramsMatch = chunk.match(/params:\s*\{([^}]*)\}/s);
  const bodyMatch = chunk.match(/body:\s*(\S+)/);
  const fingerprint = [
    bodyMatch?.[1] ?? "?",
    paramsMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "?",
    responseMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "?",
  ].join("|");

  return { path, method, responseFingerprint: fingerprint };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const oldSource = await readOldTypes(args.old as string | undefined);
const newSource = await readNewTypes(args.new as string | undefined);

// Identical files → trivially no change
if (oldSource === newSource) {
  console.log("TRIVIAL: no changes detected (files are identical)");
  process.exit(0);
}

// First sync (no old file) → everything is new, trivial
if (oldSource === "") {
  console.log("TRIVIAL: first sync — all routes are new additions");
  process.exit(0);
}

const oldRoutes = extractRoutes(oldSource);
const newRoutes = extractRoutes(newSource);

const oldMap = new Map<string, Route>();
for (const r of oldRoutes) oldMap.set(`${r.path}#${r.method}`, r);

const newMap = new Map<string, Route>();
for (const r of newRoutes) newMap.set(`${r.path}#${r.method}`, r);

const removed: Route[] = [];
const changed: { old: Route; new: Route }[] = [];
const added: Route[] = [];

for (const [key, or] of oldMap) {
  if (!newMap.has(key)) removed.push(or);
}

for (const [key, nr] of newMap) {
  const or = oldMap.get(key);
  if (!or) {
    added.push(nr);
  } else if (or.responseFingerprint !== nr.responseFingerprint) {
    changed.push({ old: or, new: nr });
  }
}

// Large diff heuristic: compare raw line counts
const oldLines = oldSource.split("\n").length;
const newLines = newSource.split("\n").length;
const lineDelta = Math.abs(newLines - oldLines);

const reasons: string[] = [];

if (removed.length > 0) {
  reasons.push(
    `${removed.length} route(s) removed: ${removed.map((r) => `${r.method.toUpperCase()} ${r.path}`).join(", ")}`
  );
}
if (changed.length > 0) {
  reasons.push(
    `${changed.length} route(s) changed: ${changed.map((c) => `${c.new.method.toUpperCase()} ${c.new.path}`).join(", ")}`
  );
}
if (lineDelta > LARGE_DIFF_THRESHOLD) {
  reasons.push(`large diff (${lineDelta} line delta)`);
}

if (reasons.length > 0) {
  console.log(`NON-TRIVIAL: ${reasons.join("; ")}`);
  process.exit(1);
}

console.log(
  `TRIVIAL: ${added.length} route(s) added, 0 removed, 0 changed`
);
process.exit(0);
