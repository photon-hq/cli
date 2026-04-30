import type { Command } from "@commander-js/extra-typings";
import { getApi } from "~/lib/api.ts";
import { resolveProject } from "~/lib/api-context.ts";
import { openInBrowser } from "~/lib/browser.ts";
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
    .description("show the project's current subscription (defaults to linked)")
    .option("-p, --project <id>", "project id (overrides linked)")
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

function registerCheckout(billing: Command): void {
  billing
    .command("checkout")
    .description("start a subscription checkout (opens Stripe in browser)")
    .option("--plan <price-id>", "Stripe price id from `photon billing plans`")
    .option("--qty <n>", "quantity", parsePositiveInt)
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .option("--json", "output JSON ({url}) and skip browser open")
    .action(async (opts) => {
      if (!opts.plan) {
        die("--plan <price-id> is required.", {
          hint: "List options: `photon billing plans`. Pass the `price id` column.",
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

      const { data, error, status } = await api.api.billing.checkout.post({
        projectId,
        priceId: opts.plan,
        quantity: opts.qty,
      });
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to start checkout: ${formatApiError(error)}`);
      const result = data as { success?: true; url?: string; error?: string };
      if (result.error) die(result.error);
      if (!result.url) die("Server did not return a checkout URL.");

      // --json: scriptable mode — emit only the URL and skip the
      // browser launch so callers can pipe the URL elsewhere.
      if (opts.json) return printJson({ url: result.url });

      const outcome = await openInBrowser(result.url, {
        noBrowser: !opts.browser,
        label: "Stripe checkout",
      });
      if (outcome === "failed") {
        console.log(c.warn("Could not open browser automatically — copy the URL above."));
      }
    });
}

/**
 * commander argParser for `--qty`. Validates the input is a positive
 * integer; throws InvalidArgumentError on bad input so commander
 * shows a clean parse error instead of NaN reaching the API.
 */
function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new (require("commander").InvalidArgumentError as new (msg: string) => Error)(
      `must be a non-negative integer (got "${value}")`
    );
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new (require("commander").InvalidArgumentError as new (msg: string) => Error)(
      `must be at least 1 (got "${value}")`
    );
  }
  return parsed;
}

// ──────────────────────────── manage ────────────────────────────

function registerManage(billing: Command): void {
  billing
    .command("manage")
    .alias("portal")
    .description("open the Stripe customer portal for this project")
    .option("-p, --project <id>", "project id (overrides linked)")
    .option("--api-host <url>", "API host URL (defaults to PHOTON_API_HOST or built-in production)")
    .option("-t, --token <token>", "API token (overrides stored creds)")
    .option("--no-browser", "print the URL instead of launching a browser")
    .option("--json", "output JSON ({url}) and skip browser open")
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
        .subscription.manage.post();
      if (status === 401) throw new SessionExpiredError(resolved.name);
      if (error) die(`Failed to open portal: ${formatApiError(error)}`);
      const result = data as { success?: true; url?: string; error?: string };
      if (result.error) die(result.error);
      if (!result.url) die("Server did not return a portal URL.");

      if (opts.json) return printJson({ url: result.url });

      const outcome = await openInBrowser(result.url, {
        noBrowser: !opts.browser,
        label: "Stripe portal",
      });
      if (outcome === "failed") {
        console.log(c.warn("Could not open browser automatically — copy the URL above."));
      }
    });
}

// ──────────────────────────── helpers ────────────────────────────

interface BillingPrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval?: string } | null;
}

interface BillingPlan {
  id: string;
  name: string;
  description?: string;
  prices?: BillingPrice[];
}

interface Subscription {
  tier?: string;
  status?: string | null;
  subscriptionId?: string;
}

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
