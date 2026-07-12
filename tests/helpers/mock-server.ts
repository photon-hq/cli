/**
 * Minimal Elysia mock server that mirrors the PublicApp routes consumed
 * by the CLI. Listens on a kernel-assigned port on 127.0.0.1 so tests
 * never hit the network.
 *
 * Mutable state (per-test): a single `state` object holds the current
 * subscription fixture and the `forceUnauthorized` 401 toggle, so
 * individual tests can flip behavior without restarting the server.
 * The Stripe URL fixtures (`checkoutResponse`, `manageResponse`) are
 * static — if a test ever needs to vary those, lift them into `state`.
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
  /** When set, EVERY auth-gated route in this mock server returns 401,
   *  regardless of the request's Authorization header. Use this to
   *  exercise SessionExpiredError flows without having to manipulate
   *  the test's PHOTON_TOKEN. */
  forceUnauthorized: boolean;
  profileSyncSequence: MockProfileSyncAggregate[];
  profileSyncSequenceIndex: number;
  profileSyncRequests: MockProfileSyncRequest[];
}

export type MockProfileSyncStatus =
  | "in_progress"
  | "completed"
  | "partial_failed"
  | "failed";

export interface MockProfileSyncAggregate {
  projectId: string;
  status: MockProfileSyncStatus;
  total: number;
  pending: number;
  synced: number;
  failed: number;
  errors: Array<{
    lineId: string;
    reason: string;
  }>;
}

export interface MockProfileSyncRequest {
  method: "GET" | "POST";
  projectId: string;
  authorization: string | null;
}

const DEFAULT_PROFILE_SYNC_PROJECT_ID =
  "00000000-0000-4000-a000-000000000001";

export function makeMockProfileSyncAggregate(
  overrides: Partial<MockProfileSyncAggregate> = {}
): MockProfileSyncAggregate {
  return {
    projectId: DEFAULT_PROFILE_SYNC_PROJECT_ID,
    status: "in_progress",
    total: 3,
    pending: 2,
    synced: 1,
    failed: 0,
    errors: [],
    ...overrides,
  };
}

function defaultProfileSyncSequence(): MockProfileSyncAggregate[] {
  return [
    makeMockProfileSyncAggregate(),
    makeMockProfileSyncAggregate({
      status: "completed",
      pending: 0,
      synced: 3,
    }),
  ];
}

const state: MockState = {
  subscription: subscriptionFree,
  forceUnauthorized: false,
  profileSyncSequence: defaultProfileSyncSequence(),
  profileSyncSequenceIndex: 0,
  profileSyncRequests: [],
};

export function setMockSubscription(sub: "free" | "active"): void {
  state.subscription = sub === "active" ? subscriptionActive : subscriptionFree;
}

export function setMockUnauthorized(force: boolean): void {
  state.forceUnauthorized = force;
}

/**
 * Configure the trigger response followed by successive status responses.
 * Once exhausted, the mock keeps returning the final aggregate so polling is
 * deterministic even if a client performs one extra GET.
 */
export function setMockProfileSyncSequence(
  sequence: MockProfileSyncAggregate[]
): void {
  if (sequence.length === 0) {
    throw new Error("Profile sync sequence must contain at least one response.");
  }
  state.profileSyncSequence = sequence.map((aggregate) => ({
    ...aggregate,
    errors: aggregate.errors.map((error) => ({ ...error })),
  }));
  state.profileSyncSequenceIndex = 0;
}

export function getMockProfileSyncRequests(): MockProfileSyncRequest[] {
  return state.profileSyncRequests.map((request) => ({ ...request }));
}

export function resetMockState(): void {
  state.subscription = subscriptionFree;
  state.forceUnauthorized = false;
  state.profileSyncSequence = defaultProfileSyncSequence();
  state.profileSyncSequenceIndex = 0;
  state.profileSyncRequests = [];
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

function profileSyncResponse(method: "GET" | "POST"): Response {
  const index = Math.min(
    state.profileSyncSequenceIndex,
    state.profileSyncSequence.length - 1
  );
  const aggregate = state.profileSyncSequence[index]!;
  state.profileSyncSequenceIndex += 1;
  return Response.json(
    { succeed: true, data: aggregate },
    { status: method === "POST" ? 202 : 200 }
  );
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
  .post("/api/projects/:id/spectrum/profile/sync", ({ headers, params }) => {
    state.profileSyncRequests.push({
      method: "POST",
      projectId: params.id,
      authorization: headers.authorization ?? null,
    });
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return profileSyncResponse("POST");
  })
  .get("/api/projects/:id/spectrum/profile/sync", ({ headers, params }) => {
    state.profileSyncRequests.push({
      method: "GET",
      projectId: params.id,
      authorization: headers.authorization ?? null,
    });
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return profileSyncResponse("GET");
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
  // Refuse to clobber an existing handle — a forgotten stopMockServer()
  // would otherwise leak the prior listener AND leave resetMockState()
  // racing against in-flight requests on the dangling instance.
  if (server) {
    throw new Error(
      "Mock server already started; call stopMockServer() before starting a new one."
    );
  }
  // Reset on every start so test suites that don't explicitly call
  // resetMockState() in beforeEach can't accidentally inherit state
  // mutated by a prior suite. Defensive — the per-test reset is still
  // the recommended pattern.
  resetMockState();
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
