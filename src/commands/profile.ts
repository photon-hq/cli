import type { Command } from "@commander-js/extra-typings";
import {
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";
import { getApi } from "~/lib/api.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";
import type { ProfileResponse } from "~/lib/types.ts";

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command("profile")
    .description("view or manage your developer / organization profile");

  registerShowCommand(profile);
  registerInitCommand(profile);
  registerUpdateCommand(profile);
}

// ──────────────────────────── show ────────────────────────────

function registerShowCommand(profile: Command): void {
  profile
    .command("show", { isDefault: true })
    .description("show your profile")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, creds, env } = await getApi({
        apiHost: opts.apiHost,
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

      if (creds) {
        console.log(c.bold(creds.user.name) + c.dim(` <${creds.user.email}>`));
      } else {
        console.log(c.dim(`token-authenticated on env ${env.name}`));
      }
      console.log();

      if (!profile) {
        console.log(c.dim("No developer or organization profile yet."));
        console.log(c.hint("Set one up: `photon profile init`."));
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

// ──────────────────────────── init ────────────────────────────

interface InitOpts {
  // commander returns the raw `--type <type>` value as `string`, so this
  // mirrors that — narrowing to the literal union happens after validation.
  type?: string;
  // Developer fields
  languages?: string;       // CSV
  referral?: string;
  // Organization fields
  companyName?: string;
  role?: string;
  companySize?: string;
  website?: string;
  platforms?: string;       // CSV
  // Common
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerInitCommand(profile: Command): void {
  profile
    .command("init")
    .description("set up your developer or organization profile")
    .option("--type <type>", "developer | organization")
    .option("--languages <list>", "developer: comma-separated languages")
    .option("--referral <text>", "how did you hear about us?")
    .option("--company-name <name>", "organization: company name")
    .option("--role <role>", "organization: your role")
    .option("--company-size <size>", "organization: company size (e.g. 1-10, 11-50)")
    .option("--website <url>", "organization: company website")
    .option("--platforms <list>", "organization: comma-separated platforms")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: InitOpts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      // Refuse if a profile already exists — that's `update`'s job.
      const fetched = await api.api.profile.get();
      if (fetched.status === 401) throw new SessionExpiredError(env.name);
      if (fetched.error) {
        die(`Failed to check existing profile: ${formatApiError(fetched.error)}`);
      }
      if (fetched.data) {
        die("A profile already exists for this account.", {
          hint: "Use `photon profile update` to change it.",
        });
      }

      const { type, payload } = await fillInit(opts);

      if (type === "developer") {
        const result = await api.api.profile.developer.post(payload);
        if (result.status === 401) throw new SessionExpiredError(env.name);
        if (result.error) die(`Failed to save profile: ${formatApiError(result.error)}`);
      } else {
        const result = await api.api.profile.organization.post(payload);
        if (result.status === 401) throw new SessionExpiredError(env.name);
        if (result.error) die(`Failed to save profile: ${formatApiError(result.error)}`);
      }

      if (opts.json) {
        printJson({ type, profile: payload });
        return;
      }
      console.log(c.success(`Created ${type} profile.`));
    });
}

interface DeveloperPayload {
  languages: string[];
  referralSource: string;
}

interface OrganizationPayload {
  companyName?: string;
  role?: string;
  companySize?: string;
  website?: string;
  platforms?: string[];
  referralSource?: string;
}

type InitResult =
  | { type: "developer"; payload: DeveloperPayload }
  | { type: "organization"; payload: OrganizationPayload };

async function fillInit(opts: InitOpts): Promise<InitResult> {
  // Non-interactive: --type required, must be a known value, and
  // at least one matching field flag must be present so we don't
  // silently persist an empty profile (`languages: []`,
  // `referralSource: ""`).
  if (!isInteractive()) {
    if (!opts.type) {
      die("--type is required in non-interactive mode (developer | organization).");
    }
    if (opts.type !== "developer" && opts.type !== "organization") {
      die(`Unknown profile type "${opts.type}". Use "developer" or "organization".`);
    }
    if (opts.type === "developer") {
      const hasField = opts.languages !== undefined || opts.referral !== undefined;
      if (!hasField) {
        die("At least one of --languages / --referral is required for a developer profile.", {
          hint: "Pass `--languages typescript,python` and/or `--referral 'word of mouth'`.",
        });
      }
      return {
        type: "developer",
        payload: {
          languages: parseCsv(opts.languages ?? ""),
          referralSource: opts.referral ?? "",
        },
      };
    }
    // organization
    const hasOrgField =
      opts.companyName !== undefined ||
      opts.role !== undefined ||
      opts.companySize !== undefined ||
      opts.website !== undefined ||
      opts.platforms !== undefined ||
      opts.referral !== undefined;
    if (!hasOrgField) {
      die(
        "At least one organization field is required (--company-name, --role, --company-size, --website, --platforms, --referral)."
      );
    }
    return {
      type: "organization",
      payload: {
        companyName: opts.companyName,
        role: opts.role,
        companySize: opts.companySize,
        website: opts.website,
        platforms: opts.platforms !== undefined ? parseCsv(opts.platforms) : undefined,
        referralSource: opts.referral,
      },
    };
  }

  intro(c.cyan("Set up your profile"));

  let type = opts.type;
  if (!type) {
    const answer = await select({
      message: "What kind of profile?",
      options: [
        { value: "developer", label: "Developer", hint: "individual contributor" },
        { value: "organization", label: "Organization", hint: "company / team" },
      ],
    });
    if (isCancel(answer)) die("Aborted.");
    type = String(answer);
  }

  // --type passed in could be anything; validate before branching so an
  // unknown value like `--type developer-pro` doesn't fall through into
  // the organization flow.
  if (type !== "developer" && type !== "organization") {
    die(`Unknown profile type "${type}". Use "developer" or "organization".`);
  }

  if (type === "developer") {
    const languages = await promptCsv(
      "Languages (comma-separated, e.g. typescript,python)",
      opts.languages
    );
    const referralSource = await promptText(
      "How did you hear about us?",
      opts.referral
    );
    outro(c.dim("Submitting…"));
    return {
      type: "developer",
      payload: { languages, referralSource },
    };
  }

  // organization
  const companyName = await promptOptionalText("Company name", opts.companyName);
  const role = await promptOptionalText("Your role", opts.role);
  const companySize = await promptOptionalText(
    "Company size (e.g. 1-10, 11-50, 51-200)",
    opts.companySize
  );
  const website = await promptOptionalText("Website URL", opts.website);
  const platforms =
    opts.platforms !== undefined
      ? parseCsv(opts.platforms)
      : await promptCsv("Platforms (comma-separated, e.g. ios,android,web)", undefined, true);
  const referralSource = await promptOptionalText(
    "How did you hear about us?",
    opts.referral
  );
  outro(c.dim("Submitting…"));
  return {
    type: "organization",
    payload: {
      companyName,
      role,
      companySize,
      website,
      platforms: platforms.length > 0 ? platforms : undefined,
      referralSource,
    },
  };
}

async function promptText(message: string, preset?: string): Promise<string> {
  if (preset !== undefined) return preset;
  const answer = await text({ message });
  if (isCancel(answer)) die("Aborted.");
  return answer ?? "";
}

async function promptOptionalText(
  message: string,
  preset?: string
): Promise<string | undefined> {
  if (preset !== undefined) return preset;
  const answer = await text({ message, placeholder: "(skip)" });
  if (isCancel(answer)) die("Aborted.");
  const trimmed = answer?.trim();
  return trimmed ? trimmed : undefined;
}

async function promptCsv(
  message: string,
  preset?: string,
  optional = false
): Promise<string[]> {
  if (preset !== undefined) return parseCsv(preset);
  const answer = await text({
    message,
    placeholder: optional ? "(skip)" : undefined,
  });
  if (isCancel(answer)) die("Aborted.");
  return parseCsv(answer ?? "");
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// ──────────────────────────── update ────────────────────────────

interface UpdateOpts {
  languages?: string;
  referral?: string;
  companyName?: string;
  role?: string;
  companySize?: string;
  website?: string;
  platforms?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerUpdateCommand(profile: Command): void {
  profile
    .command("update")
    .alias("edit")
    .description("update your existing profile (preserves unchanged fields)")
    .option("--languages <list>", "developer: comma-separated languages")
    .option("--referral <text>", "how did you hear about us?")
    .option("--company-name <name>", "organization: company name")
    .option("--role <role>", "organization: your role")
    .option("--company-size <size>", "organization: company size")
    .option("--website <url>", "organization: company website")
    .option("--platforms <list>", "organization: comma-separated platforms")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: UpdateOpts) => {
      const hasMutation =
        opts.languages !== undefined ||
        opts.referral !== undefined ||
        opts.companyName !== undefined ||
        opts.role !== undefined ||
        opts.companySize !== undefined ||
        opts.website !== undefined ||
        opts.platforms !== undefined;
      if (!hasMutation) {
        die("Nothing to update.", {
          hint: "Pass at least one field flag — see `photon profile update --help`.",
        });
      }

      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      const fetched = await api.api.profile.get();
      if (fetched.status === 401) throw new SessionExpiredError(env.name);
      if (fetched.error) {
        die(`Failed to fetch profile: ${formatApiError(fetched.error)}`);
      }
      const current = fetched.data as ProfileResponse;
      if (!current) {
        die("No profile to update.", {
          hint: "Create one first: `photon profile init`.",
        });
      }

      // Reject flags that don't apply to this profile type — otherwise
      // running `update --company-name X` on a developer profile would
      // silently no-op and report "✓ Updated".
      const developerOnly = ["--languages"];
      const organizationOnly = [
        "--company-name",
        "--role",
        "--company-size",
        "--website",
        "--platforms",
      ];
      const passedDeveloperFlags: string[] = [];
      if (opts.languages !== undefined) passedDeveloperFlags.push("--languages");
      const passedOrganizationFlags: string[] = [];
      if (opts.companyName !== undefined) passedOrganizationFlags.push("--company-name");
      if (opts.role !== undefined) passedOrganizationFlags.push("--role");
      if (opts.companySize !== undefined) passedOrganizationFlags.push("--company-size");
      if (opts.website !== undefined) passedOrganizationFlags.push("--website");
      if (opts.platforms !== undefined) passedOrganizationFlags.push("--platforms");
      if (current.type === "developer" && passedOrganizationFlags.length > 0) {
        die(
          `Flags ${passedOrganizationFlags.join(", ")} apply to organization profiles, but yours is a developer profile.`,
          { hint: `Valid flags for developer: ${developerOnly.join(", ")}, --referral.` }
        );
      }
      if (current.type === "organization" && passedDeveloperFlags.length > 0) {
        die(
          `Flags ${passedDeveloperFlags.join(", ")} apply to developer profiles, but yours is an organization profile.`,
          { hint: `Valid flags for organization: ${organizationOnly.join(", ")}, --referral.` }
        );
      }

      // Server upsert overwrites every field with whatever we send,
      // so fetch + overlay to preserve unchanged fields. Same pattern
      // as projects update.
      if (current.type === "developer") {
        const cp = current.profile as { languages?: string[]; referralSource?: string };
        const body: DeveloperPayload = {
          languages:
            opts.languages !== undefined ? parseCsv(opts.languages) : cp.languages ?? [],
          referralSource: opts.referral ?? cp.referralSource ?? "",
        };
        const r = await api.api.profile.developer.post(body);
        if (r.status === 401) throw new SessionExpiredError(env.name);
        if (r.error) die(`Failed to update profile: ${formatApiError(r.error)}`);
        if (opts.json) return printJson({ type: "developer", profile: body });
        console.log(c.success("Developer profile updated."));
      } else {
        const cp = current.profile as Record<string, unknown>;
        const body: OrganizationPayload = {
          companyName: opts.companyName ?? (cp.companyName as string | undefined),
          role: opts.role ?? (cp.role as string | undefined),
          companySize: opts.companySize ?? (cp.companySize as string | undefined),
          website: opts.website ?? (cp.website as string | undefined),
          platforms:
            opts.platforms !== undefined
              ? parseCsv(opts.platforms)
              : (cp.platforms as string[] | undefined),
          referralSource: opts.referral ?? (cp.referralSource as string | undefined),
        };
        const r = await api.api.profile.organization.post(body);
        if (r.status === 401) throw new SessionExpiredError(env.name);
        if (r.error) die(`Failed to update profile: ${formatApiError(r.error)}`);
        if (opts.json) return printJson({ type: "organization", profile: body });
        console.log(c.success("Organization profile updated."));
      }
    });
}

// ──────────────────────────── helpers ────────────────────────────

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
