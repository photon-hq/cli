import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  getMockProjectCreateRequests,
  resetMockState,
  startMockServer,
  stopMockServer,
} from "../helpers/mock-server.ts";
import { runCommand } from "../helpers/cli-runner.ts";

let baseUrl: string;

beforeAll(async () => {
  baseUrl = await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

beforeEach(() => {
  resetMockState();
});

describe("photon projects create", () => {
  test("explains how to enable a platform when created without platforms", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "create", "--name", "No Platform"],
      {
        env: {
          CI: "1",
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(getMockProjectCreateRequests()).toEqual([
      {
        name: "No Platform",
        location: "United States",
        platforms: [],
        template: false,
        observability: false,
      },
    ]);
    expect(stdout).toContain("No platforms enabled.");
    expect(stdout).toContain("photon projects create --help");
    expect(stdout).toContain(
      "photon spectrum platforms enable <platform-name> --project '00000000-0000-4000-a000-000000000001'",
    );
  });

  test("does not show the no-platform hint for an explicit platform", async () => {
    const { stdout, exitCode } = await runCommand(
      [
        "projects",
        "create",
        "--name",
        "iMessage Project",
        "--platforms",
        "imessage",
      ],
      {
        env: {
          CI: "1",
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(getMockProjectCreateRequests()).toEqual([
      {
        name: "iMessage Project",
        location: "United States",
        platforms: ["imessage"],
        template: false,
        observability: false,
      },
    ]);
    expect(stdout).not.toContain("No platforms enabled.");
    expect(stdout).not.toContain("photon projects create --help");
    expect(stdout).not.toContain("spectrum platforms enable");
  });

  test("keeps --json output unchanged when no platform is selected", async () => {
    const { stdout, exitCode } = await runCommand(
      ["projects", "create", "--name", "JSON Project", "--json"],
      {
        env: {
          CI: "1",
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed)).toEqual(["id", "name", "env"]);
    expect(parsed.id).toBe("00000000-0000-4000-a000-000000000001");
    expect(parsed.name).toBe("JSON Project");
    expect(typeof parsed.env).toBe("string");
    expect(getMockProjectCreateRequests()[0]?.platforms).toEqual([]);
  });
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
