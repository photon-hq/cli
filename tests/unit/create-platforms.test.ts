import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fillCreateOpts } from "~/commands/projects.ts";

// Regression for the `projects create` platform-default footgun: when no
// usable --platforms value is given, the CLI must OMIT the field (undefined) so
// the server applies its default (iMessage). Previously it sent `[]`, which the
// server reads as "no platforms enabled" — creating an unusable project. Eden
// drops undefined-valued keys from the JSON body, so undefined == omitted.
//
// `fillCreateOpts` branches on `isInteractive()` (stdout AND stdin a TTY). Under
// `bun test` from a real terminal BOTH are TTYs, which would send this into the
// interactive path and block on a clack prompt. Pin the non-interactive path so
// the suite is hermetic wherever it runs (piped CI or an attached terminal).
const stdin = process.stdin as { isTTY?: boolean };
const originalStdinTTY = stdin.isTTY;

beforeAll(() => {
  stdin.isTTY = false;
});

afterAll(() => {
  stdin.isTTY = originalStdinTTY;
});

describe("fillCreateOpts platform defaulting (non-interactive)", () => {
  test("omits platforms (undefined) when --platforms is absent", async () => {
    const filled = await fillCreateOpts({ name: "dx-test" });
    expect(filled.platforms).toBeUndefined();
  });

  test("treats a blank/whitespace/comma-only --platforms as omitted", async () => {
    // These are the scripting footguns — e.g. `--platforms "$VAR"` with $VAR
    // unset — that previously parsed to `[]` and disabled every platform.
    for (const value of ["", "   ", ",", ",,", " , "]) {
      const filled = await fillCreateOpts({ name: "dx-test", platforms: value });
      expect(filled.platforms).toBeUndefined();
    }
  });

  test("parses an explicit --platforms value", async () => {
    const one = await fillCreateOpts({ name: "dx-test", platforms: "imessage" });
    expect(one.platforms).toEqual(["imessage"]);

    // Trailing/interior blanks are tolerated; order and dedupe preserved.
    const many = await fillCreateOpts({
      name: "dx-test",
      platforms: " imessage , voice ,",
    });
    expect(many.platforms).toEqual(["imessage", "voice"]);
  });
});
