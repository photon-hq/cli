/**
 * Minimal Elysia mock server that mirrors the PublicApp routes consumed
 * by the CLI. Listens on a kernel-assigned port on 127.0.0.1 so tests
 * never hit the network.
 *
 * Mutable state (per-test): subscription tier and Stripe URLs are stored
 * on a single `state` object so individual tests can flip the project
 * between free / active without restarting the server.
 */
import { Elysia } from "elysia";
import healthFixture from "../fixtures/health.json";
import projectsFixture from "../fixtures/projects.list.json";
import projectFixture from "../fixtures/project.show.json";
import plansFixture from "../fixtures/billing.plans.json";
import whoamiFixture from "../fixtures/whoami.json";
import subscriptionFree from "../fixtures/subscription.free.json";
import subscriptionActive from "../fixtures/subscription.active.json";
import checkoutResponse from "../fixtures/billing.checkout.json";
import manageResponse from "../fixtures/subscription.manage.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any = null;

// Mutable, per-test state. Reset via resetMockState() between tests.
interface MockState {
  subscription: typeof subscriptionFree | typeof subscriptionActive;
  /** When set, all subscription/manage and billing/checkout responses
   *  short-circuit to a 401 to exercise SessionExpiredError handling. */
  forceUnauthorized: boolean;
}

const state: MockState = {
  subscription: subscriptionFree,
  forceUnauthorized: false,
};

export function setMockSubscription(sub: "free" | "active"): void {
  state.subscription = sub === "active" ? subscriptionActive : subscriptionFree;
}

export function setMockUnauthorized(force: boolean): void {
  state.forceUnauthorized = force;
}

export function resetMockState(): void {
  state.subscription = subscriptionFree;
  state.forceUnauthorized = false;
}

function requireAuth(headers: Record<string, string | undefined>) {
  const auth = headers.authorization ?? headers.Authorization;
  if (!auth || !auth.startsWith("Bearer ") || state.forceUnauthorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

const app = new Elysia()
  // Health — no auth required
  .get("/api/health", () => healthFixture)

  // Projects — auth required
  .get("/api/projects", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return projectsFixture;
  })
  .get("/api/projects/check-availability", ({ headers, query }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return { available: true };
  })
  .get("/api/projects/:id", ({ headers, params }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    const found = projectsFixture.find((p) => p.id === params.id);
    if (found) return found;
    return projectFixture;
  })
  .post("/api/projects", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return { success: true, id: projectFixture.id };
  })
  .get("/api/projects/:id/subscription", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return state.subscription;
  })
  .post("/api/projects/:id/subscription/manage", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return manageResponse;
  })

  // Billing — auth required
  .get("/api/billing/plans", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return plansFixture;
  })
  .post("/api/billing/checkout", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return checkoutResponse;
  })

  // Profile (used by whoami) — auth required
  .get("/api/profile", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return whoamiFixture;
  });

export async function startMockServer(): Promise<string> {
  server = app.listen({ hostname: "127.0.0.1", port: 0 });
  const { hostname, port } = server!.server!;
  return `http://${hostname}:${port}`;
}

export async function stopMockServer(): Promise<void> {
  if (server) {
    server.stop();
    server = null;
  }
}
