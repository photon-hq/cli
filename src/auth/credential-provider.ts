import { AsyncLocalStorage } from 'node:async_hooks'
import { CliError } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import {
  type EnvironmentKey,
  environmentKeyIdentity
} from './environment-key.ts'
import { notSignedInError } from './errors.ts'
import type { AuthRepository } from './storage/repository.ts'
import type { TokenManager } from './token-manager.ts'
import {
  type AuthIdentityDescriptor,
  authIdentityDescriptor,
  type CredentialKind,
  type StoredSession
} from './types.ts'

export type AccessTokenManager = Pick<
  TokenManager,
  'getAccessToken' | 'refreshAfterUnauthorized'
>

export interface BearerCredentialSnapshot {
  bearer: string
  identity: Pick<AuthIdentityDescriptor, 'publicId'> & {
    kind: BearerCredentialSnapshot['kind']
  }
  /** `environment` is a key from the environment, used as it is. */
  kind: CredentialKind | 'environment'
}

export interface BearerCredentialProvider {
  assertCurrent: (snapshot: BearerCredentialSnapshot) => Promise<void>
  getBearer: () => Promise<string>
  getSnapshot: () => Promise<BearerCredentialSnapshot>
  refreshAfterUnauthorized: (
    snapshot: BearerCredentialSnapshot
  ) => Promise<BearerCredentialSnapshot>
  withSnapshot: <Result>(
    snapshot: BearerCredentialSnapshot,
    action: () => Promise<Result>
  ) => Promise<Result>
}

interface StoredBearerCredentialProviderOptions {
  apiOrigin: string
  repository: AuthRepository
  signal?: AbortSignal
  tokenManager: TokenManager
}

const sessionChanged = (): CliError =>
  new CliError(
    'AUTH_SESSION_CHANGED',
    'Another Photon process changed the current session while the request was in flight.',
    { next: [{ description: 'Review auth status, then retry the command.' }] }
  )

const sameIdentity = (
  left: BearerCredentialSnapshot['identity'],
  right: AuthIdentityDescriptor
): boolean => left.kind === right.kind && left.publicId === right.publicId

const assertApiOrigin = (session: StoredSession, apiOrigin: string): void => {
  if (session.metadata.apiOrigin === apiOrigin) {
    return
  }
  throw new CliError(
    'AUTH_ORIGIN_MISMATCH',
    `Stored credentials are for ${session.metadata.apiOrigin}, but this CLI connects to ${apiOrigin}. Run ${CLI_NAME} logout, then ${CLI_NAME} login again.`
  )
}

export class DeviceTokenCredentialProvider implements BearerCredentialProvider {
  readonly #snapshots = new AsyncLocalStorage<BearerCredentialSnapshot>()
  readonly #tokenManager: AccessTokenManager

  constructor(tokenManager: AccessTokenManager) {
    this.#tokenManager = tokenManager
  }

  assertCurrent(_snapshot: BearerCredentialSnapshot): Promise<void> {
    return Promise.resolve()
  }

  async getBearer(): Promise<string> {
    return (this.#snapshots.getStore() ?? (await this.getSnapshot())).bearer
  }

  async getSnapshot(): Promise<BearerCredentialSnapshot> {
    return {
      bearer: await this.#tokenManager.getAccessToken(),
      identity: { kind: 'device', publicId: 'device' },
      kind: 'device'
    }
  }

  async refreshAfterUnauthorized(
    snapshot: BearerCredentialSnapshot
  ): Promise<BearerCredentialSnapshot> {
    return {
      ...snapshot,
      bearer: await this.#tokenManager.refreshAfterUnauthorized()
    }
  }

  async withSnapshot<Result>(
    snapshot: BearerCredentialSnapshot,
    action: () => Promise<Result>
  ): Promise<Result> {
    return await this.#snapshots.run(snapshot, action)
  }
}

/** The key from the environment: it is never refreshed or stored. */
export class EnvironmentBearerCredentialProvider
  implements BearerCredentialProvider
{
  readonly #snapshot: BearerCredentialSnapshot

  constructor(key: EnvironmentKey) {
    this.#snapshot = {
      bearer: key.secret,
      identity: { kind: 'environment', publicId: environmentKeyIdentity(key) },
      kind: 'environment'
    }
  }

  assertCurrent(_snapshot: BearerCredentialSnapshot): Promise<void> {
    return Promise.resolve()
  }

  getBearer(): Promise<string> {
    return Promise.resolve(this.#snapshot.bearer)
  }

  getSnapshot(): Promise<BearerCredentialSnapshot> {
    return Promise.resolve(this.#snapshot)
  }

  refreshAfterUnauthorized(
    snapshot: BearerCredentialSnapshot
  ): Promise<BearerCredentialSnapshot> {
    return Promise.resolve(snapshot)
  }

  async withSnapshot<Result>(
    _snapshot: BearerCredentialSnapshot,
    action: () => Promise<Result>
  ): Promise<Result> {
    return await action()
  }
}

export class StoredBearerCredentialProvider
  implements BearerCredentialProvider
{
  readonly #apiOrigin: string
  readonly #repository: AuthRepository
  readonly #signal: AbortSignal | undefined
  readonly #snapshots = new AsyncLocalStorage<BearerCredentialSnapshot>()
  readonly #tokenManager: TokenManager

  constructor(options: StoredBearerCredentialProviderOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#repository = options.repository
    this.#signal = options.signal
    this.#tokenManager = options.tokenManager
  }

  async assertCurrent(snapshot: BearerCredentialSnapshot): Promise<void> {
    const session = await this.#repository.loadSession(this.#signal)
    if (
      session === undefined ||
      !sameIdentity(snapshot.identity, authIdentityDescriptor(session.metadata))
    ) {
      throw sessionChanged()
    }
    assertApiOrigin(session, this.#apiOrigin)
  }

  async getBearer(): Promise<string> {
    return (this.#snapshots.getStore() ?? (await this.getSnapshot())).bearer
  }

  async getSnapshot(): Promise<BearerCredentialSnapshot> {
    const session = await this.#loadSession()
    const identity = authIdentityDescriptor(session.metadata)
    let snapshot: BearerCredentialSnapshot
    if (session.kind === 'account_service_key') {
      snapshot = {
        bearer: session.credentials.credential,
        identity,
        kind: 'account_service_key'
      }
    } else {
      snapshot = {
        bearer: await this.#tokenManager.getAccessToken(),
        identity,
        kind: 'device'
      }
    }
    await this.assertCurrent(snapshot)
    return snapshot
  }

  async refreshAfterUnauthorized(
    snapshot: BearerCredentialSnapshot
  ): Promise<BearerCredentialSnapshot> {
    await this.assertCurrent(snapshot)
    const refreshed: BearerCredentialSnapshot = {
      ...snapshot,
      bearer: await this.#tokenManager.refreshAfterUnauthorized()
    }
    await this.assertCurrent(refreshed)
    return refreshed
  }

  async withSnapshot<Result>(
    snapshot: BearerCredentialSnapshot,
    action: () => Promise<Result>
  ): Promise<Result> {
    return await this.#snapshots.run(snapshot, action)
  }

  async #loadSession(): Promise<StoredSession> {
    const session = await this.#repository.loadSession(this.#signal)
    if (session === undefined) {
      throw notSignedInError()
    }
    assertApiOrigin(session, this.#apiOrigin)
    return session
  }
}
