import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../helpers/cli-runner.ts";
import {
  getMockLineProfileRequests,
  resetMockState,
  startMockServer,
  stopMockServer,
} from "../helpers/mock-server.ts";

const PROJECT_ID = "00000000-0000-4000-a000-000000000001";
const LINE_ID = "11111111-1111-4111-8111-111111111111";

let baseUrl: string;
let tempDirectory: string;

beforeAll(async () => {
  baseUrl = await startMockServer();
  tempDirectory = await mkdtemp(join(tmpdir(), "photon-line-avatar-"));
});

afterAll(async () => {
  await stopMockServer();
  await rm(tempDirectory, { recursive: true, force: true });
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

describe("single iMessage Line profile commands", () => {
  test("rejects an empty name update before calling the API", async () => {
    const result = await runCommand(
      ["spectrum", "lines", "profile", "update", LINE_ID],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing to update");
    expect(getMockLineProfileRequests()).toEqual([]);
  });

  test("updates one Line name with a single PATCH", async () => {
    const result = await runCommand(
      [
        "spectrum",
        "lines",
        "profile",
        "update",
        LINE_ID,
        "--first-name",
        "Ada",
        "--last-name",
        "Lovelace",
        "--json",
      ],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      projectId: PROJECT_ID,
      lineId: LINE_ID,
      phoneNumber: "+14155550101",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    });
    expect(getMockLineProfileRequests()).toEqual([
      {
        operation: "profile",
        method: "PATCH",
        projectId: PROJECT_ID,
        lineId: LINE_ID,
        body: { firstName: "Ada", lastName: "Lovelace" },
      },
    ]);
  });

  test("uploads and commits one Line avatar", async () => {
    const imagePath = join(tempDirectory, "avatar.png");
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));

    const result = await runCommand(
      ["spectrum", "lines", "avatar", "upload", LINE_ID, imagePath],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Uploaded avatar for line ${LINE_ID}`);
    expect(result.stdout).toContain(`https://cdn.example.test/${LINE_ID}.png`);
    expect(getMockLineProfileRequests()).toEqual([
      {
        operation: "avatar-upload",
        method: "POST",
        projectId: PROJECT_ID,
        lineId: LINE_ID,
        body: { contentType: "image/png" },
      },
      {
        operation: "avatar-put",
        method: "PUT",
        projectId: PROJECT_ID,
        lineId: LINE_ID,
        contentType: "image/png",
      },
      {
        operation: "avatar-commit",
        method: "POST",
        projectId: PROJECT_ID,
        lineId: LINE_ID,
        body: {
          key: `avatars/${PROJECT_ID}/lines/${LINE_ID}/avatar.png`,
        },
      },
    ]);
  });

  test("rejects SVG project and Line avatars before calling the API", async () => {
    const imagePath = join(tempDirectory, "avatar.SVG");
    await writeFile(
      imagePath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />'
    );

    for (const args of [
      ["spectrum", "avatar", "upload", imagePath],
      ["spectrum", "lines", "avatar", "upload", LINE_ID, imagePath],
    ]) {
      const result = await runCommand(args, { env: commandEnv() });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SVG avatars are not supported");
      expect(result.stderr).toContain(
        "Convert the image to PNG, JPEG, or WebP"
      );
    }
    expect(getMockLineProfileRequests()).toEqual([]);
  });

  test("rejects SVG content hidden behind a raster extension", async () => {
    const imagePath = join(tempDirectory, "renamed.png");
    await writeFile(
      imagePath,
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" />'
    );

    const result = await runCommand(
      ["spectrum", "lines", "avatar", "upload", LINE_ID, imagePath],
      { env: commandEnv() }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SVG avatars are not supported");
    expect(getMockLineProfileRequests()).toEqual([]);
  });
});
