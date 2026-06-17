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
        console.log(c.dim("No profile yet."));
        console.log(c.hint("Set one up: `photon profile init`."));
        return;
      }

      console.log(c.bold(`${profile.type} profile`));
      const entries: Array<[string, unknown]> = [
        ["background", profile.background],
        ["companyName", profile.companyName],
        ["platforms", profile.platforms],
        ["referralSource", profile.referralSource],
      ];
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
    .description("set up your developer or organization profile")
    .option("--type <type>", "developer | organization")
    .option("--background <text>", "free-form background (e.g. languages, stack, role)")
    .option("--referral <text>", "how did you hear about us?")
    .option("--company-name <name>", "organization: company name")
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

      const { type, details, referral } = await fillInit(opts);

      const r = await api.api.onboarding.details.post(details);
      if (r.status === 401) throw new SessionExpiredError(env.name);
      if (r.error) die(`Failed to save profile: ${formatApiError(r.error)}`);

      if (referral !== undefined) {
        const rr = await api.api.onboarding.referral.post({ referralSource: referral });
        if (rr.status === 401) throw new SessionExpiredError(env.name);
        if (rr.error) die(`Failed to save referral source: ${formatApiError(rr.error)}`);
      }

      if (opts.json) {
        printJson({ type, details, referralSource: referral ?? null });
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
  referral?: string;
}

async function fillInit(opts: InitOpts): Promise<InitResult> {
  // Non-interactive: --type required, must be a known value, and at least one
  // matching field flag must be present so we don't silently persist an empty
  // profile.
  if (!isInteractive()) {
    if (!opts.type) {
      die("--type is required in non-interactive mode (developer | organization).");
    }
    if (opts.type !== "developer" && opts.type !== "organization") {
      die(`Unknown profile type "${opts.type}". Use "developer" or "organization".`);
    }
    if (opts.type === "developer") {
      const hasField = opts.background !== undefined || opts.referral !== undefined;
      if (!hasField) {
        die("At least one of --background / --referral is required for a developer profile.", {
          hint: "Pass `--background 'TypeScript, Python, infra'` and/or `--referral 'word of mouth'`.",
        });
      }
      return {
        type: "developer",
        details: {
          type: "developer",
          background: opts.background,
        },
        referral: opts.referral,
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
      referral: opts.referral,
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
      "Background (e.g. TypeScript, Python, infra)",
      opts.background
    );
    const referralSource = await promptOptionalText(
      "How did you hear about us?",
      opts.referral
    );
    outro(c.dim("Submitting…"));
    return {
      type: "developer",
      details: { type: "developer", background },
      referral: referralSource,
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
    referral: referralSource,
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
    .option("--platforms <list>", "organization: comma-separated platforms")
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
      const organizationOnly = ["--company-name", "--platforms"];
      const passedDeveloperFlags: string[] = [];
      if (opts.background !== undefined) passedDeveloperFlags.push("--background");
      const passedOrganizationFlags: string[] = [];
      if (opts.companyName !== undefined) passedOrganizationFlags.push("--company-name");
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
      // so fetch + overlay to preserve unchanged fields.
      const details: DetailsPayload =
        current.type === "developer"
          ? {
              type: "developer",
              background: opts.background ?? current.background ?? undefined,
            }
          : {
              type: "organization",
              companyName: opts.companyName ?? current.companyName ?? undefined,
              platforms:
                opts.platforms !== undefined
                  ? parseCsv(opts.platforms)
                  : current.platforms ?? undefined,
            };

      const r = await api.api.onboarding.details.post(details);
      if (r.status === 401) throw new SessionExpiredError(env.name);
      if (r.error) die(`Failed to update profile: ${formatApiError(r.error)}`);

      let referralSource: string | undefined;
      if (opts.referral !== undefined) {
        referralSource = opts.referral;
        const rr = await api.api.onboarding.referral.post({ referralSource });
        if (rr.status === 401) throw new SessionExpiredError(env.name);
        if (rr.error) die(`Failed to update referral source: ${formatApiError(rr.error)}`);
      }

      if (opts.json) {
        return printJson({
          type: current.type,
          details,
          referralSource: referralSource ?? current.referralSource ?? null,
        });
      }
      console.log(c.success(`${capitalize(current.type)} profile updated.`));
    });
}

// ──────────────────────────── helpers ────────────────────────────

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (Array.isArray(v)) return v.length === 0 ? c.dim("—") : v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
