import type { Command } from "@commander-js/extra-typings";
import { getApi, type ApiContext } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";

export function registerSpectrumProfile(spectrum: Command): void {
  const profile = spectrum
    .command("profile")
    .description("view or update the Spectrum profile");

  profile
    .command("show", { isDefault: true })
    .description("show the Spectrum profile")
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
        .spectrum.profile.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to fetch Spectrum profile: ${formatApiError(error)}`);

      if (opts.json) return printJson(data ?? {});
      if (!data || typeof data !== "object") {
        console.log(c.dim("No Spectrum profile."));
        return;
      }
      const entries = Object.entries(
        data as unknown as Record<string, unknown>
      ).filter(([k]) => !["id", "projectId"].includes(k));
      if (entries.length === 0) {
        console.log(c.dim("Empty Spectrum profile."));
        return;
      }
      const width = Math.max(...entries.map(([k]) => k.length));
      for (const [k, v] of entries) {
        console.log(`  ${c.dim(k.padEnd(width))}  ${formatValue(v)}`);
      }
    });

  profile
    .command("update")
    .alias("edit")
    .description("update the Spectrum profile (preserves unset fields)")
    .option("--first-name <name>")
    .option("--last-name <name>")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const hasMutation =
        opts.firstName !== undefined || opts.lastName !== undefined;
      if (!hasMutation) {
        die("Nothing to update.", {
          hint: "Pass at least one of --first-name / --last-name.",
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const body: Record<string, string> = {};
      if (opts.firstName !== undefined) body.firstName = opts.firstName;
      if (opts.lastName !== undefined) body.lastName = opts.lastName;

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        .spectrum.profile.patch(body);
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to update Spectrum profile: ${formatApiError(error)}`);
      const result = data as { success?: true; profile?: unknown; error?: string };
      if (result.error) die(result.error);

      if (opts.json) return printJson(result.profile ?? {});
      console.log(c.success("Spectrum profile updated."));
    });

  profile
    .command("sync")
    .description("sync the project profile to every dedicated iMessage line")
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

      const triggerResult = await triggerProfileSync(
        api,
        projectId,
        resolved.name
      );
      printProfileSyncTriggerResult(triggerResult, opts.json ?? false);
    });

}

async function triggerProfileSync(
  api: ApiContext["api"],
  projectId: string,
  envName: string
) {
  const { data, error, status } = await api.api
    .projects({ id: projectId })
    .spectrum.profile.sync.post();

  if (status === 401) throw new SessionExpiredError(envName);
  if (error) {
    die(`Failed to trigger Spectrum profile sync: ${formatApiError(error)}`);
  }
  if (!data?.succeed) {
    die("Failed to trigger Spectrum profile sync: empty API response.");
  }
  return data.data;
}

type ProfileSyncTriggerResult = Awaited<ReturnType<typeof triggerProfileSync>>;

function printProfileSyncTriggerResult(
  result: ProfileSyncTriggerResult,
  json: boolean
): void {
  if (json) {
    printJson(result);
    return;
  }

  console.log(
    c.success(
      `Spectrum profile updated on ${result.syncedLineCount} dedicated iMessage Lines.`
    )
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
