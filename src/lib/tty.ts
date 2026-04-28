/**
 * TTY / environment detection helpers. Centralized so every command
 * (and library code) makes the same decisions about color, prompts,
 * and progress feedback.
 */

/** Standard output is connected to a TTY. */
export const isTTY = (): boolean => Boolean(process.stdout.isTTY);

/** Standard input is connected to a TTY (so we can prompt). */
export const isStdinTTY = (): boolean => Boolean(process.stdin.isTTY);

/** Best-effort CI detection. Honors common CI env vars. */
export const isCI = (): boolean =>
  Boolean(
    process.env.CI ||
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.CIRCLECI ||
      process.env.BUILDKITE ||
      process.env.TF_BUILD // Azure Pipelines
  );

/**
 * Whether to render colors. Honors the [NO_COLOR](https://no-color.org)
 * standard plus our namespaced fallback `PHOTON_NO_COLOR`. Off if not a TTY.
 */
export const useColors = (): boolean =>
  isTTY() && !process.env.NO_COLOR && !process.env.PHOTON_NO_COLOR;

/**
 * Whether to show interactive UI: spinners, prompts, progress bars.
 * Off in CI even if stdout happens to be a TTY (some CI runners fake it).
 */
export const isInteractive = (): boolean =>
  isTTY() && isStdinTTY() && !isCI();
