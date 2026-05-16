#!/usr/bin/env bun
/**
 * Compare old vs new `types/api.d.ts` and produce a structured markdown
 * summary of route changes.  Output goes to stdout — callers redirect
 * to `UPSTREAM_DIFF.md` as needed.
 *
 * Usage:
 *   bun run scripts/summarize-api-diff.ts
 *   bun run scripts/summarize-api-diff.ts --old old.d.ts --new new.d.ts
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_NEW = resolve(REPO_ROOT, "types/api.d.ts");

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
// Read old / new type files
// ---------------------------------------------------------------------------

async function readOldTypes(path?: string): Promise<string> {
  if (path) {
    const f = Bun.file(path);
    if (!(await f.exists())) {
      console.error(`✗ --old file not found: ${path}`);
      process.exit(1);
    }
    return f.text();
  }
  // Default: read from git HEAD
  try {
    const result = await Bun.$`git show HEAD:types/api.d.ts`
      .cwd(REPO_ROOT)
      .text();
    return result;
  } catch {
    return ""; // first sync — no previous version
  }
}

async function readNewTypes(path?: string): Promise<string> {
  const target = path ?? DEFAULT_NEW;
  const f = Bun.file(target);
  if (!(await f.exists())) {
    console.error(`✗ new types file not found: ${target}`);
    process.exit(1);
  }
  return f.text();
}

// ---------------------------------------------------------------------------
// Route extraction
// ---------------------------------------------------------------------------

interface Route {
  path: string;
  method: string;
  /** Rough fingerprint of the response shape (for change detection) */
  responseFingerprint: string;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * Walk the nested `& { api: { ... } }` blocks in the Elysia type
 * definition and extract route information.  This is intentionally
 * best-effort — the .d.ts is machine-generated with a very regular
 * structure, so simple regex + brace-counting works well enough.
 */
function extractRoutes(source: string): Route[] {
  const routes: Route[] = [];

  // Each route lives in its own `& { api: { ... } }` block.  We
  // find them by splitting on the `} & {` boundaries and parsing
  // each chunk independently.
  const chunks = source.split(/\}\s*&\s*\{/);

  for (const chunk of chunks) {
    const route = parseChunk(chunk);
    if (route) routes.push(route);
  }

  return routes.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
  );
}

function parseChunk(chunk: string): Route | null {
  // Extract the nested key path from lines like:
  //   api: {
  //       projects: {
  //           ":id": {
  //               spectrum: {
  //                   get: {
  const keyLineRe = /^\s*(?:"([^"]+)"|(\w[\w-]*))\s*:\s*\{/gm;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = keyLineRe.exec(chunk)) !== null) {
    keys.push(match[1] ?? match[2]!);
  }

  if (keys.length === 0) return null;

  // The last key that's an HTTP method is the method; everything
  // before it (starting from "api") is the route path.
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

  // Build a rough fingerprint from the response/params/body shape
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
// Diff logic
// ---------------------------------------------------------------------------

interface RouteDiff {
  added: Route[];
  removed: Route[];
  changed: { old: Route; new: Route }[];
  unchanged: Route[];
}

function diffRoutes(oldRoutes: Route[], newRoutes: Route[]): RouteDiff {
  const oldMap = new Map<string, Route>();
  for (const r of oldRoutes) oldMap.set(`${r.path}#${r.method}`, r);

  const newMap = new Map<string, Route>();
  for (const r of newRoutes) newMap.set(`${r.path}#${r.method}`, r);

  const added: Route[] = [];
  const removed: Route[] = [];
  const changed: { old: Route; new: Route }[] = [];
  const unchanged: Route[] = [];

  for (const [key, nr] of newMap) {
    const or = oldMap.get(key);
    if (!or) {
      added.push(nr);
    } else if (or.responseFingerprint !== nr.responseFingerprint) {
      changed.push({ old: or, new: nr });
    } else {
      unchanged.push(nr);
    }
  }

  for (const [key, or] of oldMap) {
    if (!newMap.has(key)) removed.push(or);
  }

  return { added, removed, changed, unchanged };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function formatMarkdown(diff: RouteDiff, oldCount: number, newCount: number): string {
  const lines: string[] = [];
  lines.push("# Upstream API Diff\n");
  lines.push(`> Old routes: ${oldCount} · New routes: ${newCount}\n`);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push("**No route changes detected.**\n");
    return lines.join("\n");
  }

  if (diff.added.length > 0) {
    lines.push("## Added Routes\n");
    lines.push("| Route | Method |");
    lines.push("|-------|--------|");
    for (const r of diff.added) {
      lines.push(`| \`${r.path}\` | \`${r.method.toUpperCase()}\` |`);
    }
    lines.push("");
  }

  if (diff.removed.length > 0) {
    lines.push("## Removed Routes\n");
    lines.push("| Route | Method |");
    lines.push("|-------|--------|");
    for (const r of diff.removed) {
      lines.push(`| \`${r.path}\` | \`${r.method.toUpperCase()}\` |`);
    }
    lines.push("");
  }

  if (diff.changed.length > 0) {
    lines.push("## Changed Routes\n");
    lines.push("| Route | Method | Detail |");
    lines.push("|-------|--------|--------|");
    for (const c of diff.changed) {
      lines.push(
        `| \`${c.new.path}\` | \`${c.new.method.toUpperCase()}\` | response shape changed |`
      );
    }
    lines.push("");
  }

  lines.push(`## Summary\n`);
  lines.push(`- **${diff.added.length}** added`);
  lines.push(`- **${diff.removed.length}** removed`);
  lines.push(`- **${diff.changed.length}** changed`);
  lines.push(`- **${diff.unchanged.length}** unchanged`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const oldSource = await readOldTypes(args.old as string | undefined);
const newSource = await readNewTypes(args.new as string | undefined);

const oldRoutes = extractRoutes(oldSource);
const newRoutes = extractRoutes(newSource);

const diff = diffRoutes(oldRoutes, newRoutes);
const md = formatMarkdown(diff, oldRoutes.length, newRoutes.length);

process.stdout.write(md);
