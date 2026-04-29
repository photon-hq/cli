import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";

export function registerSpectrumProfile(spectrum: Command): void {
  const profile = spectrum
    .command("profile")
    .description("view or update the Spectrum profile (display name, avatar)");

  profile
    .command("show", { isDefault: true })
    .description("show the Spectrum profile")
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
        .spectrum.profile.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to fetch Spectrum profile: ${formatApiError(error)}`);

      if (opts.json) return printJson(data ?? {});
      if (!data || typeof data !== "object") {
        console.log(c.dim("No Spectrum profile."));
        return;
      }
      const entries = Object.entries(data as Record<string, unknown>).filter(
        ([k]) => !["id"].includes(k)
      );
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
    .option("--avatar-url <url>", "avatar image URL (use `spectrum avatar upload` instead)")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const hasMutation =
        opts.firstName !== undefined ||
        opts.lastName !== undefined ||
        opts.avatarUrl !== undefined;
      if (!hasMutation) {
        die("Nothing to update.", {
          hint: "Pass at least one of --first-name / --last-name / --avatar-url.",
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

      const body: Record<string, string> = {};
      if (opts.firstName !== undefined) body.firstName = opts.firstName;
      if (opts.lastName !== undefined) body.lastName = opts.lastName;
      if (opts.avatarUrl !== undefined) body.avatarUrl = opts.avatarUrl;

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
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
