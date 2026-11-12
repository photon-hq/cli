import { ApiError, ResponseValidationError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PollClock } from '../src/auth/device-flow.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  asProjectRawScope,
  asProjectScope,
  cliInvoker,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=setup_token-1'

const operation = (state: string, type = 'resource.provision') => ({
  cancellable: state === 'pending',
  createdAt: timestamp,
  ...(type === 'resource.release'
    ? { resourceId: 'pho_res_00000000000000000000000031' }
    : {}),
  ...(type === 'resource.provision' && state === 'pending'
    ? { detail: { setupUrl: SETUP_URL } }
    : {}),
  operationId: OPERATION_ID,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType: 'telegram_bot',
  state,
  type,
  updatedAt: timestamp
})

const bot = {
  abilities: ['telegram'],
  createdAt: timestamp,
  detail: {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000031',
  state: 'active',
  type: 'telegram_bot',
  updatedAt: timestamp
}

const rawResponse = <Result>(data: Result) => ({
  data,
  headers: new Headers({ 'retry-after': '5' }),
  status: 202
})

const failedOperationId = (stdout: string): string =>
  (JSON.parse(stdout) as { error: { operationId: string } }).error.operationId

const notFound = (operationId: string, code: string): ApiError =>
  new ApiError('not found', {
    body: { code, detail: 'Not found.' },
    headers: new Headers(),
    operationId,
    status: 404
  })

const interruptedPollClock = (): PollClock => ({
  now: () => 0,
  sleep: () => {
    throw new DOMException('cancelled', 'AbortError')
  },
  wallNow: () => TEST_NOW
})

const TELEGRAM_DISCONNECT = [
  'project',
  'platform',
  'telegram',
  'disconnect',
  bot.resourceId,
  '--project',
  'pho_prj_00000000000000000000000001',
  '--yes'
]

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('recoverable Telegram operations', () => {
  test('replays a connect whose answer was lost with its original key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const connectTelegramBot = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('connectTelegramBot', [], { status: 202 })
      )
      .mockResolvedValueOnce(rawResponse(operation('pending')))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        projectRawScope: asProjectRawScope({
          platforms: { connectTelegramBot }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'telegram',
      'connect',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    const operationId = failedOperationId(failed.stdout)
    const viewed = await invoke(['operation', 'view', operationId])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project platform telegram connect',
        input: { projectId: 'pho_prj_00000000000000000000000001' },
        kind: 'telegram-bot.connect'
      }
    })
    // The setup link grants the authority to connect a bot. Nothing of it is
    // written to the local record.
    expect(viewed.stdout).not.toContain('setup_token')

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'telegram-bot.connect', status: 'resolved' },
      result: {
        operation: {
          detail: { setupUrl: SETUP_URL },
          operationId: OPERATION_ID,
          state: 'pending'
        }
      }
    })
    expect(connectTelegramBot).toHaveBeenCalledTimes(2)
    const keys = connectTelegramBot.mock.calls.map(
      ([input]) => (input as { headers: { idempotencyKey: string } }).headers
    )
    expect(keys[0]).toEqual(keys[1])
    await authenticated.remove()
  })

  test('replays a disconnect by its resource ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(
        rawResponse(operation('pending', 'resource.release'))
      )
    const getResource = vi.fn(() => Promise.resolve(bot))
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: operation('succeeded', 'resource.release') })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'telegram',
      'disconnect',
      bot.resourceId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const operationId = failedOperationId(failed.stdout)
    expect(
      JSON.parse((await invoke(['operation', 'view', operationId])).stdout)
    ).toMatchObject({
      operation: {
        command: 'project platform telegram disconnect',
        input: {
          projectId: 'pho_prj_00000000000000000000000001',
          resourceId: bot.resourceId
        },
        kind: 'telegram-bot.disconnect'
      }
    })

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'telegram-bot.disconnect', status: 'resolved' },
      result: { operation: operation('succeeded', 'resource.release') }
    })
    expect(releaseResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('settles a disconnect replay when the bot is already gone', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() =>
      Promise.reject(
        new ApiError('not found', {
          body: { code: 'RESOURCE_NOT_FOUND', detail: 'Resource not found.' },
          headers: new Headers(),
          operationId: 'getResource',
          status: 404
        })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } })
    )

    const failed = await invoke([
      'project',
      'platform',
      'telegram',
      'disconnect',
      bot.resourceId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const replayed = await invoke([
      'operation',
      'replay',
      failedOperationId(failed.stdout),
      '--yes'
    ])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'telegram-bot.disconnect', status: 'resolved' },
      result: { disconnected: true, resourceId: bot.resourceId }
    })
    await authenticated.remove()
  })

  test('keeps a disconnect unresolved when its operation is not found and the bot is still connected', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn(() =>
      Promise.reject(notFound('getOperation', 'OPERATION_NOT_FOUND'))
    )
    const getResource = vi.fn(() => Promise.resolve(bot))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(operation('pending', 'resource.release')))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: interruptedPollClock(),
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const operationId = failedOperationId(
      (await invoke(TELEGRAM_DISCONNECT)).stdout
    )
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.exitCodes).toEqual([1])
    expect(replayed.stderr).not.toContain('resolved')
    expect(replayed.stdout).not.toContain('resolved')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN',
        message: 'The outcome of the operation is unknown.',
        next: [
          {
            description: 'Replay the operation',
            run: `${CLI_NAME} operation replay ${operationId}`
          }
        ],
        operationId,
        replayable: true
      }
    })
    const viewed = JSON.parse(
      (await invoke(['operation', 'view', operationId])).stdout
    ) as { operation: Record<string, unknown> }
    expect(viewed.operation).toMatchObject({
      kind: 'telegram-bot.disconnect',
      status: 'outcome-unknown'
    })
    expect(viewed.operation).not.toHaveProperty('remoteOperationId')
    expect(getOperation).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('settles a disconnect when its operation is not found and the bot is gone', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn(() =>
      Promise.reject(notFound('getOperation', 'OPERATION_NOT_FOUND'))
    )
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(bot)
      .mockRejectedValueOnce(notFound('getResource', 'RESOURCE_NOT_FOUND'))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(operation('pending', 'resource.release')))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: interruptedPollClock(),
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const operationId = failedOperationId(
      (await invoke(TELEGRAM_DISCONNECT)).stdout
    )
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'telegram-bot.disconnect', status: 'resolved' },
      result: { disconnected: true, resourceId: bot.resourceId }
    })
    expect(getOperation).toHaveBeenCalledOnce()
    expect(getResource).toHaveBeenCalledTimes(2)
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })
})
