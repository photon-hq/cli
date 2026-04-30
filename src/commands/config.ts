import type { Command } from "@commander-js/extra-typings";
import { resolveEnv } from "~/lib/config.ts";
import { listAuthenticatedEnvs } from "~/lib/credentials.ts";
import { configDir } from "~/lib/env.ts";
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
      const authedEnvs = await listAuthenticatedEnvs();
      // `|| null` (not `?? null`) so empty / whitespace-only env vars
      // surface as null in JSON, matching how resolveProject() treats
      // them as unset (truthiness check).
      const activeProject = process.env.PHOTON_PROJECT_ID?.trim() || null;

      const view = {
        configDir: configDir(),
        currentEnv: { name: active.name, url: active.url },
        activeProject,
        authedEnvs,
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
        "active project",
        activeProject
          ? `${c.bold(activeProject)} ${c.dim("(via $PHOTON_PROJECT_ID)")}`
          : c.dim("(none — pass --project <id> or set $PHOTON_PROJECT_ID)")
      );
      print(
        "logged-in keys",
        authedEnvs.length > 0 ? authedEnvs.join(", ") : c.dim("none")
      );

      function print(label: string, value: string): void {
        console.log(`  ${c.dim(label.padEnd(labelWidth))}  ${value}`);
      }
    });
}
