import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import {
  createCheckoutAndOpen,
  fetchPlans,
  matchPlanTier,
  openPortalAndOpen,
  pickPlanInteractively,
  resolveBrowserPolicy,
  TIER_NAMES,
  type BillingPlan,
  type BillingPrice,
  type Subscription,
  type TierName,
} from "~/lib/billing-flow.ts";
import { parsePositiveInt } from "~/lib/commander.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson, printTable } from "~/lib/output.ts";

export function registerBillingCommands(program: Command): void {
  const billing = program
    .command("billing")
    .description("view + manage your project's subscription");

  registerPlans(billing);
  registerShow(billing);
  registerCheckout(billing);
  registerManage(billing);
}

// ──────────────────────────── plans ────────────────────────────

function registerPlans(billing: Command): void {
  billing
    .command("plans")
    .description("list available subscription plans")
    .option(
      "-p, --project <id>",
      "project id (accepted for parity with other billing commands; not used)"
    )
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const { api, env } = await getApi({
        apiHost: opts.apiHost,
        token: opts.token,
        requireAuth: true,
      });

      const { data, error, status } = await api.api.billing.plans.get();
      if (status === 401) throw new SessionExpiredError(env.name);
      if (error) die(`Failed to list plans: ${formatApiError(error)}`);

      const plans = (data ?? []) as BillingPlan[];
      if (opts.json) return printJson(plans);
      if (plans.length === 0) {
        console.log(c.dim("No plans available."));
        return;
      }

      const rows = plans.flatMap((plan) =>
        (plan.prices ?? [{ id: "—", unit_amount: null, currency: "—", recurring: null }]).map(
          (price) => [
            plan.name,
            price.id,
            formatPrice(price),
            price.recurring?.interval ?? c.dim("—"),
          ]
        )
      );
      printTable(["plan", "price id", "price", "interval"], rows);
    });
}

// ──────────────────────────── show ────────────────────────────

function registerShow(billing: Command): void {
  billing
    .command("show")
    .description("show the project's current subscription (defaults to $PHOTON_PROJECT_ID)")
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
        .subscription.get();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to fetch subscription: ${formatApiError(error)}`);

      if (opts.json) return printJson(data ?? {});

      const sub = (data ?? {}) as Subscription;
      console.log(c.bold("Subscription"));
      console.log(`  ${c.dim("tier".padEnd(8))}  ${formatTier(sub.tier)}`);
      console.log(`  ${c.dim("status".padEnd(8))}  ${formatStatus(sub.status ?? null)}`);
      if (sub.subscriptionId) {
        console.log(`  ${c.dim("id".padEnd(8))}  ${sub.subscriptionId}`);
      }
      if (sub.tier === "unknown") {
        console.log();
        console.log(
          c.warn(
            'Server returned tier "unknown". This is a known issue (architecture-review S3) — the subscription may still be active.'
          )
        );
      }
    });
}

// ──────────────────────────── checkout ────────────────────────────

interface CheckoutOpts {
  plan?: string;
  qty?: number;
  project?: string;
  apiHost?: string;
  token?: string;
  browser?: boolean;
  json?: boolean;
}

function registerCheckout(billing: Command): void {
  billing
    .command("checkout [tier]")
    .description(
      "start a subscription checkout (interactive picker when no tier / --plan)"
    )
    .option("--plan <price-id>", "Stripe price id (escape hatch; overrides tier picker)")
    .option("--qty <n>", "quantity", parsePositiveInt)
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .option("--json", "output JSON ({action,url,tier?}) and skip browser open")
    .action(async (tierArg: string | undefined, opts: CheckoutOpts) => {
      const tier = normalizeTier(tierArg);
      if (tierArg && !tier) {
        die(`Unknown tier "${tierArg}".`, {
          hint: `Use one of: ${TIER_NAMES.join(", ")} — or pass --plan <price-id>.`,
        });
      }

      const { projectId, env: resolved } = await resolveProject({
        flagProjectId: opts.project,
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

      let priceId: string;
      let tierLabel: string | undefined;
      if (opts.plan) {
        // --plan is a raw Stripe price id; intentionally don't emit a
        // tier in --json output because the price may not correspond to
        // any of our advertised tiers.
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
        // Multi-price tiers (typical for monthly + yearly) are
        // ambiguous from a single positional. Fail fast rather than
        // silently pick whichever price the backend returned first —
        // wrong-frequency checkouts are hard to recover from.
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
        // when possible (e.g. "Photon Pro" → "pro"), so the --json
        // `tier` field is stable across CLI paths. If no tier matches
        // (e.g. enterprise's "Contact Team"), leave tier unset.
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

function normalizeTier(s: string | undefined): TierName | undefined {
  if (!s) return undefined;
  const lower = s.trim().toLowerCase();
  return (TIER_NAMES as readonly string[]).includes(lower)
    ? (lower as TierName)
    : undefined;
}

/**
 * Map a plan display name (from the API) back to the canonical tier
 * name we expose to users. Substring match mirrors the web's tier
 * detection (apps/web/.../plan-features.ts#matchPlanTier).
 */
function canonicalTierFor(planName: string): TierName | undefined {
  const lower = planName.toLowerCase();
  for (const t of TIER_NAMES) {
    if (lower.includes(t)) return t;
  }
  return undefined;
}

// ──────────────────────────── manage ────────────────────────────

function registerManage(billing: Command): void {
  billing
    .command("manage")
    .alias("portal")
    .description("open the Stripe customer portal for this project")
    .option("-p, --project <id>", "project id (overrides $PHOTON_PROJECT_ID)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .option("--json", "output JSON ({action,url}) and skip browser open")
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

      const noBrowser = resolveBrowserPolicy({
        explicitNoBrowser: opts.browser === false,
        json: opts.json ?? false,
      });

      await openPortalAndOpen({
        api,
        projectId,
        envName: resolved.name,
        json: opts.json ?? false,
        noBrowser,
      });
    });
}

// ──────────────────────────── helpers ────────────────────────────

function formatPrice(price: BillingPrice): string {
  if (price.unit_amount == null) return c.dim("—");
  // Stripe amounts are in the smallest currency unit. Derive the
  // correct minor-unit precision from the currency code so zero-decimal
  // currencies (JPY, KRW, VND, etc.) are formatted with no fractional
  // digits, while normal 2-decimal currencies (USD, EUR, ...) get .XX.
  const currency = price.currency.toUpperCase();
  let fractionDigits = 2;
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    fractionDigits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Unknown currency code — fall back to 2 decimals.
  }
  const divisor = 10 ** fractionDigits;
  const value = (price.unit_amount / divisor).toFixed(fractionDigits);
  return `${value} ${currency}`;
}

function formatTier(tier: string | undefined): string {
  if (!tier) return c.dim("—");
  if (tier === "free") return c.dim(tier);
  if (tier === "unknown") return c.yellow(tier);
  return c.green(tier);
}

function formatStatus(status: string | null): string {
  if (!status) return c.dim("—");
  switch (status) {
    case "active":
      return c.green(status);
    case "past_due":
    case "unpaid":
      return c.red(status);
    case "trialing":
      return c.cyan(status);
    case "canceled":
      return c.dim(status);
    default:
      return status;
  }
}
