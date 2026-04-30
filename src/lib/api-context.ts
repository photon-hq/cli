import { resolveEnv } from "~/lib/config.ts";
import type { ResolvedEnv } from "~/lib/env.ts";
import { loadLink } from "~/lib/link.ts";
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
 *   3. `~/.config/photon/links/<active-env>.json` written by `photon link`
 *   4. nothing → die with a hint
 *
 * The backend follows the standard host resolution (`--api-host <url>` flag →
 * `$PHOTON_API_HOST` env var → built-in production URL). The project is
 * anchored to whichever host resolves; mismatches between linked project and
 * active host can't happen because each host has its own link file.
 */
export async function resolveProject(opts: {
  flagProjectId?: string;
  apiHost?: string;
}): Promise<ResolvedProject> {
  const env = await resolveEnv(opts.apiHost);

  if (opts.flagProjectId) {
    return { projectId: opts.flagProjectId, env };
  }

  const fromEnv = process.env.PHOTON_PROJECT_ID;
  if (fromEnv) {
    return { projectId: fromEnv, env };
  }

  const link = await loadLink(env.name);
  if (link) {
    return { projectId: link.projectId, env };
  }

  const flag = opts.apiHost ? ` --api-host ${opts.apiHost}` : "";
  die(`No project linked for backend "${env.name}".`, {
    hint: `Run \`photon link <id>${flag}\`, or pass \`--project <id>\`.`,
  });
}
