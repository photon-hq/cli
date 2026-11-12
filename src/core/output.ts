import { styleText } from 'node:util'
import ora from 'ora'
import {
  CliError,
  type CliIssue,
  type NextStep,
  type ProblemDetails
} from './errors.ts'
import {
  errorDiagnostic,
  type HttpBodyDiagnostic,
  type HttpTraceDiagnostic,
  type HttpTraceSource
} from './http-debug.ts'
import { inert } from './presenter.ts'
import { canShowSpinner, canUseColor } from './terminal.ts'

export interface WritableOutput {
  clearLine?: (direction: -1 | 0 | 1) => unknown
  cursorTo?: (x: number, y?: number) => unknown
  isTTY?: boolean
  moveCursor?: (dx: number, dy: number) => unknown
  /**
   * Calls `callback` once the chunk is written, or with the error, as Node's
   * and Bun's streams do. A writer may instead return a promise that settles
   * the same way.
   */
  write: (chunk: string, callback?: (error?: Error | null) => void) => unknown
}

export interface OutputOptions {
  color?: boolean
  /** `--color` was given, which beats `NO_COLOR` and its kin. */
  colorExplicit?: boolean
  debug?: boolean
  env?: NodeJS.ProcessEnv
  httpTrace?: HttpTraceSource
  json: boolean
  stderr?: WritableOutput
  stdout?: WritableOutput
}

export interface CliErrorPayload {
  code: string
  debug?: CliDebugPayload
  detail?: string
  docsUrl: string
  idempotencyKey?: string
  issues?: readonly CliIssue[]
  message: string
  next?: readonly NextStep[]
  operationId?: string
  problem?: ProblemDetails
  reason?: string
  remoteOperationId?: string
  replayable?: boolean
  requestId?: string
  retryAfterSeconds?: number
  retryable: boolean
  transportCode?: string
}

export interface CliDebugPayload {
  causes: DebugCause[]
  http?: HttpTraceDiagnostic
}

export interface DebugCause {
  message: string
  name: string
  stack?: string
}

export type OutputTarget = 'stderr' | 'stdout'

/** Where an error with no docs page of its own points: the CLI's error reference. */
export const CLI_ERROR_REFERENCE_URL =
  'https://photon.codes/docs/cli/output#errors'

const WEB_URL_PATTERN = /^https?:\/\//u
const TRAILING_PERIOD_PATTERN = /\.$/u
const RETRY_UNSAFE_HINT =
  "Trying again can work, but this command isn't safe to repeat: check first whether it took effect."
const BILLING_HINT =
  "Your organization's billing or plan has to change first. The docs page says how."
const CLIENT_ERROR_HINT =
  'Review the error detail and correct the request before retrying.'
const CLIENT_ERROR_DOCS_HINT =
  'Check the docs page for this error and correct the request before retrying.'
const SERVER_ERROR_HINT =
  "This failed on Photon's side. If it keeps happening, contact support with the request ID."

const WRITE_FAILURE_CODE = 'OUTPUT_WRITE_FAILED'
const WRITE_FAILURE_MESSAGE =
  'Photon could not write the result to standard output.'

// The streams a command waited on when one of its writes failed. That command
// reports the failure itself, so the stream's error event adds nothing.
const awaitedWriteFailures = new WeakSet<WritableOutput>()

// The errors `beforeWait` throws when its write fails. Nothing was recorded for
// them to replay, so `error()` reports them the way `writeFailure` does.
const waitWriteFailures = new WeakSet<CliError>()

/**
 * Whether a command awaited the write to `stream` that failed, through
 * `successAndFlush` or `beforeWait`, and so reports the failure itself.
 */
export const writeFailureSurfaced = (stream: WritableOutput): boolean =>
  awaitedWriteFailures.has(stream)

/** The problem's type page when it is a web page, else the CLI's error reference. */
export const errorDocsUrl = (error: CliError): string =>
  error.problemType !== undefined && WEB_URL_PATTERN.test(error.problemType)
    ? error.problemType
    : CLI_ERROR_REFERENCE_URL

/**
 * The hint that ends the text of an error with no step, chosen only by the
 * status, `retryable` and whether there is a detail to review, never by the
 * error. A retryable failure is unsafe to repeat when it is a recorded write
 * sent without an idempotency key; a safe one gets no hint, since repeating
 * it is the step.
 */
