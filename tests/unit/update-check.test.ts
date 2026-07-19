import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isNewerVersion,
  isUpdateProbeInvocation,
  readUpdateCache,
  runUpdateProbe,
  startUpdateNotifier,
} from "~/lib/update-check.ts";
import pkg from "../../package.json" with { type: "json" };

describe("isNewerVersion", () => {
  test("detects newer major / minor / patch", () => {
    expect(isNewerVersion("2.0.0", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.1.9")).toBe(true);
    expect(isNewerVersion("1.1.1", "1.1.0")).toBe(true);
  });

  test("equal or older is not newer", () => {
    expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.0.9", "1.1.0")).toBe(false);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
  });

  test("prerelease or malformed versions never trigger a notice", () => {
    expect(isNewerVersion("2.0.0-beta.1", "1.1.0")).toBe(false);
    expect(isNewerVersion("not-a-version", "1.1.0")).toBe(false);
    expect(isNewerVersion("2.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("2.0.0", "garbage")).toBe(false);
    expect(isNewerVersion("2..1", "1.1.0")).toBe(false);
    expect(isNewerVersion("2e1.0.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("+3.0.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("03.0.0", "1.1.0")).toBe(false);
  });
});

describe("readUpdateCache", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-cache-test-"));
  const cacheFile = path.join(tmpDir, "update-check.json");
  const originalConfigDir = process.env.PHOTON_CONFIG_DIR;

  beforeEach(() => {
    process.env.PHOTON_CONFIG_DIR = tmpDir;
    fs.rmSync(cacheFile, { force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.PHOTON_CONFIG_DIR;
    else process.env.PHOTON_CONFIG_DIR = originalConfigDir;
  });

  test("ignores malformed JSON and invalid cache fields", () => {
    fs.writeFileSync(cacheFile, "not-json");
    expect(readUpdateCache()).toEqual({ lastCheck: 0 });

    fs.writeFileSync(cacheFile, JSON.stringify({ lastCheck: 123, latest: 99 }));
    expect(readUpdateCache()).toEqual({ lastCheck: 123 });

    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ lastCheck: Number.NaN, latest: "99.0.0" })
    );
    expect(readUpdateCache()).toEqual({ lastCheck: 0 });
  });
});

describe("startUpdateNotifier", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-start-test-"));
  const cacheFile = path.join(tmpDir, "update-check.json");
  const originalConfigDir = process.env.PHOTON_CONFIG_DIR;
  const originalOptOut = process.env.PHOTON_NO_UPDATE_NOTIFIER;

  beforeEach(() => {
    process.env.PHOTON_CONFIG_DIR = tmpDir;
    delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
    fs.rmSync(cacheFile, { force: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.PHOTON_CONFIG_DIR;
    else process.env.PHOTON_CONFIG_DIR = originalConfigDir;
    if (originalOptOut === undefined) delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
    else process.env.PHOTON_NO_UPDATE_NOTIFIER = originalOptOut;
  });

  test("prints a cached update and does not spawn while the cache is fresh", () => {
    const now = 1_000_000_000;
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ lastCheck: now, latest: "99.0.0" })
    );
    const messages: string[] = [];
    let spawns = 0;

    startUpdateNotifier({
      interactive: () => true,
      now: () => now,
      spawnProbe: () => {
        spawns += 1;
      },
      writeError: (message) => messages.push(message),
    });

    expect(messages.join("\n")).toContain("Update available");
    expect(messages.join("\n")).toContain("99.0.0");
    expect(messages.join("\n")).toContain("npm update -g @photon-ai/cli");
    expect(messages.join("\n")).not.toContain("bun add -g");
    expect(spawns).toBe(0);
  });

  test("spawns one detached probe when the cache is stale", () => {
    let invocation: [string, string] | undefined;
    startUpdateNotifier({
      interactive: () => true,
      now: () => 1000 * 60 * 60 * 24 + 1,
      spawnProbe: (executable, entry) => {
        invocation = [executable, entry];
      },
    });

    expect(invocation).toEqual([process.execPath, process.argv[1] as string]);
  });

  test("guards the default launcher against emitted spawn errors", () => {
    let errorListener: ((error: Error) => void) | undefined;
    let unrefs = 0;

    startUpdateNotifier({
      interactive: () => true,
      now: () => 1000 * 60 * 60 * 24 + 1,
      spawnProcess: () => ({
        on(event, listener) {
          expect(event).toBe("error");
          errorListener = listener;
        },
        unref() {
          unrefs += 1;
        },
      }),
    });

    expect(errorListener).toBeDefined();
    expect(() => errorListener?.(new Error("spawn failed"))).not.toThrow();
    expect(unrefs).toBe(1);
  });

  test("guards the default launcher against synchronous spawn failures", () => {
    expect(() =>
      startUpdateNotifier({
        interactive: () => true,
        now: () => 1000 * 60 * 60 * 24 + 1,
        spawnProcess: () => {
          throw new Error("spawn failed");
        },
      })
    ).not.toThrow();
  });

  test("does not let a future cache timestamp suppress probes forever", () => {
    fs.writeFileSync(cacheFile, JSON.stringify({ lastCheck: 999_999_999 }));
    let spawns = 0;

    startUpdateNotifier({
      interactive: () => true,
      now: () => 123,
      spawnProbe: () => {
        spawns += 1;
      },
    });

    expect(spawns).toBe(1);
  });

  test("does nothing for non-interactive or opted-out invocations", () => {
    let spawns = 0;
    const spawnProbe = () => {
      spawns += 1;
    };
    startUpdateNotifier({ interactive: () => false, spawnProbe });
    process.env.PHOTON_NO_UPDATE_NOTIFIER = "1";
    startUpdateNotifier({ interactive: () => true, spawnProbe });

    expect(spawns).toBe(0);
  });

  test("a cache with a non-string latest version never crashes", () => {
    fs.writeFileSync(cacheFile, JSON.stringify({ lastCheck: 123, latest: 99 }));
    expect(() =>
      startUpdateNotifier({
        interactive: () => true,
        now: () => 123,
        spawnProbe: () => undefined,
      })
    ).not.toThrow();
  });
});

describe("isUpdateProbeInvocation", () => {
  test("matches only the hidden probe flag", () => {
    expect(
      isUpdateProbeInvocation(["node", "photon.js", "__photon-update-probe"])
    ).toBe(true);
    expect(isUpdateProbeInvocation(["node", "photon.js", "projects"])).toBe(
      false
    );
    expect(isUpdateProbeInvocation(["node", "photon.js"])).toBe(false);
  });
});

describe("runUpdateProbe", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-update-test-"));
  const cacheFile = path.join(tmpDir, "update-check.json");
  const origConfigDir = process.env.PHOTON_CONFIG_DIR;
  const origRegistry = process.env.PHOTON_UPDATE_REGISTRY;
  let registry: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    registry?.stop();
    registry = null;
    fs.rmSync(cacheFile, { force: true });
    process.env.PHOTON_CONFIG_DIR = tmpDir;
  });

  afterAll(() => {
    registry?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origConfigDir === undefined) {
      delete process.env.PHOTON_CONFIG_DIR;
    } else {
      process.env.PHOTON_CONFIG_DIR = origConfigDir;
    }
    if (origRegistry === undefined) {
      delete process.env.PHOTON_UPDATE_REGISTRY;
    } else {
      process.env.PHOTON_UPDATE_REGISTRY = origRegistry;
    }
  });

  test("caches the registry's latest version", async () => {
    registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const expected = `/${encodeURIComponent(pkg.name)}/latest`;
        if (new URL(req.url).pathname !== expected) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({ version: "99.0.0" });
      },
    });
    process.env.PHOTON_UPDATE_REGISTRY = `http://127.0.0.1:${registry.port}`;

    await runUpdateProbe();

    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cache.latest).toBe("99.0.0");
    expect(cache.lastCheck).toBeGreaterThan(0);
  });

  test("still stamps lastCheck when the registry is unreachable", async () => {
    // Nothing listens on this port — the fetch fails fast.
    process.env.PHOTON_UPDATE_REGISTRY = "http://127.0.0.1:1";

    await runUpdateProbe();

    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cache.lastCheck).toBeGreaterThan(0);
    expect(cache.latest).toBeUndefined();
  });

  test("does not cache a malformed registry version", async () => {
    registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ version: "2e1.0.0" });
      },
    });
    process.env.PHOTON_UPDATE_REGISTRY = `http://127.0.0.1:${registry.port}`;

    await runUpdateProbe();

    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(cache.lastCheck).toBeGreaterThan(0);
    expect(cache.latest).toBeUndefined();
  });

  test("swallows an initial cache write failure", async () => {
    const notADirectory = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(notADirectory, "blocks cache directory creation");
    process.env.PHOTON_CONFIG_DIR = notADirectory;

    await runUpdateProbe();
  });
});
