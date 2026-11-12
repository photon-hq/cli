import { CLI_NAME } from '../meta.ts'
import type { JsonDiagnosticValue } from './http-debug.ts'
import { interruptedExitCode } from './interrupt.ts'

/**
 * 0 is success and isn't an error's. 1 is a failure, 2 invalid usage or
 * input, 4 a sign-in that's needed, and 129, 130 and 143 the hangup,
 * interrupt and termination signals.
 */
export type CliExitCode = 1 | 2 | 4 | 129 | 130 | 143

/** The exit code for a run that needs a sign-in: no credential, or an expired or revoked one. */
export const SIGN_IN_EXIT_CODE = 4

export interface CliIssue {
  code?: string
  message: string
  path?: (number | string)[]
}

/**
 * One step of an error's `next`: what to do, and the command to run or the
 * page to open when there is one. `person` marks a step only a person can do.
 */
export interface NextStep {
  description: string
  person?: true
  run?: string
  url?: string
}

export type ProblemDetails = Readonly<Record<string, JsonDiagnosticValue>>

export interface CliErrorOptions {
  cause?: unknown | undefined
  debugSafe?: boolean | undefined
  detail?: string | undefined
  exitCode?: CliExitCode | undefined
  httpStatus?: number | undefined
  idempotencyKey?: string | undefined
  issues?: readonly CliIssue[] | undefined
  next?: readonly NextStep[] | undefined
  operationId?: string | undefined
  problem?: ProblemDetails | undefined
  problemType?: string | undefined
  reason?: string | undefined
  remoteOperationId?: string | undefined
  replayable?: boolean | undefined
  requestId?: string | undefined
  retryAfterSeconds?: number | undefined
  retryable?: boolean | undefined
  /** Photon gave this answer to a request sent with the key from the environment. */
  sentEnvironmentKey?: boolean | undefined
  suggestions?: readonly string[] | undefined
  transportCode?: string | undefined
}

export class CliError extends Error {
  readonly code: string
  readonly debugSafe: boolean
  readonly detail: string | undefined
  readonly exitCode: CliExitCode
  readonly httpStatus: number | undefined
  readonly idempotencyKey: string | undefined
  readonly issues: readonly CliIssue[]
  readonly next: readonly NextStep[]
  readonly operationId: string | undefined
  readonly problem: ProblemDetails | undefined
  readonly problemType: string | undefined
  readonly reason: string | undefined
  readonly remoteOperationId: string | undefined
  readonly replayable: boolean | undefined
  readonly requestId: string | undefined
  readonly retryAfterSeconds: number | undefined
  readonly retryable: boolean
  readonly sentEnvironmentKey: boolean
  /** Names the user may have meant. Text output only; JSON never has them. */
  readonly suggestions: readonly string[]
  readonly transportCode: string | undefined

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'CliError'
    this.code = code
    this.debugSafe = options.debugSafe ?? true
    this.detail = options.detail
    this.exitCode = options.exitCode ?? 1
    this.httpStatus = options.httpStatus
    this.idempotencyKey = options.idempotencyKey
    this.issues = options.issues ?? []
    this.next = options.next ?? []
    this.operationId = options.operationId
    this.problem = options.problem
    this.problemType = options.problemType
    this.reason = options.reason
    this.remoteOperationId = options.remoteOperationId
    this.replayable = options.replayable
    this.requestId = options.requestId
    this.retryAfterSeconds = options.retryAfterSeconds
    this.retryable = options.retryable ?? false
    this.sentEnvironmentKey = options.sentEnvironmentKey ?? false
    this.suggestions = options.suggestions ?? []
    this.transportCode = options.transportCode
  }
}

const ARGUMENT_NEXT: readonly NextStep[] = [
  { description: 'Run the command with --help for valid options.' }
]

