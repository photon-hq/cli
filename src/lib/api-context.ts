import { resolveEnv } from "~/lib/config.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { die } from "~/lib/output.ts";

export interface ResolvedProject {
  projectId: string;
  env: ResolvedEnv;
}

/**
 * Determine which project a command should operate on.
 *
 * Resolution order (highest precedence first):
 *   1. `--project <id>` flag
 *   2. `$PHOTON_PROJECT_ID` env var
 *   3. nothing → die with a hint
 *
 * The backend follows the standard host resolution (`--api-host <url>` flag →
 * `$PHOTON_API_HOST` env var → built-in production URL).
 */
export async function resolveProject(opts: {
  flagProjectId?: string;
  apiHost?: string;
}): Promise<ResolvedProject> {
  const env = await resolveEnv(opts.apiHost);

  const flag = opts.flagProjectId?.trim();
  if (flag) {
    return { projectId: flag, env };
  }

  // `?.trim()` so empty / whitespace-only env vars are treated as
  // unset, matching how `config show` reports them.
  const fromEnv = process.env.PHOTON_PROJECT_ID?.trim();
  if (fromEnv) {
    return { projectId: fromEnv, env };
  }

  die(`No project specified for backend "${env.name}".`, {
    hint: "Pass `--project <id>`, or set `PHOTON_PROJECT_ID` in your shell.",
  });
}
