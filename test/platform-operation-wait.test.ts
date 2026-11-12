import { ApiError } from '@photon-ai/api'
import { afterEach, describe, expect, type Mock, test, vi } from 'vitest'
import type { PollClock } from '../src/auth/device-flow.ts'
import {
  asProjectRawScope,
  asProjectScope,
  cliInvoker,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const OTHER_PROJECT_ID = 'pho_prj_00000000000000000000000002'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn04a'
const OTHER_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn04b'
const OTHER_RESOURCE_ID = 'pho_res_00000000000000000000000099'
const PROJECT = ['--project', PROJECT_ID]
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=setup_token-1'
const REFRESH_MISMATCH =
  'The operation refresh returned a different operation ID.'

interface OperationFields {
  detail: Record<string, unknown>
  operationId: string
  projectId: string
  resourceId: string
  resourceType: string
  state: string
  type: string
}

const operation = (
  fields: Partial<OperationFields> &
    Pick<OperationFields, 'resourceType' | 'state' | 'type'>
) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId: OPERATION_ID,
  projectId: PROJECT_ID,
  updatedAt: timestamp,
  ...fields
})

const resource = (
  resourceId: string,
  type: string,
  abilities: string[],
  detail: Record<string, unknown>
) => ({
  abilities,
  createdAt: timestamp,
  detail,
  projectId: PROJECT_ID,
  resourceId,
  state: 'active',
  type,
  updatedAt: timestamp
})

const smsNumber = resource(
  'pho_res_00000000000000000000000051',
  'voip_line',
  ['sms'],
  { phoneNumber: '+14155550125' }
)
const imessageLine = resource(
  'pho_res_00000000000000000000000052',
  'cosmos_line',
  ['imessage'],
  { phoneNumber: '+14155550126' }
)
const telegramBot = resource(
  'pho_res_00000000000000000000000053',
  'telegram_bot',
  ['telegram'],
  {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  }
)
const emailDomain = resource(
  'pho_res_00000000000000000000000054',
  'email_domain',
  ['email'],
  { domain: 'example.com', healthy: true }
)
const whatsappSender = resource(
  'pho_res_00000000000000000000000055',
  'whatsapp_sender',
  ['whatsapp_business'],
  {
    account: { wabaId: '112233445566778' },
    displayName: 'Acme Support',
    displayNameStatus: 'APPROVED',
    phoneNumber: '+14155550199',
    phoneNumberId: '123456789012345',
    qualityRating: 'GREEN',
    qualityRatingObservedAt: '2026-08-19T21:04:58.000Z',
    voipResourceId: 'pho_res_00000000000000000000000123'
  }
)

const emailSetup = {
  dnsRecords: [
    { name: 'a._domainkey.example.com', type: 'CNAME', value: 'a.dkim' },
    { name: 'b._domainkey.example.com', type: 'CNAME', value: 'b.dkim' },
    { name: 'c._domainkey.example.com', type: 'CNAME', value: 'c.dkim' },
    {
      name: 'bounce.example.com',
      priority: 10,
      type: 'MX',
      value: 'feedback-smtp.us-west-2.amazonses.com'
    },
    {
      name: 'bounce.example.com',
      type: 'TXT',
      value: 'v=spf1 include:amazonses.com ~all'
    },
    {
      name: 'example.com',
      priority: 10,
      type: 'MX',
      value: 'inbound-smtp.us-west-2.amazonaws.com'
    }
  ]
}

const rawResponse = <Result>(data: Result) => ({
  data,
  headers: new Headers({ 'retry-after': '5' }),
  status: 202
})

const interruptedPollClock = (): PollClock => ({
  now: () => 0,
  sleep: () => {
    throw new DOMException('cancelled', 'AbortError')
  },
  wallNow: () => TEST_NOW
})

interface ErrorDocument {
  error: { operationId: string }
}

const viewOperation = async (
  invoke: ReturnType<typeof cliInvoker>,
  operationId: string
) =>
  (
    JSON.parse((await invoke(['operation', 'view', operationId])).stdout) as {
      operation: Record<string, unknown>
    }
  ).operation