export const genericErrorHint = (error: CliError): string | undefined => {
  if (error.next.length > 0) {
    return
  }
  if (error.retryable) {
    return error.operationId !== undefined && error.idempotencyKey === undefined
      ? RETRY_UNSAFE_HINT
      : undefined
  }
  const status = error.httpStatus
  if (status === undefined || status < 400) {
    return
  }
  if (status === 402) {
    return BILLING_HINT
  }
  if (status >= 500) {
    return SERVER_ERROR_HINT
  }
  return error.detail !== undefined || typeof error.problem?.detail === 'string'
    ? CLIENT_ERROR_HINT
    : CLIENT_ERROR_DOCS_HINT
}

const stepText = (step: NextStep): string => {
  const target = step.run ?? step.url
  if (target === undefined && step.person !== true) {
    return step.description
  }
  const description = step.description.replace(TRAILING_PERIOD_PATTERN, '')
  const label = step.person ? `${description} (you do this)` : description
  return target === undefined ? label : `${label}: ${target}`
}

/** The `Next` lines of a text error: one line for one step, else a list. */
export const nextStepLines = (steps: readonly NextStep[]): string[] => {
  const [first, ...rest] = steps
  if (first === undefined) {
    return []
  }
  if (rest.length === 0) {
    return [`Next: ${stepText(first)}`]
  }
  return [
    'Next:',
    ...steps.map(
      (step, index) => `  ${(index + 1).toString()}. ${stepText(step)}`
    )
  ]
}
export type TextStyle = Parameters<typeof styleText>[0]

// The last value given for a boolean flag, read the way the parser reads the
// command line: the first "--" ends the options, and everything after it is an
// operand even when it starts with a dash (POSIX Utility Syntax Guideline 10).
// The parser never takes "--" as an option's value ("--org -- x" fails with
// "Option '--org' requires a value"), so the first one always ends them.
// Reading past it printed "nosuchcommand -- --json" as a JSON error, while
// "whoami -- --json", which parses and then fails on the unexpected argument,
// printed as text.
const lastFlagValue = (
  args: readonly string[],
  name: string,
  negatable = false
): boolean | undefined => {
  let value: boolean | undefined
  for (const arg of args) {
    if (arg === '--') {
      break
    }
    if (arg === `--${name}` || arg === `--${name}=true`) {
      value = true
    } else if (
      arg === `--${name}=false` ||
      (negatable && arg === `--no-${name}`)
    ) {
      value = false
    }
  }
  return value
}

export const outputOptionsFromArgs = (
  args: readonly string[]
): Pick<OutputOptions, 'color' | 'colorExplicit' | 'debug' | 'json'> => {
  const color = lastFlagValue(args, 'color', true)
  return {
    color: color ?? true,
    colorExplicit: color === true,
    debug: lastFlagValue(args, 'debug') ?? false,
    json: lastFlagValue(args, 'json') ?? false
  }
}

const debugCauses = (error: CliError): DebugCause[] => {
  const causes: DebugCause[] = []
  const visited = new Set<unknown>()
  let current: unknown = error
  while (
    current instanceof Error &&
    !(current instanceof CliError && !current.debugSafe) &&
    causes.length < 6 &&
    !visited.has(current)
  ) {
    visited.add(current)
    causes.push(errorDiagnostic(current))
    current = current.cause
  }
  return causes
}

const issueText = (issue: CliIssue): string => {
  const location = issue.path?.map(String).join('.')
  return location === undefined || location.length === 0
    ? issue.message
    : `${location}: ${issue.message}`
}

const errorHeadline = (error: CliError): string =>
  error.reason === undefined
    ? `${error.message} (${error.code})`
    : `${error.message} (${error.code}, ${error.reason})`

const replayableText = (value: boolean | undefined): string | undefined => {
  if (value === undefined) {
    return
  }
  return value ? 'yes' : 'no'
}

const bodyText = (body: HttpBodyDiagnostic): string => {
  if (body.kind === 'empty') {
    return '<empty>'
  }
  if (body.kind === 'json') {
    return JSON.stringify(body.value)
  }
  const details: string[] = [body.reason]
  if (body.mediaType !== undefined) {
    details.push(body.mediaType)
  }
  if (body.sizeBytes !== undefined) {
    details.push(`${body.sizeBytes.toString()} bytes`)
  }
  return `<omitted: ${details.join(', ')}>`
}

export class CliOutput {
  readonly #colorStderr: boolean
  readonly #colorStdout: boolean
  readonly #debug: boolean
  readonly #env: NodeJS.ProcessEnv
  readonly #httpTrace: HttpTraceSource | undefined
  readonly #json: boolean
  readonly #stderr: WritableOutput
  readonly #stdout: WritableOutput
  #wroteDocument = false

