import type { Command } from "@commander-js/extra-typings";
import { intro, isCancel, log, outro, text, confirm as clackConfirm } from "@clack/prompts";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import {
  canonicalTierFor,
  createCheckoutAndOpen,
  fetchPlans,
  fetchSubscription,
  matchPlanTier,
  openPortalAndOpen,
  pickPlanInteractively,
  resolveBrowserPolicy,
  TIER_NAMES,
  type TierName,
} from "~/lib/billing-flow.ts";
import { openInBrowser } from "~/lib/browser.ts";
import { parsePositiveInt } from "~/lib/commander.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { confirmDestructive } from "~/lib/interactive.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";

/** Platforms accepted by `projects create` (mirrors the API's create body). */
const PLATFORMS = ["imessage", "whatsapp_business", "voice"] as const;
type Platform = (typeof PLATFORMS)[number];

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .alias("project")
    .description("manage your Photon Dashboard projects");

  registerListCommand(projects);
  registerShowCommand(projects);
  registerCreateCommand(projects);
  registerUpdateCommand(projects);
  registerDeleteCommand(projects);
  registerRegenerateSecretCommand(projects);
  registerOpenCommand(projects);
  registerUpgradeCommand(projects);
  registerCheckPhoneCommand(projects);
}

// ──────────────────────────── list ────────────────────────────

function registerListCommand(projects: Command): void {
  projects
    .command("list", { isDefault: true })
    .alias("ls")
    .description("list your projects")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error } = await api.api.projects.get();
      if (error) {
        if (error.status === 401) throw new SessionExpiredError(env.name);
        die(`Failed to list projects: ${formatApiError(error)}`);
      }

      const list = (data ?? []) as ProjectListItem[];
      if (opts.json) {
        printJson(list);
        return;
      }
      if (list.length === 0) {
        console.log(c.dim("No projects yet."));
        console.log(c.hint("Create one with `photon projects create`."));
        return;
      }

      const rows = list.map((p) => [
        truncate(p.id, 8),
        p.name,
        p.location,
        formatStatus(p.status),
        p.platforms.length > 0 ? p.platforms.join(", ") : c.dim("—"),
        new Date(p.updatedAt).toLocaleDateString(),
      ]);
      printTable(["id", "name", "location", "status", "platforms", "updated"], rows);
    });
}

// ──────────────────────────── show ────────────────────────────

function registerShowCommand(projects: Command): void {
  projects
    .command("show [id]")
    .alias("get")
    .description("show details for one project (defaults to $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error, status } = await api.api.projects({ id: projectId }).get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (status === 404 || (!error && !data)) {
        die(`Project not found: ${projectId}`, {
          hint: "List your projects with `photon projects ls`.",
        });
      }
      if (error) {
        die(`Failed to fetch project: ${formatApiError(error)}`);
      }

      if (opts.json) {
        printJson(data);
        return;
      }

      // The 404 / no-data case is handled above; this narrows for TS.
      if (!data) return;
      const p = data;
      console.log(c.bold(p.name) + c.dim(`  (${p.id})`));
      console.log();
      printKv([
        ["status", formatStatus(p.status)],
        ["location", p.location],
        ["owner", p.isOwner ? c.green("yes") : c.dim("no")],
        ["template", p.template ? "yes" : "no"],
        ["observability", p.observability ? "yes" : "no"],
        ["slackChannelId", p.slackChannelId ?? c.dim("—")],
        ["slackTeamId", p.slackTeamId ?? c.dim("—")],
        ["createdAt", new Date(p.createdAt).toLocaleString()],
        ["updatedAt", new Date(p.updatedAt).toLocaleString()],
      ]);
    });
}

// ──────────────────────────── create ────────────────────────────