export const argumentValidationError = (
  detail: string,
  options: CliErrorOptions = {}
): CliError =>
  new CliError('ARGUMENT_VALIDATION', 'The command contains invalid input.', {
    ...options,
    detail,
    exitCode: 2,
    next: options.next ?? ARGUMENT_NEXT
  })

export const hasOwnNextSteps = (error: CliError): boolean =>
  error.next.length > 0 && error.next !== ARGUMENT_NEXT

/** The step an argument error without steps of its own gets: the command's help. */
export const validOptionsStep = (commandPath: readonly string[]): NextStep => ({
  description: 'See the valid options',
  run: `${[CLI_NAME, ...commandPath].join(' ')} --help`
})

const optionalErrorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined

// The error an argument's parse function threw, which gunshi wraps in its own.
const parseError = (issue: unknown): CliError | undefined =>
  issue instanceof Error && issue.cause instanceof CliError
    ? issue.cause
    : undefined

// Gunshi's issues, each error once: a parse function may throw one error for
// several values.
const distinctIssues = (error: AggregateError): unknown[] => {
  const seen = new Set<unknown>()
  return error.errors.filter((issue) => {
    const key = parseError(issue) ?? issue
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const aggregateIssues = (issues: readonly unknown[]): CliIssue[] =>
  issues.map((issue) => ({
    message:
      parseError(issue)?.detail ??
      (issue instanceof Error ? issue.message : 'Invalid command argument.')
  }))

export const copyCliError = (
  error: CliError,
  options: CliErrorOptions,
  message = error.message
): CliError => {
  const copied = new CliError(error.code, message, {
    cause: error.cause,
    debugSafe: error.debugSafe,
    detail: error.detail,
    exitCode: error.exitCode,
    httpStatus: error.httpStatus,
    idempotencyKey: error.idempotencyKey,
    issues: error.issues,
    next: error.next,
    operationId: error.operationId,
    problem: error.problem,
    problemType: error.problemType,
    reason: error.reason,
    remoteOperationId: error.remoteOperationId,
    replayable: error.replayable,
    requestId: error.requestId,
    retryAfterSeconds: error.retryAfterSeconds,
    retryable: error.retryable,
    sentEnvironmentKey: error.sentEnvironmentKey,
    suggestions: error.suggestions,
    transportCode: error.transportCode,
    ...options
  })
  if (error.stack !== undefined) {
    copied.stack = error.stack
  }
  return copied
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/u

/**
 * Two pieces of error text as one, the first closed with a full stop when it
 * doesn't end a sentence yet, such as Photon's title "Forbidden".
 */
export const joinSentences = (first: string, second: string): string => {
  const head = first.trimEnd()
  return SENTENCE_END.test(head) ? `${head} ${second}` : `${head}. ${second}`
}

export const normalizeCliError = (error: unknown): CliError => {
  if (error instanceof CliError) {
    return error
  }

  if (error instanceof AggregateError) {
    const issues = distinctIssues(error)
    const [onlyIssue, ...otherIssues] = issues
    const onlyParseError =
      otherIssues.length === 0 ? parseError(onlyIssue) : undefined
    if (onlyParseError !== undefined) {
      return onlyParseError
    }
    return argumentValidationError(
      error.message || 'One or more command arguments are invalid.',
      { cause: error, issues: aggregateIssues(issues) }
    )
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new CliError('COMMAND_INTERRUPTED', 'The command was interrupted.', {
      cause: error,
      exitCode: interruptedExitCode(error)
    })
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return new CliError('COMMAND_TIMED_OUT', 'The command timed out.', {
      cause: error,
      detail: 'No final response was received before the timeout.',
      next: [{ description: 'Retry the command.' }],
      retryable: true,
      transportCode: optionalErrorCode(error) ?? error.name
    })
  }

  return new CliError(
    'UNEXPECTED_ERROR',
    'Photon encountered an unexpected error.',
    {
      cause: error,
      next: [{ description: 'Retry with --debug for diagnostic information.' }]
    }
  )
}
