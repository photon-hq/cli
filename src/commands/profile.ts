import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";
import type { ProfileResponse } from "~/lib/types.ts";

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command("profile")
    .description("view or manage your developer / organization profile");

  profile
    .command("show", { isDefault: true })
    .description("show your profile")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, creds, env } = await getApi({
        envName: opts.env,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error } = await api.api.profile.get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(env.name);
        die(`Failed to fetch profile: ${formatApiError(error)}`);
      }

      const profile = data as ProfileResponse;

      if (opts.json) {
        printJson({ user: creds?.user ?? null, profile });
        return;
      }

      // creds may be null when --token / PHOTON_TOKEN was used.
      if (creds) {
        console.log(c.bold(creds.user.name) + c.dim(` <${creds.user.email}>`));
      } else {
        console.log(c.dim(`token-authenticated on env ${env.name}`));
      }
      console.log();

      if (!profile) {
        console.log(c.dim("No developer or organization profile yet."));
        console.log(
          c.hint("Set one up at the Photon Dashboard web app or via the API.")
        );
        return;
      }

      console.log(c.bold(`${profile.type} profile`));
      const p = profile.profile as Record<string, unknown>;
      const entries = Object.entries(p).filter(
        ([k]) => !["id", "userId", "createdAt", "updatedAt"].includes(k)
      );
      const width = Math.max(...entries.map(([k]) => k.length));
      for (const [k, v] of entries) {
        console.log(`  ${c.dim(k.padEnd(width))}  ${formatValue(v)}`);
      }
    });
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
