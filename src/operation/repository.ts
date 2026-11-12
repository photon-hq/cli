import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { notSignedInError } from '../auth/errors.ts'
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
  safeUnlink
} from '../auth/storage/atomic-file.ts'
import type { AuthRepository } from '../auth/storage/repository.ts'
import { authIdentityDescriptor, type CredentialKind } from '../auth/types.ts'
import { argumentValidationError, CliError } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import { withOperationLock } from './lock.ts'
import {
  OPERATION_ID_PATTERN,
  OPERATION_RETENTION_MS,
  type OperationRecord,
  operationRecordSchema
} from './types.ts'

interface OperationScope {
  apiOrigin: string
  credentialKind: CredentialKind
  directory: string
  identityId: string
  lockRoot: string
  scopeKey: string
}

interface OperationRepositoryOptions {
  apiOrigin: string
  authRepository: AuthRepository
  now?: () => number
  signal?: AbortSignal
  warning?: (message: string) => void
}

interface OperationRepositoryListOptions {
  corrupt?: 'skip' | 'throw'
}

/**
 * What the operation service needs from a journal. `persistent` says whether
 * a record outlives the run, so whether `operation replay` can pick it up.
 */
export interface OperationJournal {
  create: (record: OperationRecord) => Promise<void>
  expiresAt: (now: number) => string
  get: (operationId: string) => Promise<OperationRecord>
  identity: () => Promise<{
    apiOrigin: string
    credentialKind: CredentialKind | 'environment'
    identityId: string
  }>
  listActive: () => Promise<OperationRecord[]>
  readonly persistent: boolean
  remove: (operationId: string) => Promise<boolean>
  update: (record: OperationRecord) => Promise<void>
  withReplayLease: <Result>(
    operationId: string,
    action: () => Promise<Result>
  ) => Promise<Result>
}

const serialize = (value: unknown): string =>
  `${JSON.stringify(value, undefined, 2)}\n`

const storageFailure = (message: string, cause: unknown): CliError =>
  new CliError(
    cause instanceof CliError &&
      (cause.code === 'AUTH_STORAGE_UNSAFE' ||
        cause.code === 'AUTH_STORAGE_PERMISSIONS')
      ? 'OPERATION_STORAGE_UNSAFE'
      : 'OPERATION_STORAGE_UNAVAILABLE',
    message,
    {
      cause,
      next: [
        {
          description:
            'Check the Photon configuration directory permissions, then retry.'
        }
      ]
    }
  )

const journalCorrupt = (fileName: string, cause: unknown): CliError =>
  new CliError(
    'OPERATION_JOURNAL_CORRUPT',
    'A local operation record is malformed.',
    {
      cause,
      detail: `Photon could not validate operation record ${fileName}.`,
      next: [
        {
          description:
            'Inspect or remove the affected record from the private Photon configuration directory.'
        }
      ]
    }
  )

const parseRecord = (serialized: string, fileName: string): OperationRecord => {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw journalCorrupt(fileName, error)
  }
  const result = operationRecordSchema.safeParse(parsed)
  if (!result.success) {
    throw journalCorrupt(fileName, result.error)
  }
  return result.data
}

const scopeDigest = (
  apiOrigin: string,
  identityId: string,
  credentialKind: CredentialKind
): string => {
  // Preserve the physical path used by every existing Device-session journal.
  // ASK journals use a namespaced digest so a machine credential cannot inspect
  // or replay the human session's operations for the same Account.
  const input =
    credentialKind === 'device'
      ? `${apiOrigin}\0${identityId}`
      : `${apiOrigin}\0account_service_key\0${identityId}`
  return createHash('sha256').update(input).digest('hex')
}

const lockKey = (scopeKey: string, operationId: string): string =>
  createHash('sha256').update(`${scopeKey}\0${operationId}`).digest('hex')

const validateOperationId = (operationId: string): string => {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw argumentValidationError(
      'Operation ID must be a Photon local operation identifier.'
    )
  }
  return operationId
}

