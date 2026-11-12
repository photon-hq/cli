import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeviceTokenOutput, GetAccountOutput } from '@photon-ai/api'
import envPaths from 'env-paths'
import { BUILD_CONFIG } from '../../build-config.ts'
import { CliError } from '../../core/errors.ts'
import { CLI_NAME } from '../../meta.ts'
import type { ParsedAccountServiceKey } from '../account-service-key.ts'
import { parseAccountServiceKey } from '../account-service-key.ts'
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION,
  ACCOUNT_SERVICE_KEY_CREDENTIAL_SCHEMA_VERSION,
  API_ORIGIN,
  AUTH_SCHEMA_VERSION,
  CREDENTIAL_SCHEMA_VERSION
} from '../constants.ts'
import {
  type AccountServiceKeyCredentialSecret,
  type AuthMetadata,
  accountServiceKeyAuthMetadataSchema,
  authMetadataSchema,
  type CachedUser,
  type CredentialBackendKind,
  type CredentialSecret,
  type DeviceAuthMetadata,
  deviceAuthMetadataSchema,
  isAccountServiceKeyMetadata,
  type StoredCredentialSecret,
  type StoredSession,
  storedCredentialSecretSchema
} from '../types.ts'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  isMissingFileError,
  readPrivateFile,
  safeUnlink
} from './atomic-file.ts'
import {
  type CredentialBackend,
  defaultSecureBackendKind,
  FileCredentialBackend,
  KeychainCredentialBackend,
  SecretServiceCredentialBackend
} from './backends.ts'
import { withAuthLock } from './lock.ts'

interface AuthPaths {
  configDirectory: string
  credentialEntries: string
  credentials: string
  metadata: string
}

/** Makes the system keychain's backend for a credential. Tests pass a fake. */
export type SecureBackendFactory = (
  kind: Exclude<CredentialBackendKind, 'file'>,
  locator: string
) => CredentialBackend

export interface AuthRepositoryOptions {
  apiOrigin?: string
  configDirectory?: string
  platform?: NodeJS.Platform
  secureBackend?: SecureBackendFactory
}

export interface PreparedBackend {
  backend: CredentialBackend
  /**
   * Where a new sign-in goes if the keychain its probe picked then refuses
   * the write. A locked Linux keyring answers a lookup but can't store
   * without a prompt.
   */
  fileFallback?: PreparedBackend
  /** A new sign-in goes to a file because the system has no usable keychain. */
  keychainUnavailable?: boolean
  kind: CredentialBackendKind
  locator?: string
}

const storageCorrupt = (message: string, cause?: unknown): CliError =>
  new CliError('AUTH_STORAGE_CORRUPT', message, {
    cause,
    next: [
      {
        description: 'Remove the unreadable sign-in',
        run: `${CLI_NAME} logout --force`
      }
    ]
  })

const persistenceFailureMessage = (orphanedCredential: boolean): string =>
  orphanedCredential
    ? `Photon could not safely persist the authenticated session, and credential cleanup also failed. Run ${CLI_NAME} logout --force before retrying.`
    : 'Photon could not safely persist the authenticated session. Re-login may be required.'

const persistenceFailure = (
  cause: unknown,
  orphanedCredential = false
): CliError =>
  new CliError(
    'AUTH_PERSISTENCE_FAILED',
    persistenceFailureMessage(orphanedCredential),
    { cause }
  )

/**
 * The credential write itself failed. `leftNothing` says its cleanup
 * succeeded, so the sign-in can still go to another backend.
 */
class CredentialWriteFailure extends CliError {
  readonly leftNothing: boolean

  constructor(
    message: string,
    options: { cause: unknown; leftNothing: boolean }
  ) {
    super('AUTH_PERSISTENCE_FAILED', message, { cause: options.cause })
    this.leftNothing = options.leftNothing
  }
}

const parseJson = (serialized: string): unknown => {
  try {
    return JSON.parse(serialized) as unknown
  } catch (error) {
    throw storageCorrupt('Photon authentication data is malformed.', error)
  }
}

const parseMetadata = (serialized: string): AuthMetadata => {
  const result = authMetadataSchema.safeParse(parseJson(serialized))
  if (!result.success) {
    throw storageCorrupt(
      'Photon authentication metadata has an unsupported or malformed schema. It was not changed.',
      result.error
    )
  }
  return result.data
}

const parseCredential = (serialized: string): StoredCredentialSecret => {
  const result = storedCredentialSecretSchema.safeParse(parseJson(serialized))
  if (!result.success) {
    throw storageCorrupt(
      'Photon credentials are malformed. They were not changed.',
      result.error
    )
  }
  return result.data
}

