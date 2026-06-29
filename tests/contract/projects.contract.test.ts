import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startMockServer, stopMockServer } from "../helpers/mock-server.ts";
import { runCommand } from "../helpers/cli-runner.ts";

let baseUrl: string;

beforeAll(async () => {
  baseUrl = await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

describe("photon projects list", () => {
  test("lists project names from fixtures", async () => {
    const { stdout, exitCode } = await runCommand(["projects", "list"], {
      env: {
        PHOTON_TOKEN: "test-token",
        PHOTON_API_HOST: baseUrl,
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Acme Agent");
    expect(stdout).toContain("Beta Bot");
    expect(stdout).toContain("Gamma Gateway");
  });

  test("list --json returns valid JSON array", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "list", "--json"],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].name).toBe("Acme Agent");
  });
});

describe("photon projects show", () => {
  test("shows project details", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "show", "00000000-0000-4000-a000-000000000001"],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Acme Agent");
    expect(stdout).toContain("United States");
  });

  test("show --json returns valid JSON", async () => {
    const { stdout, exitCode } = await runCommand(
      [
        "projects",
        "show",
        "00000000-0000-4000-a000-000000000001",
        "--json",
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.name).toBe("Acme Agent");
    expect(parsed.id).toBe("00000000-0000-4000-a000-000000000001");
  });
});

describe("photon projects secret", () => {
  // Unknown id falls through to the project.show.json fixture, which carries
  // a non-null projectSecret.
  const idWithSecret = "00000000-0000-4000-a000-000000000009";
  // The list fixture's first project has projectSecret: null.
  const idWithoutSecret = "00000000-0000-4000-a000-000000000001";

  test("prints the bare secret on stdout", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "secret", idWithSecret],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("sk_test_acme_0123456789abcdef");
  });

  test("--json returns id and secret", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "secret", idWithSecret, "--json"],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe(idWithSecret);
    expect(parsed.projectSecret).toBe("sk_test_acme_0123456789abcdef");
  });

  test("fails clearly when the project has no secret yet", async () => {
    const { stderr, exitCode } = await runCommand(
      ["projects", "secret", idWithoutSecret],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no API secret");
  });
});
