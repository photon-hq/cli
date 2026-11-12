/**
 * A stream as the terminal rules read it: whether it is a terminal, and
 * whether it can move its cursor.
 */
export interface TerminalStream {
  clearLine?: unknown
  cursorTo?: unknown
  isTTY?: boolean
  moveCursor?: unknown
}

/** The three standard streams, as the prompt rule reads them. */
export interface TerminalStreams {
  stderr: TerminalStream
  stdin: TerminalStream
  stdout: TerminalStream
}

/** What turns questions off besides the streams. */
export interface PromptOptions {
  env: NodeJS.ProcessEnv
  json: boolean
  noInput: boolean
}

export interface ColorOptions {
  color?: boolean | undefined
  /** `--color` was given on the command line, not left at its default. */
  colorExplicit?: boolean | undefined
  env: NodeJS.ProcessEnv
  json: boolean
}

/** Whether an on/off variable is on: any value but empty, `0` or `false`. */
export const isOn = (value: string | undefined): boolean =>
  value !== undefined &&
  value !== '' &&
  value !== '0' &&
  value.toLowerCase() !== 'false'

/** Whether the stream is a terminal, not a pipe or a file. */
export const isTerminal = (stream: TerminalStream): boolean =>
  stream.isTTY === true

/**
 * Why the CLI may not ask a question, or `undefined` when it may. It asks only
 * when standard input, output and error are all terminals, `CI` isn't on, and
 * there's no `--json`, `--no-input` or `PHOTON_NO_INPUT`.
 */
export const promptBlocker = (
  streams: TerminalStreams,
  options: PromptOptions
): string | undefined => {
  if (options.json) {
    return '--json is set'
  }
  if (options.noInput) {
    return '--no-input is set'
  }
  if (isOn(options.env.PHOTON_NO_INPUT)) {
    return 'PHOTON_NO_INPUT is set'
  }
  if (isOn(options.env.CI)) {
    return 'CI is set'
  }
  if (!isTerminal(streams.stdin)) {
    return 'standard input is not a terminal'
  }
  if (!isTerminal(streams.stdout)) {
    return 'standard output is not a terminal'
  }
  if (!isTerminal(streams.stderr)) {
    return 'standard error is not a terminal'
  }
}

/**
 * Why the CLI may not open a browser, or `undefined` when it may: not with
 * `--no-browser`, and not with `CI` on, where no one is at the machine.
 */
export const browserBlocker = (options: {
  env: NodeJS.ProcessEnv
  noBrowser: boolean
}): string | undefined => {
  if (options.noBrowser) {
    return '--no-browser is set'
  }
  if (isOn(options.env.CI)) {
    return 'CI is set'
  }
}

/** Whether the CLI may ask a question. */
export const canPrompt = (
  streams: TerminalStreams,
  options: PromptOptions
): boolean => promptBlocker(streams, options) === undefined

/**
 * Whether a spinner may animate on standard error: only when standard output
 * and error are terminals and error can move its cursor, `CI` isn't on,
 * `TERM` isn't `dumb`, and there's no `--json`.
 */
export const canShowSpinner = (
  streams: Pick<TerminalStreams, 'stderr' | 'stdout'>,
  options: Pick<PromptOptions, 'env' | 'json'>
): boolean =>
  !(options.json || isOn(options.env.CI)) &&
  options.env.TERM !== 'dumb' &&
  isTerminal(streams.stdout) &&
  isTerminal(streams.stderr) &&
  typeof streams.stderr.clearLine === 'function' &&
  typeof streams.stderr.cursorTo === 'function' &&
  typeof streams.stderr.moveCursor === 'function'

const forceColor = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return
  }
  return value !== '0' && value !== 'false'
}

/**
 * Whether text written to the stream may be styled. `--no-color` and `--json`
 * turn color off. An explicit `--color` styles a terminal whatever
 * `NO_COLOR`, `NO_COLORS`, `NODE_DISABLE_COLORS` or `FORCE_COLOR=0` say,
 * unless `TERM` is `dumb`. Otherwise `FORCE_COLOR` decides when it is set;
 * then `NO_COLOR`, `NO_COLORS`, `NODE_DISABLE_COLORS` or `TERM=dumb` turn
 * color off, and a terminal gets it.
 */
export const canUseColor = (
  stream: TerminalStream,
  options: ColorOptions
): boolean => {
  if (options.color === false || options.json) {
    return false
  }

  const { env } = options
  const forced = forceColor(env.FORCE_COLOR)
  if (options.colorExplicit === true) {
    return forced === true || (env.TERM !== 'dumb' && isTerminal(stream))
  }
  if (forced !== undefined) {
    return forced
  }
  if (
    (env.NO_COLOR !== undefined && env.NO_COLOR.length > 0) ||
    (env.NO_COLORS !== undefined && env.NO_COLORS.length > 0) ||
    env.NODE_DISABLE_COLORS !== undefined ||
    env.TERM === 'dumb'
  ) {
    return false
  }
  return isTerminal(stream)
}

/**
 * Whether a notice beside the command's output, such as a newer version, may
 * show: only when standard output and standard error are both terminals, and
 * not with `--json`, `TERM=dumb` or `CI` on.
 */
export const canShowNotice = (
  stdout: TerminalStream,
  stderr: TerminalStream,
  options: { env: NodeJS.ProcessEnv; json: boolean }
): boolean =>
  isTerminal(stdout) &&
  isTerminal(stderr) &&
  !options.json &&
  options.env.TERM !== 'dumb' &&
  !isOn(options.env.CI)
