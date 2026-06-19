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

/**
 * The profile / onboarding contract collapsed into a single flat record on
 * the server. `GET /api/profile` returns it; writes go through
 * `POST /api/onboarding/details`, which accepts `type`, `platforms`,
 * `background`, and `companyName`. `referralSource` is read-only (captured at
 * sign-up) so it's displayed but never sent.
 */
const ACCOUNT_TYPES = ["developer", "organization"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

interface OnboardingDetails {
  type?: AccountType;
  platforms?: string[];
  background?: string;
  companyName?: string;
}

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

      if (opts.json) {
        printJson({ user: creds?.user ?? null, profile: data });
        return;
      }

      if (creds) {
        console.log(c.bold(creds.user.name) + c.dim(` <${creds.user.email}>`));
      } else {
        console.log(c.dim(`token-authenticated on env ${env.name}`));
      }
      console.log();

      if (!data) {
        console.log(c.dim("No profile yet."));
        console.log(c.hint("Set one up: `photon profile init`."));
        return;
      }

      console.log(c.bold(`${data.type} profile`));
      const rows: [string, unknown][] = [
        ["companyName", data.companyName],
        ["platforms", data.platforms],
        ["background", data.background],
        ["referralSource", data.referralSource],
      ];
      const width = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) {
        console.log(`  ${c.dim(k.padEnd(width))}  ${formatValue(v)}`);
      }
    });
}

// ──────────────────────────── init ────────────────────────────

interface InitOpts {
  // commander returns the raw `--type <type>` value as `string`, so this
  // mirrors that — narrowing to the literal union happens after validation.
  type?: string;
  platforms?: string;       // CSV
  background?: string;
  companyName?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerInitCommand(profile: Command): void {
  profile
    .command("init")
    .description("set up your developer or organization profile")
    .option("--type <type>", "developer | organization")
    .option("--platforms <list>", "comma-separated platforms you're building on")
    .option("--background <text>", "what you're building")
    .option("--company-name <name>", "organization: company name")
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

      const payload = await fillInit(opts);
      await submitDetails(api, env.name, payload);

      if (opts.json) {
        printJson({ profile: payload });
        return;
      }
      console.log(c.success(`Created ${payload.type} profile.`));
    });
}

async function fillInit(opts: InitOpts): Promise<OnboardingDetails> {
  // Non-interactive: --type required and must be a known value so we don't
  // persist a typeless profile.
  if (!isInteractive()) {
    const type = normalizeType(opts.type, { required: true });
    return {
      type,
      platforms: opts.platforms !== undefined ? parseCsv(opts.platforms) : undefined,
      background: opts.background,
      companyName: opts.companyName,
    };
  }

  intro(c.cyan("Set up your profile"));

  let type = normalizeType(opts.type);
  if (!type) {
    const answer = await select({
      message: "What kind of profile?",
      options: [
        { value: "developer", label: "Developer", hint: "individual contributor" },
        { value: "organization", label: "Organization", hint: "company / team" },
      ],
    });
    if (isCancel(answer)) die("Aborted.");
    type = answer as AccountType;
  }

  const platforms =
    opts.platforms !== undefined
      ? parseCsv(opts.platforms)
      : await promptCsv("Platforms you're building on (comma-separated)", undefined, true);
  const background = await promptOptionalText("What are you building?", opts.background);
  const companyName =
    type === "organization"
      ? await promptOptionalText("Company name", opts.companyName)
      : opts.companyName;

  outro(c.dim("Submitting…"));
  return {
    type,
    platforms: platforms.length > 0 ? platforms : undefined,
    background,
    companyName,
  };
}

// ──────────────────────────── update ────────────────────────────

interface UpdateOpts {
  type?: string;
  platforms?: string;
  background?: string;
  companyName?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerUpdateCommand(profile: Command): void {
  profile
    .command("update")
    .alias("edit")
    .description("update your existing profile (preserves unchanged fields)")
    .option("--type <type>", "developer | organization")
    .option("--platforms <list>", "comma-separated platforms you're building on")
    .option("--background <text>", "what you're building")
    .option("--company-name <name>", "organization: company name")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: UpdateOpts) => {
      const hasMutation =
        opts.type !== undefined ||
        opts.platforms !== undefined ||
        opts.background !== undefined ||
        opts.companyName !== undefined;
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
      const current = fetched.data;
      if (!current) {
        die("No profile to update.", {
          hint: "Create one first: `photon profile init`.",
        });
      }

      // The write endpoint overwrites every field it receives, so fetch +
      // overlay to preserve anything the user didn't pass.
      const payload: OnboardingDetails = {
        type: opts.type !== undefined
          ? normalizeType(opts.type, { required: true })
          : normalizeType(current.type) ?? undefined,
        platforms:
          opts.platforms !== undefined
            ? parseCsv(opts.platforms)
            : current.platforms ?? undefined,
        background: opts.background ?? current.background ?? undefined,
        companyName: opts.companyName ?? current.companyName ?? undefined,
      };

      await submitDetails(api, env.name, payload);

      if (opts.json) return printJson({ profile: payload });
      console.log(c.success("Profile updated."));
    });
}

// ──────────────────────────── helpers ────────────────────────────

/**
 * POST the onboarding details, dropping `undefined` fields so we only send
 * what's set. Throws SessionExpiredError on 401, dies on any other error.
 */
async function submitDetails(
  api: Awaited<ReturnType<typeof getApi>>["api"],
  envName: string,
  payload: OnboardingDetails
): Promise<void> {
  const body: OnboardingDetails = {};
  if (payload.type !== undefined) body.type = payload.type;
  if (payload.platforms !== undefined) body.platforms = payload.platforms;
  if (payload.background !== undefined) body.background = payload.background;
  if (payload.companyName !== undefined) body.companyName = payload.companyName;

  const result = await api.api.onboarding.details.post(body);
  if (result.status === 401) throw new SessionExpiredError(envName);
  if (result.error) die(`Failed to save profile: ${formatApiError(result.error)}`);
}

/**
 * Validate and narrow a raw `--type` value to the AccountType union.
 * Returns undefined when not provided and not required.
 */
function normalizeType(
  value: string | undefined,
  { required = false }: { required?: boolean } = {}
): AccountType | undefined {
  if (value === undefined || value === "") {
    if (required) {
      die("--type is required (developer | organization).");
    }
    return undefined;
  }
  if (!ACCOUNT_TYPES.includes(value as AccountType)) {
    die(`Unknown profile type "${value}". Use "developer" or "organization".`);
  }
  return value as AccountType;
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

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : c.dim("—");
  if (typeof v === "boolean") return v ? c.green("yes") : c.dim("no");
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
