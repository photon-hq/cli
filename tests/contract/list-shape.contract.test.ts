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

// Runtime validation must follow the current published API contract. Shape
// drift should fail clearly instead of crashing inside table rendering.

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

  test("rejects a bare array instead of the documented lines envelope", async () => {
    setMockWrongShape("lines");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "lines", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of lines");
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

  test("rejects a bare array instead of the documented users envelope", async () => {
    setMockWrongShape("users");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "users", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of users");
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

  test("rejects an entry array instead of the documented platform map", async () => {
    setMockWrongShape("platforms");
    const { stderr, exitCode } = await runCommand(
      ["spectrum", "platforms", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected a platform map object");
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
  test("rejects an envelope instead of the documented projects array", async () => {
    setMockWrongShape("projects");
    const { stderr, exitCode } = await runCommand(
      ["projects", "list", "--api-host", baseUrl],
      { env: ENV }
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("expected an array of projects");
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