const serialize = (value: unknown): string =>
  `${JSON.stringify(value, undefined, 2)}\n`

const normalizedOriginKey = (apiOrigin: string): string => {
  const { origin } = new URL(apiOrigin)
  const digest = createHash('sha256').update(origin).digest('hex').slice(0, 16)
  return `${new URL(origin).hostname}:${digest}`
}

const newCredentialLocator = (apiOrigin: string): string =>
  `${normalizedOriginKey(apiOrigin)}:${randomUUID()}`

const corruptCredentialPair = (): CliError =>
  storageCorrupt(
    'Photon authentication metadata does not match its credential. It was not changed.'
  )

const storedSession = (
  metadata: AuthMetadata,
  credentials: StoredCredentialSecret
): StoredSession => {
  if (isAccountServiceKeyMetadata(metadata)) {
    if (!('kind' in credentials)) {
      throw corruptCredentialPair()
    }
    const parsed = parseAccountServiceKey(credentials.credential)
    if (parsed?.serviceKeyId !== metadata.serviceKeyId) {
      throw corruptCredentialPair()
    }
    return { credentials, kind: 'account_service_key', metadata }
  }
  if ('kind' in credentials) {
    throw corruptCredentialPair()
  }
  return { credentials, kind: 'device', metadata }
}

export class AuthRepository {
  readonly paths: AuthPaths
  readonly #apiOrigin: string
  readonly #platform: NodeJS.Platform
  readonly #secureBackend: SecureBackendFactory | undefined

  constructor(options: AuthRepositoryOptions = {}) {
    const configDirectory =
      options.configDirectory ??
      envPaths(BUILD_CONFIG.stateNamespace, { suffix: '' }).config
    this.paths = {
      configDirectory,
      credentialEntries: join(configDirectory, 'credential-entries'),
      credentials: join(configDirectory, 'credentials.json'),
      metadata: join(configDirectory, 'auth.json')
    }
    this.#apiOrigin = new URL(options.apiOrigin ?? API_ORIGIN).origin
    this.#platform = options.platform ?? process.platform
    this.#secureBackend = options.secureBackend
  }

  async withLock<Result>(
    action: () => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    return await withAuthLock(this.paths.configDirectory, action, signal)
  }

  async loadMetadata(): Promise<AuthMetadata | undefined> {
    const serialized = await readPrivateFile(this.paths.metadata)
    return serialized === undefined ? undefined : parseMetadata(serialized)
  }

  async loadSession(signal?: AbortSignal): Promise<StoredSession | undefined> {
    const metadata = await this.loadMetadata()
    if (metadata === undefined) {
      return
    }

    const backend = this.#backendForMetadata(metadata)
    const serialized = await backend.read(signal)
    if (serialized === undefined) {
      throw storageCorrupt(
        'Photon found authentication metadata without its credential.'
      )
    }

    return storedSession(metadata, parseCredential(serialized))
  }

  async prepareLoginBackend(
    insecureStorage: boolean,
    existingMetadata: AuthMetadata | undefined,
    signal?: AbortSignal
  ): Promise<PreparedBackend> {
    await ensurePrivateDirectory(this.paths.configDirectory)

    if (existingMetadata !== undefined) {
      const backend = this.#backendForMetadata(existingMetadata)
      await backend.probe(signal)
      return {
        backend,
        kind: existingMetadata.backend,
        ...(existingMetadata.credentialLocator === undefined
          ? {}
          : { locator: existingMetadata.credentialLocator })
      }
    }

    return await this.#prepareNewBackend(insecureStorage, undefined, signal)
  }

  credentialBackend(metadata: AuthMetadata): CredentialBackend {
    return this.#backendForMetadata(metadata)
  }

