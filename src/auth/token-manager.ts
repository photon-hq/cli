import {
  ApiError,
  type DeviceTokenOutput,
  ResponseValidationError,
  TransportError
} from '@photon-ai/api'
import { apiErrorOptions, transportCode } from '../core/api-problem.ts'
import { CliError, SIGN_IN_EXIT_CODE } from '../core/errors.ts'
import { networkErrorMessage } from '../core/sdk-error.ts'
import { CLI_NAME } from '../meta.ts'
import {
  ACCESS_TOKEN_REFRESH_SKEW_MS,
  REFRESH_GRANT_TYPE
} from './constants.ts'
import { oauthErrorCode, validateDeviceToken } from './device-token.ts'
import { notSignedInError } from './errors.ts'
import {
  type AuthRepository,
  cachedUserFromGrant
} from './storage/repository.ts'
import { accessTokenExpiresAt } from './token-expiry.ts'
import type {
  CredentialSecret,
  DeviceAuthMetadata,
  DeviceAuthScope,
  DeviceStoredSession,
  StoredSession
} from './types.ts'

interface TokenManagerOptions {
  device: DeviceAuthScope
  now?: () => number
  repository: AuthRepository
  signal?: AbortSignal
}

const deviceSessionRequired = (session: StoredSession): DeviceStoredSession => {
  if (session.kind === 'device') {
    return session
  }
  throw new CliError(
    'AUTH_CREDENTIAL_KIND_MISMATCH',
    'The current account service key cannot enter the OAuth refresh flow.',
    {
      next: [
        {
          description: `Retry the request with the account service key, or run ${CLI_NAME} login --force to replace it.`
        }
      ]
    }
  )
}

const expiresAtMilliseconds = (credentials: CredentialSecret): number =>
  Date.parse(credentials.accessTokenExpiresAt)

const usableWithoutRefresh = (
  credentials: CredentialSecret,
  now: number
): boolean =>
  expiresAtMilliseconds(credentials) - ACCESS_TOKEN_REFRESH_SKEW_MS > now

const accessTokenStillValid = (
  credentials: CredentialSecret,
  now: number
): boolean => expiresAtMilliseconds(credentials) > now

const isTransientRefreshError = (error: unknown): boolean =>
  error instanceof TransportError ||
  (error instanceof ApiError && (error.status === 429 || error.status >= 500))