interface CreateOpts {
  name?: string;
  location?: string;
  platforms?: string;
  template?: boolean;
  observability?: boolean;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerCreateCommand(projects: Command): void {
  projects
    .command("create")
    .alias("new")
    .description("create a new project")
    .option("-n, --name <name>", "project name")
    .option("-l, --location <location>", 'location (default: "United States")')
    .option("--platforms <list>", `comma-separated platforms (${PLATFORMS.join(", ")})`)
    .option("--template", "use as template")
    .option("--observability", "enable observability")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts: CreateOpts) => {
      const filled = await fillCreateOpts(opts);
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api.projects.post({
        name: filled.name,
        location: filled.location,
        platforms: filled.platforms,
        template: filled.template,
        observability: filled.observability,
      });
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) {
        die(`Failed to create project: ${formatApiError(error)}`);
      }
      const result = data as { success?: true; id?: string; error?: string };
      if (result.error) {
        die(result.error);
      }
      if (!result.id) {
        die("Server did not return a project id.");
      }

      if (opts.json) {
        printJson({ id: result.id, name: filled.name, env: env.name });
        return;
      }

      console.log(
        c.success(
          `Created ${c.bold(filled.name)} ${c.dim(`(${result.id})`)} on ${c.bold(env.name)}`
        )
      );
      console.log(
        c.dim(`  To make this the active project: export PHOTON_PROJECT_ID='${result.id}'`)
      );
    });
}

interface FilledCreate {
  name: string;
  location: string;
  platforms: Platform[];
  template: boolean;
  observability: boolean;
}

/**
 * Parse a comma-separated --platforms value into the API's platform union,
 * rejecting unknown values up front so the server doesn't 422 us.
 */
function parsePlatforms(value: string): Platform[] {
  const parsed = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const invalid = parsed.filter((p) => !PLATFORMS.includes(p as Platform));
  if (invalid.length > 0) {
    die(`Unknown platform(s): ${invalid.join(", ")}.`, {
      hint: `Valid platforms: ${PLATFORMS.join(", ")}.`,
    });
  }
  // Dedupe while preserving order.
  return [...new Set(parsed)] as Platform[];
}

async function fillCreateOpts(opts: CreateOpts): Promise<FilledCreate> {
  // Non-interactive path: name is required; defaults fill the rest.
  if (!isInteractive()) {
    if (!opts.name?.trim()) {
      die("--name is required in non-interactive mode.", {
        hint: "Run from a terminal for the interactive prompt, or pass --name <name>.",
      });
    }
    return {
      name: opts.name.trim(),
      location: opts.location ?? "United States",
      platforms: opts.platforms !== undefined ? parsePlatforms(opts.platforms) : [],
      template: opts.template ?? false,
      observability: opts.observability ?? false,
    };
  }

  intro(c.cyan("Create a new project"));

  let name = opts.name?.trim();
  if (!name) {
    const answer = await text({
      message: "Project name",
      validate: (value) =>
        value && value.trim() ? undefined : "Project name is required",
    });
    if (isCancel(answer)) {
      die("Aborted.");
    }
    name = answer.trim();
  }

  let location = opts.location;
  if (location === undefined) {
    const answer = await text({
      message: "Location",
      placeholder: "United States",
      defaultValue: "United States",
    });
    if (isCancel(answer)) {
      die("Aborted.");
    }
    location = answer || "United States";
  }

  const platforms =
    opts.platforms !== undefined
      ? parsePlatforms(opts.platforms)
      : parsePlatforms(
          await promptText(
            `Platforms (comma-separated: ${PLATFORMS.join(", ")})`,
            undefined,
            true
          )
        );
  const template = opts.template ?? (await promptBool("Use as template?", false));
  const observability =
    opts.observability ?? (await promptBool("Enable observability?", false));

  outro(c.dim("Submitting…"));
  return { name, location, platforms, template, observability };
}

/**
 * Free-text prompt. When `optional`, an empty answer is allowed and
 * returns "". Aborts on cancel.
 */
async function promptText(
  message: string,
  preset?: string,
  optional = false
): Promise<string> {
  if (preset !== undefined) return preset;
  const answer = await text({
    message,
    placeholder: optional ? "(skip)" : undefined,
  });
  if (isCancel(answer)) die("Aborted.");
  return answer ?? "";
}

async function promptBool(message: string, initial: boolean): Promise<boolean> {
  const answer = await clackConfirm({ message, initialValue: initial });
  if (isCancel(answer)) die("Aborted.");
  return Boolean(answer);
}

// ──────────────────────────── update ────────────────────────────

