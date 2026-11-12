import { randomUUID } from 'node:crypto'
import {
  ApiError,
  type CommitAccountProfilePictureOutput,
  type CreateAccountProfilePictureUploadOutput,
  type CreateAccountServiceKeyOutput,
  type GetAccountOutput,
  type ListAccountServiceKeysOutput,
  type PhotonNamespaces,
  type RequestOptions,
  type ResetAccountProfilePictureOutput,
  type RevokeAccountServiceKeyOutput,
  type UpdateAccountOutput
} from '@photon-ai/api'
import { z } from 'zod'
import { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { ACCOUNT_ID_PATTERN, API_ORIGIN } from '../auth/constants.ts'
import type { EnvironmentKey } from '../auth/environment-key.ts'
import type { AuthRepository } from '../auth/storage/repository.ts'
import type { TokenManager } from '../auth/token-manager.ts'
import { parseApiProblem } from '../core/api-problem.ts'
import {
  type AvatarFile,
  prepareAvatarFile,
  uploadAvatarFile
} from '../core/avatar.ts'
import { CliError, copyCliError, joinSentences } from '../core/errors.ts'
import { ID_FORMATS, validateId } from '../core/photon-id.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../core/request.ts'
import { apiProblemError, normalizeSdkError } from '../core/sdk-error.ts'
import { boundedText, invalidInput } from '../core/validation.ts'
import { CLI_NAME } from '../meta.ts'

type AccountNamespace = PhotonNamespaces['account']

export interface AccountServiceKey {
  accountId: string
  createdAt: string
  expiresAt: null | string
  name: string
  revokedAt: null | string
  serviceKeyId: string
}

export interface AccountServiceKeyCreateInput {
  expiresAt?: string
  name: string
}

export interface AccountServiceKeyCreation {
  secret: string
  serviceKey: AccountServiceKey
}

export type AccountScope = Pick<
  AccountNamespace,
  | 'commitProfilePicture'
  | 'createProfilePictureUpload'
  | 'get'
  | 'resetProfilePicture'
  | 'update'
> &
  Partial<
    Pick<
      AccountNamespace,
      | 'createAccountServiceKey'
      | 'listAccountServiceKeys'
      | 'revokeAccountServiceKey'
    >
  >

export interface AccountChanges {
  firstName?: string
  lastName?: null | string
}

interface AccountServiceOptions {
  account: AccountScope
  apiOrigin?: string
  /** The run's key from the environment, which outranks the stored sign-in. */
  environmentKey?: EnvironmentKey
  fetch?: typeof globalThis.fetch
  repository: AuthRepository
  request?: AuthenticatedRequest
  signal?: AbortSignal
  timeoutMs?: number
  tokenManager?: TokenManager
  warning?: (message: string) => void
}

type AccountRequest<Result> = (options?: RequestOptions) => Promise<Result>

export interface AccountRunOptions {
  idempotencyKey?: string
  sensitive?: boolean
}

const MAXIMUM_ACCOUNT_SERVICE_KEY_LIFETIME_DAYS = 3650
const MAXIMUM_ACCOUNT_SERVICE_KEY_NAME_LENGTH = 128
const MILLISECONDS_PER_DAY = 86_400_000
const ACCOUNT_SERVICE_KEY_ID_PATTERN = ID_FORMATS.accountServiceKey.pattern
const ACCOUNT_SERVICE_KEY_SECRET_PATTERN =
  /^pho_ask_[0-7][0-9a-hjkmnp-tv-z]{25}_[A-Za-z0-9_-]+$/u
const RFC3339_TIMESTAMP = z.iso.datetime({ offset: true })

const accountServiceKeySchema = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  createdAt: RFC3339_TIMESTAMP,
  expiresAt: RFC3339_TIMESTAMP.nullable(),
  name: z.string().min(1).max(MAXIMUM_ACCOUNT_SERVICE_KEY_NAME_LENGTH),
  revokedAt: RFC3339_TIMESTAMP.nullable(),
  serviceKeyId: z.string().regex(ACCOUNT_SERVICE_KEY_ID_PATTERN)
})

