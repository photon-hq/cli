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

describe("photon ping", () => {
  test("success — prints status and elapsed time", async () => {
    const { stdout, exitCode } = await runCommand(["ping", "--url", baseUrl], {
      env: { PHOTON_API_HOST: baseUrl },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("200");
    expect(stdout).toMatch(/\d+ms/);
    expect(stdout).toContain("ok");
  });

  test("failure — non-existent server prints error", async () => {
    const { stderr, exitCode } = await runCommand(
      ["ping", "--url", "http://127.0.0.1:1"],
      { env: { PHOTON_API_HOST: "http://127.0.0.1:1" } },
    );

    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
