/**
 * Minimal Elysia mock server that mirrors the PublicApp routes consumed
 * by the CLI. Listens on a kernel-assigned port on 127.0.0.1 so tests
 * never hit the network.
 */
import { Elysia } from "elysia";
import healthFixture from "../fixtures/health.json";
import projectsFixture from "../fixtures/projects.list.json";
import projectFixture from "../fixtures/project.show.json";
import plansFixture from "../fixtures/billing.plans.json";
import whoamiFixture from "../fixtures/whoami.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any = null;

function requireAuth(headers: Record<string, string | undefined>) {
  const auth = headers.authorization ?? headers.Authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
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

  // Billing — auth required
  .get("/api/billing/plans", ({ headers }) => {
    const denied = requireAuth(headers as Record<string, string | undefined>);
    if (denied) return denied;
    return plansFixture;
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
