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

describe("photon whoami", () => {
  test("shows user info when authenticated via token", async () => {
    const { stdout, exitCode } = await runCommand(["whoami"], {
      env: {
        PHOTON_TOKEN: "test-token",
        PHOTON_API_HOST: baseUrl,
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("authenticated via token");
    expect(stdout).toContain("developer");
  });

  test("exits non-zero when unauthenticated", async () => {
    const { exitCode, stderr } = await runCommand(["whoami"], {
      env: {
        PHOTON_API_HOST: baseUrl,
        PHOTON_TOKEN: "",
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