const expiredSessionError = (error: ApiError): CliError =>
  new CliError(
    'AUTH_SESSION_EXPIRED',
    `Your Photon session expired. Run ${CLI_NAME} login again.`,
    {
      ...apiErrorOptions(error, true),
      exitCode: SIGN_IN_EXIT_CODE,
      next: [
        { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
      ]
    }
  )

const refreshUnavailableError = (error: unknown): CliError => {
  const apiOptions =
    error instanceof ApiError ? apiErrorOptions(error, true) : {}
  const code = transportCode(error)
  return new CliError(
    'AUTH_TEMPORARILY_UNAVAILABLE',
    'Photon could not refresh your session. Your credentials were preserved; retry later.',
    {
      ...apiOptions,
      debugSafe: false,
      detail:
        networkErrorMessage(error) ??
        'The refresh request did not produce a usable final response.',
      retryable: true,
      ...(code === undefined ? {} : { transportCode: code })
    }
  )
}

const refreshProtocolError = (cause: unknown): CliError =>
  new CliError(
    'AUTH_PROTOCOL_ERROR',
    'The authentication server returned an invalid refresh response.',
    {
      cause,
      debugSafe: false,
      detail: 'The response did not match the expected refresh schema.',
      next: [
        { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
      ]
    }
  )

const refreshRejectedError = (error: ApiError): CliError =>
  new CliError(
    'AUTH_REFRESH_FAILED',
    'The authentication server rejected the session refresh. Your credentials were preserved.',
    {
      ...apiErrorOptions(error, true),
      exitCode: SIGN_IN_EXIT_CODE,
      next: [
        { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
      ]
    }
  )

const refreshPersistenceError = (cause: unknown): CliError =>
  new CliError(
    'AUTH_PERSISTENCE_FAILED',
    `Photon refreshed your session but could not save the rotated credentials. Run ${CLI_NAME} login again.`,
    { cause, debugSafe: false }
  )

export class TokenManager {
  readonly #device: DeviceAuthScope
  readonly #now: () => number
  readonly #repository: AuthRepository
  readonly #signal: AbortSignal | undefined
  #ambiguousRefresh:
    | {
        accessToken: string
        error: unknown
      }
    | undefined
  #cachedAccessToken: string | undefined
  #lastAccessToken: string | undefined

  constructor(options: TokenManagerOptions) {
    this.#device = options.device
    this.#now = options.now ?? Date.now
    this.#repository = options.repository
    this.#signal = options.signal
  }

  async getAccessToken(): Promise<string> {
    if (this.#cachedAccessToken !== undefined) {
      return this.#cachedAccessToken
    }
    const stored = await this.#repository.loadSession(this.#signal)
    if (stored === undefined) {
      throw notSignedInError()
    }
    const session = deviceSessionRequired(stored)

    const ambiguousRefresh = this.#ambiguousRefresh
    const sameSessionAsAmbiguousRefresh =
      ambiguousRefresh !== undefined &&
      session.credentials.accessToken === ambiguousRefresh.accessToken
    if (sameSessionAsAmbiguousRefresh) {
      if (accessTokenStillValid(session.credentials, this.#now())) {
        return this.#rememberAccessToken(session.credentials.accessToken)
      }
      throw refreshUnavailableError(ambiguousRefresh.error)
    }
    this.#ambiguousRefresh = undefined

    if (usableWithoutRefresh(session.credentials, this.#now())) {
      return this.#rememberAccessToken(session.credentials.accessToken)
    }

    return await this.#refresh(undefined)
  }

  async refreshAfterUnauthorized(): Promise<string> {
    const rejectedAccessToken = this.#lastAccessToken
    this.#cachedAccessToken = undefined
    return await this.#refresh(rejectedAccessToken)
  }

  async #refresh(rejectedAccessToken: string | undefined): Promise<string> {
    return await this.#repository.withLock(
      () => this.#refreshLocked(rejectedAccessToken),
      this.#signal
    )
  }

  async #refreshLocked(
    rejectedAccessToken: string | undefined
  ): Promise<string> {
    const stored = await this.#repository.loadSession(this.#signal)
    if (stored === undefined) {
      throw notSignedInError()
    }
    const session = deviceSessionRequired(stored)

    const anotherProcessRefreshed =
      rejectedAccessToken !== undefined &&
      session.credentials.accessToken !== rejectedAccessToken
    const freshAfterLock =
      rejectedAccessToken === undefined &&
      usableWithoutRefresh(session.credentials, this.#now())
    if (anotherProcessRefreshed || freshAfterLock) {
      if (anotherProcessRefreshed) {
        this.#ambiguousRefresh = undefined
      }
      return this.#rememberAccessToken(session.credentials.accessToken)
    }

    const ambiguousRefresh = this.#ambiguousRefresh
    const wouldRepeatAmbiguousRefresh =
      rejectedAccessToken !== undefined &&
      ambiguousRefresh !== undefined &&
      session.credentials.accessToken === rejectedAccessToken &&
      session.credentials.accessToken === ambiguousRefresh.accessToken
    if (wouldRepeatAmbiguousRefresh) {
      throw refreshUnavailableError(ambiguousRefresh.error)
    }

    const grant = await this.#requestRefresh(session)
    if (grant === undefined) {
      if (rejectedAccessToken !== undefined) {
        throw refreshUnavailableError(this.#ambiguousRefresh?.error)
      }
      return this.#rememberAccessToken(session.credentials.accessToken)
    }

    const credentials = this.#repository.createCredential(
      grant.access_token,
      grant.refresh_token,
      accessTokenExpiresAt(grant.access_token, grant.expires_in, this.#now())
    )
    const metadata: DeviceAuthMetadata = {
      ...session.metadata,
      cachedUser: cachedUserFromGrant(grant.user),
      updatedAt: new Date(this.#now()).toISOString()
    }
    const backend = this.#repository.credentialBackend(metadata)
    try {
      await this.#repository.persistSessionLocked(
        credentials,
        metadata,
        backend,
        session,
        this.#signal
      )
    } catch (error) {
      throw refreshPersistenceError(error)
    }
    return this.#rememberAccessToken(credentials.accessToken)
  }

  async #requestRefresh(
    session: DeviceStoredSession
  ): Promise<DeviceTokenOutput | undefined> {
    this.#ambiguousRefresh = undefined
    try {
      const grant = await this.#device.token(
        {
          body: {
            grant_type: REFRESH_GRANT_TYPE,
            refresh_token: session.credentials.refreshToken
          }
        },
        this.#signal === undefined ? undefined : { signal: this.#signal }
      )
      validateDeviceToken(grant)
      return grant
    } catch (error) {
      this.#signal?.throwIfAborted()
      const invalidGrant =
        error instanceof ApiError && oauthErrorCode(error) === 'invalid_grant'
      if (invalidGrant) {
        await this.#repository.removeSessionLocked(false, this.#signal)
        throw expiredSessionError(error)
      }

      if (!isTransientRefreshError(error)) {
        if (error instanceof ResponseValidationError) {
          throw refreshProtocolError(error)
        }
        if (error instanceof ApiError) {
          throw refreshRejectedError(error)
        }
        throw error
      }
      this.#ambiguousRefresh = {
        accessToken: session.credentials.accessToken,
        error
      }
      if (accessTokenStillValid(session.credentials, this.#now())) {
        return
      }
      throw refreshUnavailableError(error)
    }
  }

  #rememberAccessToken(accessToken: string): string {
    this.#cachedAccessToken = accessToken
    this.#lastAccessToken = accessToken
    return accessToken
  }
}
