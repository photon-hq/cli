import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "../helpers/cli-runner.ts";
import {
  resetMockState,
  setMockSubscription,
  setMockUnauthorized,
  startMockServer,
  stopMockServer,
} from "../helpers/mock-server.ts";

let baseUrl: string;
const PROJECT_ID = "00000000-0000-4000-a000-000000000001";

beforeAll(async () => {
  baseUrl = await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

beforeEach(() => {
  resetMockState();
});

describe("photon projects upgrade — smart routing", () => {
  test("free subscription routes to checkout", async () => {
    setMockSubscription("free");
    const { stdout, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "pro", "--json"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("checkout");
    expect(parsed.url).toContain("checkout.stripe.com");
    expect(parsed.tier).toBe("pro");
  });

  test("active subscription routes to manage", async () => {
    setMockSubscription("active");
    const { stdout, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "--json"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("manage");
    expect(parsed.url).toContain("billing.stripe.com");
  });
});

describe("photon projects upgrade — explicit overrides", () => {
  test("--checkout forces checkout even when active", async () => {
    setMockSubscription("active");
    const { stdout, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "pro", "--checkout", "--json"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("checkout");
  });

  test("--manage forces portal even when free", async () => {
    setMockSubscription("free");
    const { stdout, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "--manage", "--json"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("manage");
  });

  test("--checkout + --manage is rejected", async () => {
    const { stderr, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "--checkout", "--manage"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("mutually exclusive");
  });

  test("--plan <price-id> bypasses the tier picker", async () => {
    setMockSubscription("free");
    const { stdout, exitCode } = await runCommand(
      [
        "projects",
        "upgrade",
        PROJECT_ID,
        "--plan",
        "price_custom_xyz",
        "--json",
      ],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.action).toBe("checkout");
    expect(parsed.url).toContain("checkout.stripe.com");
  });
});

describe("photon projects upgrade — non-TTY browser policy", () => {
  test("does not attempt to launch a browser in non-TTY (test) environments", async () => {
    setMockSubscription("free");
    // The CLI test runner runs in a non-TTY environment. Without --json we
    // should still get the URL printed to stdout but no real `open()` call
    // (would otherwise blow up under `bun test`). Success criterion: the
    // URL is present in stdout and the process exits cleanly.
    const { stdout, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "pro"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("checkout.stripe.com");
  });
});

describe("photon projects upgrade — error handling", () => {
  test("401 surfaces SessionExpiredError", async () => {
    setMockSubscription("free");
    setMockUnauthorized(true);
    const { stderr, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "pro", "--json"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).not.toBe(0);
    // The in-process runner doesn't wire in handleTopLevelError (the
    // production CLI does), so we see the raw error name + message here.
    // The "Run `photon login`" hint is added by handleTopLevelError and
    // is covered indirectly by every CLI-as-binary smoke test.
    expect(stderr).toContain("Session expired");
  });

  test("unknown tier is rejected with helpful hint", async () => {
    const { stderr, exitCode } = await runCommand(
      ["projects", "upgrade", PROJECT_ID, "ultra"],
      {
        env: { PHOTON_TOKEN: "test-token", PHOTON_API_HOST: baseUrl },
      }
    );

    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("unknown tier");
    expect(stderr).toContain("pro");
  });
});
