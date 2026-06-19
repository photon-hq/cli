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
import type { OnboardingProfile, ProfileResponse } from "~/lib/types.ts";

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
      const entries = Object.entries(profile as unknown as Record<string, unknown>).filter(
        ([k]) => !["id", "userId", "type"].includes(k)
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
  background?: string;
  // Organization fields
  companyName?: string;
  platforms?: string;       // CSV
  // Common
  referral?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerInitCommand(profile: Command): void {
  profile
    .command("init")
    .description("set up your onboarding profile")
    .option("--type <type>", "developer | organization")
    .option("--background <text>", "developer: short background / experience blurb")
    .option("--company-name <name>", "organization: company name")
    .option("--platforms <list>", "organization: comma-separated platforms")
    .option("--referral <text>", "how did you hear about us?")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: InitOpts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

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

      const result = await fillInit(opts);

      const detailsBody: DetailsPayload = {
        type: result.type,
        background: result.background,
        companyName: result.companyName,
        platforms: result.platforms,
      };
      const detailsRes = await api.api.onboarding.details.post(detailsBody);
      if (detailsRes.status === 401) throw new SessionExpiredError(env.name);
      if (detailsRes.error) {
        die(`Failed to save profile: ${formatApiError(detailsRes.error)}`);
      }

      if (result.referralSource) {
        const refRes = await api.api.onboarding.referral.post({
          referralSource: result.referralSource,
        });
        if (refRes.status === 401) throw new SessionExpiredError(env.name);
        if (refRes.error) {
          die(`Failed to save referral: ${formatApiError(refRes.error)}`);
        }
      }

      if (opts.json) {
        printJson({ type: result.type, profile: result });
        return;
      }
      console.log(c.success(`Created ${result.type} profile.`));
    });
}

interface FilledProfile {
  type: "developer" | "organization";
  background?: string;
  companyName?: string;
  platforms?: string[];
  referralSource?: string;
}

interface DetailsPayload {
  type: "developer" | "organization";
  background?: string;
  companyName?: string;
  platforms?: string[];
}

async function fillInit(opts: InitOpts): Promise<FilledProfile> {
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
      const hasField = opts.background !== undefined || opts.referral !== undefined;
      if (!hasField) {
        die("At least one of --background / --referral is required for a developer profile.", {
          hint: "Pass `--background 'staff engineer at acme'` and/or `--referral 'word of mouth'`.",
        });
      }
      return {
        type: "developer",
        background: opts.background,
        referralSource: opts.referral,
      };
    }
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
      companyName: opts.companyName,
      platforms: opts.platforms !== undefined ? parseCsv(opts.platforms) : undefined,
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

  if (type !== "developer" && type !== "organization") {
    die(`Unknown profile type "${type}". Use "developer" or "organization".`);
  }

  if (type === "developer") {
    const background = await promptOptionalText(
      "Background (e.g. 'staff engineer at acme')",
      opts.background
    );
    const referralSource = await promptOptionalText(
      "How did you hear about us?",
      opts.referral
    );
    outro(c.dim("Submitting…"));
    return {
      type: "developer",
      background,
      referralSource,
    };
  }

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
    companyName,
    platforms: platforms.length > 0 ? platforms : undefined,
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
  companyName?: string;
  platforms?: string;
  referral?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerUpdateCommand(profile: Command): void {
  profile
    .command("update")
    .alias("edit")
    .description("update your existing profile (preserves unchanged fields)")
    .option("--background <text>", "developer: short background / experience blurb")
    .option("--company-name <name>", "organization: company name")
    .option("--platforms <list>", "organization: comma-separated platforms")
    .option("--referral <text>", "how did you hear about us?")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: UpdateOpts) => {
      const hasMutation =
        opts.background !== undefined ||
        opts.companyName !== undefined ||
        opts.platforms !== undefined ||
        opts.referral !== undefined;
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

      const merged: OnboardingProfile = {
        ...current,
        background:
          current.type === "developer" && opts.background !== undefined
            ? opts.background
            : current.background,
        companyName:
          current.type === "organization" && opts.companyName !== undefined
            ? opts.companyName
            : current.companyName,
        platforms:
          current.type === "organization" && opts.platforms !== undefined
            ? parseCsv(opts.platforms)
            : current.platforms,
        referralSource:
          opts.referral !== undefined ? opts.referral : current.referralSource,
      };

      // Always re-send details so the server's upsert keeps the row in sync;
      // this matches how the dashboard's onboarding form behaves.
      const detailsBody: DetailsPayload = {
        type: merged.type,
        background: merged.background ?? undefined,
        companyName: merged.companyName ?? undefined,
        platforms: merged.platforms ?? undefined,
      };
      const detailsRes = await api.api.onboarding.details.post(detailsBody);
      if (detailsRes.status === 401) throw new SessionExpiredError(env.name);
      if (detailsRes.error) {
        die(`Failed to update profile: ${formatApiError(detailsRes.error)}`);
      }

      if (opts.referral !== undefined && merged.referralSource) {
        const refRes = await api.api.onboarding.referral.post({
          referralSource: merged.referralSource,
        });
        if (refRes.status === 401) throw new SessionExpiredError(env.name);
        if (refRes.error) {
          die(`Failed to update referral: ${formatApiError(refRes.error)}`);
        }
      }

      if (opts.json) return printJson({ type: merged.type, profile: merged });
      console.log(c.success(`${capitalize(merged.type)} profile updated.`));
    });
}

// ──────────────────────────── helpers ────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (Array.isArray(v)) return v.length === 0 ? c.dim("—") : v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
