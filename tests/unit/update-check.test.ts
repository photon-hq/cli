import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type updateNotifier from "update-notifier";
import { startUpdateNotifier } from "~/lib/update-check.ts";
import pkg from "../../package.json" with { type: "json" };

const initialOptOut = process.env.PHOTON_NO_UPDATE_NOTIFIER;

beforeEach(() => {
  delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
});

afterEach(() => {
  if (initialOptOut === undefined) {
    delete process.env.PHOTON_NO_UPDATE_NOTIFIER;
  } else {
    process.env.PHOTON_NO_UPDATE_NOTIFIER = initialOptOut;
  }
});

describe("startUpdateNotifier", () => {
  test("delegates the deferred 24-hour check to update-notifier", () => {
    let factoryOptions: Parameters<typeof updateNotifier>[0] | undefined;
    let notifyOptions: Parameters<ReturnType<typeof updateNotifier>["notify"]>[0];
    const createNotifier = ((options: Parameters<typeof updateNotifier>[0]) => {
      factoryOptions = options;
      return {
        notify(optionsToNotify: typeof notifyOptions) {
          notifyOptions = optionsToNotify;
        },
      };
    }) as unknown as typeof updateNotifier;

    startUpdateNotifier({ interactive: () => true, createNotifier });

    expect(factoryOptions).toEqual({
      pkg: { name: "@photon-ai/cli", version: pkg.version },
      updateCheckInterval: 1000 * 60 * 60 * 24,
    });
    expect(notifyOptions).toEqual({ defer: true, isGlobal: true });
  });

  test("skips non-interactive sessions", () => {
    let created = false;
    const createNotifier = (() => {
      created = true;
      return { notify() {} };
    }) as unknown as typeof updateNotifier;

    startUpdateNotifier({ interactive: () => false, createNotifier });

    expect(created).toBe(false);
  });

  test("honors PHOTON_NO_UPDATE_NOTIFIER", () => {
    process.env.PHOTON_NO_UPDATE_NOTIFIER = "1";
    let created = false;
    const createNotifier = (() => {
      created = true;
      return { notify() {} };
    }) as unknown as typeof updateNotifier;

    startUpdateNotifier({ interactive: () => true, createNotifier });

    expect(created).toBe(false);
  });
});
