import { ApiError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import { ProjectService } from '../src/project/service.ts'
import {
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  instantPollClock
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const OTHER_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02r'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=setup_token-1'

const operation = (state: string, overrides: Record<string, unknown> = {}) => ({
  cancellable: state === 'pending',
  createdAt: timestamp,
  ...(state === 'pending' || state === 'running'
    ? { detail: { setupUrl: SETUP_URL } }
    : {}),
  operationId: OPERATION_ID,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType: 'telegram_bot',
  state,
  type: 'resource.provision',
  updatedAt: timestamp,
  ...overrides
})

const bot = (overrides: Record<string, unknown> = {}) => ({
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
  updatedAt: timestamp,
  ...overrides
})

const rawResponse = <Result>(data: Result, status = 202) => ({
  data,
  headers: new Headers({ 'retry-after': '5' }),
  status
})

const provisionInProgress = (body: Record<string, unknown> = {}) =>
  new ApiError('conflict', {
    body: {
      code: 'TELEGRAM_PROVISION_IN_PROGRESS',
      detail: 'This project already has an unfinished Telegram bot connection.',
      operationId: OPERATION_ID,
      operationUrl: `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${OPERATION_ID}`,
      ...body
    },
    headers: new Headers(),
    operationId: 'connectTelegramBot',
    status: 409
  })

const createService = (
  raw: Record<string, unknown>,
  scope: Record<string, unknown>
) => {
  const clock = instantPollClock()
  const service = new ProjectService({
    clock,
    organizationScope: asOrganizationScope(),
    rawScope: asProjectRawScope({ platforms: raw }),
    request: new AuthenticatedRequest({
      tokenManager: {
        getAccessToken: vi.fn(() => Promise.resolve('access-token')),
        refreshAfterUnauthorized: vi.fn(() => Promise.resolve('rotated-token'))
      }
    }),
    scope: asProjectScope({ platforms: scope })
  })
  return { clock, service }
}

describe('Telegram bot connection', () => {
  test('starts a setup and returns its link without polling', async () => {
    const connectTelegramBot = vi.fn(() =>
      Promise.resolve(rawResponse(operation('pending')))
    )
    const getOperation = vi.fn()
    const accepted = vi.fn(() => Promise.resolve())
    const { clock, service } = createService(
      { connectTelegramBot },
      { getOperation }
    )

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key',
        accepted
      )
    ).resolves.toEqual({
      response: { operation: operation('pending') },
      resumed: false,
      setupUrl: SETUP_URL
    })
    expect(connectTelegramBot).toHaveBeenCalledWith(
      {
        body: {},
        headers: { idempotencyKey: 'telegram-key' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(accepted).toHaveBeenCalledWith(OPERATION_ID)
    expect(getOperation).not.toHaveBeenCalled()
    expect(clock.sleeps).toEqual([])
  })

  test('continues the unfinished setup a refused connect names', async () => {
    const connectTelegramBot = vi.fn(() =>
      Promise.reject(provisionInProgress())
    )
    const unfinished = operation('running', {
      detail: { displayName: 'Alex Support', setupUrl: SETUP_URL }
    })
    const getOperation = vi.fn(() => Promise.resolve({ operation: unfinished }))
    const accepted = vi.fn(() => Promise.resolve())
    const { service } = createService({ connectTelegramBot }, { getOperation })

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'another-key',
        accepted
      )
    ).resolves.toEqual({
      response: { operation: unfinished },
      resumed: true,
      setupUrl: SETUP_URL
    })
    expect(connectTelegramBot).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          operationId: OPERATION_ID
        }
      },
      undefined
    )
    expect(accepted).toHaveBeenCalledExactlyOnceWith(OPERATION_ID)
  })

  test('starts again when the setup in the way has finished meanwhile', async () => {
    const started = operation('pending', { operationId: OTHER_OPERATION_ID })
    const connectTelegramBot = vi
      .fn()
      .mockRejectedValueOnce(provisionInProgress())
      .mockResolvedValueOnce(rawResponse(started))
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: operation('cancelled') })
    )
    const accepted = vi.fn(() => Promise.resolve())
    const { service } = createService({ connectTelegramBot }, { getOperation })

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key',
        accepted
      )
    ).resolves.toEqual({
      response: { operation: started },
      resumed: false,
      setupUrl: SETUP_URL
    })
    expect(connectTelegramBot).toHaveBeenCalledTimes(2)
    expect(accepted).toHaveBeenCalledExactlyOnceWith(OTHER_OPERATION_ID)
  })

  test('reports the refusal when a second attempt is refused too', async () => {
    const connectTelegramBot = vi.fn(() =>
      Promise.reject(provisionInProgress())
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: operation('failed') })
    )
    const { service } = createService({ connectTelegramBot }, { getOperation })

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key'
      )
    ).rejects.toMatchObject({
      code: 'TELEGRAM_PROVISION_IN_PROGRESS',
      httpStatus: 409
    })
    expect(connectTelegramBot).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['is missing', { operationId: undefined }],
    [
      'is not an operation ID',
      { operationId: 'pho_prj_00000000000000000000000001/../secrets' }
    ]
  ])('does not follow a refusal whose operation %s', async (_name, body) => {
    const connectTelegramBot = vi.fn(() =>
      Promise.reject(provisionInProgress(body))
    )
    const getOperation = vi.fn()
    const { service } = createService({ connectTelegramBot }, { getOperation })

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key'
      )
    ).rejects.toMatchObject({ code: 'TELEGRAM_PROVISION_IN_PROGRESS' })
    expect(getOperation).not.toHaveBeenCalled()
  })

  test.each([
    ['another host', 'https://example.com/PhotonManagerBot?start=token'],
    ['plain HTTP', 'http://t.me/PhotonManagerBot?start=token'],
    ['no start parameter', 'https://t.me/PhotonManagerBot'],
    ['an extra parameter', 'https://t.me/PhotonManagerBot?start=token&x=1'],
    ['credentials', 'https://user:pass@t.me/PhotonManagerBot?start=token']
  ])('omits a setup link with %s', async (_name, setupUrl) => {
    const started = operation('pending', { detail: { setupUrl } })
    const connectTelegramBot = vi.fn(() =>
      Promise.resolve(rawResponse(started))
    )
    const { service } = createService({ connectTelegramBot }, {})

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key'
      )
    ).resolves.toEqual({ response: { operation: started }, resumed: false })
  })

  test('rejects an accepted operation that is not a Telegram setup', async () => {
    const connectTelegramBot = vi.fn(() =>
      Promise.resolve(
        rawResponse(operation('pending', { resourceType: 'voip_line' }))
      )
    )
    const { service } = createService({ connectTelegramBot }, {})

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      remoteOperationId: OPERATION_ID
    })
  })

  test('reads a setup again without marking it as continued', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: operation('succeeded'), resource: bot() })
    )
    const { service } = createService({}, { getOperation })

    await expect(
      service.resumeTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).resolves.toEqual({
      response: { operation: operation('succeeded'), resource: bot() },
      resumed: false
    })
  })

  test('polls every five seconds until the bot is connected', async () => {
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: operation('pending') })
      .mockResolvedValueOnce({ operation: operation('running') })
      .mockResolvedValueOnce({
        operation: operation('succeeded'),
        resource: bot()
      })
    const { clock, service } = createService({}, { getOperation })

    await expect(
      service.waitForTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).resolves.toEqual({ operation: operation('succeeded'), resource: bot() })
    expect(clock.sleeps).toEqual([5000, 5000])
    expect(getOperation).toHaveBeenCalledTimes(3)
  })

  test('reads the operation once more when success arrives without the bot', async () => {
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: operation('succeeded') })
      .mockResolvedValueOnce({
        operation: operation('succeeded'),
        resource: bot()
      })
    const { clock, service } = createService({}, { getOperation })

    await expect(
      service.waitForTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).resolves.toEqual({ operation: operation('succeeded'), resource: bot() })
    expect(clock.sleeps).toEqual([])
  })

  test('rejects a success that never names a Telegram bot', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation('succeeded'),
        resource: bot({ type: 'voip_line' })
      })
    )
    const { service } = createService({}, { getOperation })

    await expect(
      service.waitForTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      remoteOperationId: OPERATION_ID
    })
  })

  test.each([
    [
      'failed',
      {
        error: { code: 'TELEGRAM_BOT_UNAVAILABLE', detail: 'Bot was removed.' }
      },
      { code: 'TELEGRAM_BOT_UNAVAILABLE', detail: 'Bot was removed.' }
    ],
    ['cancelled', {}, { code: 'PROJECT_OPERATION_CANCELLED' }]
  ])('reports a %s setup', async (state, overrides, expected) => {
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: operation(state, overrides) })
    )
    const { service } = createService({}, { getOperation })

    await expect(
      service.waitForTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).rejects.toMatchObject({ ...expected, remoteOperationId: OPERATION_ID })
  })

  test('refuses to wait on an operation of another kind', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation('running', { type: 'resource.release' })
      })
    )
    const { clock, service } = createService({}, { getOperation })

    await expect(
      service.waitForTelegramBotConnection(
        'pho_prj_00000000000000000000000001',
        OPERATION_ID
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    expect(clock.sleeps).toEqual([])
  })

  test('rejects an unfinished setup a refused connect names that is not a Telegram setup', async () => {
    const connectTelegramBot = vi.fn(() =>
      Promise.reject(provisionInProgress())
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation('running', { resourceType: 'voip_line' })
      })
    )
    const accepted = vi.fn(() => Promise.resolve())
    const { service } = createService({ connectTelegramBot }, { getOperation })

    await expect(
      service.connectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'telegram-key',
        accepted
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned an invalid Telegram bot operation.',
      remoteOperationId: OPERATION_ID
    })
    expect(connectTelegramBot).toHaveBeenCalledOnce()
    expect(accepted).not.toHaveBeenCalled()
  })

  test.each([
    [
      'waiting for',
      (service: ProjectService) =>
        service.waitForTelegramBotConnection(
          'pho_prj_00000000000000000000000001',
          OPERATION_ID
        )
    ],
    [
      'resuming',
      (service: ProjectService) =>
        service.resumeTelegramBotConnection(
          'pho_prj_00000000000000000000000001',
          OPERATION_ID
        )
    ]
  ])(
    'rejects a setup that reads back as an SMS number purchase when %s it',
    async (_name, read) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: operation('running', { resourceType: 'voip_line' })
        })
      )
      const { clock, service } = createService({}, { getOperation })

      await expect(read(service)).rejects.toMatchObject({
        code: 'PROJECT_PROTOCOL_ERROR',
        message: 'Photon returned an invalid Telegram bot operation.',
        remoteOperationId: OPERATION_ID
      })
      expect(clock.sleeps).toEqual([])
    }
  )
})

