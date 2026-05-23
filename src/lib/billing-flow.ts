/**
 * Shared billing primitives used by `projects upgrade` and `billing checkout`.
 *
 * Why this lives here and not duplicated per-command: both flows hit
 * `/api/billing/plans`, `/api/billing/checkout`, and
 * `/api/projects/:id/subscription{,/manage}`, share the same "smart routing"
 * logic, and need consistent TTY / `--no-browser` / `--json` semantics. Keep
 * the wire-shape DTOs and the API-edge casts in one place so drift surfaces
 * once, not twice.
 */
import { select, isCancel } from "@clack/prompts";
import type { ApiContext } from "~/lib/api.ts";
import { openInBrowser } from "~/lib/browser.ts";
import { SessionExpiredError } from "~/lib/errors.ts";
import { c, die, formatApiError, printJson } from "~/lib/output.ts";
import { isInteractive } from "~/lib/tty.ts";

// ──────────────────────────── DTOs ────────────────────────────

export interface BillingPrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval?: string } | null;
}

export interface BillingPlan {
  id: string;
  name: string;
  description?: string;
  prices?: BillingPrice[];
}

export interface Subscription {
  tier?: string;
  status?: string | null;
  subscriptionId?: string;
}

/** "pro" | "business" | "enterprise" — the user-facing tier names. */
export type TierName = "pro" | "business" | "enterprise";

export const TIER_NAMES: readonly TierName[] = ["pro", "business", "enterprise"];

/** Action returned by the flow helpers so callers can render `--json`. */
export type FlowAction = "checkout" | "manage";

export interface FlowResult {
  action: FlowAction;
  url: string;
  tier?: string;
}

// ──────────────────────────── API calls ────────────────────────────

type Api = ApiContext["api"];

/**
 * Fetch the list of subscription plans. Throws SessionExpiredError on 401
 * and `die()`s on other errors so callers don't have to re-handle.
 */
export async function fetchPlans(api: Api, envName: string): Promise<BillingPlan[]> {
  const { data, error, status } = await api.api.billing.plans.get();
  if (status === 401) throw new SessionExpiredError(envName);
  if (error) die(`Failed to list plans: ${formatApiError(error)}`);
  return (data ?? []) as BillingPlan[];
}

/**
 * Fetch the subscription for a project. Behavior by status:
 *   - 401            → throws SessionExpiredError (caller catches centrally)
 *   - 5xx / network  → returns `{ tier: "unknown", status: null }` + printed warn,
 *                      so smart routers can refuse to guess instead of silently
 *                      coercing to "free" and risking a duplicate Stripe sub
 *   - other 4xx      → die() with the API error verbatim; "project not found"
 *                      or a validation failure shouldn't be disguised as a
 *                      flaky-upstream "unknown" state
 *
 * Background: the server-side `GET /subscription` proxies Spectrum, which
 * can be flaky independently of the project's actual state.
 */
export async function fetchSubscription(
  api: Api,
  projectId: string,
  envName: string
): Promise<Subscription> {
  const { data, error, status } = await api.api.projects({ id: projectId }).subscription.get();
  if (status === 401) throw new SessionExpiredError(envName);
  if (error) {
    // 5xx and missing-status (network) failures are the "we couldn't
    // tell" case — fall back to unknown. Other 4xx errors are definite
    // and should surface verbatim so the user can act on them.
    const code = typeof status === "number" ? status : 0;
    const isUpstreamFlake = code === 0 || code >= 500;
    if (!isUpstreamFlake) {
      die(`Failed to fetch subscription: ${formatApiError(error)}`);
    }
    console.error(
      c.warn(
        `Could not read subscription for project ${projectId}: ${formatApiError(error)}. Subscription state unknown.`
      )
    );
    return { tier: "unknown", status: null };
  }
  return (data ?? {}) as Subscription;
}

// ──────────────────────────── plan selection ────────────────────────────

/**
 * Match a tier name against the plan list. Mirrors the web's substring
 * search (`apps/web/.../plan-features.ts#matchPlanTier`) so "Pro" /
 * "Photon Pro" / "Pro Plus" all map to the `pro` tier.
 *
 * Returns the first matching plan with at least one price.
 */
export function matchPlanTier(plans: BillingPlan[], tier: TierName): BillingPlan | null {
  const needle = tier.toLowerCase();
  for (const plan of plans) {
    const name = plan.name.toLowerCase();
    if (!name.includes(needle)) continue;
    if (!plan.prices?.length) continue;
    return plan;
  }
  return null;
}

/**
 * Inverse of matchPlanTier: map a plan's display name (e.g. "Photon
 * Pro") back to one of the canonical TIER_NAMES we expose to users.
 * Returns undefined when no tier substring matches — used so the
 * `--json tier` field stays stable across positional and interactive
 * code paths, omitting itself rather than emitting a display name.
 */
export function canonicalTierFor(planName: string): TierName | undefined {
  const lower = planName.toLowerCase();
  for (const t of TIER_NAMES) {
    if (lower.includes(t)) return t;
  }
  return undefined;
}

/**
 * Interactive plan picker. Uses @clack/prompts `select` to render the
 * plan list and return the chosen `{ plan, price }`.
 *
 * Non-TTY callers must check `isInteractive()` themselves — we still
 * guard here as a belt-and-braces measure and `die()` with a helpful
 * hint that lists the script-friendly alternatives.
 */
