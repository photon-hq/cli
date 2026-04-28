import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import type { Project } from "~/lib/types.ts";

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .alias("project")
    .description("manage your Photon Dashboard projects");

  projects
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your projects")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, env } = await getApi({
        envName: opts.env,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error } = await api.api.projects.get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(env.name);
        die(`Failed to list projects: ${formatApiError(error)}`);
      }

      const list = (data ?? []) as Project[];
      if (opts.json) {
        printJson(list);
        return;
      }
      if (list.length === 0) {
        console.log(c.dim("No projects yet."));
        console.log(
          c.hint("Create one with `photon projects create` (coming soon).")
        );
        return;
      }

      const rows = list.map((p) => [
        truncate(p.id, 8),
        p.name,
        p.location,
        formatStatus(p.status),
        p.spectrum ? c.green("on") : c.dim("off"),
        new Date(p.updatedAt).toLocaleDateString(),
      ]);
      printTable(["id", "name", "location", "status", "spectrum", "updated"], rows);
    });

  projects
    .command("show <id>")
    .alias("get")
    .description("show details for one project")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (id, opts) => {
      const { api, env } = await getApi({
        envName: opts.env,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error } = await api.api.projects({ id }).get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(env.name);
        die(`Failed to fetch project: ${formatApiError(error)}`);
      }
      if (!data) {
        die(`Project not found: ${id}`);
      }

      if (opts.json) {
        printJson(data);
        return;
      }

      const p = data as Project;
      console.log(c.bold(p.name) + c.dim(`  (${p.id})`));
      console.log();
      printKv([
        ["status", formatStatus(p.status)],
        ["location", p.location],
        ["spectrum", p.spectrum ? c.green("enabled") : c.dim("disabled")],
        ["spectrumProjectId", p.spectrumProjectId ?? c.dim("—")],
        ["template", p.template ? "yes" : "no"],
        ["observability", p.observability ? "yes" : "no"],
        ["subscription", p.subscriptionStatus ?? c.dim("—")],
        ["createdAt", new Date(p.createdAt).toLocaleString()],
        ["updatedAt", new Date(p.updatedAt).toLocaleString()],
      ]);
    });
}

function formatStatus(s: string): string {
  switch (s) {
    case "running":
      return c.green(s);
    case "paused":
      return c.yellow(s);
    case "error":
      return c.red(s);
    default:
      return s;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printKv(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    console.log(`  ${c.dim(k.padEnd(width))}  ${v}`);
  }
}
