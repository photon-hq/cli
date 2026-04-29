import type { Command } from "@commander-js/extra-typings";
import { listEnvs, loadConfig } from "~/lib/config.ts";
import { listAuthenticatedEnvs, loadCredentials } from "~/lib/credentials.ts";
import { c, printJson, printTable } from "~/lib/output.ts";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("inspect authentication state across environments");

  auth
    .command("status")
    .description("show login status for every environment")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const config = await loadConfig();
      const envs = listEnvs(config);
      const authedNames = new Set(await listAuthenticatedEnvs());

      const rows = await Promise.all(
        envs.map(async (env) => {
          if (!authedNames.has(env.name)) {
            return {
              name: env.name,
              url: env.url,
              loggedIn: false,
              user: null,
              issuedAt: null,
              kind: env.builtin ? "built-in" : "custom",
            };
          }
          const creds = await loadCredentials(env.name);
          return {
            name: env.name,
            url: env.url,
            loggedIn: true,
            user: creds?.user ?? null,
            issuedAt: creds?.issuedAt ?? null,
            kind: env.builtin ? "built-in" : "custom",
          };
        })
      );

      if (opts.json) return printJson(rows);

      const tableRows = rows.map((r) => [
        r.name === config.currentEnv ? c.green("●") : " ",
        r.name,
        r.kind === "built-in" ? c.dim("built-in") : c.dim("custom"),
        r.loggedIn ? c.green(r.user?.email ?? "yes") : c.dim("no"),
        r.issuedAt ? new Date(r.issuedAt).toLocaleDateString() : c.dim("—"),
      ]);
      printTable(["", "env", "kind", "logged in", "since"], tableRows);
    });
}