const refreshError = (extra: Record<string, unknown> = {}) => ({
  error: expect.objectContaining({
    code: 'PROJECT_PROTOCOL_ERROR',
    detail: REFRESH_MISMATCH,
    message: 'Photon returned an invalid project response.',
    remoteOperationId: OPERATION_ID,
    ...extra
  })
})

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

const releases = [
  {
    args: ['project', 'platform', 'sms', 'delete'],
    command: 'sms delete',
    detail: 'The SMS release operation did not match the requested number.',
    released: smsNumber
  },
  {
    args: ['project', 'platform', 'email', 'disconnect'],
    command: 'email disconnect',
    detail:
      'The email-domain release operation did not match the requested domain.',
    released: emailDomain
  },
  {
    args: ['project', 'platform', 'telegram', 'disconnect'],
    command: 'telegram disconnect',
    detail: 'The Telegram release operation did not match the requested bot.',
    released: telegramBot
  },
  {
    args: ['project', 'platform', 'whatsapp-business', 'number', 'delete'],
    command: 'whatsapp-business number delete',
    detail:
      'The WhatsApp Business release operation did not match the requested sender.',
    released: whatsappSender
  }
] as const

type Release = (typeof releases)[number]

const releaseOperation = (
  { released }: Release,
  state: string,
  fields: Partial<OperationFields> = {}
) =>
  operation({
    resourceId: released.resourceId,
    resourceType: released.type,
    state,
    type: 'resource.release',
    ...fields
  })

const mismatchesOf = (release: Release) =>
  (
    [
      ['another resource', { resourceId: OTHER_RESOURCE_ID }],
      ['another project', { projectId: OTHER_PROJECT_ID }],
      ['a provision', { type: 'resource.provision' }],
      ...(release.released.type === 'voip_line'
        ? []
        : [
            [
              'another resource type',
              { resourceType: 'cosmos_line' }
            ] satisfies [string, Partial<OperationFields>]
          ])
    ] satisfies [string, Partial<OperationFields>][]
  ).map(([name, fields]) => ({ fields, name, release }))

const releaseProtocolError = (
  release: Release,
  remoteOperationId = OPERATION_ID
) => ({
  error: expect.objectContaining({
    code: 'PROJECT_PROTOCOL_ERROR',
    detail: release.detail,
    message: 'Photon returned an invalid project response.',
    remoteOperationId
  })
})

const releaseInvoker = async (
  release: Release,
  getOperation: Mock,
  releaseResource: Mock,
  clock: PollClock = instantPollClock()
) => {
  const authenticated = await createAuthenticatedConfig()
  const scope = asProjectScope({
    platforms: {
      getOperation,
      getResource: vi.fn(() => Promise.resolve(release.released))
    }
  })
  const projectRawScope = asProjectRawScope({ platforms: { releaseResource } })
  return {
    authenticated,
    invoke: cliInvoker(authenticated.configDirectory, scope, {
      clock,
      projectRawScope
    }),
    invokeWith: (nextClock: PollClock) =>
      cliInvoker(authenticated.configDirectory, scope, {
        clock: nextClock,
        projectRawScope
      })
  }
}

const releaseArgs = (release: Release) => [
  ...release.args,
  release.released.resourceId,
  ...PROJECT,
  '--yes'
]

