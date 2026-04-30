import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";

export function registerSpectrumPlatforms(spectrum: Command): void {
  const platforms = spectrum
    .command("platforms")
    .description("manage Spectrum platform integrations on a project");

  platforms
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list platforms and their enabled state")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .platforms.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to list platforms: ${formatApiError(error)}`);

      const map = (data ?? {}) as Record<string, boolean>;
      if (opts.json) return printJson(map);
      const entries = Object.entries(map);
      if (entries.length === 0) {
        console.log(c.dim("No platforms configured for this project."));
        return;
      }
      const rows = entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, enabled]) => [name, enabled ? c.green("on") : c.dim("off")]);
      printTable(["platform", "state"], rows);
    });

  platforms
    .command("enable <name>")
    .description("enable a platform")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (name, opts) => {
      await togglePlatform(name, true, opts);
    });

  platforms
    .command("disable <name>")
    .description("disable a platform")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (name, opts) => {
      await togglePlatform(name, false, opts);
    });
}

async function togglePlatform(
  name: string,
  enabled: boolean,
  opts: { project?: string; apiHost?: string; token?: string; json?: boolean }
): Promise<void> {
  const { projectId, env: resolved } = await resolveProject({
    flagProjectId: opts.project,
    apiHost: opts.apiHost,
  });
  const { api } = await getApi({
    apiHost: resolved.url,
    token: opts.token,
    requireAuth: true,
  });

  const { data, error, status } = await api.api
    .projects({ id: projectId })
    .platforms.toggle.post({ platformId: name, enabled });
  if (status === 401) throw new SessionExpiredError(resolved.name);
  if (error) die(`Failed to ${enabled ? "enable" : "disable"} ${name}: ${formatApiError(error)}`);
  const result = data as {
    success?: true;
    platforms?: Record<string, boolean>;
    error?: string;
  };
  if (result.error) {
    die(result.error, {
      hint:
        result.error === "Unsupported platform"
          ? "Run `photon spectrum platforms ls` to see available platforms."
          : undefined,
    });
  }

  if (opts.json) return printJson(result.platforms ?? {});
  console.log(c.success(`${enabled ? "Enabled" : "Disabled"} ${c.bold(name)}`));
}
