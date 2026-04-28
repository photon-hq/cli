import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveEnv } from "~/lib/config.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { clearLink, listLinks, loadLink, saveLink } from "~/lib/link.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import type { Project } from "~/lib/types.ts";

export function registerLinkCommands(program: Command): void {
  program
    .command("link <id>")
    .description("set this id as the active project for the current environment")
    .option("-e, --env <name>", "environment to link the project under (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .action(async (id, opts) => {
      const { api, env } = await getApi({
        envName: opts.env,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api.projects({ id }).get();
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) {
        die(`Could not validate project: ${formatApiError(error)}`);
      }
      if (!data) {
        die(`Project not found: ${id}`, {
          hint: "List your projects with `photon projects ls`.",
        });
      }

      const project = data as Project;
      await saveLink({
        projectId: project.id,
        projectName: project.name,
        envName: env.name,
        linkedAt: new Date().toISOString(),
      });
      console.log(
        c.success(
          `Linked ${c.bold(project.name)} ${c.dim(`(${project.id})`)} on ${c.bold(env.name)}`
        )
      );
    });

  program
    .command("unlink")
    .description("clear the active project link for an environment")
    .option("-e, --env <name>", "environment to unlink (defaults to current)")
    .option("-y, --yes", "skip confirmation")
    .action(async (opts) => {
      const env = await resolveEnv(opts.env);
      const existing = await loadLink(env.name);
      if (!existing) {
        console.log(c.dim(`No link to clear for env ${c.bold(env.name)}.`));
        return;
      }

      await confirmDestructive({
        message: `Unlink ${existing.projectName} from ${env.name}?`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to unlink ${existing.projectName} from ${env.name}.`,
      });

      await clearLink(env.name);
      console.log(c.success(`Unlinked from ${c.bold(env.name)}`));
    });

  // `photon link:status` — explicit subcommand instead of `link --status`
  // so the help output shows it as a first-class operation.
  program
    .command("link:status")
    .description("show currently linked project(s) across environments")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const links = await listLinks();
      if (opts.json) {
        printJson(links);
        return;
      }
      if (links.length === 0) {
        console.log(c.dim("No projects linked."));
        console.log(c.hint("Run `photon link <id>` to link the active env."));
        return;
      }
      const rows = links.map((l) => [
        l.envName,
        l.projectName,
        truncate(l.projectId, 12),
        new Date(l.linkedAt).toLocaleDateString(),
      ]);
      printTable(["env", "project", "id", "linked"], rows);
    });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
