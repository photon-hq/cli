#!/usr/bin/env bun
/**
 * Scan src/commands for Eden treaty API calls and generate
 * .agent-flow/route-manifest.json.
 *
 * Usage:
 *   bun run scripts/generate-route-manifest.ts
 */
import { resolve, relative } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COMMANDS_DIR = resolve(REPO_ROOT, "src/commands");
const OUT_DIR = resolve(REPO_ROOT, ".agent-flow");
const OUT_FILE = resolve(OUT_DIR, "route-manifest.json");

interface ManifestEntry {
  path: string;
  method: string;
  used_by: string;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Collapse multiline method chains so `api.api\n  .projects(...)` becomes
 * a single line.  Also normalize bracket access split across lines.
 */
function collapseChains(source: string): string {
  return source
    // Join lines where the next line starts with `.` (method chain continuation)
    .replace(/\n\s*\./g, ".")
    // Collapse split bracket access: `projects[\n  "check-availability"\n]`
    .replace(/\[\s*\n\s*/g, "[")
    .replace(/\s*\n\s*\]/g, "]");
}

function extractApiCalls(source: string, filePath: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();

  function add(path: string, method: string) {
    const key = `${path}#${method}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path, method, used_by: filePath });
  }

  const collapsed = collapseChains(source);

  // Find every `api.api.` occurrence and extract the full chain
  const startRe = new RegExp("api\\.api\\.", "g");
  let startMatch: RegExpExecArray | null;

  while ((startMatch = startRe.exec(collapsed)) !== null) {
    const from = startMatch.index + startMatch[0].length;
    const chain = readChain(collapsed, from);
    if (chain) add(chain.path, chain.method);
  }

  return entries;
}

interface ChainResult {
  path: string;
  method: string;
}

/**
 * Starting at `pos` (right after `api.api.`), read segments of a
 * method chain and return the route path + HTTP method.
 */
function readChain(src: string, pos: number): ChainResult | null {
  const segments: string[] = ["api"];
  let i = pos;

  while (i < src.length) {
    // Try reading an identifier (word chars + hyphens)
    const idMatch = src.slice(i).match(/^([\w-]+)/);
    if (!idMatch) break;

    const name = idMatch[1]!;
    i += name.length;

    // If this is an HTTP method followed by `(`, we're done
    if (METHODS.has(name)) {
      const afterMethod = src.slice(i).match(/^\s*\(/);
      if (afterMethod) {
        return { path: segments.join("."), method: name };
      }
    }

    segments.push(name);

    // Skip optional call args: `({ id: projectId })`
    if (src[i] === "(") {
      const close = findClosingParen(src, i);
      if (close < 0) break;
      i = close + 1;
      segments.push(":param");
    }

    // Expect a `.` or `[` to continue the chain
    const contMatch = src.slice(i).match(/^\s*(\.|(?=\[))/);
    if (!contMatch) break;
    i += contMatch[0].length;

    // Bracket access: ["check-availability"]
    if (src[i] === "[") {
      const bracketMatch = src.slice(i).match(/^\[["']([\w-]+)["']\]/);
      if (!bracketMatch) break;
      segments.push(bracketMatch[1]!);
      i += bracketMatch[0].length;

      // After bracket, need `.` to continue
      const dotAfter = src.slice(i).match(/^\s*\./);
      if (!dotAfter) break;
      i += dotAfter[0].length;
    }
  }

  return null;
}

function findClosingParen(src: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const glob = new Glob("**/*.ts");
const allEntries: ManifestEntry[] = [];

for await (const file of glob.scan({ cwd: COMMANDS_DIR, absolute: true })) {
  const source = await Bun.file(file).text();
  const rel = relative(REPO_ROOT, file);
  const entries = extractApiCalls(source, rel);
  allEntries.push(...entries);
}

allEntries.sort((a, b) =>
  a.path === b.path
    ? a.method.localeCompare(b.method)
    : a.path.localeCompare(b.path),
);

const manifest = {
  generated_at: new Date().toISOString(),
  routes: allEntries,
};

await Bun.write(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

const count = allEntries.length;
const dest = relative(REPO_ROOT, OUT_FILE);
console.log(`Done: ${count} route(s) written to ${dest}`);
