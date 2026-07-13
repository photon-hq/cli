import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { runCommand } from "../helpers/cli-runner.ts";
import {
  getMockProfileSyncRequests,
  makeMockProfileSyncAggregate,
  resetMockState,
  setMockProfileSyncSequence,
  setMockUnauthorized,
  startMockServer,
  stopMockServer,
} from "../helpers/mock-server.ts";

let baseUrl: string;

const PROJECT_ID = "00000000-0000-4000-a000-000000000001";
const FLAG_PROJECT_ID = "00000000-0000-4000-a000-000000000077";

beforeAll(async () => {
  baseUrl = await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

beforeEach(() => {
  resetMockState();
});

function commandEnv(overrides: Record<string, string> = {}) {
  return {
    PHOTON_TOKEN: "test-token",
    PHOTON_API_HOST: baseUrl,
    PHOTON_PROJECT_ID: PROJECT_ID,
    ...overrides,
  };
}

function expectNoSyncId(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain("syncId");
}

describe("photon spectrum profile sync", () => {
  test("updates Line Profiles once without polling", async () => {
    setMockProfileSyncSequence([makeMockProfileSyncAggregate({ total: 3 })]);

    const result = await runCommand(
      ["spectrum", "profile", "sync", "--json"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({
      projectId: PROJECT_ID,
      syncedLineCount: 3,
    });
    expectNoSyncId(parsed);
    expect(getMockProfileSyncRequests().map(({ method }) => method)).toEqual([
      "POST",
    ]);
  });

  test("prints the synchronized Line count in human output", async () => {
    setMockProfileSyncSequence([makeMockProfileSyncAggregate({ total: 2 })]);

    const result = await runCommand(["spectrum", "profile", "sync"], {
      env: commandEnv(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 dedicated iMessage Lines");
    expect(getMockProfileSyncRequests().map(({ method }) => method)).toEqual([
      "POST",
    ]);
  });
});

describe("photon spectrum profile sync-status", () => {
  test("returns the current in-progress counts without requiring a sync id", async () => {
    setMockProfileSyncSequence([makeMockProfileSyncAggregate()]);

    const result = await runCommand(
      ["spectrum", "profile", "sync-status", "--json"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("in_progress");
    expect(parsed).toMatchObject({ total: 3, pending: 2, synced: 1, failed: 0 });
    expectNoSyncId(parsed);
    expect(getMockProfileSyncRequests().map(({ method }) => method)).toEqual([
      "GET",
    ]);
  });

  test("returns a safe partial_failed aggregate and exits 1", async () => {
    setMockProfileSyncSequence([
      makeMockProfileSyncAggregate({
        status: "partial_failed",
        pending: 0,
        synced: 2,
        failed: 1,
        errors: [
          { lineId: "line-safe-9", reason: "Tailor temporarily unavailable" },
        ],
      }),
    ]);

    const result = await runCommand(
      ["spectrum", "profile", "sync-status", "--json"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("partial_failed");
    expect(parsed.errors).toEqual([
      { lineId: "line-safe-9", reason: "Tailor temporarily unavailable" },
    ]);
    expect(result.stderr).not.toContain("test-token");
  });

  test("renders only the safe line id and reason in human failure output", async () => {
    setMockProfileSyncSequence([
      makeMockProfileSyncAggregate({
        status: "failed",
        pending: 0,
        synced: 0,
        failed: 1,
        total: 1,
        errors: [{ lineId: "line-safe-10", reason: "Tailor unavailable" }],
      }),
    ]);

    const result = await runCommand(
      ["spectrum", "profile", "sync-status"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("line-safe-10: Tailor unavailable");
    expect(result.stdout).not.toContain("test-token");
    expect(result.stderr).not.toContain("test-token");
  });

  test("uses SessionExpiredError for a Dashboard 401", async () => {
    setMockUnauthorized(true);

    const result = await runCommand(
      ["spectrum", "profile", "sync-status", "--json"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Session expired");
  });

  test("resolves explicit project, API host, and token before calling the typed route", async () => {
    setMockProfileSyncSequence([
      makeMockProfileSyncAggregate({
        projectId: FLAG_PROJECT_ID,
        status: "completed",
        pending: 0,
        synced: 3,
      }),
    ]);

    const result = await runCommand(
      [
        "spectrum",
        "profile",
        "sync-status",
        "--project",
        FLAG_PROJECT_ID,
        "--api-host",
        baseUrl,
        "--token",
        "flag-token",
        "--json",
      ],
      {
        env: commandEnv({
          PHOTON_TOKEN: "wrong-env-token",
          PHOTON_API_HOST: "http://127.0.0.1:1",
          PHOTON_PROJECT_ID: "wrong-env-project",
        }),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).projectId).toBe(FLAG_PROJECT_ID);
    expect(getMockProfileSyncRequests()).toEqual([
      {
        method: "GET",
        projectId: FLAG_PROJECT_ID,
        authorization: "Bearer flag-token",
      },
    ]);
  });
});
