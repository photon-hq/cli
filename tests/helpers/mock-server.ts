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
import linesFixture from "../fixtures/lines.list.json";
import usersFixture from "../fixtures/spectrum.users.list.json";
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
  /** Endpoints flagged here return a payload outside the published contract. */
  wrongShape: Set<WrongShapeEndpoint>;
  invalidShape: Set<WrongShapeEndpoint>;
  lineAvatarResponseFault: "missing-avatar-url" | "missing-upload-key" | null;
  lineProfileRequests: MockLineProfileRequest[];
  profileSyncRequests: MockProfileSyncRequest[];
}

export interface MockLineProfileRequest {
  body?: unknown;
  contentType?: string | null;
  lineId: string;
  method: "PATCH" | "POST" | "PUT";
  operation: "profile" | "avatar-upload" | "avatar-put" | "avatar-commit";
  projectId: string;
}

export interface MockProfileSyncRequest {
  method: "POST";
  projectId: string;
  authorization: string | null;
}

export type WrongShapeEndpoint =
  | "projects"
  | "lines"
  | "users"
  | "platforms";

const state: MockState = {
  subscription: subscriptionFree,
  forceUnauthorized: false,
  wrongShape: new Set(),
  invalidShape: new Set(),
  lineAvatarResponseFault: null,
  lineProfileRequests: [],
  profileSyncRequests: [],
};

export function setMockSubscription(sub: "free" | "active"): void {
  state.subscription = sub === "active" ? subscriptionActive : subscriptionFree;
}

export function setMockUnauthorized(force: boolean): void {
  state.forceUnauthorized = force;
}

export function setMockWrongShape(endpoint: WrongShapeEndpoint): void {
  state.wrongShape.add(endpoint);
}

export function setMockInvalidShape(endpoint: WrongShapeEndpoint): void {
  state.invalidShape.add(endpoint);
}

export function setMockLineAvatarResponseFault(
  fault: MockState["lineAvatarResponseFault"]
): void {
  state.lineAvatarResponseFault = fault;
}

export function getMockProfileSyncRequests(): MockProfileSyncRequest[] {
  return state.profileSyncRequests.map((request) => ({ ...request }));
}

export function getMockLineProfileRequests(): MockLineProfileRequest[] {
  return state.lineProfileRequests.map((request) => ({ ...request }));
}

export function resetMockState(): void {
  state.subscription = subscriptionFree;
  state.forceUnauthorized = false;
  state.wrongShape.clear();
  state.invalidShape.clear();
  state.lineAvatarResponseFault = null;
  state.lineProfileRequests = [];
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

function profileSyncResponse(projectId: string): Response {
  return Response.json({
    succeed: true,
    data: { projectId, targetedLineCount: 3 },
  });
}

const app = new Elysia()
  // Health — no auth required
  .get("/api/health", () => healthFixture)

  // Projects — auth required
  .get("/api/projects", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    if (state.invalidShape.has("projects")) {
      return { items: projectsFixture };
    }
    if (state.wrongShape.has("projects")) {
      return { projects: projectsFixture };
    }
    return projectsFixture;
  })
  .get("/api/projects/:id/lines", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    if (state.invalidShape.has("lines")) {
      return { items: linesFixture.lines };
    }
    if (state.wrongShape.has("lines")) {
      return linesFixture.lines;
    }
    return linesFixture;
  })
  .get("/api/projects/:id/platforms", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    if (state.invalidShape.has("platforms")) {
      return { imessage: "yes" };
    }
    if (state.wrongShape.has("platforms")) {
      return [{ platform: "imessage", enabled: true }];
    }
    return { imessage: true, whatsapp_business: false };
  })
  .get("/api/projects/:id/spectrum/users", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    if (state.invalidShape.has("users")) {
      return { items: usersFixture.users };
    }
    if (state.wrongShape.has("users")) {
      return usersFixture.users;
    }
    return usersFixture;
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
    return profileSyncResponse(params.id);
  })
  .patch(
    "/api/projects/:id/lines/:lineId/profile",
    ({ body, headers, params }) => {
      state.lineProfileRequests.push({
        operation: "profile",
        method: "PATCH",
        projectId: params.id,
        lineId: params.lineId,
        body,
      });
      const denied = requireAuth(headers as Record<string, string | undefined>);
      if (denied) return denied;
      const patch = body as { firstName?: string; lastName?: string };
      return {
        succeed: true as const,
        data: {
          projectId: params.id,
          lineId: params.lineId,
          phoneNumber: "+14155550101",
          firstName: patch.firstName ?? "Existing",
          lastName: patch.lastName ?? "Line",
          avatarUrl: null,
        },
      };
    }
  )
  .post(
    "/api/projects/:id/lines/:lineId/profile/avatar/upload",
    ({ body, headers, params, request }) => {
      state.lineProfileRequests.push({
        operation: "avatar-upload",
        method: "POST",
        projectId: params.id,
        lineId: params.lineId,
        body,
      });
      const denied = requireAuth(headers as Record<string, string | undefined>);
      if (denied) return denied;
      const origin = new URL(request.url).origin;
      return {
        succeed: true as const,
        data:
          state.lineAvatarResponseFault === "missing-upload-key"
            ? { uploadUrl: `${origin}/unused` }
            : {
                projectId: params.id,
                lineId: params.lineId,
                uploadUrl: `${origin}/mock-line-avatar/${params.id}/${params.lineId}`,
                key: `avatars/${params.id}/lines/${params.lineId}/avatar.png`,
              },
      };
    }
  )
  .put("/mock-line-avatar/:id/:lineId", ({ headers, params }) => {
    state.lineProfileRequests.push({
      operation: "avatar-put",
      method: "PUT",
      projectId: params.id,
      lineId: params.lineId,
      contentType: headers["content-type"] ?? null,
    });
    return new Response(null, { status: 200 });
  })
  .post(
    "/api/projects/:id/lines/:lineId/profile/avatar/commit",
    ({ body, headers, params }) => {
      state.lineProfileRequests.push({
        operation: "avatar-commit",
        method: "POST",
        projectId: params.id,
        lineId: params.lineId,
        body,
      });
      const denied = requireAuth(headers as Record<string, string | undefined>);
      if (denied) return denied;
      return {
        succeed: true as const,
        data: {
          projectId: params.id,
          lineId: params.lineId,
          phoneNumber: "+14155550101",
          firstName: "Existing",
          lastName: "Line",
          avatarUrl:
            state.lineAvatarResponseFault === "missing-avatar-url"
              ? null
              : `https://cdn.example.test/${params.lineId}.png`,
        },
      };
    }
  )
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
