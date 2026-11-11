import { afterAll, describe, expect, test } from "bun:test";
import semverInc from "semver/functions/inc.js";
import pkg from "../../package.json" with { type: "json" };
import { runCommand } from "../helpers/cli-runner.ts";
import { startNpmRegistry } from "../helpers/npm-registry.ts";

const nextLegacy = semverInc(pkg.version, "patch") as string;

describe("photon update follows npm's legacy tag", () => {
  const registry = startNpmRegistry({ latest: "3.0.0", legacy: pkg.version });
  const env = { npm_config_registry: registry.url };

  afterAll(() => registry.stop());

  test("--check --json reports up-to-date when latest is 3.0.0", async () => {
    registry.setDistTags({ latest: "3.0.0", legacy: pkg.version });
    const result = await runCommand(["update", "--check", "--json"], { env });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "up-to-date",
      currentVersion: pkg.version,
      latestVersion: pkg.version,
      installer: null,
    });
    expect(result.stderr).toBe("");
  });

  test("update installs nothing when latest is 3.0.0", async () => {
    registry.setDistTags({ latest: "3.0.0", legacy: pkg.version });
    const result = await runCommand(["update", "--json"], { env });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "up-to-date",
      currentVersion: pkg.version,
      latestVersion: pkg.version,
      installer: null,
    });
  });

  test("--check offers the newest legacy release, not latest", async () => {
    registry.setDistTags({ latest: "3.0.0", legacy: nextLegacy });
    const result = await runCommand(["update", "--check", "--json"], { env });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "update-available",
      currentVersion: pkg.version,
      latestVersion: nextLegacy,
      installer: null,
    });
  });

  test("never falls back to latest when the legacy tag is missing", async () => {
    registry.setDistTags({ latest: "3.0.0" });
    const result = await runCommand(["update", "--check", "--json"], { env });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("3.0.0");
    expect(result.stderr).toContain(
      "The Photon update registry has no legacy release of @photon-ai/cli"
    );
  });
});
