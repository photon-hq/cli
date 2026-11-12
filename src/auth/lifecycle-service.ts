import {
  ApiError,
  type DeviceAuthorizeOutput,
  type GetAccountOutput,
  ResponseValidationError,
  TransportError
} from '@photon-ai/api'
import {
  type AccountService,
  isDeletedAccountError
} from '../account/service.ts'
import { apiErrorOptions, transportCode } from '../core/api-problem.ts'
import type { BrowserLauncher } from '../core/browser.ts'
import { CliError } from '../core/errors.ts'
import type { CliOutput } from '../core/output.ts'
import { inert } from '../core/presenter.ts'
import { networkErrorMessage } from '../core/sdk-error.ts'
import { browserBlocker } from '../core/terminal.ts'
import { CLI_NAME } from '../meta.ts'
import type { AccountServiceKeyInput } from './account-service-key.ts'
import { ACCOUNT_ID_PATTERN } from './constants.ts'
import {
  type PollClock,
  pollDeviceToken,
  systemPollClock,
  validateDeviceAuthorization
} from './device-flow.ts'
import type { EnvironmentKey } from './environment-key.ts'
import { environmentKeySet } from './errors.ts'
import {
  type AuthRepository,
  cachedUserFromGrant,
  displayName,
  type PreparedBackend
} from './storage/repository.ts'
import { accessTokenExpiresAt } from './token-expiry.ts'
import {
  type AuthMetadata,
  type AuthStatusResult,
  accountEmailSchema,
  type CredentialKind,
  type DeviceAuthScope,
  isAccountServiceKeyMetadata,
  type LoginOptions,
  type LoginResult,
  type LogoutResult,
  type StoredSession
} from './types.ts'

export type AccountServiceKeyVerifier = (
  credential: string
) => Promise<GetAccountOutput>

interface AuthLifecycleServiceOptions {
  accountService: AccountService
  accountServiceKeyInput: AccountServiceKeyInput
  accountServiceKeyVerifier: AccountServiceKeyVerifier
  apiOrigin: string
  browserLauncher: BrowserLauncher
  clock?: PollClock
  device: DeviceAuthScope
  env?: NodeJS.ProcessEnv
  /** The run's key from the environment, which outranks the stored sign-in. */
  environmentKey?: EnvironmentKey
  now?: () => number
  output: CliOutput
  repository: AuthRepository
  signal?: AbortSignal
}

interface DeviceLoginStart {
  existingMetadata: AuthMetadata | undefined
  existingSession: StoredSession | undefined
  replaceExistingBackend: boolean
  result: LoginResult | undefined
}

const authorizeError = (error: unknown): CliError => {
  if (error instanceof TransportError) {
    return new CliError(
      'AUTH_TEMPORARILY_UNAVAILABLE',
      'Photon could not reach the authentication server. Check your connection and retry.',
      {
        cause: error,
        detail:
          networkErrorMessage(error) ??
          'No final authentication response was received.',
        retryable: true,
        transportCode: transportCode(error)
      }
    )
  }

  if (error instanceof ResponseValidationError) {
    return new CliError(
      'AUTH_PROTOCOL_ERROR',
      'The authentication server returned an invalid device authorization.',
      {
        cause: error,
        detail: 'The response did not match the expected authorization schema.',
        retryable: true
      }
    )
  }

  if (error instanceof ApiError) {
    return new CliError(
      'AUTH_REQUEST_FAILED',
      'Photon could not start device authorization. Retry the login.',
      {
        ...apiErrorOptions(error),
        next: [
          { description: 'Review the error detail, then retry the login.' }
        ]
      }
    )
  }

  return error instanceof CliError
    ? error
    : new CliError(
        'AUTH_REQUEST_FAILED',
        'Photon could not start device authorization.',
        { cause: error }
      )
}

