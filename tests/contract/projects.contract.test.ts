import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  getMockPlatformToggleRequests,
  getMockProjectCreateRequests,
  getMockProjectDeleteRequests,
  resetMockState,
  setMockPlatformToggleEmptyResponse,
  setMockPlatformToggleWarning,
  setMockProjectCreateWarning,
  setMockSpectrumUserAddFailure,
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

describe("photon projects create", () => {
  test("creates the project and warns when owner enrollment is exhausted", async () => {
    resetMockState();
    setMockProjectCreateWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "projects",
        "create",
        "--name",
        "Quota test",
        "--platforms",
        "imessage",
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created Quota test");
    expect(stderr).toContain(
      "We couldn't connect your phone to a shared iMessage line",
    );
    expect(getMockProjectDeleteRequests()).toEqual([]);
  });

  test("create --json includes the non-blocking warning", async () => {
    resetMockState();
    setMockProjectCreateWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "projects",
        "create",
        "--name",
        "Quota test",
        "--platforms",
        "imessage",
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
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      id: "00000000-0000-4000-a000-000000000001",
      name: "Quota test",
      warning: {
        code: "shared_line_unavailable",
        message:
          "We couldn't connect your phone to a shared iMessage line. You can add another phone or connect a dedicated line.",
      },
    });
    expect(getMockProjectDeleteRequests()).toEqual([]);
  });

  test("uses CLI warning copy when the API returns only a known code", async () => {
    resetMockState();
    setMockProjectCreateWarning(true, false);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "projects",
        "create",
        "--name",
        "Quota test",
        "--platforms",
        "imessage",
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created Quota test");
    expect(stderr).toContain(
      "We couldn't connect your phone to a shared iMessage line",
    );
  });

  test("still warns when deletion does not restore shared capacity", async () => {
    resetMockState();
    setMockProjectCreateWarning(true);
    const projectId = "00000000-0000-4000-a000-000000000001";
    const env = {
      PHOTON_TOKEN: "test-token",
      PHOTON_API_HOST: baseUrl,
    };

    const deletion = await runCommand(
      ["projects", "delete", projectId, "--yes"],
      { env },
    );
    expect(deletion.exitCode).toBe(0);
    expect(getMockProjectDeleteRequests()).toEqual([projectId]);

    const creation = await runCommand(
      [
        "projects",
        "create",
        "--name",
        "After deletion",
        "--platforms",
        "imessage",
      ],
      { env },
    );

    expect(creation.exitCode).toBe(0);
    expect(creation.stdout).toContain("Created After deletion");
    expect(creation.stderr).toContain(
      "We couldn't connect your phone to a shared iMessage line",
    );
  });

});

describe("photon spectrum platforms enable", () => {
  const projectId = "00000000-0000-4000-a000-000000000001";

  test("succeeds and warns when iMessage has no connected phone", async () => {
    resetMockState();
    setMockPlatformToggleWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "enable",
        "imessage",
        "--project",
        projectId,
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Enabled imessage");
    expect(stderr).toContain(
      "iMessage was enabled without a connected phone. Add another phone or connect a dedicated line.",
    );
    expect(getMockPlatformToggleRequests()).toEqual([
      { projectId, platformId: "imessage", enabled: true },
    ]);
  });

  test("--json keeps the successful platform state and warning", async () => {
    resetMockState();
    setMockPlatformToggleWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "enable",
        "imessage",
        "--project",
        projectId,
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
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      platforms: { imessage: true },
      warning: {
        code: "imessage_connection_missing",
        message:
          "iMessage was enabled without a connected phone. Add another phone or connect a dedicated line.",
      },
    });
  });

  test("does not show an iMessage warning for another platform", async () => {
    resetMockState();
    setMockPlatformToggleWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "enable",
        "whatsapp",
        "--project",
        projectId,
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Enabled whatsapp");
    expect(stderr).toBe("");
  });

  test("does not show an iMessage warning when disabling iMessage", async () => {
    resetMockState();
    setMockPlatformToggleWarning(true);

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "disable",
        "imessage",
        "--project",
        projectId,
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Disabled imessage");
    expect(stderr).toBe("");
  });

  test("preserves the raw platform map in JSON when there is no warning", async () => {
    resetMockState();

    const { stdout, stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "enable",
        "whatsapp",
        "--project",
        projectId,
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
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ whatsapp: true });
  });

  test("fails clearly when platform toggle returns no result", async () => {
    resetMockState();
    setMockPlatformToggleEmptyResponse(true);

    const { stderr, exitCode } = await runCommand(
      [
        "spectrum",
        "platforms",
        "enable",
        "imessage",
        "--project",
        projectId,
      ],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Server did not return a platform result.");
  });
});

describe("photon spectrum users add", () => {
  const projectId = "00000000-0000-4000-a000-000000000001";
  const args = [
    "spectrum",
    "users",
    "add",
    "--first-name",
    "Ada",
    "--last-name",
    "Lovelace",
    "--email",
    "ada@example.com",
    "--phone",
    "+15551234567",
  ];

  test("fails visibly when the phone has no shared route available", async () => {
    resetMockState();
    setMockSpectrumUserAddFailure({
      code: "shared_line_unavailable",
      message: "This phone couldn't be connected to a shared iMessage line.",
    });

    const { stdout, stderr, exitCode } = await runCommand(
      args,
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
          PHOTON_PROJECT_ID: projectId,
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("Added");
    expect(stderr).toContain(
      "This phone couldn't be connected to a shared iMessage line. Try another phone or connect a dedicated line.",
    );
  });

  test("prints a structured JSON error and exits one", async () => {
    resetMockState();
    setMockSpectrumUserAddFailure({
      code: "shared_line_unavailable",
      message: "This phone couldn't be connected to a shared iMessage line.",
    });

    const { stdout, stderr, exitCode } = await runCommand(
      [...args, "--json"],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
          PHOTON_PROJECT_ID: projectId,
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      error: {
        code: "shared_line_unavailable",
        message:
          "This phone couldn't be connected to a shared iMessage line. Try another phone or connect a dedicated line.",
      },
    });
  });

  test("explains that iMessage must be enabled before adding a Spectrum user", async () => {
    resetMockState();
    setMockSpectrumUserAddFailure({
      code: "imessage_not_enabled",
      message: "Enable iMessage for this project before adding a Spectrum user.",
    });

    const { stdout, stderr, exitCode } = await runCommand(
      [...args, "--json"],
      {
        env: {
          PHOTON_TOKEN: "test-token",
          PHOTON_API_HOST: baseUrl,
          PHOTON_PROJECT_ID: projectId,
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      error: {
        code: "imessage_not_enabled",
        message: "Enable iMessage for this project before adding a Spectrum user.",
      },
    });
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