export class OperationRepository implements OperationJournal {
  readonly persistent = true
  readonly #apiOrigin: string
  readonly #authRepository: AuthRepository
  readonly #now: () => number
  readonly #signal: AbortSignal | undefined
  readonly #warning: (message: string) => void

  constructor(options: OperationRepositoryOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#authRepository = options.authRepository
    this.#now = options.now ?? Date.now
    this.#signal = options.signal
    this.#warning = options.warning ?? (() => undefined)
  }

  async create(record: OperationRecord): Promise<void> {
    const scope = await this.#scope()
    this.#assertRecordScope(record, scope)
    await this.#write(scope, record)
  }

  async identity(): Promise<{
    apiOrigin: string
    credentialKind: CredentialKind
    identityId: string
  }> {
    const scope = await this.#scope()
    return {
      apiOrigin: scope.apiOrigin,
      credentialKind: scope.credentialKind,
      identityId: scope.identityId
    }
  }

  async update(record: OperationRecord): Promise<void> {
    const scope = await this.#scope()
    this.#assertRecordScope(record, scope)
    const existing = await this.#read(scope, record.operationId)
    if (existing === undefined) {
      throw this.#notFound(record.operationId)
    }
    await this.#write(scope, record)
  }

  async get(operationId: string): Promise<OperationRecord> {
    const scope = await this.#scope()
    const fileId = validateOperationId(operationId)
    const record = await this.#read(scope, fileId)
    if (record === undefined) {
      throw this.#notFound(operationId)
    }
    this.#assertRecordScope(record, scope, fileId)
    return record
  }