const serviceKeyVerificationError = (error: unknown): CliError => {
  if (error instanceof CliError) {
    return error
  }
  if (error instanceof TransportError) {
    return new CliError(
      'AUTH_TEMPORARILY_UNAVAILABLE',
      'Photon could not verify the account service key. Your current credentials were preserved.',
      {
        debugSafe: false,
        detail:
          networkErrorMessage(error) ??
          'No final account response was received.',
        retryable: true,
        transportCode: transportCode(error)
      }
    )
  }
  if (error instanceof ResponseValidationError) {
    return new CliError(
      'AUTH_PROTOCOL_ERROR',
      'Photon returned an invalid Account response. Your current credentials were preserved.',
      {
        debugSafe: false,
        detail: 'The response did not match the expected Account schema.',
        retryable: true
      }
    )
  }
  if (error instanceof ApiError) {
    const unavailable =
      error.status === 408 || error.status === 429 || error.status >= 500
    return new CliError(
      unavailable
        ? 'AUTH_TEMPORARILY_UNAVAILABLE'
        : 'AUTH_SERVICE_KEY_REJECTED',
      unavailable
        ? 'Photon could not verify the account service key. Your current credentials were preserved.'
        : 'Photon rejected the account service key. Your current credentials were preserved.',
      {
        ...apiErrorOptions(error, true),
        ...(unavailable
          ? {}
          : {
              next: [
                {
                  description:
                    'Check that the complete key was supplied and has not expired or been revoked.'
                }
              ]
            }),
        retryable: unavailable
      }
    )
  }
  return new CliError(
    'AUTH_REQUEST_FAILED',
    'Photon could not verify the account service key. Your current credentials were preserved.',
    {
      debugSafe: false
    }
  )
}

const invalidAccountServiceKeyAccount = (detail: string): CliError =>
  new CliError(
    'AUTH_PROTOCOL_ERROR',
    'Photon returned an invalid Account response. Your current credentials were preserved.',
    { debugSafe: false, detail, retryable: true }
  )

const assertCanonicalAccountServiceKeyAccount = (
  account: GetAccountOutput
): void => {
  if (!ACCOUNT_ID_PATTERN.test(account.accountId)) {
    throw invalidAccountServiceKeyAccount(
      'The Account response did not contain a canonical account ID.'
    )
  }
  if (!accountEmailSchema.safeParse(account.email).success) {
    throw invalidAccountServiceKeyAccount(
      'The Account response did not contain a valid email address.'
    )
  }
}

const canRestartDeviceLogin = (error: unknown): boolean =>
  error instanceof CliError &&
  (error.code === 'AUTH_SESSION_EXPIRED' ||
    error.code === 'NOT_AUTHENTICATED' ||
    isDeletedAccountError(error))

const rejectedAccountServiceKey = (
  error: unknown,
  metadata: AuthMetadata
): boolean =>
  isAccountServiceKeyMetadata(metadata) &&
  error instanceof CliError &&
  error.httpStatus === 401

const rejectedAuthentication = (error: unknown): boolean =>
  error instanceof CliError && error.httpStatus === 401

const metadataIdentity = (
  metadata: AuthMetadata
): {
  credentialKind?: CredentialKind
  email: string
  name: string | null
  serviceKeyId?: string
} =>
  isAccountServiceKeyMetadata(metadata)
    ? {
        credentialKind: 'account_service_key',
        email: metadata.email,
        name: metadata.name,
        serviceKeyId: metadata.serviceKeyId
      }
    : {
        email: metadata.cachedUser.email,
        name: metadata.cachedUser.name
      }

const authenticatedStatus = (
  apiOrigin: string,
  account: GetAccountOutput,
  session: StoredSession
): AuthStatusResult => {
  const result: AuthStatusResult = {
    accountId: account.accountId,
    apiOrigin,
    email: account.email,
    name: displayName(account.firstName, account.lastName),
    source: 'stored',
    state: 'authenticated',
    storage: session.metadata.backend
  }
  return session.kind === 'device'
    ? {
        ...result,
        credentialKind: 'device',
        expiresAt: session.credentials.accessTokenExpiresAt
      }
    : {
        ...result,
        credentialKind: 'account_service_key',
        serviceKeyId: session.metadata.serviceKeyId
      }
}