describe('a release wait that polls its operation', () => {
  test.each(releases.flatMap((release) => mismatchesOf(release)))(
    '$release.command refuses a poll for $name',
    async ({ fields, release }) => {
      const getOperation = vi
        .fn()
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running', fields)
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'succeeded')
        })
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke } = await releaseInvoker(
        release,
        getOperation,
        releaseResource
      )

      const result = await invoke(releaseArgs(release))

      expect(result.exitCodes).toEqual([1])
      const document = JSON.parse(result.stdout) as ErrorDocument
      expect(document).toEqual(releaseProtocolError(release))
      expect(
        await viewOperation(invoke, document.error.operationId)
      ).toMatchObject({
        remoteOperationId: OPERATION_ID,
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(releases)(
    '$command refuses a replayed poll for another resource',
    async (release) => {
      const getOperation = vi
        .fn()
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running')
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running', {
            resourceId: OTHER_RESOURCE_ID
          })
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'succeeded')
        })
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke, invokeWith } = await releaseInvoker(
        release,
        getOperation,
        releaseResource,
        interruptedPollClock()
      )
      const { operationId } = (
        JSON.parse((await invoke(releaseArgs(release))).stdout) as ErrorDocument
      ).error

      const replayed = await invokeWith(instantPollClock())([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual(releaseProtocolError(release))
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        remoteOperationId: OPERATION_ID,
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(
    releases.flatMap((release) => [
      {
        name: 'another resource',
        release,
        returned: { ...release.released, resourceId: OTHER_RESOURCE_ID }
      },
      {
        name: 'a resource in another project',
        release,
        returned: { ...release.released, projectId: OTHER_PROJECT_ID }
      }
    ])
  )(
    '$release.command refuses a release read beside $name',
    async ({ release, returned }) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: releaseOperation(release, 'succeeded'),
          resource: { ...returned, state: 'retired' }
        })
      )
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke } = await releaseInvoker(
        release,
        getOperation,
        releaseResource
      )

      const result = await invoke(releaseArgs(release))

      expect(result.exitCodes).toEqual([1])
      expect(JSON.parse(result.stdout)).toEqual(releaseProtocolError(release))
      expect(result.stdout).not.toContain(OTHER_RESOURCE_ID)
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(releases)(
    '$command prints a release read beside the released resource',
    async (release) => {
      const read = {
        operation: releaseOperation(release, 'succeeded'),
        resource: { ...release.released, state: 'retired' }
      }
      const getOperation = vi.fn(() => Promise.resolve(read))
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke } = await releaseInvoker(
        release,
        getOperation,
        releaseResource
      )

      const result = await invoke(releaseArgs(release))

      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toEqual(read)
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )
})

describe('a release send whose answer is refused', () => {
  test.each(releases)(
    '$command sends the release again on each replay',
    async (release) => {
      const other = {
        operationId: OTHER_OPERATION_ID,
        resourceId: OTHER_RESOURCE_ID
      }
      const releaseResource = vi
        .fn()
        .mockResolvedValueOnce(
          rawResponse(releaseOperation(release, 'pending', other))
        )
        .mockResolvedValueOnce(
          rawResponse(releaseOperation(release, 'pending', other))
        )
        .mockResolvedValueOnce(
          rawResponse(releaseOperation(release, 'pending'))
        )
      const getOperation = vi.fn(
        ({ path }: { path: { operationId: string } }) =>
          Promise.resolve({
            operation:
              path.operationId === OPERATION_ID
                ? releaseOperation(release, 'succeeded')
                : releaseOperation(release, 'succeeded', other)
          })
      )
      const { authenticated, invoke } = await releaseInvoker(
        release,
        getOperation,
        releaseResource
      )

      const sent = await invoke(releaseArgs(release))
      const { operationId } = (JSON.parse(sent.stdout) as ErrorDocument).error
      const afterSend = await viewOperation(invoke, operationId)
      const replay = ['operation', 'replay', operationId, '--yes']
      const refused = await invoke(replay)
      const afterRefusedReplay = await viewOperation(invoke, operationId)
      const resolved = await invoke(replay)

      expect(sent.exitCodes).toEqual([1])
      expect(JSON.parse(sent.stdout)).toEqual(
        releaseProtocolError(release, OTHER_OPERATION_ID)
      )
      expect(afterSend).toMatchObject({ status: 'outcome-unknown' })
      expect(afterSend).not.toHaveProperty('remoteOperationId')
      expect(refused.exitCodes).toEqual([1])
      expect(JSON.parse(refused.stdout)).toEqual(
        releaseProtocolError(release, OTHER_OPERATION_ID)
      )
      expect(afterRefusedReplay).toMatchObject({ status: 'outcome-unknown' })
      expect(afterRefusedReplay).not.toHaveProperty('remoteOperationId')
      expect(resolved.exitCodes).toEqual([])
      expect(JSON.parse(resolved.stdout)).toMatchObject({
        operation: { operationId, status: 'resolved' },
        result: { operation: releaseOperation(release, 'succeeded') }
      })
      expect(releaseResource).toHaveBeenCalledTimes(3)
      expect(getOperation).toHaveBeenCalledExactlyOnceWith(
        { path: { id: PROJECT_ID, operationId: OPERATION_ID } },
        undefined
      )
      await authenticated.remove()
    }
  )
})

