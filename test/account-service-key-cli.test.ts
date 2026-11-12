import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  type DeviceTokenOutput,
  type GetAccountOutput
} from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import type { AccountScope } from '../src/account/service.ts'
import { parseAccountServiceKey } from '../src/auth/account-service-key.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS } from '../src/operation/types.ts'
import { photonKey } from './key-support.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  lateFailingInvoker,
  lateFailingStdout,
  stderrError,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const createdAt = '2026-07-31T17:00:00.000Z'
const accountId = 'pho_acc_01h455vb4pex5vsknk084sn02q'
const serviceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const otherServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02t')
const secret = `${serviceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`

type ServiceKeySdkCompatibility = Required<
  Pick<
    AccountScope,
    | 'createAccountServiceKey'
    | 'listAccountServiceKeys'
    | 'revokeAccountServiceKey'
  >
>

const serviceKey = (
  id = serviceKeyId,
  overrides: Partial<{ name: string; revokedAt: null | string }> = {}
) => ({
  accountId,
  addedByNewerApi: 'from-a-newer-api',
  createdAt,
  expiresAt: null,
  name: overrides.name ?? 'production automation',
  revokedAt: overrides.revokedAt ?? null,
  serviceKeyId: id
})

interface AccountServiceKeyMocks {
  create: ReturnType<
    typeof vi.fn<ServiceKeySdkCompatibility['createAccountServiceKey']>
  >
  list: ReturnType<
    typeof vi.fn<ServiceKeySdkCompatibility['listAccountServiceKeys']>
  >
  revoke: ReturnType<
    typeof vi.fn<ServiceKeySdkCompatibility['revokeAccountServiceKey']>
  >
  scope: AccountScope
}

const accountServiceKeyMocks = (
  overrides: Partial<ServiceKeySdkCompatibility> = {}
): AccountServiceKeyMocks => {
  const create = vi.fn<ServiceKeySdkCompatibility['createAccountServiceKey']>(
    overrides.createAccountServiceKey ??
      ((input) =>
        Promise.resolve({
          secret,
          serviceKey: serviceKey(serviceKeyId, { name: input.body.name })
        }))
  )
  const list = vi.fn<ServiceKeySdkCompatibility['listAccountServiceKeys']>(
    overrides.listAccountServiceKeys ??
      (() =>
        Promise.resolve({
          serviceKeys: [serviceKey()]
        }))
  )
  const revoke = vi.fn<ServiceKeySdkCompatibility['revokeAccountServiceKey']>(
    overrides.revokeAccountServiceKey ??
      ((input) =>
        Promise.resolve({
          serviceKey: serviceKey(input.path.serviceKeyId, {
            revokedAt: createdAt
          })
        }))
  )
  return {
    create,
    list,
    revoke,
    scope: {
      createAccountServiceKey: create,
      listAccountServiceKeys: list,
      revokeAccountServiceKey: revoke
    } as unknown as AccountScope
  }
}

const unavailable = (): ApiError =>
  new ApiError(`request failed with ${secret}`, {
    body: { code: 'UPSTREAM_FAILURE', detail: `echoed ${secret}` },
    headers: new Headers(),
    operationId: 'createAccountServiceKey',
    requestId: 'request_account_service_key',
    status: 503
  })

const refreshedGrant: DeviceTokenOutput = {
  access_token: 'rotated-account-access-token',
  expires_in: 3600,
  refresh_token: 'rotated-account-refresh-token',
  user: {
    email: 'user_ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const refreshingDeviceScope = (): DeviceAuthScope => ({
  authorize: () => Promise.reject(new Error('authorize should not be called')),
  token: vi.fn(() => Promise.resolve(refreshedGrant))
})

const accountFixture: GetAccountOutput = {
  accountId,
  createdAt,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: createdAt
}

const replaceWithAccountServiceKeySession = async (
  configDirectory: string
): Promise<AuthRepository> => {
  const repository = new AuthRepository({
    configDirectory,
    platform: 'linux'
  })
  const current = await repository.loadSession()
  const parsed = parseAccountServiceKey(secret)
  if (current === undefined || parsed === undefined) {
    throw new Error('test auth fixture is invalid')
  }
  const backend = await repository.prepareAccountServiceKeyBackend(
    true,
    current.metadata
  )
  const metadata = repository.createAccountServiceKeyMetadata(
    backend,
    accountFixture,
    parsed,
    current.metadata
  )
  await repository.withLock(async () => {
    await repository.persistSessionLocked(
      repository.createAccountServiceKeyCredential(parsed),
      metadata,
      backend.backend,
      current
    )
  })
  return repository
}