interface UpdateOpts {
  name?: string;
  project?: string;
  apiHost?: string;
  token?: string;
  json?: boolean;
}

function registerUpdateCommand(projects: Command): void {
  projects
    .command("update [id]")
    .alias("edit")
    .alias("rename")
    .description("rename a project (defaults to $PHOTON_PROJECT_ID)")
    .option("-n, --name <name>", "new name")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (idArg: string | undefined, opts: UpdateOpts) => {
      // The API's PATCH only accepts a new name — spectrum/template/
      // observability are no longer mutable via this route. Require a
      // non-empty --name so a whitespace-only value doesn't silently
      // "succeed" with no change.
      const trimmedName = opts.name?.trim();
      if (!trimmedName) {
        die("--name is required.", {
          hint: "Pass a non-empty name, e.g. `photon projects update --name 'New Name'`.",
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const { error, status, data } = await api.api
        .projects({ id: projectId })
        .patch({ name: trimmedName });
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to update project: ${formatApiError(error)}`);
      const result = data as { success?: true; error?: string };
      if (result.error) die(result.error);

      if (opts.json) {
        printJson({ id: projectId, name: trimmedName });
        return;
      }
      console.log(c.success(`Updated ${c.bold(trimmedName)} ${c.dim(`(${projectId})`)}`));
    });
}

// ──────────────────────────── delete ────────────────────────────

function registerDeleteCommand(projects: Command): void {
  projects
    .command("delete [id]")
    .alias("rm")
    .alias("remove")
    .description("permanently delete a project (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      // Look up the project name so we can show it in the prompt.
      // Distinguish "not found" (404 / null body) from genuine errors
      // (500, network) — otherwise users get a misleading "deleted?"
      // message when the GET actually failed for a different reason.
      const fetched = await api.api.projects({ id: projectId }).get();
      if (fetched.status === 401) throw new SessionExpiredError(resolved.name);
      if (fetched.status === 404 || (!fetched.error && !fetched.data)) {
        die(`Project not found: ${projectId}`, {
          hint: "Already deleted? `photon projects ls` to confirm.",
        });
      }
      if (fetched.error) {
        die(`Failed to look up project: ${formatApiError(fetched.error)}`);
      }
      // The not-found case is handled above; this narrows for TS.
      if (!fetched.data) return;
      const project = fetched.data;

      await confirmDestructive({
        message: `Delete project ${c.bold(project.name)} (${projectId})? This cannot be undone.`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to delete ${project.name}.`,
      });

      const { error, status } = await api.api.projects({ id: projectId }).delete();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to delete project: ${formatApiError(error)}`);

      console.log(c.success(`Deleted ${c.bold(project.name)} ${c.dim(`(${projectId})`)}`));

      // If the active project env var points at the project we just deleted,
      // surface a hint. We can't unset it from a subprocess, so the user has
      // to do it themselves.
      if (process.env.PHOTON_PROJECT_ID === projectId) {
        console.error(
          c.warn(`Active project just deleted. Run \`unset PHOTON_PROJECT_ID\` to clear.`)
        );
      }
    });
}

// ──────────────────────────── regenerate-secret ────────────────────────────

function registerRegenerateSecretCommand(projects: Command): void {
  projects
    .command("regenerate-secret [id]")
    .alias("rotate-secret")
    .description("rotate the project's Spectrum API secret (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("-y, --yes", "skip confirmation")
    .option("--json", "output JSON")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      await confirmDestructive({
        message: `Rotate the API secret for project ${projectId}? Existing integrations using the old secret will stop working immediately.`,
        yes: opts.yes ?? false,
        fallbackHint: `Pass --yes to rotate the secret.`,
      });

      const { data, error, status } = await api.api
        .projects({ id: projectId })
        ["regenerate-secret"].post();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to rotate secret: ${formatApiError(error)}`);
      const result = data as { success?: true; projectSecret?: string; error?: string };
      if (result.error) die(result.error);
      if (!result.projectSecret) die("Server did not return a new secret.");

      if (opts.json) {
        printJson({ id: projectId, projectSecret: result.projectSecret });
        return;
      }

      console.log(c.success(`New secret for ${projectId}:`));
      console.log(`  ${c.bold(result.projectSecret)}`);
      log.warn(
        "This is shown once. Store it somewhere safe — re-rotating is the only way to recover."
      );
    });
}

// ──────────────────────────── open ────────────────────────────

function registerOpenCommand(projects: Command): void {
  projects
    .command("open [id]")
    .description("open the project in the dashboard web UI (defaults to $PHOTON_PROJECT_ID)")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .action(async (idArg, opts) => {
      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: idArg ?? opts.project,
        apiHost: opts.apiHost,
      });
      // Use new URL() rather than concatenation so a custom env URL
      // with a trailing slash doesn't produce `https://x//dashboard/...`.
      const url = new URL(`/dashboard/${projectId}`, resolved.url).toString();
      await openInBrowser(url, { noBrowser: !opts.browser, label: "URL" });
    });
}

