import type { Command } from "@commander-js/extra-typings";
import { listEnvs, loadConfig, resolveEnv } from "~/lib/config.ts";
import { listAuthenticatedEnvs } from "~/lib/credentials.ts";
import { configDir } from "~/lib/env.ts";
import { UnknownEnvError } from "~/lib/errors.ts";
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
      const cfg = await loadConfig();
      // `config show` is an inspection command — don't fail just
      // because the persisted currentEnv refers to an env that no
      // longer exists (e.g. a custom env that was removed, or a
      // manual config edit). Catch UnknownEnvError and degrade.
      let env: { name: string; url: string } | null = null;
      let envUnresolved = false;
      try {
        const resolved = await resolveEnv();
        env = { name: resolved.name, url: resolved.url };
      } catch (err) {
        if (err instanceof UnknownEnvError) {
          envUnresolved = true;
          env = { name: cfg.currentEnv, url: "(unknown)" };
        } else {
          throw err;
        }
      }
      const linkForCurrent = envUnresolved ? null : await loadLink(env!.name);
      const allLinks = await listLinks();
      const authedEnvs = await listAuthenticatedEnvs();
      const envs = listEnvs(cfg);

      const view = {
        configDir: configDir(),
        currentEnv: {
          name: env!.name,
          url: env!.url,
          unresolved: envUnresolved,
        },
        linkedProject: linkForCurrent
          ? {
              id: linkForCurrent.projectId,
              name: linkForCurrent.projectName,
              linkedAt: linkForCurrent.linkedAt,
            }
          : null,
        authedEnvs,
        environments: envs.map((e) => ({
          name: e.name,
          url: e.url,
          kind: e.builtin ? "built-in" : "custom",
        })),
        otherLinks: allLinks
          .filter((l) => l.envName !== env!.name)
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
        "current env",
        view.currentEnv.unresolved
          ? `${c.bold(view.currentEnv.name)} ${c.yellow("(unknown — run `photon env use <name>`)")}`
          : `${c.bold(view.currentEnv.name)} ${c.dim(`(${view.currentEnv.url})`)}`
      );
      print(
        "linked project",
        view.linkedProject
          ? `${c.bold(view.linkedProject.name)} ${c.dim(`(${view.linkedProject.id})`)}`
          : c.dim("(none)")
      );
      print(
        "logged-in envs",
        authedEnvs.length > 0 ? authedEnvs.join(", ") : c.dim("none")
      );
      print(
        "available envs",
        envs.map((e) => e.name).join(", ")
      );

      if (view.otherLinks.length > 0) {
        console.log();
        console.log(c.bold("links on other envs"));
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