describe('Account Service Key CLI', () => {
  test('creates once, lists the keys Photon returns, and revokes only a canonical ID', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountServiceKeyMocks()
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const created = await invoke([
      'account',
      'service-key',
      'create',
      '--name',
      ' production automation ',
      '--no-expiry',
      '--idempotency-key',
      'account-key-create'
    ])
    expect(created.exitCodes, created.stderr).toEqual([])
    expect(JSON.parse(created.stdout)).toEqual({
      secret,
      serviceKey: serviceKey(serviceKeyId, { name: 'production automation' })
    })
    expect(created.stderr).toContain('Save this account service key now')
    expect(created.stderr).not.toContain(secret)
    const createCall = mocks.create.mock.calls.at(0)
    expect(createCall?.[0]).toEqual({
      body: { name: 'production automation' },
      headers: { idempotencyKey: 'account-key-create' }
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })

    const listed = await invoke(['account', 'service-key', 'list'])
    expect(JSON.parse(listed.stdout)).toEqual({ serviceKeys: [serviceKey()] })

    const fullCredential = await invoke([
      'account',
      'service-key',
      'revoke',
      secret,
      '--yes'
    ])
    expect(JSON.parse(fullCredential.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(fullCredential.exitCodes).toEqual([2])
    expect(mocks.revoke).not.toHaveBeenCalled()

    const revoked = await invoke([
      'account',
      'service-key',
      'revoke',
      otherServiceKeyId,
      '--yes',
      '--idempotency-key',
      'account-key-revoke'
    ])
    expect(JSON.parse(revoked.stdout)).toEqual({
      serviceKey: serviceKey(otherServiceKeyId, { revokedAt: createdAt })
    })
    expect(revoked.stdout).not.toContain(secret)
    expect(revoked.stderr).not.toContain(secret)
    const revokeCall = mocks.revoke.mock.calls.at(0)
    expect(revokeCall?.[0]).toEqual({
      headers: { idempotencyKey: 'account-key-revoke' },
      path: { serviceKeyId: otherServiceKeyId }
    })
  })

  test('prints a server-provided name inert in text and unchanged in JSON', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const name = 'ok\u001b[31m-forged-terminal-output'
    const mocks = accountServiceKeyMocks({
      listAccountServiceKeys: () =>
        Promise.resolve({
          serviceKeys: [serviceKey(serviceKeyId, { name })]
        })
    })
    const options = { accountScope: mocks.scope }
    const list = ['account', 'service-key', 'list']

    const json = await cliInvoker(
      configDirectory,
      asProjectScope({}),
      options
    )(list)
    expect(JSON.parse(json.stdout)).toMatchObject({ serviceKeys: [{ name }] })

    const text = await terminalInvoker(
      configDirectory,
      asProjectScope({}),
      options
    )(list)
    expect(text.stdout).toContain('ok^[[31m-forged-terminal-output')
    expect(`${text.stdout}${text.stderr}`).not.toContain('\u001b')
  })

  test('keeps an awaiting record when secret output fails and replays before the deadline', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountServiceKeyMocks()
    const device = refreshingDeviceScope()
    let currentNow = TEST_NOW
    const stderr = collector()
    const exitCodes: number[] = []
    const rejectingStdout: WritableOutput = {
      write: () => Promise.reject(new Error('stdout unavailable'))
    }

    await runCli(
      [
        'account',
        'service-key',
        'create',
        '--name',
        'output recovery',
        '--no-expiry',
        '--idempotency-key',
        'output-recovery',
        '--json'
      ],
      {
        accountScope: mocks.scope,
        configDirectory,
        deviceScope: device,
        now: () => currentNow,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: rejectingStdout
      }
    )
    expect(exitCodes, stderr.value()).toEqual([1])
    expect(stderr.value()).not.toContain(secret)

    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      deviceScope: device,
      now: () => currentNow
    })
    const pending = JSON.parse(
      (await invoke(['operation', 'list'])).stdout
    ) as {
      operations: Array<{
        operationId: string
        replayable: boolean
        status: string
      }>
    }
    expect(pending.operations).toHaveLength(1)
    expect(pending.operations[0]).toMatchObject({
      replayable: true,
      status: 'awaiting-output-ack'
    })
    const pendingOperation = pending.operations.at(0)
    if (pendingOperation === undefined) {
      throw new Error('pending operation fixture is missing')
    }
    const { operationId } = pendingOperation
    const viewed = JSON.parse(
      (await invoke(['operation', 'view', operationId])).stdout
    ) as { operation: { replayExpiresAt: string } }
    expect(viewed.operation.replayExpiresAt).toBe(
      new Date(TEST_NOW + ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS).toISOString()
    )

    const operationsRoot = join(configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    const stored = await readFile(
      join(operationsRoot, scopeName ?? '', `${operationId}.json`),
      'utf8'
    )
    expect(stored).not.toContain(secret)

    currentNow = TEST_NOW + ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS - 1
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'account-service-key.create',
        operationId,
        status: 'resolved'
      },
      result: { secret, serviceKey: { serviceKeyId } }
    })
    expect(replayed.stderr).toContain('Save this account service key now')
    expect(replayed.stderr).not.toContain(secret)
    expect(mocks.create).toHaveBeenCalledTimes(2)
    const initialCreateCall = mocks.create.mock.calls.at(0)
    const replayCreateCall = mocks.create.mock.calls.at(1)
    expect(replayCreateCall?.[0]).toEqual(initialCreateCall?.[0])
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('names the replay and keeps the record when stdout fails after taking the new key, and again when the replay output fails', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountServiceKeyMocks()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'account',
        'service-key',
        'create',
        '--name',
        'late output failure',
        '--no-expiry',
        '--idempotency-key',
        'account-key-late-output-failure',
        '--json'
      ],
      {
        accountScope: mocks.scope,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: lateFailingStdout()
      }
    )

    expect(exitCodes, stderr.value()).toEqual([1])
    expect(stderr.value()).not.toContain(secret)
    const failure = JSON.parse(stderr.value().trim().split('\n').at(-1) ?? '')
    expect(failure.error).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      idempotencyKey: 'account-key-late-output-failure',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      replayable: true
    })

    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [
        {
          kind: 'account-service-key.create',
          operationId: failure.error.operationId,
          status: 'awaiting-output-ack'
        }
      ]
    })
    const failedReplay = await lateFailingInvoker(
      configDirectory,
      asProjectScope({}),
      { accountScope: mocks.scope }
    )(['operation', 'replay', failure.error.operationId, '--yes'])
    expect(failedReplay.exitCodes).toEqual([1])
    expect(failedReplay.stderr).not.toContain(secret)
    expect(stderrError(failedReplay.stderr)).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      operationId: failure.error.operationId,
      replayable: true
    })
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stdout.split(secret)).toHaveLength(2)
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'account-service-key.create', status: 'resolved' },
      result: { secret, serviceKey: { serviceKeyId } }
    })
    expect(mocks.create).toHaveBeenCalledTimes(3)
    expect(mocks.create.mock.calls.at(1)?.[0]).toEqual(
      mocks.create.mock.calls.at(0)?.[0]
    )
    expect(mocks.create.mock.calls.at(2)?.[0]).toEqual(
      mocks.create.mock.calls.at(0)?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('names the replay when stdout fails after a revoke, and again when the replay output fails', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountServiceKeyMocks()
    const failing = lateFailingInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const failed = await failing([
      'account',
      'service-key',
      'revoke',
      serviceKeyId,
      '--yes',
      '--idempotency-key',
      'revoke-late-output-failure'
    ])
    expect(failed.exitCodes, failed.stderr).toEqual([1])
    const operationId = String(stderrError(failed.stderr).operationId)
    const replayStep = {
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${operationId}`
        }
      ],
      operationId,
      replayable: true
    }
    expect(stderrError(failed.stderr)).toMatchObject({
      ...replayStep,
      idempotencyKey: 'revoke-late-output-failure'
    })
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [
        {
          kind: 'account-service-key.revoke',
          operationId,
          status: 'awaiting-output-ack'
        }
      ]
    })

    const failedReplay = await failing([
      'operation',
      'replay',
      operationId,
      '--yes'
    ])
    expect(failedReplay.exitCodes).toEqual([1])
    expect(stderrError(failedReplay.stderr)).toMatchObject(replayStep)

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'account-service-key.revoke',
        operationId,
        status: 'resolved'
      },
      result: { revoked: true, serviceKeyId }
    })
    expect(mocks.revoke).toHaveBeenCalledOnce()
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('replays a revoke whose output failed as the key it revoked, without another request', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountServiceKeyMocks()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'account',
        'service-key',
        'revoke',
        serviceKeyId,
        '--yes',
        '--idempotency-key',
        'revoke-output-recovery',
        '--json'
      ],
      {
        accountScope: mocks.scope,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: { write: () => Promise.reject(new Error('stdout unavailable')) }
      }
    )
    expect(exitCodes, stderr.value()).toEqual([1])

    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      deviceScope: unusedDeviceScope()
    })
    const pending = JSON.parse(
      (await invoke(['operation', 'list'])).stdout
    ) as {
      operations: Array<{ operationId: string; status: string }>
    }
    expect(pending.operations).toMatchObject([
      { status: 'awaiting-output-ack' }
    ])
    const operationId = pending.operations[0]?.operationId

    const replayed = await invoke([
      'operation',
      'replay',
      String(operationId),
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'account-service-key.revoke',
        operationId,
        status: 'resolved'
      },
      result: { revoked: true, serviceKeyId }
    })
    expect(mocks.revoke).toHaveBeenCalledOnce()
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('expires replay locally at the deadline without another request', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const create = vi
      .fn<ServiceKeySdkCompatibility['createAccountServiceKey']>()
      .mockRejectedValue(unavailable())
    const mocks = accountServiceKeyMocks({ createAccountServiceKey: create })
    let currentNow = TEST_NOW
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      deviceScope: unusedDeviceScope(),
      now: () => currentNow
    })

    const failed = await invoke([
      'account',
      'service-key',
      'create',
      '--name',
      'expired replay',
      '--no-expiry',
      '--idempotency-key',
      'expired-replay'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const { operationId } = failure.error
    expect(failed.stderr).toBe('')
    expect(failed.stderr).not.toContain(secret)
    expect(failed.stdout).not.toContain(secret)
    expect(create, failed.stderr).toHaveBeenCalledOnce()

    currentNow = TEST_NOW + ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS
    const viewed = JSON.parse(
      (await invoke(['operation', 'view', operationId])).stdout
    )
    expect(viewed).toMatchObject({
      operation: {
        operationId,
        replayable: false,
        replayExpiresAt: new Date(currentNow).toISOString()
      }
    })
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: { code: 'OPERATION_REPLAY_EXPIRED', operationId }
    })
    expect(create).toHaveBeenCalledOnce()
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [{ operationId, replayable: false }]
    })
  })

  test('flushes a self-revoke before acknowledging and removing its session', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const repository =
      await replaceWithAccountServiceKeySession(configDirectory)
    const mocks = accountServiceKeyMocks()
    const stderr = collector()
    const exitCodes: number[] = []
    let serialized = ''
    const stdout: WritableOutput = {
      write: async (chunk) => {
        serialized += chunk
        await expect(repository.loadSession()).resolves.toMatchObject({
          kind: 'account_service_key'
        })
        const operationFiles = await readdir(
          join(configDirectory, 'operations'),
          { recursive: true }
        )
        expect(operationFiles.some((file) => file.endsWith('.json'))).toBe(true)
      }
    }

    await runCli(
      [
        'account',
        'service-key',
        'revoke',
        serviceKeyId,
        '--yes',
        '--idempotency-key',
        'self-revoke',
        '--json'
      ],
      {
        accountScope: mocks.scope,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(exitCodes).toEqual([])
    expect(JSON.parse(serialized)).toEqual({
      serviceKey: serviceKey(serviceKeyId, { revokedAt: createdAt })
    })
    expect(stderr.value()).toContain('active CLI credential')
    expect(stderr.value()).not.toContain(secret)
    await expect(repository.loadSession()).resolves.toBeUndefined()
    const operationFiles = await readdir(join(configDirectory, 'operations'), {
      recursive: true
    })
    expect(operationFiles.some((file) => file.endsWith('.json'))).toBe(false)
  })
})