export async function pickPlanInteractively(
  plans: BillingPlan[]
): Promise<{ plan: BillingPlan; price: BillingPrice }> {
  if (!isInteractive()) {
    die("Cannot prompt for a plan in non-interactive mode.", {
      hint: "Pass a tier (pro / business / enterprise) or --plan <price-id>.",
    });
  }

  const selectable = plans.filter((p) => p.prices && p.prices.length > 0);
  if (selectable.length === 0) {
    die("No subscription plans available.", {
      hint: "Contact support if you expected plans to be listed.",
    });
  }

  // Build flat options: one entry per (plan, price) so users see e.g.
  // "Pro — 29 USD / month" and "Pro — 290 USD / year" as distinct picks.
  type Choice = { plan: BillingPlan; price: BillingPrice };
  const options: { value: Choice; label: string; hint?: string }[] = [];
  for (const plan of selectable) {
    for (const price of plan.prices ?? []) {
      options.push({
        value: { plan, price },
        label: `${plan.name} — ${formatPriceShort(price)}`,
        hint: plan.description,
      });
    }
  }

  const answer = await select<Choice>({
    message: "Pick a plan",
    options,
  });
  if (isCancel(answer)) {
    die("Aborted.");
  }
  return answer;
}

// ──────────────────────────── browser policy ────────────────────────────

export interface BrowserPolicyInput {
  /** True when the user passed `--no-browser`. */
  explicitNoBrowser: boolean;
  /** True when the command is in `--json` mode (machine-readable output). */
  json: boolean;
}

/**
 * Decide whether to skip the browser open. We skip when:
 *   - `--json` was passed (script-mode — caller is parsing stdout)
 *   - `--no-browser` was passed (explicit user opt-out)
 *   - the shell isn't interactive — `isInteractive()` returns false
 *     when stdout OR stdin isn't a TTY, or when a CI env var is set
 *     (some CI runners fake a TTY on stdout)
 *
 * The non-interactive check is inspired by Vercel CLI's `vc buy pro
 * --yes | cat` behavior — don't surprise users by launching their
 * browser inside pipes, CI runs, or headless contexts.
 */
export function resolveBrowserPolicy({ explicitNoBrowser, json }: BrowserPolicyInput): boolean {
  if (json || explicitNoBrowser) return true;
  return !isInteractive();
}

// ──────────────────────────── checkout / portal ────────────────────────────

export interface CheckoutOptions {
  api: Api;
  projectId: string;
  priceId: string;
  quantity?: number;
  json: boolean;
  noBrowser: boolean;
  envName: string;
  /** Optional human-readable tier name to include in `--json` output. */
  tierLabel?: string;
}

/**
 * Create a Stripe checkout session and open it in the browser. Returns
 * the FlowResult so the caller can echo `--json` cleanly.
 */
export async function createCheckoutAndOpen(opts: CheckoutOptions): Promise<FlowResult> {
  const { data, error, status } = await opts.api.api.billing.checkout.post({
    projectId: opts.projectId,
    priceId: opts.priceId,
    quantity: opts.quantity,
  });
  if (status === 401) throw new SessionExpiredError(opts.envName);
  if (error) die(`Failed to start checkout: ${formatApiError(error)}`);

  const result = data as { success?: true; url?: string; error?: string };
  if (result.error) die(result.error);
  if (!result.url) die("Server did not return a checkout URL.");

  const flow: FlowResult = {
    action: "checkout",
    url: result.url,
    ...(opts.tierLabel ? { tier: opts.tierLabel } : {}),
  };

  if (opts.json) {
    printJson(flow);
    return flow;
  }

  const outcome = await openInBrowser(flow.url, {
    noBrowser: opts.noBrowser,
    label: "Stripe checkout",
  });
  if (outcome === "failed") {
    console.log(c.warn("Could not open browser automatically — copy the URL above."));
  }
  return flow;
}

export interface PortalOptions {
  api: Api;
  projectId: string;
  json: boolean;
  noBrowser: boolean;
  envName: string;
}

/**
 * Create a Stripe billing-portal session and open it in the browser.
 * Same return shape as createCheckoutAndOpen so the caller can render
 * `--json` consistently.
 */
export async function openPortalAndOpen(opts: PortalOptions): Promise<FlowResult> {
  const { data, error, status } = await opts.api.api
    .projects({ id: opts.projectId })
    .subscription.manage.post();
  if (status === 401) throw new SessionExpiredError(opts.envName);
  if (error) die(`Failed to open portal: ${formatApiError(error)}`);

  const result = data as { success?: true; url?: string; error?: string };
  if (result.error) die(result.error);
  if (!result.url) die("Server did not return a portal URL.");

  const flow: FlowResult = { action: "manage", url: result.url };

  if (opts.json) {
    printJson(flow);
    return flow;
  }

  const outcome = await openInBrowser(flow.url, {
    noBrowser: opts.noBrowser,
    label: "Stripe portal",
  });
  if (outcome === "failed") {
    console.log(c.warn("Could not open browser automatically — copy the URL above."));
  }
  return flow;
}

// ──────────────────────────── formatting ────────────────────────────

/**
 * Compact price formatter for use in the plan picker dropdown — uses
 * Intl.NumberFormat so JPY (zero-decimal) and USD (2-decimal) both
 * render correctly.
 */
function formatPriceShort(price: BillingPrice): string {
  if (price.unit_amount == null) return "—";
  const currency = price.currency.toUpperCase();
  let fractionDigits = 2;
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    fractionDigits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Unknown currency — fall back to 2 decimals.
  }
  const divisor = 10 ** fractionDigits;
  const amount = (price.unit_amount / divisor).toFixed(fractionDigits);
  const interval = price.recurring?.interval;
  return interval ? `${amount} ${currency} / ${interval}` : `${amount} ${currency}`;
}