const failedStatus = (
  apiOrigin: string,
  error: unknown,
  metadata: AuthMetadata | undefined,
  session: StoredSession | undefined
): AuthStatusResult => {
  if (canRestartDeviceLogin(error)) {
    return {
      apiOrigin,
      reason: error instanceof Error ? error.message : 'Login required.',
      state: 'not_authenticated'
    }
  }
  const availableMetadata = session?.metadata ?? metadata
  const identity =
    availableMetadata === undefined
      ? undefined
      : metadataIdentity(availableMetadata)
  const rejectedServiceKey =
    availableMetadata !== undefined &&
    isAccountServiceKeyMetadata(availableMetadata) &&
    rejectedAuthentication(error)
  return {
    apiOrigin,
    reason:
      error instanceof CliError
        ? error.message
        : 'Photon could not verify authentication.',
    state: rejectedServiceKey ? 'not_authenticated' : 'unavailable',
    ...(error instanceof CliError && error.code === 'AUTH_STORAGE_CORRUPT'
      ? { next: error.next }
      : {}),
    ...(availableMetadata === undefined || identity === undefined
      ? {}
      : { ...identity, source: 'stored', storage: availableMetadata.backend }),
    ...(session?.kind === 'device'
      ? { expiresAt: session.credentials.accessTokenExpiresAt }
      : {})
  }
}

const sameSessionIdentity = (
  left: AuthMetadata,
  right: AuthMetadata
): boolean => {
  if (
    left.apiOrigin !== right.apiOrigin ||
    left.backend !== right.backend ||
    left.credentialLocator !== right.credentialLocator
  ) {
    return false
  }
  if (isAccountServiceKeyMetadata(left)) {
    return (
      isAccountServiceKeyMetadata(right) &&
      left.serviceKeyId === right.serviceKeyId
    )
  }
  return (
    !isAccountServiceKeyMetadata(right) &&
    left.cachedUser.id === right.cachedUser.id
  )
}

const matchesSessionSnapshot = (
  snapshot: StoredSession | undefined,
  current: StoredSession | undefined
): boolean =>
  snapshot === undefined
    ? current === undefined
    : current !== undefined &&
      sameSessionIdentity(snapshot.metadata, current.metadata)

export class AuthLifecycleService {
  readonly #accountService: AccountService
  readonly #accountServiceKeyInput: AccountServiceKeyInput
  readonly #accountServiceKeyVerifier: AccountServiceKeyVerifier
  readonly #apiOrigin: string
  readonly #browserLauncher: BrowserLauncher
  readonly #clock: PollClock
  readonly #device: DeviceAuthScope
  readonly #env: NodeJS.ProcessEnv
  readonly #environmentKey: EnvironmentKey | undefined
  readonly #now: () => number
  readonly #output: CliOutput
  readonly #repository: AuthRepository
  readonly #signal: AbortSignal | undefined

  constructor(options: AuthLifecycleServiceOptions) {
    this.#accountService = options.accountService
    this.#accountServiceKeyInput = options.accountServiceKeyInput
    this.#accountServiceKeyVerifier = options.accountServiceKeyVerifier
    this.#apiOrigin = options.apiOrigin
    this.#browserLauncher = options.browserLauncher
    this.#clock = options.clock ?? systemPollClock
    this.#device = options.device
    this.#env = options.env ?? process.env
    this.#environmentKey = options.environmentKey
    this.#now = options.now ?? Date.now
    this.#output = options.output
    this.#repository = options.repository
    this.#signal = options.signal
  }

