import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import {
  NotAuthenticatedError,
  SessionExpiredError,
} from "~/lib/errors.ts";
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
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, creds } = await mustGetApi(opts.env);
      const { data, error } = await api.api.profile.get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(opts.env ?? "");
        die(`Failed to fetch profile: ${formatApiError(error)}`);
      }

      const profile = data as ProfileResponse;

      if (opts.json) {
        printJson({ user: creds!.user, profile });
        return;
      }

      const user = creds!.user;
      console.log(c.bold(user.name) + c.dim(` <${user.email}>`));
      console.log();

      if (!profile) {
        console.log(c.dim("No developer or organization profile yet."));
        console.log(
          c.hint("Set one up at the dashboard web app or via the API.")
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

async function mustGetApi(envName?: string): Promise<Awaited<ReturnType<typeof getApi>>> {
  try {
    return await getApi({ envName, requireAuth: true });
  } catch (err) {
    if (err instanceof NotAuthenticatedError) die(err.message);
    throw err;
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
