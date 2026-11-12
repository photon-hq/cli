import type { EnvironmentKey } from '../auth/environment-key.ts'
import { environmentKeyIdentity } from '../auth/environment-key.ts'
import { CliError } from '../core/errors.ts'
import type { OperationJournal } from './repository.ts'
import { OPERATION_RETENTION_MS, type OperationRecord } from './types.ts'

interface MemoryOperationRepositoryOptions {
  apiOrigin: string
  key: EnvironmentKey
}

/**
 * The journal for a run with a key from the environment. It keeps this run's
 * operations in memory only, so nothing reaches the configuration directory,
 * and a failure can't be replayed after the run ends: the retry is the same
 * command with the same idempotency key.
 */
export class MemoryOperationRepository implements OperationJournal {
  readonly persistent = false
  readonly #apiOrigin: string
  readonly #key: EnvironmentKey
  readonly #records = new Map<string, OperationRecord>()

  constructor(options: MemoryOperationRepositoryOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#key = options.key
  }

  create(record: OperationRecord): Promise<void> {
    this.#records.set(record.operationId, record)
    return Promise.resolve()
  }

  expiresAt(now: number): string {
    return new Date(now + OPERATION_RETENTION_MS).toISOString()
  }

  get(operationId: string): Promise<OperationRecord> {
    const record = this.#records.get(operationId)
    return record === undefined
      ? Promise.reject(this.#notFound(operationId))
      : Promise.resolve(record)
  }

  identity(): Promise<{
    apiOrigin: string
    credentialKind: 'environment'
    identityId: string
  }> {
    return Promise.resolve({
      apiOrigin: this.#apiOrigin,
      credentialKind: 'environment',
      identityId: environmentKeyIdentity(this.#key)
    })
  }

  listActive(): Promise<OperationRecord[]> {
    return Promise.resolve([...this.#records.values()])
  }

  remove(operationId: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(operationId))
  }

  update(record: OperationRecord): Promise<void> {
    if (!this.#records.has(record.operationId)) {
      return Promise.reject(this.#notFound(record.operationId))
    }
    this.#records.set(record.operationId, record)
    return Promise.resolve()
  }

  async withReplayLease<Result>(
    _operationId: string,
    action: () => Promise<Result>
  ): Promise<Result> {
    return await action()
  }

  #notFound(operationId: string): CliError {
    return new CliError(
      'OPERATION_NOT_FOUND',
      'The local operation was not found.',
      {
        detail: `Photon keeps no local operations while ${this.#key.variable} is set, so ${operationId} isn't one.`
      }
    )
  }
}
