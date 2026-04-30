import type { Command } from "@commander-js/extra-typings";
import { resolveEnv } from "~/lib/config.ts";
import { listAuthenticatedEnvs, loadCredentials } from "~/lib/credentials.ts";
import { c, printJson, printTable } from "~/lib/output.ts";

interface AuthRow {
  name: string;
  url: string | null;
  loggedIn: boolean;
  user: { id: string; email: string; name: string } | null;
  issuedAt: string | null;
  corrupt: boolean;
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("inspect authentication state across backends");

  auth
    .command("status")
    .description("show login status for every backend you've authenticated against")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const active = await resolveEnv();
      const authedNames = await listAuthenticatedEnvs();

      // The active backend may have no credentials yet — surface it as a
      // logged-out row so users see it in the table.
      const allNames = Array.from(new Set([active.name, ...authedNames])).sort();

      const rows: AuthRow[] = await Promise.all(
        allNames.map(async (name) => {
          // listAuthenticatedEnvs() only checked file existence; the
          // file could still be corrupt JSON, which loadCredentials()
          // returns as null. Treat that as "logged out, but warn"
          // rather than rendering a phantom "yes" with no email.
          const creds = await loadCredentials(name);
          if (!creds) {
            return {
              name,
              url: name === active.name ? active.url : null,
              loggedIn: false,
              user: null,
              issuedAt: null,
              corrupt: authedNames.includes(name),
            };
          }
          return {
            name,
            url: creds.apiUrl,
            loggedIn: true,
            user: creds.user,
            issuedAt: creds.issuedAt,
            corrupt: false,
          };
        })
      );

      if (opts.json) return printJson(rows);

      const tableRows = rows.map((r: AuthRow) => [
        r.name === active.name ? c.green("●") : " ",
        r.name,
        r.url ?? c.dim("—"),
        r.loggedIn
          ? c.green(r.user?.email ?? "yes")
          : r.corrupt
            ? c.yellow("corrupt")
            : c.dim("no"),
        r.issuedAt ? new Date(r.issuedAt).toLocaleDateString() : c.dim("—"),
      ]);
      printTable(["", "key", "url", "logged in", "since"], tableRows);
      const corruptEnvs = rows
        .filter((r: AuthRow) => r.corrupt)
        .map((r: AuthRow) => r.name);
      if (corruptEnvs.length > 0) {
        console.log();
        console.log(
          c.warn(
            `Credentials file for ${corruptEnvs.join(", ")} is unreadable. Re-login with \`photon login --api-host <url>\`.`
          )
        );
      }
    });
}