  async list(
    options: OperationRepositoryListOptions = {}
  ): Promise<OperationRecord[]> {
    const scope = await this.#scope()
    try {
      await ensurePrivateDirectory(scope.directory)
      const entries = await readdir(scope.directory, { withFileTypes: true })
      const corruptFiles: string[] = []
      const records: OperationRecord[] = []
      for (const entry of entries) {
        if (
          entry.name.startsWith('.') ||
          !entry.name.endsWith('.json') ||
          !OPERATION_ID_PATTERN.test(entry.name.slice(0, -5))
        ) {
          continue
        }
        const operationId = entry.name.slice(0, -5)
        try {
          // readPrivateFile performs the authoritative regular-file and symlink checks.
          // biome-ignore lint/performance/noAwaitInLoops: records are intentionally validated one at a time.
          const record = await this.#read(scope, operationId)
          if (record !== undefined) {
            this.#assertRecordScope(record, scope, operationId)
            records.push(record)
          }
        } catch (error) {
          if (
            options.corrupt !== 'throw' &&
            error instanceof CliError &&
            error.code === 'OPERATION_JOURNAL_CORRUPT'
          ) {
            corruptFiles.push(entry.name)
            continue
          }
          throw error
        }
      }
      if (corruptFiles.length > 0) {
        this.#warning(
          `Photon skipped malformed local operation records: ${corruptFiles.join(', ')}.`
        )
      }
      return records.sort((left, right) => {
        const timestampOrder = right.updatedAt.localeCompare(left.updatedAt)
        return timestampOrder === 0
          ? right.operationId.localeCompare(left.operationId)
          : timestampOrder
      })
    } catch (error) {
      if (error instanceof CliError && error.code.startsWith('OPERATION_')) {
        throw error
      }
      throw storageFailure('Photon could not list local operations.', error)
    }
  }

  async listActive(
    options: OperationRepositoryListOptions = {}
  ): Promise<OperationRecord[]> {
    const records = await this.list(options)
    const active: OperationRecord[] = []
    for (const record of records) {
      if (Date.parse(record.expiresAt) > this.#now()) {
        active.push(record)
        continue
      }
      // biome-ignore lint/performance/noAwaitInLoops: journal removals must be individually durable.
      await this.remove(record.operationId)
    }
    return active
  }

  async remove(operationId: string): Promise<boolean> {
    const scope = await this.#scope()
    const validatedId = validateOperationId(operationId)
    try {
      return await safeUnlink(join(scope.directory, `${validatedId}.json`))
    } catch (error) {
      throw storageFailure(
        'Photon could not remove the local operation.',
        error
      )
    }
  }

  async purgeExpired(
    options: OperationRepositoryListOptions = {}
  ): Promise<number> {
    const records = await this.list(options)
    let removed = 0
    for (const record of records) {
      if (Date.parse(record.expiresAt) > this.#now()) {
        continue
      }
      // biome-ignore lint/performance/noAwaitInLoops: journal removals must be individually durable.
      if (await this.remove(record.operationId)) {
        removed += 1
      }
    }
    return removed
  }

  async withReplayLease<Result>(
    operationId: string,
    action: () => Promise<Result>
  ): Promise<Result> {
    const scope = await this.#scope()
    const validatedId = validateOperationId(operationId)
    return await withOperationLock(
      scope.lockRoot,
      lockKey(scope.scopeKey, validatedId),
      validatedId,
      action,
      this.#signal
    )
  }

  expiresAt(now: number): string {
    return new Date(now + OPERATION_RETENTION_MS).toISOString()
  }

  async #scope(): Promise<OperationScope> {
    const metadata = await this.#authRepository.loadMetadata()
    if (metadata === undefined) {
      throw notSignedInError()
    }
    const identity = authIdentityDescriptor(metadata)
    const identityId = identity.publicId
    const scopeKey = scopeDigest(this.#apiOrigin, identityId, identity.kind)
    const operationsRoot = join(
      this.#authRepository.paths.configDirectory,
      'operations'
    )
    return {
      apiOrigin: this.#apiOrigin,
      credentialKind: identity.kind,
      directory: join(operationsRoot, scopeKey),
      identityId,
      lockRoot: join(
        this.#authRepository.paths.configDirectory,
        'operation-locks'
      ),
      scopeKey
    }
  }

  /**
   * `fileId` names the file in this scope's directory a record was read from,
   * which `operation remove` deletes. A record a command is writing has none.
   */
  #assertRecordScope(
    record: OperationRecord,
    scope: OperationScope,
    fileId?: string
  ): void {
    if (
      record.apiOrigin !== scope.apiOrigin ||
      record.identityId !== scope.identityId ||
      (record.credentialKind ?? 'device') !== scope.credentialKind
    ) {
      throw new CliError(
        'OPERATION_SCOPE_MISMATCH',
        'The local operation belongs to a different Photon sign-in or API origin.',
        {
          next:
            fileId === undefined
              ? []
              : [
                  {
                    description: 'Remove the local record',
                    run: `${CLI_NAME} operation remove ${fileId} --yes`
                  }
                ],
          operationId: fileId ?? record.operationId
        }
      )
    }
  }

  async #read(
    scope: OperationScope,
    operationId: string
  ): Promise<OperationRecord | undefined> {
    const fileName = `${operationId}.json`
    let serialized: string | undefined
    try {
      serialized = await readPrivateFile(join(scope.directory, fileName))
    } catch (error) {
      throw storageFailure('Photon could not read the local operation.', error)
    }
    return serialized === undefined
      ? undefined
      : parseRecord(serialized, fileName)
  }

  async #write(scope: OperationScope, record: OperationRecord): Promise<void> {
    const fileName = `${record.operationId}.json`
    const validated = operationRecordSchema.safeParse(record)
    if (!validated.success) {
      throw journalCorrupt(fileName, validated.error)
    }
    try {
      await atomicWritePrivateFile(
        join(scope.directory, fileName),
        serialize(validated.data)
      )
    } catch (error) {
      throw storageFailure(
        'Photon could not persist the local operation.',
        error
      )
    }
  }

  #notFound(operationId: string): CliError {
    return new CliError(
      'OPERATION_NOT_FOUND',
      'The local operation was not found.',
      {
        detail: `No unresolved operation exists with ID ${operationId}.`,
        next: [
          {
            description: 'List unresolved operations',
            run: `${CLI_NAME} operation list`
          }
        ]
      }
    )
  }
}