describe('Telegram bot resources', () => {
  test('lists bots by ability with the setups in progress', async () => {
    const listResources = vi.fn(() => Promise.resolve({ resources: [bot()] }))
    const listOperations = vi.fn(() =>
      Promise.resolve({
        operations: [
          operation('pending'),
          operation('pending', {
            operationId: OTHER_OPERATION_ID,
            resourceType: 'voip_line'
          })
        ]
      })
    )
    const { service } = createService({}, { listOperations, listResources })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'telegram',
        { limit: 30 }
      )
    ).resolves.toEqual({
      provisioning: [operation('pending')],
      resources: [bot()]
    })
    expect(listResources).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'telegram', pageSize: 30 }
      },
      undefined
    )
  })

  test('reads a bot and rejects a resource of another type', async () => {
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(bot())
      .mockResolvedValueOnce(bot({ type: 'email_domain' }))
    const { service } = createService({}, { getResource })

    await expect(
      service.getTelegramBot(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031'
      )
    ).resolves.toEqual(bot())
    await expect(
      service.getTelegramBot(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031'
      )
    ).rejects.toMatchObject({
      code: 'ARGUMENT_VALIDATION',
      detail:
        'Resource pho_res_00000000000000000000000031 is not a Telegram bot.',
      exitCode: 2
    })
  })

  test('disconnects a bot and waits for the release', async () => {
    const release = {
      ...operation('pending', { type: 'resource.release' }),
      resourceId: 'pho_res_00000000000000000000000031'
    }
    const releaseResource = vi.fn(() => Promise.resolve(rawResponse(release)))
    const getResource = vi.fn(() => Promise.resolve(bot()))
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: { ...release, state: 'succeeded' } })
    )
    const accepted = vi.fn(() => Promise.resolve())
    const { clock, service } = createService(
      { releaseResource },
      { getOperation, getResource }
    )

    await expect(
      service.disconnectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031',
        accepted
      )
    ).resolves.toEqual({ operation: { ...release, state: 'succeeded' } })
    expect(releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000031'
        }
      },
      undefined
    )
    expect(accepted).toHaveBeenCalledWith(OPERATION_ID)
    expect(clock.sleeps).toEqual([5000])
  })

  test('does not release a resource that is not a Telegram bot', async () => {
    const releaseResource = vi.fn()
    const getResource = vi.fn(() =>
      Promise.resolve(bot({ type: 'email_domain' }))
    )
    const { service } = createService({ releaseResource }, { getResource })

    await expect(
      service.disconnectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031'
      )
    ).rejects.toMatchObject({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
    expect(releaseResource).not.toHaveBeenCalled()
  })

  test('resumes waiting for a release that was already accepted', async () => {
    const release = operation('running', {
      resourceId: 'pho_res_00000000000000000000000031',
      type: 'resource.release'
    })
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: release })
      .mockResolvedValueOnce({ operation: { ...release, state: 'succeeded' } })
    const { clock, service } = createService({}, { getOperation })

    await expect(
      service.resumeTelegramBotDisconnection(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031',
        OPERATION_ID
      )
    ).resolves.toEqual({ operation: { ...release, state: 'succeeded' } })
    expect(clock.sleeps).toEqual([5000])
  })

  test.each([
    ['another resource', { resourceId: 'pho_res_00000000000000000000000032' }],
    ['another project', { projectId: 'pho_prj_00000000000000000000000002' }],
    ['another resource type', { resourceType: 'voip_line' }],
    ['a provision', { type: 'resource.provision' }]
  ])(
    'does not report a disconnection from an operation for %s',
    async (_name, overrides) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: operation('succeeded', {
            resourceId: 'pho_res_00000000000000000000000031',
            type: 'resource.release',
            ...overrides
          })
        })
      )
      const { service } = createService({}, { getOperation })

      await expect(
        service.resumeTelegramBotDisconnection(
          'pho_prj_00000000000000000000000001',
          'pho_res_00000000000000000000000031',
          OPERATION_ID
        )
      ).rejects.toMatchObject({
        code: 'PROJECT_PROTOCOL_ERROR',
        detail:
          'The Telegram release operation did not match the requested bot.',
        remoteOperationId: OPERATION_ID
      })
    }
  )

  test('rejects an accepted release that names another bot', async () => {
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          operation('pending', {
            resourceId: 'pho_res_00000000000000000000000032',
            type: 'resource.release'
          })
        )
      )
    )
    const getResource = vi.fn(() => Promise.resolve(bot()))
    const getOperation = vi.fn()
    const { service } = createService(
      { releaseResource },
      { getOperation, getResource }
    )

    await expect(
      service.disconnectTelegramBot(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000031'
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    expect(getOperation).not.toHaveBeenCalled()
  })
})
