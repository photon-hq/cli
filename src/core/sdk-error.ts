import {
  ApiError,
  ResponseValidationError,
  TransportError
} from '@photon-ai/api'
import { CLI_NAME } from '../meta.ts'
import {
  apiErrorOptions,
  parseApiProblem,
  safeRequestId,
  transportCode
} from './api-problem.ts'
import { CliError, type NextStep, SIGN_IN_EXIT_CODE } from './errors.ts'
import { NetworkError } from './network.ts'

export interface SdkErrorOptions {
  /**
   * A service's per-operation change to the mapped error, such as a message
   * that must name what the CLI already did. It never adds fix text.
   */
  override?: (error: CliError) => CliError
  sensitive?: boolean
  signal?: AbortSignal
}

const SIGN_IN_STEP: NextStep = {
  description: 'Sign in again',
  person: true,
  run: `${CLI_NAME} login`
}

const diagnosticOptions = (
  error: unknown,
  sensitive: boolean
): { cause?: unknown; debugSafe?: boolean } =>
  sensitive ? { debugSafe: false } : { cause: error }

const causeOfType = <Type>(
  error: unknown,
  type: new (...args: never[]) => Type
): Type | undefined => {
  const visited = new Set<unknown>()
  let current = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current)
    if (current instanceof type) {
      return current
    }
    current = 'cause' in current ? current.cause : undefined
  }
}

/**
 * The message of the NetworkError behind an error: the host the request went
 * to, or the proxy that couldn't be reached, and after a timeout the time
 * limit.
 */
export const networkErrorMessage = (error: unknown): string | undefined =>
  causeOfType(error, NetworkError)?.message

/**
 * An API problem as the CLI's error: the server's code unchanged, its detail
 * as the message, and its reason, remediation, issues and request ID. The
 * CLI writes no fix of its own for an API error, except signing in again
 * after a 401, which is the CLI's own step.
 */
export const apiProblemError = (
  error: ApiError,
  sensitive = false
): CliError => {
  const problem = parseApiProblem(error)
  const { detail, ...options } = apiErrorOptions(error, sensitive)
  const fallback = `Photon's API answered HTTP ${error.status.toString()}.`
  return new CliError(
    problem.code ?? 'API_ERROR',
    sensitive ? fallback : (detail ?? problem.title ?? fallback),
    {
      ...options,
      ...(error.status === 401
        ? { exitCode: SIGN_IN_EXIT_CODE, next: [SIGN_IN_STEP] }
        : {})
    }
  )
}

const sdkCliError = (
  error: unknown,
  sensitive: boolean
): CliError | undefined => {
  if (error instanceof ApiError) {
    return apiProblemError(error, sensitive)
  }
  if (error instanceof ResponseValidationError) {
    const requestId = safeRequestId(error.requestId)
    return new CliError(
      'API_PROTOCOL_ERROR',
      "Photon's response didn't match what this version of the CLI expects.",
      {
        ...diagnosticOptions(error, sensitive),
        ...(requestId === undefined ? {} : { requestId })
      }
    )
  }
  if (error instanceof TransportError) {
    return new CliError(
      'API_CONNECTION_ERROR',
      networkErrorMessage(error) ?? "Photon's API could not be reached.",
      {
        ...diagnosticOptions(error, sensitive),
        retryable: true,
        transportCode: transportCode(error)
      }
    )
  }
}

/**
 * The one mapper from SDK errors to the CLI's error. A CLI error found in the
 * cause chain is returned as it is; anything that isn't an SDK error is
 * returned unchanged.
 */
export const normalizeSdkError = (
  error: unknown,
  options: SdkErrorOptions = {}
): unknown => {
  options.signal?.throwIfAborted()
  const cliError = causeOfType(error, CliError)
  if (cliError !== undefined) {
    return cliError
  }
  const mapped = sdkCliError(error, options.sensitive ?? false)
  if (mapped === undefined) {
    return error
  }
  return options.override?.(mapped) ?? mapped
}
