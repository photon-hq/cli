import type { Command } from "@commander-js/extra-typings";
import { resolveEnv } from "~/lib/config.ts";
import { listAuthenticatedEnvs } from "~/lib/credentials.ts";
import { configDir } from "~/lib/env.ts";
import { listLinks, loadLink } from "~/lib/link.ts";
import { c, printJson } from "~/lib/output.ts";

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("inspect Photon CLI configuration");

  config
    .command("show", { isDefault: true })
    .description("dump the active configuration (no secrets printed)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const active = await resolveEnv();
      const linkForCurrent = await loadLink(active.name);
      const allLinks = await listLinks();
      const authedEnvs = await listAuthenticatedEnvs();

      const view = {
        configDir: configDir(),
        currentEnv: { name: active.name, url: active.url },
        linkedProject: linkForCurrent
          ? {
              id: linkForCurrent.projectId,
              name: linkForCurrent.projectName,
              linkedAt: linkForCurrent.linkedAt,
            }
          : null,
        authedEnvs,
        otherLinks: allLinks
          .filter((l) => l.envName !== active.name)
          .map((l) => ({
            envName: l.envName,
            projectId: l.projectId,
            projectName: l.projectName,
          })),
      };

      if (opts.json) return printJson(view);

      console.log(c.bold("Photon CLI configuration"));
      console.log();
      const labelWidth = 18;
      print("config dir", view.configDir);
      print(
        "active backend",
        `${c.bold(view.currentEnv.name)} ${c.dim(`(${view.currentEnv.url})`)}`
      );
      print(
        "linked project",
        view.linkedProject
          ? `${c.bold(view.linkedProject.name)} ${c.dim(`(${view.linkedProject.id})`)}`
          : c.dim("(none)")
      );
      print(
        "logged-in keys",
        authedEnvs.length > 0 ? authedEnvs.join(", ") : c.dim("none")
      );

      if (view.otherLinks.length > 0) {
        console.log();
        console.log(c.bold("links on other backends"));
        for (const l of view.otherLinks) {
          console.log(
            `  ${c.dim(l.envName.padEnd(labelWidth - 2))}  ${l.projectName} ${c.dim(`(${l.projectId})`)}`
          );
        }
      }

      function print(label: string, value: string): void {
        console.log(`  ${c.dim(label.padEnd(labelWidth))}  ${value}`);
      }
    });
}
