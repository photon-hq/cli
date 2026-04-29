import type { Command } from "@commander-js/extra-typings";
import { isCancel, text } from "@clack/prompts";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";

export function registerSpectrumUsers(spectrum: Command): void {
  const users = spectrum
    .command("users")
    .description("manage Spectrum users on a project");

  users
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list Spectrum users for the linked project")
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
        .spectrum.users.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to list users: ${formatApiError(error)}`);

      const list = (data ?? []) as SpectrumUser[];
      if (opts.json) return printJson(list);
      if (list.length === 0) {
        console.log(c.dim("No Spectrum users yet."));
        console.log(c.hint("Add one with `photon spectrum users add`."));
        return;
      }
      const rows = list.map((u) => [
        truncate(u.id, 10),
        formatName(u),
        u.email ?? c.dim("—"),
        u.phoneNumber ?? c.dim("—"),
      ]);
      printTable(["id", "name", "email", "phone"], rows);
    });

  users
    .command("add")
    .alias("create")
    .description("add a Spectrum user to the linked project")
    .option("--first-name <name>", "first name")
    .option("--last-name <name>", "last name")
    .option("--email <email>", "email address")
    .option("--phone <number>", "phone number (E.164)")
    .option("--invite", "send an onboarding invite to this user")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const filled = await fillAddOpts(opts);
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
        .spectrum.users.post({
          firstName: filled.firstName,
          lastName: filled.lastName,
          email: filled.email,
          phoneNumber: filled.phone,
          sendInvite: opts.invite ?? false,
        });
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to add user: ${formatApiError(error)}`);
      const result = data as { success?: true; user?: SpectrumUser; error?: string };
      if (result.error) die(result.error);

      if (opts.json) return printJson(result.user ?? {});
      const u = result.user;
      console.log(
        c.success(
          `Added ${formatName(u ?? filled)} ${u?.id ? c.dim(`(${u.id})`) : ""}`
        )
      );
      if (opts.invite) console.log(c.dim("  Invite sent."));
    });

  users
    .command("remove <user-id>")
    .alias("rm")
    .alias("delete")
    .description("remove a Spectrum user")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("-e, --env <name>", "environment (defaults to current)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .action(async (userId, opts) => {
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
        message: `Remove user ${userId} from project ${projectId}?`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to remove user ${userId}.`,
      });

      const { error, status } = await api.api
        .projects({ id: projectId })
        .spectrum.users({ userId })
        .delete();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to remove user: ${formatApiError(error)}`);

      console.log(c.success(`Removed user ${userId}`));
    });
}

interface SpectrumUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}

interface FilledAdd {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

async function fillAddOpts(opts: {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}): Promise<FilledAdd> {
  // Server requires all four fields.
  if (!isInteractive()) {
    const missing: string[] = [];
    if (!opts.firstName) missing.push("--first-name");
    if (!opts.lastName) missing.push("--last-name");
    if (!opts.email) missing.push("--email");
    if (!opts.phone) missing.push("--phone");
    if (missing.length > 0) {
      die(`Missing required flags in non-interactive mode: ${missing.join(", ")}`);
    }
    return {
      firstName: opts.firstName!,
      lastName: opts.lastName!,
      email: opts.email!,
      phone: opts.phone!,
    };
  }
  return {
    firstName: opts.firstName ?? (await promptRequired("First name")),
    lastName: opts.lastName ?? (await promptRequired("Last name")),
    email: opts.email ?? (await promptRequired("Email")),
    phone: opts.phone ?? (await promptRequired("Phone (E.164, e.g. +14155551234)")),
  };
}

async function promptRequired(message: string): Promise<string> {
  const answer = await text({
    message,
    validate: (v) => (v && v.trim() ? undefined : "Required"),
  });
  if (isCancel(answer)) die("Aborted.");
  return answer.trim();
}

function formatName(u: { firstName?: string | null; lastName?: string | null }): string {
  const parts = [u.firstName, u.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : c.dim("(no name)");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
