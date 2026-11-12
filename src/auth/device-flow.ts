import {
  ApiError,
  type DeviceAuthorizeOutput,
  type DeviceTokenOutput,
  ResponseValidationError,
  TransportError
} from '@photon-ai/api'
import { CliError, SIGN_IN_EXIT_CODE } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import {
  DEVICE_GRANT_TYPE,
  MAX_DEVICE_AUTHORIZATION_LIFETIME_SECONDS,
  MAX_DEVICE_POLL_INTERVAL_SECONDS,
  MAX_POLL_BACKOFF_MS,
  MIN_POLL_INTERVAL_MS,
  OAUTH_SLOW_DOWN_MS
} from './constants.ts'
import { oauthErrorCode, validateDeviceToken } from './device-token.ts'
import type { DeviceAuthScope } from './types.ts'

export interface PollClock {
  now: () => number
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>
  wallNow: () => number
}

const abortedReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException('The authentication request was aborted.', 'AbortError')

export const systemPollClock: PollClock = {
  now: () => performance.now(),
  sleep: async (durationMs, signal) => {
    if (signal?.aborted) {
      throw abortedReason(signal)
    }

    await new Promise<void>((resolve, reject) => {
      const complete = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const timer = setTimeout(complete, durationMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal === undefined ? undefined : abortedReason(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
  wallNow: () => Date.now()
}

const positiveFinite = (
  value: number,
  field: string,
  maximum: number
): void => {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new CliError(
      'AUTH_PROTOCOL_ERROR',
      `The authentication server returned an invalid ${field}.`
    )
  }
}

const protocolError = (
  message: string,
  cause: unknown,
  requestId?: string
): CliError =>
  new CliError('AUTH_PROTOCOL_ERROR', message, {
    cause,
    ...(requestId === undefined ? {} : { requestId })
  })

const secureUrl = (value: string, field: string): void => {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw protocolError(
      `The authentication server returned an invalid ${field}.`,
      error
    )
  }

  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new CliError(
      'AUTH_PROTOCOL_ERROR',
      `The authentication server returned an unsafe ${field}.`
    )
  }
}

export const validateDeviceAuthorization = (
  authorization: DeviceAuthorizeOutput
): void => {
  positiveFinite(
    authorization.expires_in,
    'expires_in',
    MAX_DEVICE_AUTHORIZATION_LIFETIME_SECONDS
  )
  positiveFinite(
    authorization.interval,
    'interval',
    MAX_DEVICE_POLL_INTERVAL_SECONDS
  )
  if (
    authorization.device_code.length === 0 ||
    authorization.user_code.length === 0
  ) {
    throw new CliError(
      'AUTH_PROTOCOL_ERROR',
      'The authentication server returned an incomplete device authorization.'
    )
  }
  secureUrl(authorization.verification_uri, 'verification_uri')
  secureUrl(
    authorization.verification_uri_complete,
    'verification_uri_complete'
  )
}

const deviceCodeExpired = (requestId?: string): CliError =>
  new CliError('AUTH_DEVICE_CODE_EXPIRED', 'The login code expired.', {
    exitCode: SIGN_IN_EXIT_CODE,
    next: [
      { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
    ],
    ...(requestId === undefined ? {} : { requestId })
  })

const terminalOAuthError = (
  code: string,
  requestId: string | undefined
): CliError => {
  const options = requestId === undefined ? {} : { requestId }
  switch (code) {
    case 'access_denied':
      return new CliError(
        'AUTH_ACCESS_DENIED',
        'Login was denied in the browser.',
        options
      )
    case 'expired_token':
      return deviceCodeExpired(requestId)
    case 'server_error':
      return new CliError(
        'AUTH_SERVER_ERROR',
        'The authentication server could not complete this login. Start a new login.',
        options
      )
    case 'invalid_request':
    case 'unsupported_grant_type':
      return new CliError(
        'AUTH_PROTOCOL_ERROR',
        'The authentication server rejected the device request.',
        options
      )
    default:
      return new CliError(
        'AUTH_OAUTH_ERROR',
        'The authentication server returned an unsupported OAuth error.',
        options
      )
  }
}

const exponentialBackoff = (
  intervalMs: number,
  transientAttempt: number
): number =>
  Math.max(
    intervalMs,
    Math.min(
      MAX_POLL_BACKOFF_MS,
      intervalMs * 2 ** Math.min(transientAttempt, 6)
    )
  )

interface PollDeviceTokenOptions {
  authorization: DeviceAuthorizeOutput
  clock?: PollClock
  device: DeviceAuthScope
  signal?: AbortSignal
}

interface PollState {
  delayMs: number
  intervalMs: number
  transientAttempt: number
}

const transientState = (
  state: PollState,
  retryAfterMs: number | undefined
): PollState => {
  const transientAttempt = state.transientAttempt + 1
  return {
    ...state,
    delayMs: Math.max(
      exponentialBackoff(state.intervalMs, transientAttempt),
      retryAfterMs ?? 0
    ),
    transientAttempt
  }
}

const retryAfterMilliseconds = (
  error: ApiError,
  now: number
): number | undefined => {
  const value = error.headers.get('retry-after')
  if (value === null) {
    return
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

const apiErrorState = (
  error: ApiError,
  state: PollState,
  wallNow: number
): PollState => {
  const oauthError = oauthErrorCode(error)
  if (oauthError === 'authorization_pending') {
    return {
      ...state,
      delayMs: state.intervalMs,
      transientAttempt: 0
    }
  }

  if (oauthError === 'slow_down' || error.status === 429) {
    const intervalMs = state.intervalMs + OAUTH_SLOW_DOWN_MS
    return {
      delayMs: Math.max(
        intervalMs,
        retryAfterMilliseconds(error, wallNow) ?? 0
      ),
      intervalMs,
      transientAttempt: 0
    }
  }

  if (oauthError === 'server_error') {
    throw terminalOAuthError(oauthError, error.requestId)
  }

  if (error.status >= 500) {
    return transientState(state, retryAfterMilliseconds(error, wallNow))
  }

  if (oauthError !== undefined) {
    throw terminalOAuthError(oauthError, error.requestId)
  }

  throw new CliError(
    'AUTH_REQUEST_FAILED',
    'The authentication server rejected the login request.',
    {
      cause: error,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    }
  )
}

const nextPollState = (
  error: unknown,
  state: PollState,
  wallNow: number,
  signal?: AbortSignal
): PollState => {
  if (signal?.aborted) {
    throw abortedReason(signal)
  }
  if (error instanceof ApiError) {
    return apiErrorState(error, state, wallNow)
  }
  if (error instanceof TransportError) {
    return transientState(state, undefined)
  }
  if (error instanceof ResponseValidationError) {
    throw protocolError(
      'The authentication server returned an invalid token response.',
      error
    )
  }
  throw error
}

export const pollDeviceToken = async (
  options: PollDeviceTokenOptions
): Promise<DeviceTokenOutput> => {
  const clock = options.clock ?? systemPollClock
  const deadline =
    clock.now() + Math.floor(options.authorization.expires_in * 1000)
  const initialInterval = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.floor(options.authorization.interval * 1000)
  )
  let state: PollState = {
    delayMs: initialInterval,
    intervalMs: initialInterval,
    transientAttempt: 0
  }

  while (clock.now() < deadline) {
    const remainingMs = deadline - clock.now()
    // biome-ignore lint/performance/noAwaitInLoops: RFC 8628 requires serial polling after each server-directed delay.
    await clock.sleep(Math.min(state.delayMs, remainingMs), options.signal)
    if (clock.now() >= deadline) {
      break
    }

    try {
      const grant = await options.device.token(
        {
          body: {
            device_code: options.authorization.device_code,
            grant_type: DEVICE_GRANT_TYPE
          }
        },
        options.signal === undefined ? undefined : { signal: options.signal }
      )
      validateDeviceToken(grant)
      return grant
    } catch (error) {
      state = nextPollState(error, state, clock.wallNow(), options.signal)
    }
  }

  throw deviceCodeExpired()
}