  constructor(options: OutputOptions) {
    this.#debug = options.debug ?? false
    this.#httpTrace = options.httpTrace
    this.#json = options.json
    this.#stderr = options.stderr ?? process.stderr
    this.#stdout = options.stdout ?? process.stdout
    this.#env = options.env ?? process.env
    const color = {
      color: options.color,
      colorExplicit: options.colorExplicit,
      env: this.#env,
      json: this.#json
    }
    this.#colorStderr = canUseColor(this.#stderr, color)
    this.#colorStdout = canUseColor(this.#stdout, color)
  }

  get json(): boolean {
    return this.#json
  }

  style(
    style: TextStyle,
    text: string,
    target: OutputTarget = 'stdout'
  ): string {
    const enabled = target === 'stdout' ? this.#colorStdout : this.#colorStderr
    return enabled ? styleText(style, text, { validateStream: false }) : text
  }

  success(data: object, human: string | string[]): void {
    if (this.#json) {
      this.#wroteDocument = true
      this.#write(this.#stdout, JSON.stringify(data))
      return
    }

    const lines = Array.isArray(human) ? human : [human]
    for (const line of lines) {
      this.#write(this.#stdout, line)
    }
  }

  /**
   * Writes a success payload and waits for each write's callback, which a
   * stream calls once the chunk has reached the operating system, or with the
   * error, such as a full disk or a closed pipe, that can arrive after
   * `write()` has returned. Secret-bearing commands use this before deleting
   * their write-ahead record, so a failed write leaves the operation
   * recoverable.
   */
  async successAndFlush(data: object, human: string | string[]): Promise<void> {
    if (this.#json) {
      this.#wroteDocument = true
      await this.#writeAndFlush(this.#stdout, JSON.stringify(data))
      return
    }

    const lines = Array.isArray(human) ? human : [human]
    for (const line of lines) {
      // biome-ignore lint/performance/noAwaitInLoops: preserve output order and acknowledgement.
      await this.#writeAndFlush(this.#stdout, line)
    }
  }

  /**
   * Writes what a person needs while the command waits, before the wait. Text
   * mode puts it on stdout, ahead of the result. JSON mode puts it on stderr,
   * so stdout holds only the document written when the wait ends.
   */
  async beforeWait(human: string[]): Promise<void> {
    const target = this.#json ? this.#stderr : this.#stdout
    try {
      for (const line of human) {
        // biome-ignore lint/performance/noAwaitInLoops: preserve output order and acknowledgement.
        await this.#writeAndFlush(target, line)
      }
    } catch (cause) {
      if (target !== this.#stdout) {
        throw cause
      }
      const error = new CliError(WRITE_FAILURE_CODE, WRITE_FAILURE_MESSAGE, {
        cause
      })
      waitWriteFailures.add(error)
      throw error
    }
  }

  /**
   * Writes help, version or usage text to stdout, as `console.log` would.
   * Gunshi renders it and leaves the writing to the CLI (`usageSilent`), so a
   * failed write reaches the stream's error event, which Bun's `console.log`
   * never emits.
   */
  usage(text: string): void {
    this.#write(this.#stdout, text)
  }

