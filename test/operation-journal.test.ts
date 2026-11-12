import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { API_ORIGIN } from '../src/auth/constants.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { CLI_NAME } from '../src/meta.ts'
import { OperationRepository } from '../src/operation/repository.ts'
import {
  type OperationIntent,
  type OperationRecord,
  requestFingerprint
} from '../src/operation/types.ts'
import { createAuthenticatedConfig, TEST_NOW } from './project-test-support.ts'

const intent: OperationIntent = {
  activate: false,
  kind: 'project.create',
  name: 'Journal Test'
}

const recordFor = async (
  repository: OperationRepository,
  overrides: Partial<OperationRecord> = {}
): Promise<OperationRecord> => {
  const identity = await repository.identity()
  const timestamp = new Date(TEST_NOW).toISOString()
  return {
    apiOrigin: identity.apiOrigin,
    attemptCount: 1,
    createdAt: timestamp,
    expiresAt: new Date(TEST_NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
    failure: {
      code: 'PROJECTS_UNAVAILABLE',
      message: 'Photon could not reach the project service.',
      remediation: ['Retry the operation.'],
      retryable: true
    },
    idempotencyKey: 'journal-test-key',
    identityId: identity.identityId,
    intent,
    operationId: `op_${randomUUID()}`,
    replayable: true,
    replayPolicy: 'keyed',
    requestFingerprint: requestFingerprint(intent),
    status: 'failed',
    updatedAt: timestamp,
    ...overrides
  }
}

describe('operation journal', () => {
  test('uses private scoped directories and atomic private files', async () => {
    const authenticated = await createAuthenticatedConfig()
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW
    })
    const record = await recordFor(repository)
    await repository.create(record)

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    if (scopeName === undefined) {
      throw new Error('Expected an operation scope directory.')
    }
    const scopeDirectory = join(operationsRoot, scopeName)
    const filePath = join(scopeDirectory, `${record.operationId}.json`)
    const directoryStats = await stat(scopeDirectory)
    const fileStats = await stat(filePath)
    if (process.platform !== 'win32') {
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission modes are bit masks.
      expect(directoryStats.mode & 0o777).toBe(0o700)
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission modes are bit masks.
      expect(fileStats.mode & 0o777).toBe(0o600)
    }
    await expect(repository.get(record.operationId)).resolves.toEqual(record)
    await authenticated.remove()
  })

  test('isolates records by authenticated identity and API origin', async () => {
    const authenticated = await createAuthenticatedConfig('identity_a')
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW
    })
    await repository.create(await recordFor(repository))

    const otherOrigin = new OperationRepository({
      apiOrigin: 'https://api.other-photon.example',
      authRepository,
      now: () => TEST_NOW
    })
    await expect(otherOrigin.list()).resolves.toEqual([])

    await authRepository.withLock(async () => {
      const previous = await authRepository.loadSession()
      if (previous === undefined) {
        throw new Error('Expected an authenticated test session.')
      }
      const prepared = await authRepository.prepareLoginBackend(
        true,
        previous.metadata
      )
      const metadata = authRepository.createMetadata(
        prepared,
        {
          email: 'identity_b@example.test',
          id: 'identity_b',
          name: 'Identity B'
        },
        previous.metadata
      )
      await authRepository.persistSessionLocked(
        authRepository.createCredential(
          'identity-b-access',
          'identity-b-refresh',
          new Date(TEST_NOW + 3_600_000)
        ),
        metadata,
        prepared.backend,
        previous
      )
    })
    await expect(repository.list()).resolves.toEqual([])
    await authenticated.remove()
  })

  test('purges expired records and fails closed on malformed records', async () => {
    const authenticated = await createAuthenticatedConfig()
    const warning = vi.fn()
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW,
      warning
    })
    const expiredCreatedAt = new Date(TEST_NOW - 3).toISOString()
    const expiredUpdatedAt = new Date(TEST_NOW - 2).toISOString()
    const expired = await recordFor(repository, {
      createdAt: expiredCreatedAt,
      expiresAt: new Date(TEST_NOW - 1).toISOString(),
      updatedAt: expiredUpdatedAt
    })
    await repository.create(expired)
    await expect(repository.purgeExpired()).resolves.toBe(1)
    await expect(repository.list()).resolves.toEqual([])

    const valid = await recordFor(repository)
    await repository.create(valid)
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    if (scopeName === undefined) {
      throw new Error('Expected an operation scope directory.')
    }
    const corruptOperationId = `op_${randomUUID()}`
    await writeFile(
      join(operationsRoot, scopeName, `${corruptOperationId}.json`),
      `${JSON.stringify({
        ...valid,
        operationId: corruptOperationId,
        schemaVersion: 1
      })}\n`,
      { mode: 0o600 }
    )
    await expect(repository.list()).resolves.toEqual([valid])
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`${corruptOperationId}.json`)
    )
    await expect(repository.get(corruptOperationId)).rejects.toMatchObject({
      code: 'OPERATION_JOURNAL_CORRUPT'
    })
    await authenticated.remove()
  })

  test('reports invalid records as journal corruption before writing', async () => {
    const authenticated = await createAuthenticatedConfig()
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW
    })
    const invalid = await recordFor(repository, {
      failure: {
        code: 'PROJECTS_UNAVAILABLE',
        message: 'Photon could not reach the project service.',
        remediation: [],
        requestId: 'request with whitespace',
        retryable: true
      }
    })

    await expect(repository.create(invalid)).rejects.toMatchObject({
      code: 'OPERATION_JOURNAL_CORRUPT'
    })
    await expect(repository.list()).resolves.toEqual([])
    await authenticated.remove()
  })

  test('accepts current billing records without a schema version', async () => {
    const authenticated = await createAuthenticatedConfig()
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW
    })
    const legacyIntent: OperationIntent = {
      category: 'Legacy-Category',
      kind: 'billing.plan.purchase',
      planCode: 'legacy.plan-code',
      projectId: 'pho_prj_00000000000000000000000001'
    }
    const legacyRecord = await recordFor(repository, {
      intent: legacyIntent,
      requestFingerprint: requestFingerprint(legacyIntent)
    })

    await repository.create(legacyRecord)

    await expect(repository.list({ corrupt: 'throw' })).resolves.toEqual([
      legacyRecord
    ])
    await authenticated.remove()
  })

  test('names the file of a record from another sign-in, which remove deletes', async () => {
    const authenticated = await createAuthenticatedConfig()
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      now: () => TEST_NOW
    })
    const record = await recordFor(repository)
    await repository.create(record)
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeKey = ''] = await readdir(operationsRoot)
    const fileId = `op_${randomUUID()}`
    await writeFile(
      join(operationsRoot, scopeKey, `${fileId}.json`),
      JSON.stringify({ ...record, identityId: 'user_grace' }),
      { mode: 0o600 }
    )
    const mismatch = {
      code: 'OPERATION_SCOPE_MISMATCH',
      next: [
        {
          description: 'Remove the local record',
          run: `${CLI_NAME} operation remove ${fileId} --yes`
        }
      ],
      operationId: fileId
    }

    await expect(repository.list()).rejects.toMatchObject(mismatch)
    await expect(repository.get(fileId)).rejects.toMatchObject(mismatch)
    await expect(repository.remove(fileId)).resolves.toBe(true)
    await expect(repository.list()).resolves.toEqual([record])
    await authenticated.remove()
  })

  test('recovers an abandoned replay lease with no owner record', async () => {
    const authenticated = await createAuthenticatedConfig()
    const authRepository = new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    })
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository,
      now: () => TEST_NOW
    })
    const record = await recordFor(repository)
    await repository.create(record)
    const [scopeKey] = await readdir(
      join(authenticated.configDirectory, 'operations')
    )
    if (scopeKey === undefined) {
      throw new Error('Expected an operation scope directory.')
    }
    const leaseKey = createHash('sha256')
      .update(`${scopeKey}\0${record.operationId}`)
      .digest('hex')
    const staleLease = join(
      authenticated.configDirectory,
      'operation-locks',
      `${leaseKey}.lock`
    )
    await mkdir(staleLease, { mode: 0o700, recursive: true })
    const staleTime = new Date(Date.now() - 5 * 60 * 1000)
    await utimes(staleLease, staleTime, staleTime)

    await expect(
      repository.withReplayLease(record.operationId, () =>
        Promise.resolve('acquired')
      )
    ).resolves.toBe('acquired')
    await expect(stat(staleLease)).rejects.toMatchObject({ code: 'ENOENT' })
    await authenticated.remove()
  })
})