const accountServiceKeyCreationSchema = z
  .object({
    secret: z
      .string()
      .min(1)
      .max(512)
      .regex(ACCOUNT_SERVICE_KEY_SECRET_PATTERN),
    serviceKey: accountServiceKeySchema
  })
  .superRefine((result, context) => {
    if (!result.secret.startsWith(`${result.serviceKey.serviceKeyId}_`)) {
      context.addIssue({
        code: 'custom',
        message: 'The credential does not match the returned service key ID.',
        path: ['secret']
      })
    }
  })

const accountServiceKeyListSchema = z.object({
  serviceKeys: z.array(accountServiceKeySchema).max(25)
})

const accountServiceKeyRevocationSchema = z.object({
  serviceKey: accountServiceKeySchema
})

const serviceKeyProtocolError = (): CliError =>
  new CliError(
    'ACCOUNT_PROTOCOL_ERROR',
    'Photon returned an invalid account service key response.',
    {
      debugSafe: false,
      detail: 'The response did not match the safe service key schema.',
      retryable: true
    }
  )

const checkServiceKeyResponse = (schema: z.ZodType, value: unknown): void => {
  if (!schema.safeParse(value).success) {
    throw serviceKeyProtocolError()
  }
}

export const isAccountServiceKeyCreation = (
  value: unknown
): value is AccountServiceKeyCreation =>
  accountServiceKeyCreationSchema.safeParse(value).success

export const validateAccountServiceKeyId = (value: string): string =>
  validateId('accountServiceKey', value, 'Service key ID')

export const validateAccountServiceKeyCreateInput = (
  input: { expiresAt?: string; name: string; noExpiry: boolean },
  now: number = Date.now()
): AccountServiceKeyCreateInput => {
  if (input.expiresAt === undefined && !input.noExpiry) {
    throw invalidInput('Pass either --expires-at or --no-expiry.')
  }
  if (input.expiresAt !== undefined && input.noExpiry) {
    throw invalidInput('Pass either --expires-at or --no-expiry, not both.')
  }
  const name = boundedText(
    input.name,
    'Service key name',
    MAXIMUM_ACCOUNT_SERVICE_KEY_NAME_LENGTH
  )
  if (input.expiresAt === undefined) {
    return { name }
  }
  const expiresAt = boundedText(input.expiresAt, 'Expires-at', 128)
  if (!RFC3339_TIMESTAMP.safeParse(expiresAt).success) {
    throw invalidInput('Expires-at must be a valid RFC 3339 timestamp.')
  }
  const requestedExpiry = Date.parse(expiresAt)
  const latestExpiry =
    now + MAXIMUM_ACCOUNT_SERVICE_KEY_LIFETIME_DAYS * MILLISECONDS_PER_DAY
  if (requestedExpiry <= now) {
    throw invalidInput('Expires-at must be in the future.')
  }
  if (requestedExpiry > latestExpiry) {
    throw invalidInput(
      `Expires-at cannot be more than ${MAXIMUM_ACCOUNT_SERVICE_KEY_LIFETIME_DAYS.toString()} days in the future.`
    )
  }
  return { expiresAt: new Date(requestedExpiry).toISOString(), name }
}

const isDeletedAccount = (error: ApiError): boolean =>
  error.status === 410 || parseApiProblem(error).code === 'ACCOUNT_DELETED'

export const isDeletedAccountError = (error: unknown): boolean =>
  error instanceof CliError &&
  (error.httpStatus === 410 || error.code === 'ACCOUNT_DELETED')

export class AccountService {
  readonly #account: AccountScope
  readonly #apiOrigin: string
  readonly #environmentKey: EnvironmentKey | undefined
  readonly #fetch: typeof globalThis.fetch
  readonly #request: AuthenticatedRequest
  readonly #repository: AuthRepository
  readonly #signal: AbortSignal | undefined
  readonly #timeoutMs: number
  readonly #warning: (message: string) => void