  /**
   * Reports a failed write to stdout that no command reported, in one line on
   * stderr: the headline of the error, or the error document with `--json`.
   * `--debug` adds the cause chain, as it does for other errors. A closed pipe
   * gets no message, since its reader is gone.
   */
  writeFailure(cause: unknown): void {
    if (cause instanceof Error && 'code' in cause && cause.code === 'EPIPE') {
      return
    }
    const error = new CliError(WRITE_FAILURE_CODE, WRITE_FAILURE_MESSAGE, {
      cause
    })
    if (this.#json) {
      this.#write(
        this.#stderr,
        JSON.stringify({ error: this.#errorPayload(error) })
      )
      return
    }
    const label = this.style('red', 'Error', 'stderr')
    this.#write(this.#stderr, `${label}: ${inert(errorHeadline(error))}`)
    this.#writeDebug(error)
  }

  progress(message: string): void {
    this.#write(this.#stderr, message)
  }

  /**
   * Writes a line for the person at the terminal to stderr, such as a list's
   * empty message. JSON mode leaves it out: its document is the whole answer.
   */
  notice(message: string): void {
    if (!this.#json) {
      this.#write(this.#stderr, message)
    }
  }

  async withLoading<Result>(
    message: string,
    action: () => Promise<Result>,
    options: { nonInteractive?: 'silent' | 'static' } = {}
  ): Promise<Result> {
    const animated = canShowSpinner(
      { stderr: this.#stderr, stdout: this.#stdout },
      { env: this.#env, json: this.#json }
    )
    const spinner = ora({
      color: this.#colorStderr ? 'cyan' : false,
      // Ora would otherwise put the terminal in raw mode to swallow keystrokes.
      // Raw mode stops Ctrl-C from raising SIGINT, and Ora's own re-raise never
      // runs here because nothing reads stdin, so Ctrl-C did nothing at all.
      discardStdin: false,
      isEnabled: animated,
      isSilent:
        this.#json || (!animated && options.nonInteractive === 'silent'),
      stream: this.#stderr as NodeJS.WritableStream,
      text: inert(message)
    }).start()
    try {
      return await action()
    } finally {
      spinner.stop()
    }
  }

  warning(message: string): void {
    const label = this.style('yellow', 'Warning:', 'stderr')
    this.#write(this.#stderr, `${label} ${inert(message)}`)
  }

  async completeDebug(): Promise<void> {
    await this.settleDebug()
    if (!this.#debug) {
      return
    }
    const http = this.#httpTrace?.snapshot()
    if (http === undefined) {
      return
    }
    if (this.#json) {
      this.#write(this.#stderr, JSON.stringify({ debug: { http } }))
      return
    }
    this.#writeDebugSection([], http)
  }

  async settleDebug(): Promise<void> {
    if (this.#debug) {
      await this.#httpTrace?.settle()
    }
  }

  /**
   * Writes an error. JSON mode puts its document on stdout, where it is the
   * command's one document, unless the command already wrote its result
   * there: then stdout keeps the result and the error goes to stderr.
   */
  error(error: CliError): void {
    if (waitWriteFailures.has(error)) {
      this.writeFailure(error.cause)
      return
    }
    if (this.#json) {
      this.#write(
        this.#wroteDocument ? this.#stderr : this.#stdout,
        JSON.stringify({ error: this.#errorPayload(error) })
      )
      return
    }

    this.#writeHumanError(error)
  }

  #writeHumanError(error: CliError): void {
    const label = this.style('red', 'Error', 'stderr')
    this.#write(this.#stderr, `${label}: ${inert(errorHeadline(error))}`)
    if (error.detail !== undefined) {
      this.#writeText(`Detail: ${error.detail}`)
    }
    this.#writeIssues(error)
    for (const name of error.suggestions) {
      this.#writeText(`Did you mean ${name}?`)
    }
    this.#writeNext(error)
    this.#writeMetadata(error)
    const hint = genericErrorHint(error)
    if (hint !== undefined) {
      this.#writeText(hint)
    }
    this.#writeDebug(error)
  }

  /** A line of an error or a debug trace, which carry text from the API. */
  #writeText(message: string): void {
    this.#write(this.#stderr, inert(message))
  }

  #writeIssues(error: CliError): void {
    const [only, ...others] = error.issues
    if (
      only === undefined ||
      (others.length === 0 && issueText(only) === error.detail)
    ) {
      return
    }
    this.#write(this.#stderr, 'Issues:')
    for (const issue of error.issues) {
      this.#writeText(`  - ${issueText(issue)}`)
    }
  }

  #writeNext(error: CliError): void {
    for (const line of nextStepLines(error.next)) {
      this.#writeText(line)
    }
  }

