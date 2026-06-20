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
import type { ProfileResponse, ProfileRow } from "~/lib/types.ts";

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command("profile")
    .description("view or manage your onboarding profile");

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
        console.log(c.dim("No onboarding profile yet."));
        console.log(c.hint("Set one up: `photon profile init`."));
        return;
      }

      console.log(c.bold(`${profile.type} profile`));
      const entries = visibleEntries(profile);
      const width = Math.max(...entries.map(([k]) => k.length));
      for (const [k, v] of entries) {
        console.log(`  ${c.dim(k.padEnd(width))}  ${formatValue(v)}`);
      }
    });
}

function visibleEntries(profile: ProfileRow): Array<[string, unknown]> {
  return Object.entries(profile).filter(
    ([k]) => !["id", "userId", "createdAt", "updatedAt"].includes(k)
  );
}

// ──────────────────────────── init ────────────────────────────

interface InitOpts {
  // commander returns the raw `--type <type>` value as `string`, so this
  // mirrors that — narrowing to the literal union happens after validation.
  type?: string;
  background?: string;
  referral?: string;
  companyName?: string;
  platforms?: string;       // CSV
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerInitCommand(profile: Command): void {
  profile
    .command("init")
    .description("set up your onboarding profile")
    .option("--type <type>", "developer | organization")
    .option("--background <text>", "developer: free-form background / focus areas")
    .option("--referral <text>", "how did you hear about us?")
    .option("--company-name <name>", "organization: company name")
    .option("--platforms <list>", "comma-separated platforms (e.g. ios,android,web)")
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

      const { type, details, referralSource } = await fillInit(opts);

      const detailsRes = await api.api.onboarding.details.post(details);
      if (detailsRes.status === 401) throw new SessionExpiredError(env.name);
      if (detailsRes.error) {
        die(`Failed to save profile: ${formatApiError(detailsRes.error)}`);
      }

      if (referralSource) {
        const refRes = await api.api.onboarding.referral.post({ referralSource });
        if (refRes.status === 401) throw new SessionExpiredError(env.name);
        if (refRes.error) {
          die(`Failed to save referral: ${formatApiError(refRes.error)}`);
        }
      }

      if (opts.json) {
        printJson({ type, details, referralSource });
        return;
      }
      console.log(c.success(`Created ${type} profile.`));
    });
}

interface DetailsPayload {
  type: "developer" | "organization";
  background?: string;
  companyName?: string;
  platforms?: string[];
}

interface InitResult {
  type: "developer" | "organization";
  details: DetailsPayload;
  referralSource?: string;
}

async function fillInit(opts: InitOpts): Promise<InitResult> {
  // Non-interactive: --type required, must be a known value, and
  // at least one matching field flag must be present so we don't
  // silently persist an empty profile.
  if (!isInteractive()) {
    if (!opts.type) {
      die("--type is required in non-interactive mode (developer | organization).");
    }
    if (opts.type !== "developer" && opts.type !== "organization") {
      die(`Unknown profile type "${opts.type}". Use "developer" or "organization".`);
    }
    if (opts.type === "developer") {
      const hasField =
        opts.background !== undefined ||
        opts.platforms !== undefined ||
        opts.referral !== undefined;
      if (!hasField) {
        die("At least one of --background / --platforms / --referral is required for a developer profile.", {
          hint: "Pass `--background 'building agents'` and/or `--referral 'word of mouth'`.",
        });
      }
      return {
        type: "developer",
        details: {
          type: "developer",
          background: opts.background,
          platforms: opts.platforms !== undefined ? parseCsv(opts.platforms) : undefined,
        },
        referralSource: opts.referral,
      };
    }
    // organization
    const hasOrgField =
      opts.companyName !== undefined ||
      opts.platforms !== undefined ||
      opts.referral !== undefined;
    if (!hasOrgField) {
      die(
        "At least one organization field is required (--company-name, --platforms, --referral)."
      );
    }
    return {
      type: "organization",
      details: {
        type: "organization",
        companyName: opts.companyName,
        platforms: opts.platforms !== undefined ? parseCsv(opts.platforms) : undefined,
      },
      referralSource: opts.referral,
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
    const background = await promptOptionalText(
      "Background (e.g. building agents, mobile apps)",
      opts.background
    );
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
      type: "developer",
      details: {
        type: "developer",
        background,
        platforms: platforms.length > 0 ? platforms : undefined,
      },
      referralSource,
    };
  }

  // organization
  const companyName = await promptOptionalText("Company name", opts.companyName);
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
    details: {
      type: "organization",
      companyName,
      platforms: platforms.length > 0 ? platforms : undefined,
    },
    referralSource,
  };
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
  background?: string;
  referral?: string;
  companyName?: string;
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
    .option("--background <text>", "developer: free-form background")
    .option("--referral <text>", "how did you hear about us?")
    .option("--company-name <name>", "organization: company name")
    .option("--platforms <list>", "comma-separated platforms")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: UpdateOpts) => {
      const hasMutation =
        opts.background !== undefined ||
        opts.referral !== undefined ||
        opts.companyName !== undefined ||
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
      const developerOnly = ["--background"];
      const organizationOnly = ["--company-name"];
      const passedDeveloperFlags: string[] = [];
      if (opts.background !== undefined) passedDeveloperFlags.push("--background");
      const passedOrganizationFlags: string[] = [];
      if (opts.companyName !== undefined) passedOrganizationFlags.push("--company-name");
      if (current.type === "developer" && passedOrganizationFlags.length > 0) {
        die(
          `Flags ${passedOrganizationFlags.join(", ")} apply to organization profiles, but yours is a developer profile.`,
          { hint: `Valid flags for developer: ${developerOnly.join(", ")}, --platforms, --referral.` }
        );
      }
      if (current.type === "organization" && passedDeveloperFlags.length > 0) {
        die(
          `Flags ${passedDeveloperFlags.join(", ")} apply to developer profiles, but yours is an organization profile.`,
          { hint: `Valid flags for organization: ${organizationOnly.join(", ")}, --platforms, --referral.` }
        );
      }

      // Server upsert overwrites every field with whatever we send,
      // so fetch + overlay to preserve unchanged fields.
      const details: DetailsPayload = {
        type: current.type,
        background:
          current.type === "developer"
            ? (opts.background ?? current.background ?? undefined)
            : undefined,
        companyName:
          current.type === "organization"
            ? (opts.companyName ?? current.companyName ?? undefined)
            : undefined,
        platforms:
          opts.platforms !== undefined
            ? parseCsv(opts.platforms)
            : (current.platforms ?? undefined),
      };

      const detailsRes = await api.api.onboarding.details.post(details);
      if (detailsRes.status === 401) throw new SessionExpiredError(env.name);
      if (detailsRes.error) {
        die(`Failed to update profile: ${formatApiError(detailsRes.error)}`);
      }

      const referralSource = opts.referral ?? current.referralSource ?? undefined;
      if (opts.referral !== undefined && referralSource) {
        const refRes = await api.api.onboarding.referral.post({ referralSource });
        if (refRes.status === 401) throw new SessionExpiredError(env.name);
        if (refRes.error) {
          die(`Failed to update referral: ${formatApiError(refRes.error)}`);
        }
      }

      if (opts.json) {
        printJson({ type: current.type, details, referralSource });
        return;
      }
      console.log(c.success(`${capitalize(current.type)} profile updated.`));
    });
}

// ──────────────────────────── helpers ────────────────────────────

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