  constructor(options: AccountServiceOptions) {
    if (options.request === undefined && options.tokenManager === undefined) {
      throw new TypeError(
        'AccountService requires an authenticated request or token manager.'
      )
    }
    this.#account = options.account
    this.#apiOrigin = options.apiOrigin ?? API_ORIGIN
    this.#environmentKey = options.environmentKey
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#request =
      options.request ??
      new AuthenticatedRequest({
        // The constructor guard above makes this fallback defined.
        tokenManager: options.tokenManager as TokenManager,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    this.#repository = options.repository
    this.#signal = options.signal
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#warning = options.warning ?? (() => undefined)
  }

  async get(): Promise<GetAccountOutput> {
    return await this.#runAccount(
      (options) => this.#account.get({}, options),
      true
    )
  }

  async update(
    changes: AccountChanges,
    idempotencyKey: string = randomUUID()
  ): Promise<UpdateAccountOutput> {
    return await this.#runAccount((options) =>
      this.#account.update(
        { body: changes, headers: { idempotencyKey } },
        options
      )
    )
  }

  async createServiceKey(
    input: AccountServiceKeyCreateInput,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateAccountServiceKeyOutput> {
    const create = this.#account.createAccountServiceKey
    if (create === undefined) {
      throw serviceKeyProtocolError()
    }
    const result = await this.run(
      (options) =>
        create({ body: input, headers: { idempotencyKey } }, options),
      { sensitive: true }
    )
    checkServiceKeyResponse(accountServiceKeyCreationSchema, result)
    await this.#assertServiceKeyAccountBinding([result.serviceKey])
    return result
  }

  async listServiceKeys(): Promise<ListAccountServiceKeysOutput> {
    const list = this.#account.listAccountServiceKeys
    if (list === undefined) {
      throw serviceKeyProtocolError()
    }
    const result = await this.run((options) => list({}, options), {
      sensitive: true
    })
    checkServiceKeyResponse(accountServiceKeyListSchema, result)
    await this.#assertServiceKeyAccountBinding(result.serviceKeys)
    return result
  }

  async revokeServiceKey(
    serviceKeyId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<RevokeAccountServiceKeyOutput> {
    const revoke = this.#account.revokeAccountServiceKey
    if (revoke === undefined) {
      throw serviceKeyProtocolError()
    }
    const result = await this.run(
      (options) =>
        revoke(
          {
            headers: { idempotencyKey },
            path: { serviceKeyId }
          },
          options
        ),
      { sensitive: true }
    )
    checkServiceKeyResponse(accountServiceKeyRevocationSchema, result)
    if (
      result.serviceKey.serviceKeyId !== serviceKeyId ||
      result.serviceKey.revokedAt === null
    ) {
      throw serviceKeyProtocolError()
    }
    await this.#assertServiceKeyAccountBinding([result.serviceKey])
    return result
  }

  async commitAvatar(
    uploadId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<CommitAccountProfilePictureOutput> {
    return await this.#runAccount((options) =>
      this.#account.commitProfilePicture(
        { body: { uploadId }, headers: { idempotencyKey } },
        options
      )
    )
  }

  async resetAvatar(
    idempotencyKey: string = randomUUID()
  ): Promise<ResetAccountProfilePictureOutput> {
    return await this.#runAccount((options) =>
      this.#account.resetProfilePicture(
        { headers: { idempotencyKey } },
        options
      )
    )
  }

  async uploadAvatar(
    fileOrPath: AvatarFile | string,
    idempotencyKey: string = randomUUID(),
    beforeCommit?: (uploadId: string) => Promise<void>
  ): Promise<CommitAccountProfilePictureOutput> {
    const file =
      typeof fileOrPath === 'string'
        ? await prepareAvatarFile(fileOrPath)
        : fileOrPath
    const upload = await this.run<CreateAccountProfilePictureUploadOutput>(
      (options) => {
        const headers = new Headers(options?.headers)
        headers.set('Idempotency-Key', `${idempotencyKey}:upload`)
        return this.#account.createProfilePictureUpload(
          { body: { contentType: file.contentType } },
          { ...options, headers }
        )
      }
    )
    await uploadAvatarFile(upload, file, {
      fetch: this.#fetch,
      protocolErrorCode: 'ACCOUNT_PROTOCOL_ERROR',
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      timeoutMs: this.#timeoutMs
    })
    await beforeCommit?.(upload.uploadId)
    return await this.commitAvatar(upload.uploadId, idempotencyKey)
  }

  // Runs an account-service request. Service key and 10DLC requests are
  // sensitive: their errors leave the API's wording out of diagnostics.
  async run<Result>(
    request: AccountRequest<Result>,
    options: AccountRunOptions = {}
  ): Promise<Result> {
    await this.#assertApiOrigin()
    try {
      return await this.#request.run(request)
    } catch (error) {
      try {
        return await this.#throwAccountError(
          error,
          false,
          options.sensitive ?? false
        )
      } catch (mappedError) {
        if (
          options.idempotencyKey === undefined ||
          !(mappedError instanceof CliError)
        ) {
          throw mappedError
        }
        throw copyCliError(mappedError, {
          idempotencyKey: options.idempotencyKey
        })
      }
    }
  }

  async #runAccount<Result extends GetAccountOutput>(
    request: AccountRequest<Result>,
    verification = false
  ): Promise<Result> {
    await this.#assertApiOrigin()
    let account: Result
    try {
      account = await this.#request.run(request)
    } catch (error) {
      return await this.#throwAccountError(error, verification)
    }
    await this.#rememberVerification(account)
    return account
  }

  async #throwAccountError(
    error: unknown,
    verification: boolean,
    sensitive = false
  ): Promise<never> {
    this.#signal?.throwIfAborted()
    if (
      error instanceof ApiError &&
      isDeletedAccount(error) &&
      this.#environmentKey === undefined
    ) {
      await this.#repository.withLock(async () => {
        await this.#repository.removeSessionLocked(false, this.#signal)
      }, this.#signal)
      throw copyCliError(
        apiProblemError(error, sensitive),
        {},
        'This Photon account was deleted. Local credentials were removed.'
      )
    }

    throw normalizeSdkError(error, {
      ...(verification && this.#environmentKey === undefined
        ? {
            override: (mapped: CliError) =>
              copyCliError(
                mapped,
                {},
                joinSentences(
                  mapped.message,
                  'Your credentials were preserved.'
                )
              )
          }
        : {}),
      sensitive,
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    })
  }

  async #assertServiceKeyAccountBinding(
    serviceKeys: readonly AccountServiceKey[]
  ): Promise<void> {
    if (this.#environmentKey !== undefined) {
      return
    }
    const metadata = await this.#repository.loadMetadata()
    if (
      metadata?.schemaVersion === 2 &&
      metadata.credentialKind === 'account_service_key' &&
      serviceKeys.some(
        (serviceKey) => serviceKey.accountId !== metadata.accountId
      )
    ) {
      throw serviceKeyProtocolError()
    }
  }

  async #assertApiOrigin(): Promise<void> {
    if (this.#environmentKey !== undefined) {
      return
    }
    const metadata = await this.#repository.loadMetadata()
    if (metadata === undefined || metadata.apiOrigin === this.#apiOrigin) {
      return
    }
    throw new CliError(
      'AUTH_ORIGIN_MISMATCH',
      `Stored credentials are for ${metadata.apiOrigin}, but this CLI connects to ${this.#apiOrigin}. Run ${CLI_NAME} logout, then ${CLI_NAME} login again.`
    )
  }

  async #rememberVerification(account: GetAccountOutput): Promise<void> {
    if (this.#environmentKey !== undefined) {
      return
    }
    try {
      await this.#repository.withLock(async () => {
        const session = await this.#repository.loadSession(this.#signal)
        if (session !== undefined) {
          await this.#repository.updateVerifiedAccountLocked(
            session.metadata,
            account
          )
        }
      }, this.#signal)
    } catch {
      this.#warning(
        'The account request succeeded, but Photon could not refresh cached local identity metadata.'
      )
    }
  }
}
