import { afterAll, describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { runCommand } from "../helpers/cli-runner.ts";

describe("photon update", () => {
  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/@photon-ai%2Fcli") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        name: "@photon-ai/cli",
        "dist-tags": { latest: "99.0.0" },
        versions: {
          "99.0.0": { name: "@photon-ai/cli", version: "99.0.0" },
        },
      });
    },
  });
  const env = {
    npm_config_registry: `http://127.0.0.1:${registry.port}`,
  };

  afterAll(() => registry.stop());

  test("--check --json reports an available release without installing it", async () => {
    const result = await runCommand(["update", "--check", "--json"], { env });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "update-available",
      currentVersion: pkg.version,
      latestVersion: "99.0.0",
      installer: null,
    });
    expect(result.stderr).toBe("");
  });

  test("human check output includes the next step", async () => {
    const result = await runCommand(["update", "--check"], { env });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Update available: ${pkg.version} → 99.0.0`
    );
    expect(result.stdout).toContain("photon update");
  });

  test("rejects contradictory check and force options", async () => {
    const result = await runCommand(["update", "--check", "--force"], { env });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--check and --force cannot be used together");
  });

  test("reports registry failures without suggesting the Dashboard API host", async () => {
    const result = await runCommand(["update", "--check"], {
      env: { npm_config_registry: "http://127.0.0.1:1" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Could not reach the Photon update registry");
    expect(result.stderr).not.toContain("PHOTON_API_HOST");
  });
});
