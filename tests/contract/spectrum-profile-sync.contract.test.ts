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
  resetMockState,
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

function commandEnv() {
  return {
    PHOTON_TOKEN: "test-token",
    PHOTON_API_HOST: baseUrl,
    PHOTON_PROJECT_ID: PROJECT_ID,
  };
}

describe("photon spectrum profile sync", () => {
  test("returns the Dashboard targeted Line count without polling", async () => {
    const result = await runCommand(
      ["spectrum", "profile", "sync", "--json"],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      projectId: PROJECT_ID,
      targetedLineCount: 3,
    });
    expect(getMockProfileSyncRequests().map(({ method }) => method)).toEqual([
      "POST",
    ]);
  });

  test("prints the targeted Line count in human output", async () => {
    const result = await runCommand(["spectrum", "profile", "sync"], {
      env: commandEnv(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Profile synced. 3 lines updated.");
    expect(getMockProfileSyncRequests().map(({ method }) => method)).toEqual([
      "POST",
    ]);
  });
});
