import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "../helpers/cli-runner.ts";
import {
  resetMockState,
  setMockInvalidShape,
  setMockWrongShape,
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

const ENV = { PHOTON_TOKEN: "test-token", PHOTON_PROJECT_ID: PROJECT_ID };

// Regression coverage for ENG-1998's bug class: normalize the two response
// shapes deployed historically, while rejecting unrelated payloads clearly.

describe("photon spectrum lines list", () => {
  test("renders the lines table", async () => {
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "lines", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("+16283586125");
    expect(stdout).toContain("available");
  });

  test("supports the legacy bare-array payload", async () => {
    setMockWrongShape("lines");
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "lines", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("+16283586125");
  });

  test("rejects an unrelated payload clearly", async () => {
    setMockInvalidShape("lines");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "lines", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of lines");
  });
});

describe("photon spectrum users list", () => {
  test("renders the users table", async () => {
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "users", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Henry Zhang");
    expect(stdout).toContain("+15555550100");
  });

  test("supports the legacy bare-array payload", async () => {
    setMockWrongShape("users");
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "users", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Henry Zhang");
  });

  test("rejects an unrelated payload clearly", async () => {
    setMockInvalidShape("users");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "users", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of users");
  });
});

describe("photon spectrum platforms list", () => {
  test("renders the platform toggle table", async () => {
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "platforms", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("imessage");
    expect(stdout).toContain("on");
  });

  test("supports the legacy entry-array payload", async () => {
    setMockWrongShape("platforms");
    const { stdout, exitCode } = await runCommand(
      ["spectrum", "platforms", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("imessage");
  });

  test("rejects non-boolean platform values", async () => {
    setMockInvalidShape("platforms");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "platforms", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected a platform map object");
  });
});

describe("photon projects list", () => {
  test("supports the legacy projects envelope", async () => {
    setMockWrongShape("projects");
    const { stdout, exitCode } = await runCommand(
      ["projects", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Acme Agent");
  });

  test("rejects an unrelated payload clearly", async () => {
    setMockInvalidShape("projects");
    const { stderr, exitCode } = await runCommand(
      ["projects", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of projects");
  });
});
