import { describe, test, expect } from "bun:test";
import { formatApiError, c } from "~/lib/output.ts";

describe("formatApiError", () => {
  test("returns message from Error instance", () => {
    expect(formatApiError(new Error("boom"))).toBe("boom");
  });

  test("returns plain string as-is", () => {
    expect(formatApiError("something broke")).toBe("something broke");
  });

  test("extracts value string with status", () => {
    expect(formatApiError({ status: 404, value: "Not Found" })).toBe(
      "Not Found [404]",
    );
  });

  test("extracts value.error with status", () => {
    expect(
      formatApiError({ status: 500, value: { error: "Internal error" } }),
    ).toBe("Internal error [500]");
  });

  test("extracts value.message with status", () => {
    expect(
      formatApiError({ status: 422, value: { message: "Validation failed" } }),
    ).toBe("Validation failed [422]");
  });

  test("JSON-serializes unknown value shape with status", () => {
    const result = formatApiError({ status: 400, value: { foo: "bar" } });
    expect(result).toContain("[400]");
    expect(result).toContain('"foo"');
  });

  test("handles null value with status", () => {
    const result = formatApiError({ status: 500, value: null });
    expect(result).toContain("[500]");
  });

  test("handles object without status", () => {
    expect(formatApiError({ value: "oops" })).toBe("oops");
  });

  test("handles non-object non-string values via String()", () => {
    expect(formatApiError(42)).toBe("42");
    expect(formatApiError(undefined)).toBe("undefined");
    expect(formatApiError(null)).toBe("null");
  });
});

describe("color helpers (c)", () => {
  test("c.success prepends check mark", () => {
    const result = c.success("done");
    expect(result).toContain("done");
    expect(result).toMatch(/✓/);
  });

  test("c.error prepends cross mark", () => {
    const result = c.error("failed");
    expect(result).toContain("failed");
    expect(result).toMatch(/✗/);
  });

  test("c.info prepends diamond", () => {
    const result = c.info("note");
    expect(result).toContain("note");
    expect(result).toMatch(/◆/);
  });

  test("c.warn prepends exclamation", () => {
    const result = c.warn("careful");
    expect(result).toContain("careful");
    expect(result).toMatch(/!/);
  });
});