  #writeMetadata(error: CliError): void {
    const retryAfter =
      error.retryAfterSeconds === undefined
        ? undefined
        : `${error.retryAfterSeconds.toString()} seconds`
    const metadata: [string, number | string | undefined][] = [
      ['Request ID', error.requestId],
      ['Retry after', retryAfter],
      ['Transport code', error.transportCode],
      ['Operation ID', error.operationId],
      ['Remote operation', error.remoteOperationId],
      ['Idempotency key', error.idempotencyKey],
      ['Replayable', replayableText(error.replayable)],
      ['Docs', errorDocsUrl(error)]
    ]
    for (const [metadataLabel, value] of metadata) {
      if (value !== undefined) {
        this.#writeText(`${metadataLabel}: ${String(value)}`)
      }
    }
  }

  #writeDebug(error: CliError): void {
    if (!this.#debug) {
      return
    }
    const causes = debugCauses(error)
    const http = this.#httpTrace?.snapshot()
    if (
      causes.length === 0 &&
      http === undefined &&
      error.problem === undefined
    ) {
      return
    }
    this.#writeDebugSection(causes, http, error.problem)
  }

  #writeDebugSection(
    causes: readonly DebugCause[],
    http: HttpTraceDiagnostic | undefined,
    problem?: ProblemDetails
  ): void {
    this.#writeText('')
    this.#writeText('Debug:')
    if (problem !== undefined) {
      this.#writeText(`  Problem: ${JSON.stringify(problem)}`)
    }
    if (http !== undefined) {
      this.#writeHttpTrace(http)
    }
    if (causes.length === 0) {
      return
    }
    this.#writeText('  Cause chain:')
    for (const cause of causes) {
      this.#writeText(`    ${cause.name}: ${cause.message}`)
      if (cause.stack !== undefined) {
        for (const line of cause.stack.split('\n').slice(1)) {
          this.#writeText(`      ${line.trimStart()}`)
        }
      }
    }
  }

  #writeHttpTrace(trace: HttpTraceDiagnostic): void {
    this.#writeText('  HTTP exchanges:')
    for (const exchange of trace.exchanges) {
      this.#writeText(
        `    #${exchange.sequence.toString()} ${exchange.request.method} ${exchange.request.url}`
      )
      this.#writeText(`      Started: ${exchange.startedAt}`)
      if (exchange.request.queryParameterNames !== undefined) {
        this.#writeText(
          `      Query parameters: ${exchange.request.queryParameterNames.join(', ')}`
        )
      }
      this.#writeHeaders('Request headers', exchange.request.headers)
      this.#writeText(`      Request body: ${bodyText(exchange.request.body)}`)
      if (exchange.response !== undefined) {
        const statusText =
          exchange.response.statusText === undefined
            ? ''
            : ` ${exchange.response.statusText}`
        this.#writeText(
          `      Response: ${exchange.response.status.toString()}${statusText} (${exchange.durationMs.toString()} ms)`
        )
        this.#writeHeaders('Response headers', exchange.response.headers)
        this.#writeText(
          `      Response body: ${bodyText(exchange.response.body)}`
        )
      } else if (exchange.transportError !== undefined) {
        const code =
          exchange.transportError.code === undefined
            ? ''
            : ` [${exchange.transportError.code}]`
        this.#writeText(
          `      Transport error: ${exchange.transportError.name}${code}: ${exchange.transportError.message} (${exchange.durationMs.toString()} ms)`
        )
      }
    }
    if (trace.droppedExchangeCount > 0) {
      this.#writeText(
        `    ${trace.droppedExchangeCount.toString()} earlier exchange(s) omitted by the debug limit.`
      )
    }
  }

  #writeHeaders(
    label: string,
    headers: Readonly<Record<string, string>>
  ): void {
    const entries = Object.entries(headers)
    if (entries.length === 0) {
      this.#writeText(`      ${label}: <none>`)
      return
    }
    this.#writeText(`      ${label}:`)
    for (const [name, value] of entries) {
      this.#writeText(`        ${name}: ${value}`)
    }
  }

  #debugPayload(error: CliError): CliDebugPayload | undefined {
    if (!this.#debug) {
      return
    }
    const causes = debugCauses(error)
    const http = this.#httpTrace?.snapshot()
    if (causes.length === 0 && http === undefined) {
      return
    }
    return {
      causes,
      ...(http === undefined ? {} : { http })
    }
  }

  #errorPayload(error: CliError): CliErrorPayload {
    const debug = this.#debugPayload(error)
    return {
      code: error.code,
      message: error.message,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      retryable: error.retryable,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      docsUrl: errorDocsUrl(error),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.issues.length === 0 ? {} : { issues: error.issues }),
      ...(error.next.length === 0 ? {} : { next: error.next }),
      ...(error.problem === undefined ? {} : { problem: error.problem }),
      ...(error.transportCode === undefined
        ? {}
        : { transportCode: error.transportCode }),
      ...(error.operationId === undefined
        ? {}
        : { operationId: error.operationId }),
      ...(error.remoteOperationId === undefined
        ? {}
        : { remoteOperationId: error.remoteOperationId }),
      ...(error.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: error.idempotencyKey }),
      ...(error.replayable === undefined
        ? {}
        : { replayable: error.replayable }),
      ...(debug === undefined ? {} : { debug })
    }
  }

  #write(target: WritableOutput, message: string): void {
    target.write(`${message}\n`)
  }

  async #writeAndFlush(target: WritableOutput, message: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const result = target.write(`${message}\n`, (error) => {
        if (error) {
          awaitedWriteFailures.add(target)
          reject(error)
          return
        }
        resolve()
      })
      if (
        (typeof result === 'object' || typeof result === 'function') &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        Promise.resolve(result).then(() => resolve(), reject)
      }
    })
  }
}
