import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import { requireBooleanRecord } from "~/lib/shape.ts";
import type {
  PlatformToggleResult,
  PlatformToggleWarning,
} from "~/lib/types.ts";

const IMESSAGE_CONNECTION_MISSING_WARNING: PlatformToggleWarning = {
  code: "imessage_connection_missing",
  message:
    "iMessage was enabled without a connected phone. Add another phone or connect a dedicated line.",
};

function readPlatformToggleWarning(
  value: unknown
): PlatformToggleWarning | undefined {
  if (!(value && typeof value === "object")) return undefined;
  const warning = value as { code?: unknown };
  return warning.code === "imessage_connection_missing"
    ? IMESSAGE_CONNECTION_MISSING_WARNING
    : undefined;
}

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

      const map = requireBooleanRecord(data, "platform map");
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
  const result = data as PlatformToggleResult;
  if (result.error) {
    die(result.error, {
      hint:
        result.error === "Unsupported platform"
          ? "Run `photon spectrum platforms ls` to see available platforms."
          : undefined,
    });
  }

  const warning =
    name === "imessage" && enabled
      ? readPlatformToggleWarning(result.warning)
      : undefined;
  if (opts.json) {
    return printJson(
      warning
        ? { platforms: result.platforms ?? {}, warning }
        : (result.platforms ?? {}),
    );
  }
  console.log(c.success(`${enabled ? "Enabled" : "Disabled"} ${c.bold(name)}`));
  if (warning) {
    console.error(c.warn(warning.message));
  }
}
