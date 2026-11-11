import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import semverInc from "semver/functions/inc.js";
import updateNotifier, { type UpdateInfo } from "update-notifier";
import { startUpdateNotifier } from "~/lib/update-check.ts";
import pkg from "../../package.json" with { type: "json" };
import { startNpmRegistry } from "../helpers/npm-registry.ts";

const nextLegacy = semverInc(pkg.version, "patch") as string;
const initialOptOut = process.env.PHOTON_NO_UPDATE_NOTIFIER;
const initialRegistry = process.env.npm_config_registry;

beforeEach(() => {
  delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
});

afterEach(() => {
  if (initialOptOut === undefined) {
    delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
  } else {
    process.env.PHOTON_NO_UPDATE_NOTIFIER = initialOptOut;
  }
  if (initialRegistry === undefined) {
    delete process.env.npm_config_registry;
  } else {
    process.env.npm_config_registry = initialRegistry;
  }
});

function cachedNotifier(latest: unknown) {
  const notified: unknown[] = [];
  const update = {
    latest,
    current: pkg.version,
    type: "patch",
    name: pkg.name,
  } as UpdateInfo;
  const createNotifier = (() => ({
    update,
    notify(options: unknown) {
      notified.push(options);
    },
  })) as unknown as typeof updateNotifier;
  return { createNotifier, notified };
}

describe("the update notice follows npm's legacy tag", () => {
  const registry = startNpmRegistry({ latest: "3.0.0", legacy: nextLegacy });

  afterAll(() => registry.stop());

  test("looks the release up on legacy when latest is 3.0.0", async () => {
    process.env.npm_config_registry = registry.url;
    let created: ReturnType<typeof updateNotifier> | undefined;
    const createNotifier = ((options: Parameters<typeof updateNotifier>[0]) => {
      created = updateNotifier(options);
      return created;
    }) as typeof updateNotifier;

    startUpdateNotifier({ interactive: () => true, createNotifier });

    expect(created).toBeDefined();
    const info = await created?.fetchInfo();
    expect(info?.latest).toBe(nextLegacy);
  });

  test("ignores a cached 3.0.0 update left by a release that followed latest", () => {
    const { createNotifier, notified } = cachedNotifier("3.0.0");

    startUpdateNotifier({ interactive: () => true, createNotifier });

    expect(notified).toEqual([]);
  });

  test("ignores a cached update whose version is not a string", () => {
    const { createNotifier, notified } = cachedNotifier(5);

    expect(() =>
      startUpdateNotifier({ interactive: () => true, createNotifier })
    ).not.toThrow();
    expect(notified).toEqual([]);
  });

  test("names photon update for a cached update on this line", () => {
    const { createNotifier, notified } = cachedNotifier(nextLegacy);

    startUpdateNotifier({ interactive: () => true, createNotifier });

    expect(notified.length).toBe(1);
    const { message } = notified[0] as { message: string };
    expect(message).toContain("photon update");
    expect(message).not.toContain("{updateCommand}");
  });
});