  async login(options: LoginOptions): Promise<LoginResult> {
    if (this.#environmentKey !== undefined) {
      throw environmentKeySet(this.#environmentKey)
    }
    return options.serviceKey
      ? await this.#loginAccountServiceKey(options)
      : await this.#loginDevice(options)
  }

  async logout(force: boolean): Promise<LogoutResult> {
    return await this.#repository.withLock(async () => {
      let metadata: AuthMetadata | undefined
      try {
        metadata = await this.#repository.loadMetadata()
      } catch (error) {
        if (!force) {
          throw error
        }
      }
      const result = await this.#repository.removeSessionLocked(
        force,
        this.#signal
      )
      return {
        ...result,
        ...(metadata === undefined || !isAccountServiceKeyMetadata(metadata)
          ? {}
          : {
              credentialKind: 'account_service_key' as const
            }),
        ...(this.#environmentKey === undefined
          ? {}
          : { environmentVariable: this.#environmentKey.variable })
      }
    }, this.#signal)
  }

  async removeRevokedAccountServiceKey(
    serviceKeyId: string
  ): Promise<LogoutResult | undefined> {
    return await this.#repository.withLock(async () => {
      const metadata = await this.#repository.loadMetadata()
      if (
        metadata === undefined ||
        !isAccountServiceKeyMetadata(metadata) ||
        metadata.serviceKeyId !== serviceKeyId
      ) {
        return
      }
      return {
        ...(await this.#repository.removeSessionLocked(false, this.#signal)),
        credentialKind: 'account_service_key'
      }
    }, this.#signal)
  }

  async whoami(): Promise<GetAccountOutput> {
    if (this.#environmentKey === undefined) {
      this.#assertApiOrigin(await this.#repository.loadMetadata())
    }
    return await this.#accountService.get()
  }

  async status(): Promise<AuthStatusResult> {
    if (this.#environmentKey !== undefined) {
      return await this.#environmentKeyStatus(this.#environmentKey)
    }
    let metadata: AuthMetadata | undefined
    let session: StoredSession | undefined
    try {
      metadata = await this.#repository.loadMetadata()
      this.#assertApiOrigin(metadata)
      if (metadata === undefined) {
        return {
          apiOrigin: this.#apiOrigin,
          state: 'not_authenticated'
        }
      }

      session = await this.#repository.loadSession(this.#signal)
      if (session === undefined) {
        return {
          apiOrigin: this.#apiOrigin,
          state: 'not_authenticated'
        }
      }

      const account = await this.#accountService.get()
      const refreshed = await this.#repository.loadSession(this.#signal)
      return authenticatedStatus(this.#apiOrigin, account, refreshed ?? session)
    } catch (error) {
      return failedStatus(this.#apiOrigin, error, metadata, session)
    }
  }

  /**
   * The status of a key from the environment. The kind comes from the key
   * itself. Only an account service key is checked with the API, because
   * `GET /v1/account` is the one request that takes a key without a project.
   */
  async #environmentKeyStatus(key: EnvironmentKey): Promise<AuthStatusResult> {
    const result: AuthStatusResult = {
      apiOrigin: this.#apiOrigin,
      credentialKind: key.kind,
      ...(key.keyId === undefined ? {} : { keyId: key.keyId }),
      source: 'environment',
      state: 'unverified',
      variable: key.variable
    }
    if (key.kind !== 'account_service_key') {
      return {
        ...result,
        reason:
          key.kind === 'unknown'
            ? `${key.variable} doesn't hold a key in a format this CLI knows, so it wasn't checked. Photon's API decides whether it works.`
            : `Photon has no request that checks this kind of key without a project, so it wasn't checked.`
      }
    }
    try {
      const account = await this.#accountService.get()
      return {
        ...result,
        accountId: account.accountId,
        email: account.email,
        name: displayName(account.firstName, account.lastName),
        state: 'authenticated'
      }
    } catch (error) {
      this.#signal?.throwIfAborted()
      const rejected = rejectedAuthentication(error)
      return {
        ...result,
        reason:
          error instanceof CliError
            ? error.message
            : 'Photon could not verify authentication.',
        state: rejected ? 'not_authenticated' : 'unavailable',
        ...(rejected && error instanceof CliError ? { next: error.next } : {})
      }
    }
  }

  async #loginAccountServiceKey(options: LoginOptions): Promise<LoginResult> {
    const existingMetadata = await this.#repository.loadMetadata()
    this.#assertApiOrigin(existingMetadata)
    if (existingMetadata !== undefined && !options.force) {
      throw new CliError(
        'AUTH_SESSION_REPLACEMENT_REQUIRED',
        'Photon is already authenticated. Pass --force to replace the current session with an account service key.',
        {
          next: [
            {
              description: 'Sign in again with the key on standard input',
              run: `${CLI_NAME} login --service-key --force`
            }
          ]
        }
      )
    }

    const existingSession =
      existingMetadata === undefined
        ? undefined
        : await this.#repository.loadSession(this.#signal)
    const preparedBackend =
      await this.#repository.prepareAccountServiceKeyBackend(
        options.insecureStorage,
        existingMetadata,
        this.#signal
      )
    const serviceKey = await this.#accountServiceKeyInput.read()
    let account: GetAccountOutput
    try {
      account = await this.#accountServiceKeyVerifier(serviceKey.credential)
      assertCanonicalAccountServiceKeyAccount(account)
    } catch (error) {
      this.#signal?.throwIfAborted()
      throw serviceKeyVerificationError(error)
    }

    const credentials =
      this.#repository.createAccountServiceKeyCredential(serviceKey)
    const persistence = await this.#repository.withLock(async () => {
      const currentSession = await this.#repository.loadSession(this.#signal)
      if (!matchesSessionSnapshot(existingSession, currentSession)) {
        throw new CliError(
          'AUTH_SESSION_CHANGED',
          'Another Photon process changed the current session. The account service key was not saved.',
          {
            next: [{ description: 'Review auth status, then retry the login.' }]
          }
        )
      }
      return await this.#repository.persistSignInLocked(
        credentials,
        preparedBackend,
        (backend) =>
          this.#repository.createAccountServiceKeyMetadata(
            backend,
            account,
            serviceKey,
            currentSession?.metadata
          ),
        currentSession,
        this.#signal
      )
    }, this.#signal)

    if (persistence.orphanedPreviousCredential) {
      this.#output.warning(
        'The account service key is active, but an older credential entry could not be removed.'
      )
    }
    this.#warnFileStorage(persistence.prepared)
    return {
      accountId: account.accountId,
      alreadyAuthenticated: false,
      apiOrigin: this.#apiOrigin,
      credentialKind: 'account_service_key',
      email: account.email,
      name: displayName(account.firstName, account.lastName),
      serviceKeyId: serviceKey.serviceKeyId,
      storage: persistence.prepared.kind
    }
  }

  async #deviceLoginStart(options: LoginOptions): Promise<DeviceLoginStart> {
    let existingMetadata = await this.#repository.loadMetadata()
    this.#assertApiOrigin(existingMetadata)
    let existingSession: StoredSession | undefined
    let replaceExistingBackend = options.force

    if (existingMetadata !== undefined) {
      existingSession = await this.#repository.loadSession(this.#signal)
    }

    if (existingMetadata === undefined || options.force) {
      return {
        existingMetadata,
        existingSession,
        replaceExistingBackend,
        result: undefined
      }
    }

    await this.#repository.prepareLoginBackend(
      options.insecureStorage,
      existingMetadata,
      this.#signal
    )
    try {
      const account = await this.#accountService.get()
      const refreshed = await this.#repository.loadSession(this.#signal)
      const currentMetadata = refreshed?.metadata ?? existingMetadata
      return {
        existingMetadata,
        existingSession,
        replaceExistingBackend,
        result: {
          accountId: account.accountId,
          alreadyAuthenticated: true,
          apiOrigin: this.#apiOrigin,
          email: account.email,
          name: displayName(account.firstName, account.lastName),
          storage: currentMetadata.backend,
          ...(isAccountServiceKeyMetadata(currentMetadata)
            ? {
                credentialKind: 'account_service_key' as const,
                serviceKeyId: currentMetadata.serviceKeyId
              }
            : {})
        }
      }
    } catch (error) {
      const restartRejectedServiceKey = rejectedAccountServiceKey(
        error,
        existingMetadata
      )
      if (!(canRestartDeviceLogin(error) || restartRejectedServiceKey)) {
        throw error
      }
      replaceExistingBackend ||= restartRejectedServiceKey
      existingMetadata = await this.#repository.loadMetadata()
      existingSession = undefined
      if (restartRejectedServiceKey && existingMetadata !== undefined) {
        existingSession = await this.#repository.loadSession(this.#signal)
      }
      return {
        existingMetadata,
        existingSession,
        replaceExistingBackend,
        result: undefined
      }
    }
  }

  async #loginDevice(options: LoginOptions): Promise<LoginResult> {
    const start = await this.#deviceLoginStart(options)
    if (start.result !== undefined) {
      return start.result
    }
    const preparedBackend = await this.#prepareDeviceBackend(
      start.replaceExistingBackend,
      options.insecureStorage,
      start.existingMetadata
    )
    let authorization: DeviceAuthorizeOutput
    try {
      authorization = await this.#device.authorize(
        {},
        this.#signal === undefined ? undefined : { signal: this.#signal }
      )
      validateDeviceAuthorization(authorization)
    } catch (error) {
      this.#signal?.throwIfAborted()
      throw authorizeError(error)
    }

    this.#output.progress(
      inert(
        `Open ${authorization.verification_uri} and confirm code ${authorization.user_code}.`
      )
    )
    this.#output.progress(
      inert(
        `Or open ${authorization.verification_uri_complete}, which has the code filled in.`
      )
    )
    const noBrowser = browserBlocker({
      env: this.#env,
      noBrowser: options.noBrowser
    })
    if (noBrowser === undefined) {
      try {
        await this.#browserLauncher(authorization.verification_uri_complete)
      } catch {
        this.#output.warning(
          'The browser could not be opened. Continue with the printed URL and code.'
        )
      }
    } else {
      this.#output.progress(
        `No browser was opened because ${noBrowser}. Continue with the printed URL and code.`
      )
    }

    const grant = await this.#output.withLoading(
      'Waiting for browser authorization',
      async () =>
        await pollDeviceToken({
          authorization,
          clock: this.#clock,
          device: this.#device,
          ...(this.#signal === undefined ? {} : { signal: this.#signal })
        })
    )
    const receivedAt = this.#now()
    const credentials = this.#repository.createCredential(
      grant.access_token,
      grant.refresh_token,
      accessTokenExpiresAt(grant.access_token, grant.expires_in, receivedAt)
    )

    const persistence = await this.#repository.withLock(async () => {
      const currentSession =
        (await this.#repository.loadSession(this.#signal)) ??
        start.existingSession
      return await this.#repository.persistSignInLocked(
        credentials,
        preparedBackend,
        (backend) =>
          this.#repository.createMetadata(
            backend,
            cachedUserFromGrant(grant.user),
            currentSession?.metadata
          ),
        currentSession,
        this.#signal
      )
    }, this.#signal)

    if (persistence.orphanedPreviousCredential) {
      this.#output.warning(
        'The new login is active, but an older keychain entry could not be removed.'
      )
    }
    this.#warnFileStorage(persistence.prepared)

    return {
      alreadyAuthenticated: false,
      apiOrigin: this.#apiOrigin,
      email: grant.user.email,
      name: displayName(grant.user.first_name, grant.user.last_name),
      storage: persistence.prepared.kind
    }
  }

  #warnFileStorage(prepared: PreparedBackend): void {
    const { path } = prepared.backend
    if (path === undefined) {
      return
    }
    this.#output.warning(
      prepared.keychainUnavailable
        ? `The system keychain could not be used, so the sign-in was saved in plain text to ${path}.`
        : `The sign-in was saved in plain text to ${path}.`
    )
  }

  #assertApiOrigin(metadata: AuthMetadata | undefined): void {
    if (metadata === undefined || metadata.apiOrigin === this.#apiOrigin) {
      return
    }
    throw new CliError(
      'AUTH_ORIGIN_MISMATCH',
      `Stored credentials are for ${metadata.apiOrigin}, but this CLI connects to ${this.#apiOrigin}. Run ${CLI_NAME} logout, then ${CLI_NAME} login again.`
    )
  }

  async #prepareDeviceBackend(
    replaceExistingBackend: boolean,
    insecureStorage: boolean,
    existingMetadata: AuthMetadata | undefined
  ): Promise<PreparedBackend> {
    if (replaceExistingBackend && existingMetadata !== undefined) {
      return await this.#repository.createReplacementBackend(
        existingMetadata,
        this.#signal
      )
    }
    return await this.#repository.prepareLoginBackend(
      insecureStorage,
      existingMetadata,
      this.#signal
    )
  }
}
