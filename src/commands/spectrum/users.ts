import type { Command } from "@commander-js/extra-typings";
import { isCancel, text } from "@clack/prompts";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import { requireArrayField } from "~/lib/shape.ts";
import type {
  SpectrumUser,
  SpectrumUserAddFailure,
  SpectrumUserAddFailureCode,
  SpectrumUserAddResult,
} from "~/lib/types.ts";
import { isInteractive } from "~/lib/tty.ts";

export function registerSpectrumUsers(spectrum: Command): void {
  const users = spectrum
    .command("users")
    .description("manage Spectrum users on a project");

  users
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list Spectrum users for the active project")
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
        .spectrum.users.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to list users: ${formatApiError(error)}`);

      const list = requireArrayField(data, "users");
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
    .description("add a Spectrum user to the active project")
    .option("--first-name <name>", "first name")
    .option("--last-name <name>", "last name")
    .option("--email <email>", "email address")
    .option("--phone <number>", "phone number (E.164)")
    .option("--invite", "send an onboarding invite to this user")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      // Resolve project + auth FIRST so users don't fill out 4 prompts
      // and only then learn they're not logged in or have no link.
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const filled = await fillAddOpts(opts);

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
      if (error) failSpectrumUserAdd(error, opts.json ?? false);
      if (!data) {
        failSpectrumUserAdd(
          "Server did not return a Spectrum user result.",
          opts.json ?? false,
        );
      }
      const result = data as SpectrumUserAddResult;
      if (result.error) {
        failSpectrumUserAdd(
          {
            code: "shared_user_create_failed",
            message: result.error,
          },
          opts.json ?? false,
        );
      }

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
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .action(async (userId, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
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

function isSpectrumUserAddFailureCode(
  value: unknown
): value is SpectrumUserAddFailureCode {
  return (
    value === "imessage_not_enabled" ||
    value === "shared_line_unavailable" ||
    value === "shared_user_create_failed"
  );
}

function findStructuredFailure(error: unknown): SpectrumUserAddFailure | null {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!(value && typeof value === "object") || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      isSpectrumUserAddFailureCode(record.code) &&
      typeof record.message === "string"
    ) {
      return { code: record.code, message: record.message };
    }
    for (const key of ["value", "message", "error", "cause"]) {
      if (record[key] && typeof record[key] === "object") {
        queue.push(record[key]);
      }
    }
  }
  return null;
}

const SHARED_LINE_UNAVAILABLE_MESSAGE =
  "This phone couldn't be connected to a shared iMessage line. Try another phone or connect a dedicated line.";

function failSpectrumUserAdd(error: unknown, json: boolean): never {
  const parsedFailure = findStructuredFailure(error) ?? {
    code: "shared_user_create_failed",
    message: formatApiError(error),
  };
  const failure =
    parsedFailure.code === "shared_line_unavailable"
      ? { ...parsedFailure, message: SHARED_LINE_UNAVAILABLE_MESSAGE }
      : parsedFailure;
  if (json) {
    printJson({ error: failure });
    process.exit(1);
  }
  die(`Failed to add user: ${failure.message}`);
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
