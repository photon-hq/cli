import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";

export function registerSpectrumLines(spectrum: Command): void {
  const lines = spectrum
    .command("lines")
    .description("manage Spectrum phone lines on a project");

  lines
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list lines for the linked project")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        envOverride: opts.env,
      });
      const { api } = await getApi({
        envName: resolved.name,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .lines.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to list lines: ${formatApiError(error)}`);

      const list = (data ?? []) as SpectrumLine[];
      if (opts.json) return printJson(list);
      if (list.length === 0) {
        console.log(c.dim("No lines yet."));
        console.log(c.hint("Add one with `photon spectrum lines add`."));
        return;
      }
      const rows = list.map((l) => [
        truncate(l.id, 10),
        l.platform ?? "—",
        l.phoneNumber ?? c.dim("—"),
        l.status ?? c.dim("—"),
      ]);
      printTable(["id", "platform", "number", "status"], rows);
    });

  lines
    .command("add")
    .alias("create")
    .description("add a new line (currently iMessage only)")
    .option("--platform <name>", "platform (only 'imessage' supported today)", "imessage")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      if (opts.platform !== "imessage") {
        die(`Unsupported platform "${opts.platform}".`, {
          hint: "The server currently only accepts 'imessage'.",
        });
      }
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        envOverride: opts.env,
      });
      const { api } = await getApi({
        envName: resolved.name,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .lines.post({ platform: "imessage" });
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to add line: ${formatApiError(error)}`);
      const result = data as { success?: true; line?: SpectrumLine; error?: string };
      if (result.error) die(result.error);

      if (opts.json) return printJson(result.line ?? {});
      console.log(
        c.success(
          `Added ${result.line?.platform ?? "imessage"} line${
            result.line?.id ? c.dim(` (${result.line.id})`) : ""
          }`
        )
      );
    });

  lines
    .command("remove <line-id>")
    .alias("rm")
    .alias("delete")
    .description("remove a line")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .action(async (lineId, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        envOverride: opts.env,
      });
      const { api } = await getApi({
        envName: resolved.name,
        token: opts.token,
        requireAuth: true,
      });

      await confirmDestructive({
        message: `Remove line ${lineId} from project ${projectId}?`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to remove line ${lineId}.`,
      });

      const { error, status } = await api.api
        .projects({ id: projectId })
        .lines({ lineId })
        .delete();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to remove line: ${formatApiError(error)}`);

      console.log(c.success(`Removed line ${lineId}`));
    });
}

interface SpectrumLine {
  id: string;
  platform?: string;
  phoneNumber?: string | null;
  status?: string | null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
