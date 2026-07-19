import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import plansFixture from "../fixtures/billing.plans.json";
import { runCommand } from "../helpers/cli-runner.ts";

let baseUrl: string;
let payload: unknown = plansFixture;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/billing/plans") {
        return new Response("not found", { status: 404 });
      }
      return Response.json(payload);
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  payload = plansFixture;
});

const ENV = { PHOTON_TOKEN: "test-token" };

describe("photon billing plans", () => {
  test("renders the plans table", async () => {
    const { stdout, exitCode } = await runCommand(
      ["billing", "plans", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pro");
    expect(stdout).toContain("price_pro_monthly");
  });

  test("--json prints the plans array", async () => {
    const { stdout, exitCode } = await runCommand(
      ["billing", "plans", "--json", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("plan_free");
  });
});

describe("photon billing plans — payload validation", () => {
  test("rejects a plans envelope that is not in the API contract", async () => {
    payload = { plans: plansFixture, pendingChanges: [] };
    const { stderr, exitCode } = await runCommand(
      ["billing", "plans", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of plans");
  });

  test("rejects unrelated objects with a clear shape error", async () => {
    payload = { items: plansFixture };
    const { stderr, exitCode } = await runCommand(
      ["billing", "plans", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of plans");
    expect(stderr).not.toContain("is not a function");
  });
});
