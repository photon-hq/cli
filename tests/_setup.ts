/**
 * Global test setup — preloaded by `bun test` via bunfig.toml.
 *
 * Ensures deterministic, hermetic output across all test runs.
 */

process.env.NO_COLOR = "1";
process.env.TZ = "UTC";
process.env.LC_ALL = "C";
process.env.COLUMNS = "120";
process.env.FORCE_TTY = "0";

// Deterministic timestamps when PHOTON_TEST_NOW is set.
if (process.env.PHOTON_TEST_NOW) {
  const frozen = Number(process.env.PHOTON_TEST_NOW);
  if (!Number.isFinite(frozen)) {
    throw new Error("PHOTON_TEST_NOW must be a finite number");
  }
  Date.now = () => frozen;
}

// Prevent accidental network calls — only loopback is allowed.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(
      `[test-guard] Blocked outbound fetch to ${parsed.hostname} — only 127.0.0.1 is allowed in tests.`,
    );
  }
  return _originalFetch(input, init);
}) as typeof fetch;