  async prepareAccountServiceKeyBackend(
    insecureStorage: boolean,
    existingMetadata: AuthMetadata | undefined,
    signal?: AbortSignal
  ): Promise<PreparedBackend> {
    await ensurePrivateDirectory(this.paths.configDirectory)
    const locator = newCredentialLocator(this.#apiOrigin)
    if (existingMetadata === undefined) {
      return await this.#prepareNewBackend(insecureStorage, locator, signal)
    }
    const backend = this.#createBackend(existingMetadata.backend, locator)
    await backend.probe(signal)
    return { backend, kind: existingMetadata.backend, locator }
  }

  async createReplacementBackend(
    current: AuthMetadata,
    signal?: AbortSignal
  ): Promise<PreparedBackend> {
    if (current.backend === 'file') {
      const backend = this.#createBackend('file')
      await backend.probe(signal)
      return { backend, kind: 'file' }
    }

    const locator = newCredentialLocator(this.#apiOrigin)
    const backend = this.#createBackend(current.backend, locator)
    await backend.probe(signal)
    return { backend, kind: current.backend, locator }
  }

  createMetadata(
    backend: PreparedBackend,
    user: CachedUser,
    previous?: AuthMetadata
  ): DeviceAuthMetadata {
    const now = new Date().toISOString()
    return {
      apiOrigin: this.#apiOrigin,
      backend: backend.kind,
      cachedUser: user,
      createdAt: previous?.createdAt ?? now,
      ...(backend.locator === undefined
        ? {}
        : { credentialLocator: backend.locator }),
      schemaVersion: AUTH_SCHEMA_VERSION,
      updatedAt: now
    }
  }

  createAccountServiceKeyMetadata(
    backend: PreparedBackend,
    account: GetAccountOutput,
    serviceKey: ParsedAccountServiceKey,
    previous?: AuthMetadata
  ): AuthMetadata {
    if (backend.locator === undefined) {
      throw new CliError(
        'AUTH_PERSISTENCE_FAILED',
        'Photon could not create an isolated credential target.'
      )
    }
    const timestamp = new Date().toISOString()
    return accountServiceKeyAuthMetadataSchema.parse({
      accountId: account.accountId,
      apiOrigin: this.#apiOrigin,
      backend: backend.kind,
      createdAt: previous?.createdAt ?? timestamp,
      credentialKind: 'account_service_key',
      credentialLocator: backend.locator,
      email: account.email,
      lastVerifiedAt: timestamp,
      name: displayName(account.firstName, account.lastName),
      schemaVersion: ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION,
      serviceKeyId: serviceKey.serviceKeyId,
      updatedAt: timestamp
    })
  }

  async persistSessionLocked(
    credentials: StoredCredentialSecret,
    metadata: AuthMetadata,
    backend: CredentialBackend,
    previous?: StoredSession,
    signal?: AbortSignal
  ): Promise<{ orphanedPreviousCredential: boolean }> {
    storedSession(metadata, credentials)
    if (
      isAccountServiceKeyMetadata(metadata) &&
      (metadata.backend !== backend.kind ||
        metadata.credentialLocator !== backend.locator)
    ) {
      throw new CliError(
        'AUTH_PERSISTENCE_FAILED',
        'Photon refused to persist credentials to a mismatched storage target.'
      )
    }
    const oldBackend =
      previous === undefined
        ? undefined
        : this.#backendForMetadata(previous.metadata)
    const credentialTargetChanged =
      oldBackend !== undefined &&
      (oldBackend.kind !== backend.kind ||
        oldBackend.locator !== backend.locator)
    const newCredentialTarget =
      previous === undefined || credentialTargetChanged

    try {
      await backend.write(serialize(credentials), signal)
    } catch (error) {
      let orphanedCredential = false
      if (newCredentialTarget) {
        await backend.delete().catch(() => {
          orphanedCredential = true
          return false
        })
      }
      throw new CredentialWriteFailure(
        persistenceFailureMessage(
          isAccountServiceKeyMetadata(metadata) && orphanedCredential
        ),
        {
          cause: error,
          leftNothing: newCredentialTarget && !orphanedCredential
        }
      )
    }

    try {
      await atomicWritePrivateFile(this.paths.metadata, serialize(metadata))
    } catch (error) {
      let orphanedCredential = false
      if (newCredentialTarget) {
        await backend.delete().catch(() => {
          orphanedCredential = true
          return false
        })
      }
      throw persistenceFailure(
        error,
        isAccountServiceKeyMetadata(metadata) && orphanedCredential
      )
    }

    if (!credentialTargetChanged || oldBackend === undefined) {
      return { orphanedPreviousCredential: false }
    }

    try {
      await oldBackend.delete(signal)
      return { orphanedPreviousCredential: false }
    } catch {
      return { orphanedPreviousCredential: true }
    }
  }

  /**
   * Saves a sign-in from `photon login`. When the keychain that a new
   * sign-in's probe picked refuses the write, and the write left nothing
   * behind, the sign-in goes to `prepared.fileFallback` instead, as gh's
   * login saves to a file when its keyring write fails. A sign-in that
   * replaces a stored one keeps the existing error.
   */
  async persistSignInLocked(
    credentials: StoredCredentialSecret,
    prepared: PreparedBackend,
    metadataFor: (prepared: PreparedBackend) => AuthMetadata,
    previous?: StoredSession,
    signal?: AbortSignal
  ): Promise<{
    orphanedPreviousCredential: boolean
    prepared: PreparedBackend
  }> {
    try {
      const persisted = await this.persistSessionLocked(
        credentials,
        metadataFor(prepared),
        prepared.backend,
        previous,
        signal
      )
      return { ...persisted, prepared }
    } catch (error) {
      const { fileFallback } = prepared
      if (
        fileFallback === undefined ||
        previous !== undefined ||
        !(error instanceof CredentialWriteFailure && error.leftNothing) ||
        !(
          error.cause instanceof CliError &&
          error.cause.code === 'AUTH_STORAGE_UNAVAILABLE'
        )
      ) {
        throw error
      }
      signal?.throwIfAborted()
      await fileFallback.backend.probe(signal)
      const persisted = await this.persistSessionLocked(
        credentials,
        metadataFor(fileFallback),
        fileFallback.backend,
        undefined,
        signal
      )
      return { ...persisted, prepared: fileFallback }
    }
  }

  async updateVerifiedAccountLocked(
    metadata: AuthMetadata,
    account: GetAccountOutput
  ): Promise<AuthMetadata> {
    if (
      isAccountServiceKeyMetadata(metadata) &&
      (!ACCOUNT_ID_PATTERN.test(account.accountId) ||
        metadata.accountId !== account.accountId)
    ) {
      throw new CliError(
        'AUTH_PROTOCOL_ERROR',
        'Photon refused to cache an Account response for a different or invalid account identity.'
      )
    }
    const timestamp = new Date().toISOString()
    const updated = isAccountServiceKeyMetadata(metadata)
      ? accountServiceKeyAuthMetadataSchema.parse({
          ...metadata,
          email: account.email,
          lastVerifiedAt: timestamp,
          name: displayName(account.firstName, account.lastName),
          updatedAt: timestamp
        })
      : deviceAuthMetadataSchema.parse({
          ...metadata,
          cachedUser: {
            email: account.email,
            id: metadata.cachedUser.id,
            name: displayName(account.firstName, account.lastName)
          },
          lastVerifiedAccountId: account.accountId,
          lastVerifiedAt: timestamp,
          updatedAt: timestamp
        })
    await atomicWritePrivateFile(this.paths.metadata, serialize(updated))
    return updated
  }

  async removeSessionLocked(
    force: boolean,
    signal?: AbortSignal
  ): Promise<{ orphanedCredential: boolean; removed: boolean }> {
    let metadata: AuthMetadata | undefined
    try {
      metadata = await this.loadMetadata()
    } catch (error) {
      if (!force) {
        throw error
      }

      const legacy = await this.#removeLegacyFile(true)
      const entries = await this.#removeCredentialEntryFiles(true)
      const removedMetadata = await safeUnlink(this.paths.metadata)
      return {
        orphanedCredential: true,
        removed: legacy.removed || entries.removed || removedMetadata
      }
    }

    if (metadata === undefined) {
      const legacy = await this.#removeLegacyFile(force)
      const entries = await this.#removeCredentialEntryFiles(force)
      return {
        orphanedCredential: legacy.orphaned || entries.orphaned,
        removed: legacy.removed || entries.removed
      }
    }

    let orphanedCredential = false
    let removedCredential = false
    if (metadata.backend !== 'file') {
      const backend = this.#backendForMetadata(metadata)
      try {
        removedCredential = await backend.delete(signal)
      } catch (error) {
        if (!force) {
          throw error
        }
        orphanedCredential = true
      }
    }

    const legacy = await this.#removeLegacyFile(force)
    const entries = await this.#removeCredentialEntryFiles(force)
    const removedMetadata = await safeUnlink(this.paths.metadata)
    return {
      orphanedCredential:
        orphanedCredential || legacy.orphaned || entries.orphaned,
      removed:
        removedCredential ||
        legacy.removed ||
        entries.removed ||
        removedMetadata
    }
  }

  createCredential(
    accessToken: string,
    refreshToken: string,
    expiresAt: Date
  ): CredentialSecret {
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt.toISOString(),
      refreshToken,
      version: CREDENTIAL_SCHEMA_VERSION
    }
  }

  createAccountServiceKeyCredential(
    serviceKey: ParsedAccountServiceKey
  ): AccountServiceKeyCredentialSecret {
    return {
      credential: serviceKey.credential,
      kind: 'account_service_key',
      version: ACCOUNT_SERVICE_KEY_CREDENTIAL_SCHEMA_VERSION
    }
  }

  /**
   * Where a new sign-in goes: the system keychain, or a file only the user
   * can read, with `--insecure-storage` or when there's no usable keychain.
   * Without a `locator` the file is `credentials.json`, and a keychain
   * entry gets a new locator.
   */
  async #prepareNewBackend(
    insecureStorage: boolean,
    locator: string | undefined,
    signal?: AbortSignal
  ): Promise<PreparedBackend> {
    const file: PreparedBackend = {
      backend: this.#createBackend('file', locator),
      kind: 'file',
      ...(locator === undefined ? {} : { locator })
    }
    if (!insecureStorage) {
      try {
        const kind = defaultSecureBackendKind(this.#platform)
        const secureLocator = locator ?? newCredentialLocator(this.#apiOrigin)
        const backend = this.#createBackend(kind, secureLocator)
        await backend.probe(signal)
        return {
          backend,
          fileFallback: { ...file, keychainUnavailable: true },
          kind,
          locator: secureLocator
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (
          !(
            error instanceof CliError &&
            error.code === 'AUTH_STORAGE_UNAVAILABLE'
          )
        ) {
          throw error
        }
        await file.backend.probe(signal)
        return { ...file, keychainUnavailable: true }
      }
    }
    await file.backend.probe(signal)
    return file
  }

  #backendForMetadata(metadata: AuthMetadata): CredentialBackend {
    return this.#createBackend(metadata.backend, metadata.credentialLocator)
  }

  async #removeLegacyFile(
    force: boolean
  ): Promise<{ orphaned: boolean; removed: boolean }> {
    try {
      return {
        orphaned: false,
        removed: await safeUnlink(this.paths.credentials)
      }
    } catch (error) {
      if (!force) {
        throw error
      }
      return { orphaned: true, removed: false }
    }
  }

  async #removeCredentialEntryFiles(
    force: boolean
  ): Promise<{ orphaned: boolean; removed: boolean }> {
    let stats: Stats
    try {
      stats = await lstat(this.paths.credentialEntries)
    } catch (error) {
      if (isMissingFileError(error)) {
        return { orphaned: false, removed: false }
      }
      if (!force) {
        throw error
      }
      return { orphaned: true, removed: false }
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      const error = new CliError(
        'AUTH_STORAGE_UNSAFE',
        'Photon refused to clean an unsafe credential-entry directory.'
      )
      if (!force) {
        throw error
      }
      return { orphaned: true, removed: false }
    }

    let entries: string[]
    try {
      entries = await readdir(this.paths.credentialEntries)
    } catch (error) {
      if (!force) {
        throw error
      }
      return { orphaned: true, removed: false }
    }

    let orphaned = false
    let removed = false
    for (const entry of entries) {
      try {
        // The directory is reserved for isolated Photon credential files.
        // safeUnlink still rejects symlinks and non-regular entries.
        // biome-ignore lint/performance/noAwaitInLoops: cleanup must record each individual failure.
        const entryRemoved = await safeUnlink(
          join(this.paths.credentialEntries, entry)
        )
        removed = entryRemoved || removed
      } catch (error) {
        if (!force) {
          throw error
        }
        orphaned = true
      }
    }
    return { orphaned, removed }
  }