// ──────────────────────────── upgrade ────────────────────────────

interface UpgradeOpts {
  plan?: string;
  qty?: number;
  checkout?: boolean;
  manage?: boolean;
  project?: string;
  apiHost?: string;
  token?: string;
  browser?: boolean;
  json?: boolean;
}

/**
 * Upgrade / pay for a project. Mirrors the web's billing page: free
 * projects get the checkout flow (pick a plan → Stripe Checkout), already
 * subscribed projects get the Stripe customer portal (manage / cancel /
 * change plan).
 *
 * Signature follows Heroku `addons:upgrade ADDON [PLAN]` — both id and
 * tier are positional, so the most common form is just
 * `photon projects upgrade my-app pro`.
 */
function registerUpgradeCommand(projects: Command): void {
  projects
    .command("upgrade [id] [tier]")
    .description(
      "subscribe / pay for a project (smart-routes to Stripe checkout or billing portal)"
    )
    .option("--plan <price-id>", "Stripe price id (escape hatch; overrides tier picker)")
    .option("--qty <n>", "quantity (default 1)", parsePositiveInt)
    .option("--checkout", "force checkout flow (even if currently subscribed)")
    .option("--manage", "force Stripe portal (downgrade / cancel / change card)")
    .option("-p, --project <id>", "project id (overrides positional [id] and $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .option("--json", "output JSON ({action,url,tier?}) and skip browser open")
    .action(async (idArg: string | undefined, tierArg: string | undefined, opts: UpgradeOpts) => {
      if (opts.checkout && opts.manage) {
        die("--checkout and --manage are mutually exclusive.");
      }

      // Positional [id] [tier] disambiguation: if only one positional was
      // given and it matches a known tier name, treat it as tier (id then
      // falls back to --project / $PHOTON_PROJECT_ID). This lets users run
      // `photon projects upgrade pro` when PHOTON_PROJECT_ID is set,
      // matching the Heroku-style ergonomics from the plan.
      let positionalId = idArg;
      let tier = normalizeTier(tierArg);
      if (!tier && positionalId && isKnownTier(positionalId) && !tierArg) {
        tier = normalizeTier(positionalId);
        positionalId = undefined;
      }
      if (tierArg && !tier) {
        die(`Unknown tier "${tierArg}".`, {
          hint: `Use one of: ${TIER_NAMES.join(", ")} — or pass --plan <price-id>.`,
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project ?? positionalId,
        apiHost: opts.apiHost,
      });
      const { api } = await getApi({
        apiHost: resolved.url,
        token: opts.token,
        requireAuth: true,
      });

      const noBrowser = resolveBrowserPolicy({
        explicitNoBrowser: opts.browser === false,
        json: opts.json ?? false,
      });

      // Route precedence (most specific wins):
      //   1. --manage explicitly requested portal
      //   2. --checkout / --plan / [tier] explicitly requested checkout
      //   3. smart routing based on current subscription status
      let route: "checkout" | "manage";
      if (opts.manage) {
        route = "manage";
      } else if (opts.checkout || opts.plan || tier) {
        route = "checkout";
      } else {
        const sub = await fetchSubscription(api, projectId, resolved.name);
        // When fetchSubscription couldn't reach the upstream, it returns
        // tier=unknown. Refuse to guess at the route in that case — the
        // user must pick --checkout or --manage explicitly, otherwise we
        // risk creating a duplicate subscription on a project that's
        // actually already paying. This matches fetchSubscription's
        // docstring contract.
        if (sub.tier === "unknown") {
          die(
            `Cannot determine the subscription state of project ${projectId}.`,
            {
              hint: "Re-run with --checkout to subscribe, or --manage to open the Stripe portal.",
            }
          );
        }
        const active = sub.status === "active" || sub.status === "past_due";
        route = active ? "manage" : "checkout";
        if (route === "manage" && !opts.json) {
          console.log(
            c.info(
              `Project ${c.bold(projectId)} is on ${sub.tier ?? "—"} (${sub.status ?? "—"}). Opening Stripe portal…`
            )
          );
          console.log(c.dim("  To pick a different plan instead, re-run with --checkout."));
        }
      }

      if (route === "manage") {
        await openPortalAndOpen({
          api,
          projectId,
          envName: resolved.name,
          json: opts.json ?? false,
          noBrowser,
        });
        return;
      }

      // checkout path: resolve a priceId from --plan > tier > interactive
      let priceId: string;
      let tierLabel: string | undefined;
      if (opts.plan) {
        // --plan is a raw Stripe price id; intentionally don't claim a
        // tier in --json output since the price may not map to one.
        priceId = opts.plan;
      } else if (tier) {
        const plans = await fetchPlans(api, resolved.name);
        const matched = matchPlanTier(plans, tier);
        const onlyPrice = matched?.prices?.length === 1 ? matched.prices[0] : undefined;
        if (!matched || !matched.prices?.length) {
          die(`No plan matching tier "${tier}".`, {
            hint: "List options with `photon billing plans`.",
          });
        }
        if (!onlyPrice) {
          die(`Tier "${tier}" has multiple billing intervals.`, {
            hint: "Pass --plan <price-id> to choose, or omit the tier to use the interactive picker.",
          });
        }
        priceId = onlyPrice.id;
        tierLabel = tier;
      } else {
        const plans = await fetchPlans(api, resolved.name);
        const picked = await pickPlanInteractively(plans);
        priceId = picked.price.id;
        // Normalize the picker's plan name back to a canonical tier
        // when possible, so --json `tier` is stable across paths.
        tierLabel = canonicalTierFor(picked.plan.name);
      }

      await createCheckoutAndOpen({
        api,
        projectId,
        priceId,
        quantity: opts.qty,
        envName: resolved.name,
        json: opts.json ?? false,
        noBrowser,
        tierLabel,
      });
    });
}

function isKnownTier(s: string): boolean {
  return TIER_NAMES.includes(s.trim().toLowerCase() as TierName);
}

function normalizeTier(s: string | undefined): TierName | undefined {
  if (!s) return undefined;
  const lower = s.trim().toLowerCase();
  return (TIER_NAMES as readonly string[]).includes(lower)
    ? (lower as TierName)
    : undefined;
}

// ──────────────────────────── check-phone ────────────────────────────

function registerCheckPhoneCommand(projects: Command): void {
  projects
    .command("check-phone <number>")
    .description("check whether a phone number is available on Spectrum")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (number, opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });
      const { data, error, status } = await api.api.projects[
        "check-availability"
      ].get({
        query: { phoneNumber: number },
      });
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) die(`Failed to check phone availability: ${formatApiError(error)}`);

      if (opts.json) {
        printJson(data);
        return;
      }
      const result = data as { available?: boolean };
      if (result.available) {
        console.log(c.success(`${number} is available.`));
      } else {
        console.log(c.warn(`${number} is taken.`));
      }
    });
}

// ──────────────────────────── helpers ────────────────────────────

function formatStatus(s: string): string {
  switch (s) {
    case "running":
      return c.green(s);
    case "paused":
      return c.yellow(s);
    case "error":
      return c.red(s);
    default:
      return s;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function printKv(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    console.log(`  ${c.dim(k.padEnd(width))}  ${v}`);
  }
}

interface ProjectListItem {
  id: string;
  name: string;
  location: string;
  status: string;
  platforms: string[];
  updatedAt: string | Date;
}
