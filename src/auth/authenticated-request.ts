import { ApiError, type RequestOptions } from '@photon-ai/api'
import {
  apiErrorOptions,
  markEnvironmentKeyAnswer
} from '../core/api-problem.ts'
import { CliError, SIGN_IN_EXIT_CODE } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import {
  type AccessTokenManager,
  type BearerCredentialProvider,
  type BearerCredentialSnapshot,
  DeviceTokenCredentialProvider
} from './credential-provider.ts'
import { environmentKeyRejected } from './errors.ts'

interface AuthenticatedRequestOptions {
  credentialProvider?: BearerCredentialProvider
  signal?: AbortSignal
  tokenManager?: AccessTokenManager
}

interface AuthenticatedRunOptions {
  reauthenticate?: () => Promise<void>
}

const REAUTHENTICATION_ERROR_PATTERN =
  /(?:^|[,\s])error\s*=\s*"?insufficient_user_authentication"?/iu

const problemError = (error: ApiError): string | undefined => {
  if (typeof error.body !== 'object' || error.body === null) {
    return
  }
  let candidate: unknown
  if ('error' in error.body) {
    candidate = error.body.error
  } else if ('code' in error.body) {
    candidate = error.body.code
  }
  return typeof candidate === 'string' ? candidate : undefined
}

export const requiresReauthentication = (error: unknown): error is ApiError =>
  error instanceof ApiError &&
  error.status === 401 &&
  (problemError(error) === 'insufficient_user_authentication' ||
    REAUTHENTICATION_ERROR_PATTERN.test(
      error.headers.get('www-authenticate') ?? ''
    ))

const reauthenticationRequired = (error: ApiError): CliError =>
  new CliError(
    'AUTH_REAUTHENTICATION_REQUIRED',
    'This security change requires a recent Photon login.',
    {
      ...apiErrorOptions(error, true),
      exitCode: SIGN_IN_EXIT_CODE,
      next: [
        {
          description: 'Sign in again',
          person: true,
          run: `${CLI_NAME} login --force`
        }
      ]
    }
  )

const sameIdentity = (
  left: BearerCredentialSnapshot,
  right: BearerCredentialSnapshot
): boolean =>
  left.identity.kind === right.identity.kind &&
  left.identity.publicId === right.identity.publicId

export class AuthenticatedRequest {
  readonly #credentialProvider: BearerCredentialProvider
  readonly #signal: AbortSignal | undefined

  constructor(options: AuthenticatedRequestOptions) {
    this.#signal = options.signal
    if (options.credentialProvider !== undefined) {
      this.#credentialProvider = options.credentialProvider
    } else if (options.tokenManager === undefined) {
      throw new TypeError(
        'AuthenticatedRequest requires a credential provider.'
      )
    } else {
      this.#credentialProvider = new DeviceTokenCredentialProvider(
        options.tokenManager
      )
    }
  }

  async run<Result>(
    request: (options?: RequestOptions) => Promise<Result>,
    options: AuthenticatedRunOptions = {}
  ): Promise<Result> {
    const credential = await this.#credentialProvider.getSnapshot()

    try {
      return await this.#invoke(request, credential)
    } catch (error) {
      this.#signal?.throwIfAborted()
      if (error instanceof ApiError && credential.kind === 'environment') {
        markEnvironmentKeyAnswer(error)
      }
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error
      }

      await this.#credentialProvider.assertCurrent(credential)
      if (credential.kind === 'environment') {
        throw environmentKeyRejected(error)
      }
      if (credential.kind === 'account_service_key') {
        throw error
      }
      if (requiresReauthentication(error)) {
        return await this.#reauthenticateAndRetry(
          request,
          credential,
          error,
          options
        )
      }
      const refreshed =
        await this.#credentialProvider.refreshAfterUnauthorized(credential)
      return await this.#invoke(request, refreshed)
    }
  }

  async #reauthenticateAndRetry<Result>(
    request: (options?: RequestOptions) => Promise<Result>,
    credential: BearerCredentialSnapshot,
    challenge: ApiError,
    options: AuthenticatedRunOptions
  ): Promise<Result> {
    if (options.reauthenticate === undefined) {
      throw reauthenticationRequired(challenge)
    }
    await options.reauthenticate()
    this.#signal?.throwIfAborted()
    const freshCredential = await this.#credentialProvider.getSnapshot()
    if (!sameIdentity(credential, freshCredential)) {
      throw new CliError(
        'AUTH_SESSION_CHANGED',
        'The Photon account changed during reauthentication, so the security change was not retried.',
        {
          next: [{ description: 'Review auth status, then retry the command.' }]
        }
      )
    }
    try {
      return await this.#invoke(request, freshCredential)
    } catch (error) {
      if (requiresReauthentication(error)) {
        throw reauthenticationRequired(error)
      }
      throw error
    }
  }

  async #invoke<Result>(
    request: (options?: RequestOptions) => Promise<Result>,
    credential: BearerCredentialSnapshot
  ): Promise<Result> {
    return await this.#credentialProvider.withSnapshot(
      credential,
      async () => await request(this.#requestOptions())
    )
  }

  #requestOptions(): RequestOptions | undefined {
    return this.#signal === undefined ? undefined : { signal: this.#signal }
  }
}
