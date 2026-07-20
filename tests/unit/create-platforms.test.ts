import { describe, expect, test } from "bun:test";
import { fillCreateOpts } from "~/commands/projects.ts";

// Regression for the `projects create` platform-default footgun: when no
// --platforms flag is given, the CLI must OMIT the field (undefined) so the
// server applies its default (iMessage). Previously it sent `[]`, which the
// server reads as "no platforms enabled" — creating an unusable project.
describe("fillCreateOpts platform defaulting", () => {
  test("omits platforms (undefined) when --platforms is not given", async () => {
    const filled = await fillCreateOpts({ name: "dx-test" });
    expect(filled.platforms).toBeUndefined();
  });

  test("parses an explicit --platforms value", async () => {
    const filled = await fillCreateOpts({
      name: "dx-test",
      platforms: "imessage",
    });
    expect(filled.platforms).toEqual(["imessage"]);
  });
});
