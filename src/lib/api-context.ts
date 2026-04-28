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
 * The env follows the standard env resolution (`--env` flag → $PHOTON_ENV →
 * config.currentEnv → DEFAULT). The project is anchored to whichever env
 * resolves; mismatches between linked project and active env can't happen
 * because each env has its own link file.
 */
export async function resolveProject(opts: {
  flagProjectId?: string;
  envOverride?: string;
}): Promise<ResolvedProject> {
  const env = await resolveEnv(opts.envOverride);

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

  const flag = env.name === "production" ? "" : ` --env ${env.name}`;
  die(`No project linked for env "${env.name}".`, {
    hint: `Run \`photon link <id>${flag}\`, or pass \`--project <id>\`.`,
  });
}