  #createBackend(
    kind: CredentialBackendKind,
    locator?: string
  ): CredentialBackend {
    if (kind === 'file') {
      if (locator === undefined) {
        return new FileCredentialBackend(this.paths.credentials)
      }
      const fileName = `${createHash('sha256').update(locator).digest('hex')}.json`
      return new FileCredentialBackend(
        join(this.paths.credentialEntries, fileName),
        locator
      )
    }

    if (locator === undefined) {
      throw storageCorrupt(
        'Photon secure credential metadata is missing its locator.'
      )
    }

    if (kind === 'keychain') {
      if (this.#platform !== 'darwin' && this.#platform !== 'win32') {
        throw new CliError(
          'AUTH_STORAGE_UNAVAILABLE',
          'These credentials belong to an unsupported operating-system keychain.'
        )
      }
      return (
        this.#secureBackend?.(kind, locator) ??
        new KeychainCredentialBackend(locator)
      )
    }

    if (this.#platform !== 'linux') {
      throw new CliError(
        'AUTH_STORAGE_UNAVAILABLE',
        'These credentials require Linux Secret Service.'
      )
    }
    return (
      this.#secureBackend?.(kind, locator) ??
      new SecretServiceCredentialBackend(locator)
    )
  }
}

export const cachedUserFromGrant = (
  user: DeviceTokenOutput['user']
): CachedUser => ({
  email: user.email,
  id: user.id,
  name: displayName(user.first_name, user.last_name)
})

export const displayName = (
  firstName: string | null,
  lastName: string | null
): string | null => {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim()
  return name.length === 0 ? null : name
}