describe('the first read of a platform operation wait', () => {
  test.each(releases)(
    'operation replay of $command refuses a first read that names another operation',
    async (release) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: releaseOperation(release, 'succeeded', {
            operationId: OTHER_OPERATION_ID
          })
        })
      )
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke, invokeWith } = await releaseInvoker(
        release,
        getOperation,
        releaseResource,
        interruptedPollClock()
      )
      const { operationId } = (
        JSON.parse((await invoke(releaseArgs(release))).stdout) as ErrorDocument
      ).error

      const replayed = await invokeWith(instantPollClock())([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual(releaseProtocolError(release))
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        remoteOperationId: OPERATION_ID,
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(releases)(
    'operation replay of $command refuses a first read beside another resource',
    async (release) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: releaseOperation(release, 'succeeded'),
          resource: {
            ...release.released,
            resourceId: OTHER_RESOURCE_ID,
            state: 'retired'
          }
        })
      )
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
      )
      const { authenticated, invoke, invokeWith } = await releaseInvoker(
        release,
        getOperation,
        releaseResource,
        interruptedPollClock()
      )
      const { operationId } = (
        JSON.parse((await invoke(releaseArgs(release))).stdout) as ErrorDocument
      ).error

      const replayed = await invokeWith(instantPollClock())([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual(releaseProtocolError(release))
      expect(replayed.stdout).not.toContain(OTHER_RESOURCE_ID)
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        remoteOperationId: OPERATION_ID,
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  const purchases = [
    {
      args: ['project', 'platform', 'sms', 'purchase'],
      name: 'sms purchase',
      provisioned: smsNumber,
      purchase: 'purchaseSmsNumber'
    },
    {
      args: ['project', 'platform', 'imessage', 'purchase'],
      name: 'imessage purchase',
      provisioned: imessageLine,
      purchase: 'provisionImessageDedicatedLine'
    }
  ] as const

  test.each(purchases)(
    'operation replay of $name refuses a first read that names another operation',
    async ({ args, provisioned, purchase }) => {
      const authenticated = await createAuthenticatedConfig()
      const started = operation({
        resourceType: provisioned.type,
        state: 'pending',
        type: 'resource.provision'
      })
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: {
            ...started,
            operationId: OTHER_OPERATION_ID,
            state: 'succeeded'
          },
          resource: provisioned
        })
      )
      const scope = asProjectScope({ platforms: { getOperation } })
      const projectRawScope = asProjectRawScope({
        platforms: {
          [purchase]: vi.fn(() => Promise.resolve(rawResponse(started)))
        }
      })
      const failed = await cliInvoker(authenticated.configDirectory, scope, {
        clock: interruptedPollClock(),
        projectRawScope
      })([...args, ...PROJECT, '--yes'])
      const { operationId } = (JSON.parse(failed.stdout) as ErrorDocument).error
      const invoke = cliInvoker(authenticated.configDirectory, scope, {
        clock: instantPollClock(),
        projectRawScope
      })

      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual(refreshError({ operationId }))
      expect(replayed.stdout).not.toContain(provisioned.resourceId)
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        remoteOperationId: OPERATION_ID,
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  const emailConnectRun = async (
    started: ReturnType<typeof operation>,
    getOperation: Mock,
    clock: PollClock
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const scope = asProjectScope({ platforms: { getOperation } })
    const projectRawScope = asProjectRawScope({
      platforms: {
        connectEmailDomain: vi.fn(() => Promise.resolve(rawResponse(started)))
      }
    })
    const invokeWith = (nextClock: PollClock) =>
      cliInvoker(authenticated.configDirectory, scope, {
        clock: nextClock,
        projectRawScope
      })
    return {
      authenticated,
      connected: await invokeWith(clock)([
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        ...PROJECT,
        '--idempotency-key',
        'email-key'
      ]),
      invokeWith
    }
  }

  test('operation replay of email connect refuses a first read that names another operation', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation({
          detail: emailSetup,
          operationId: OTHER_OPERATION_ID,
          resourceType: 'email_domain',
          state: 'running',
          type: 'resource.provision'
        })
      })
    )
    const { authenticated, connected, invokeWith } = await emailConnectRun(
      operation({
        resourceType: 'email_domain',
        state: 'pending',
        type: 'resource.provision'
      }),
      getOperation,
      interruptedPollClock()
    )
    const { operationId } = (JSON.parse(connected.stdout) as ErrorDocument)
      .error
    const invoke = invokeWith(instantPollClock())

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.exitCodes).toEqual([1])
    expect(JSON.parse(replayed.stdout)).toEqual(refreshError({ operationId }))
    expect(replayed.stdout).not.toContain('a._domainkey.example.com')
    expect(await viewOperation(invoke, operationId)).toMatchObject({
      remoteOperationId: OPERATION_ID,
      status: 'outcome-unknown'
    })
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('email connect refuses a first verification read that names another operation', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation({
          detail: emailSetup,
          operationId: OTHER_OPERATION_ID,
          resourceType: 'email_domain',
          state: 'succeeded',
          type: 'resource.provision'
        }),
        resource: emailDomain
      })
    )
    const { authenticated, connected } = await emailConnectRun(
      operation({
        detail: emailSetup,
        resourceType: 'email_domain',
        state: 'running',
        type: 'resource.provision'
      }),
      getOperation,
      instantPollClock()
    )

    expect(connected.exitCodes).toEqual([1])
    expect(JSON.parse(connected.stdout)).toEqual(refreshError())
    expect(connected.stdout).not.toContain(emailDomain.resourceId)
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  const telegramConnect = async (
    connectTelegramBot: Mock,
    getOperation: Mock,
    flags: string[]
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const result = await cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { connectTelegramBot }
        })
      }
    )([
      'project',
      'platform',
      'telegram',
      'connect',
      ...PROJECT,
      '--idempotency-key',
      'telegram-key',
      '--no-browser',
      ...flags,
      '--yes'
    ])
    await authenticated.remove()
    return result
  }

  test('telegram connect refuses a first read of its wait that names another operation', async () => {
    const started = operation({
      detail: { setupUrl: SETUP_URL },
      resourceType: 'telegram_bot',
      state: 'pending',
      type: 'resource.provision'
    })
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: {
          ...started,
          detail: {},
          operationId: OTHER_OPERATION_ID,
          state: 'succeeded'
        },
        resource: telegramBot
      })
    )

    const result = await telegramConnect(
      vi.fn(() => Promise.resolve(rawResponse(started))),
      getOperation,
      []
    )

    expect(result.exitCodes).toEqual([1])
    expect(JSON.parse(result.stdout)).toEqual(refreshError())
    expect(result.stdout).not.toContain(telegramBot.resourceId)
    expect(getOperation).toHaveBeenCalledOnce()
  })

  test('telegram connect refuses a setup in progress whose read names another operation', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: operation({
          detail: { setupUrl: SETUP_URL },
          operationId: OTHER_OPERATION_ID,
          resourceType: 'telegram_bot',
          state: 'pending',
          type: 'resource.provision'
        })
      })
    )
    const connectTelegramBot = vi.fn(() =>
      Promise.reject(
        new ApiError('conflict', {
          body: {
            code: 'TELEGRAM_PROVISION_IN_PROGRESS',
            operationId: OPERATION_ID,
            operationUrl: `/v1/projects/${PROJECT_ID}/platforms/operations/${OPERATION_ID}`
          },
          headers: new Headers(),
          operationId: 'connectTelegramBot',
          status: 409
        })
      )
    )

    const result = await telegramConnect(connectTelegramBot, getOperation, [
      '--no-wait'
    ])

    expect(result.exitCodes).toEqual([1])
    expect(JSON.parse(result.stdout)).toEqual(refreshError())
    expect(result.stdout).not.toContain(SETUP_URL)
    expect(connectTelegramBot).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledOnce()
  })
})
