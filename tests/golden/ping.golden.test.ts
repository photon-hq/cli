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

describe("ping golden output", () => {
  test("success output matches snapshot", async () => {
    const { stdout } = await runCommand(["ping", "--url", baseUrl], {
      env: { PHOTON_API_HOST: baseUrl },
    });

    // Mask non-deterministic parts before snapshotting
    const stable = stdout
      .replace(/http:\/\/127\.0\.0\.1:\d+/, "http://127.0.0.1:PORT")
      .replace(/\d+ms/, "XXms");
    expect(stable).toMatchSnapshot();
  });
});
