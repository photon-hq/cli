import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semverInc from "semver/functions/inc.js";
import { replaceStandaloneBinary, updatePhoton } from "~/lib/self-update.ts";
import pkg from "../../package.json" with { type: "json" };
import { startNpmRegistry } from "../helpers/npm-registry.ts";

const nextLegacy = semverInc(pkg.version, "patch") as string;

describe("standalone binary updates follow npm's legacy tag", () => {
  const registry = startNpmRegistry({ latest: "3.0.0", legacy: pkg.version });
  const initialRegistry = process.env.npm_config_registry;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-legacy-binary-"));
  const target = path.join(tmpDir, "photon");
  const requested: string[] = [];
  const releases = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      const release = /^\/v([^/]+)\//.exec(pathname)?.[1] ?? "unknown";
      const binary = `binary-${release}`;
      return new Response(
        pathname.endsWith(".sha256")
          ? `${createHash("sha256").update(binary).digest("hex")}  photon\n`
          : binary
      );
    },
  });
  const installation = { kind: "standalone" as const, entryPath: target };
  const replaceStandalone = (file: string, version: string) =>
    replaceStandaloneBinary(file, version, {
      releaseBase: `http://127.0.0.1:${releases.port}`,
    });

  beforeEach(() => {
    process.env.npm_config_registry = registry.url;
    requested.length = 0;
    fs.writeFileSync(target, "current-binary", { mode: 0o755 });
  });

  afterAll(() => {
    if (initialRegistry === undefined) {
      delete process.env.npm_config_registry;
    } else {
      process.env.npm_config_registry = initialRegistry;
    }
    registry.stop();
    releases.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stays on the current binary when latest is 3.0.0", async () => {
    registry.setDistTags({ latest: "3.0.0", legacy: pkg.version });
    const result = await updatePhoton({}, { installation, replaceStandalone });

    expect(result).toEqual({
      status: "up-to-date",
      currentVersion: pkg.version,
      latestVersion: pkg.version,
      installer: null,
    });
    expect(requested).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("current-binary");
  });

  test("downloads the newest legacy release, never the 3.0.0 release", async () => {
    registry.setDistTags({ latest: "3.0.0", legacy: nextLegacy });
    const result = await updatePhoton({}, { installation, replaceStandalone });

    expect(result.status).toBe("updated");
    expect(result.latestVersion).toBe(nextLegacy);
    expect(result.installer).toBe("standalone");
    expect(requested.length).toBe(2);
    for (const pathname of requested) {
      expect(pathname.startsWith(`/v${nextLegacy}/photon-`)).toBe(true);
    }
    expect(fs.readFileSync(target, "utf8")).toBe(`binary-${nextLegacy}`);
  });
});
