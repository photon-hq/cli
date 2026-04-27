import type { Command } from "@commander-js/extra-typings";
import {
  addCustomEnv,
  listEnvs,
  loadConfig,
  removeCustomEnv,
  resolveEnv,
  setCurrentEnv,
} from "~/lib/config.ts";
import { listAuthenticatedEnvs } from "~/lib/credentials.ts";
import { UnknownEnvError } from "~/lib/errors.ts";
import { c, die, printTable } from "~/lib/output.ts";

export function registerEnvCommand(program: Command): void {
  const env = program
    .command("env")
    .description("manage CLI environments (production, staging, dev, custom)");

  env
    .command("list", { isDefault: true })
    .description("show available environments")
    .action(async () => {
      const config = await loadConfig();
      const envs = listEnvs(config);
      const authedNames = new Set(await listAuthenticatedEnvs());

      const rows = envs.map((e) => [
        e.name === config.currentEnv ? c.green("●") : " ",
        e.name,
        e.url,
        e.builtin ? c.dim("built-in") : c.dim("custom"),
        authedNames.has(e.name) ? c.green("yes") : c.dim("no"),
      ]);
      printTable(["", "name", "url", "kind", "logged in"], rows);
    });

  env
    .command("use <name>")
    .description("set the current environment")
    .action(async (name) => {
      try {
        await setCurrentEnv(name);
        const env = await resolveEnv(name);
        console.log(
          c.success(`Current environment is now ${c.bold(env.name)} (${env.url})`)
        );
      } catch (err) {
        if (err instanceof UnknownEnvError) die(err.message);
        throw err;
      }
    });

  env
    .command("add <name> <url>")
    .description("add a custom environment")
    .action(async (name, url) => {
      try {
        await addCustomEnv(name, url);
        console.log(c.success(`Added environment ${c.bold(name)} → ${url}`));
      } catch (err) {
        die(err instanceof Error ? err.message : String(err));
      }
    });

  env
    .command("remove <name>")
    .alias("rm")
    .description("remove a custom environment")
    .action(async (name) => {
      try {
        await removeCustomEnv(name);
        console.log(c.success(`Removed environment ${c.bold(name)}`));
      } catch (err) {
        die(err instanceof Error ? err.message : String(err));
      }
    });

  env
    .command("current")
    .description("show the currently selected environment")
    .action(async () => {
      const env = await resolveEnv();
      console.log(`${c.bold(env.name)} ${c.dim(`(${env.url})`)}`);
    });
}
