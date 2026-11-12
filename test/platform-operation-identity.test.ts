import { ResponseValidationError } from '@photon-ai/api'
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
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn03a'
const OTHER_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn03b'
const OTHER_RESOURCE_ID = 'pho_res_00000000000000000000000099'
const PROJECT = ['--project', PROJECT_ID]

interface OperationFields {
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
  'pho_res_00000000000000000000000041',
  'voip_line',
  ['sms'],
  { phoneNumber: '+14155550125' }
)
const imessageLine = resource(
  'pho_res_00000000000000000000000042',
  'cosmos_line',
  ['imessage'],
  { phoneNumber: '+14155550126' }
)
const telegramBot = resource(
  'pho_res_00000000000000000000000043',
  'telegram_bot',
  ['telegram'],
  {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  }
)
const emailDomain = resource(
  'pho_res_00000000000000000000000044',
  'email_domain',
  ['email'],
  { domain: 'example.com' }
)

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

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('the operation read again after a provisioning succeeds without its resource', () => {
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

  const purchaseRun = async (
    { provisioned, purchase }: (typeof purchases)[number],
    rereadOperationId: string
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const started = operation({
      resourceType: provisioned.type,
      state: 'pending',
      type: 'resource.provision'
    })
    const reread = {
      operation: {
        ...started,
        operationId: rereadOperationId,
        state: 'succeeded'
      },
      resource: provisioned
    }
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: { ...started, state: 'succeeded' } })
      .mockResolvedValueOnce(reread)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: {
            [purchase]: vi.fn(() => Promise.resolve(rawResponse(started)))
          }
        })
      }
    )
    return { authenticated, getOperation, invoke, reread }
  }

  test.each(purchases)(
    '$name prints the second read that names its operation',
    async (purchase) => {
      const { authenticated, getOperation, invoke, reread } = await purchaseRun(
        purchase,
        OPERATION_ID
      )

      const result = await invoke([...purchase.args, ...PROJECT, '--yes'])

      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toEqual(reread)
      expect(getOperation).toHaveBeenCalledTimes(2)
      await authenticated.remove()
    }
  )

  test.each(purchases)(
    '$name refuses a second read that names another operation',
    async (purchase) => {
      const { authenticated, getOperation, invoke } = await purchaseRun(
        purchase,
        OTHER_OPERATION_ID
      )

      const result = await invoke([...purchase.args, ...PROJECT, '--yes'])

      expect(result.exitCodes).toEqual([1])
      const document = JSON.parse(result.stdout) as ErrorDocument
      expect(document).toEqual({
        error: expect.objectContaining({
          code: 'PROJECT_PROTOCOL_ERROR',
          detail: 'The operation refresh returned a different operation ID.',
          message: 'Photon returned an invalid project response.',
          remoteOperationId: OPERATION_ID
        })
      })
      expect(result.stdout).not.toContain(purchase.provisioned.resourceId)
      expect(
        await viewOperation(invoke, document.error.operationId)
      ).toMatchObject({ status: 'outcome-unknown' })
      expect(getOperation).toHaveBeenCalledTimes(2)
      await authenticated.remove()
    }
  )

  const TELEGRAM_CONNECT = [
    'project',
    'platform',
    'telegram',
    'connect',
    ...PROJECT,
    '--idempotency-key',
    'telegram-key',
    '--no-browser',
    '--yes'
  ]

  const telegramRun = async (rereadOperationId: string) => {
    const authenticated = await createAuthenticatedConfig()
    const finished = operation({
      resourceType: 'telegram_bot',
      state: 'succeeded',
      type: 'resource.provision'
    })
    const reread = {
      operation: { ...finished, operationId: rereadOperationId },
      resource: telegramBot
    }
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: finished })
      .mockResolvedValueOnce(reread)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: {
            connectTelegramBot: vi.fn(() =>
              Promise.resolve(rawResponse(finished))
            )
          }
        })
      }
    )
    return { authenticated, getOperation, invoke, reread }
  }

  test('telegram connect prints the second read that names its setup', async () => {
    const { authenticated, getOperation, invoke, reread } =
      await telegramRun(OPERATION_ID)

    const result = await invoke(TELEGRAM_CONNECT)

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(reread)
    expect(getOperation).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('telegram connect refuses a second read that names another operation', async () => {
    const { authenticated, getOperation, invoke } =
      await telegramRun(OTHER_OPERATION_ID)

    const result = await invoke(TELEGRAM_CONNECT)

    expect(result.exitCodes).toEqual([1])
    expect(JSON.parse(result.stdout)).toEqual({
      error: expect.objectContaining({
        code: 'PROJECT_PROTOCOL_ERROR',
        detail: 'The operation refresh returned a different operation ID.',
        message: 'Photon returned an invalid project response.',
        remoteOperationId: OPERATION_ID
      })
    })
    expect(result.stdout).not.toContain(telegramBot.resourceId)
    expect(getOperation).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })
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

const mismatchesOf = (release: Release, resumed = false) =>
  (
    [
      ['another resource', { resourceId: OTHER_RESOURCE_ID }],
      ['another project', { projectId: 'pho_prj_00000000000000000000000002' }],
      ...(resumed
        ? [
            [
              'another operation',
              { operationId: OTHER_OPERATION_ID }
            ] satisfies [string, Partial<OperationFields>]
          ]
        : []),
      ['a provision', { type: 'resource.provision' }],
      ...(release.released.type === 'email_domain'
        ? [
            ['another resource type', { resourceType: 'voip_line' }] satisfies [
              string,
              Partial<OperationFields>
            ]
          ]
        : [])
    ] satisfies [string, Partial<OperationFields>][]
  ).map(([name, fields]) => ({ fields, name, release }))

const releaseRun = (
  release: Release,
  getOperation: Mock,
  releaseResource: Mock
) => ({
  projectRawScope: asProjectRawScope({ platforms: { releaseResource } }),
  scope: asProjectScope({
    platforms: {
      getOperation,
      getResource: vi.fn(() => Promise.resolve(release.released))
    }
  })
})

const releaseArgs = (release: Release) => [
  ...release.args,
  release.released.resourceId,
  ...PROJECT,
  '--yes'
]

const protocolError = (release: Release) => ({
  error: expect.objectContaining({
    code: 'PROJECT_PROTOCOL_ERROR',
    detail: release.detail,
    message: 'Photon returned an invalid project response.',
    remoteOperationId: OPERATION_ID
  })
})

describe('a release Photon accepts', () => {
  const sent = async (
    release: Release,
    accepted: ReturnType<typeof releaseOperation>,
    getOperation: Mock
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi.fn(() => Promise.resolve(rawResponse(accepted)))
    const { projectRawScope, scope } = releaseRun(
      release,
      getOperation,
      releaseResource
    )
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock: instantPollClock(),
      projectRawScope
    })
    return { authenticated, invoke, result: await invoke(releaseArgs(release)) }
  }

  test.each(releases)(
    '$command prints the release of the requested resource',
    async (release) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({ operation: releaseOperation(release, 'succeeded') })
      )
      const { authenticated, result } = await sent(
        release,
        releaseOperation(release, 'pending'),
        getOperation
      )

      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toEqual({
        operation: releaseOperation(release, 'succeeded')
      })
      await authenticated.remove()
    }
  )

  test.each(releases.flatMap((release) => mismatchesOf(release)))(
    '$release.command refuses an accepted release for $name',
    async ({ fields, release }) => {
      const getOperation = vi.fn()
      const { authenticated, invoke, result } = await sent(
        release,
        releaseOperation(release, 'pending', fields),
        getOperation
      )

      expect(result.exitCodes).toEqual([1])
      const document = JSON.parse(result.stdout) as ErrorDocument
      expect(document).toEqual(protocolError(release))
      expect(
        await viewOperation(invoke, document.error.operationId)
      ).toMatchObject({ status: 'outcome-unknown' })
      expect(getOperation).not.toHaveBeenCalled()
      await authenticated.remove()
    }
  )

  test.each(releases)(
    '$command refuses a release that ends for another resource',
    async (release) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({
          operation: releaseOperation(release, 'succeeded', {
            resourceId: OTHER_RESOURCE_ID
          })
        })
      )
      const { authenticated, invoke, result } = await sent(
        release,
        releaseOperation(release, 'pending'),
        getOperation
      )

      expect(result.exitCodes).toEqual([1])
      const document = JSON.parse(result.stdout) as ErrorDocument
      expect(document).toEqual(protocolError(release))
      expect(
        await viewOperation(invoke, document.error.operationId)
      ).toMatchObject({ status: 'outcome-unknown' })
      expect(getOperation).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )
})

describe('a replayed release that sends the release again', () => {
  const resent = async (
    release: Release,
    resentAnswer: ReturnType<typeof releaseOperation>,
    getOperation: Mock
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(rawResponse(resentAnswer))
    const { projectRawScope, scope } = releaseRun(
      release,
      getOperation,
      releaseResource
    )
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock: instantPollClock(),
      projectRawScope
    })
    const { operationId } = (
      JSON.parse((await invoke(releaseArgs(release))).stdout) as ErrorDocument
    ).error
    const recorded = await viewOperation(invoke, operationId)
    return {
      authenticated,
      invoke,
      operationId,
      recorded,
      releaseResource,
      replayed: await invoke(['operation', 'replay', operationId, '--yes'])
    }
  }

  test.each(releases)(
    '$command resolves a replay whose release names the recorded resource',
    async (release) => {
      const getOperation = vi.fn(() =>
        Promise.resolve({ operation: releaseOperation(release, 'succeeded') })
      )
      const {
        authenticated,
        operationId,
        recorded,
        releaseResource,
        replayed
      } = await resent(
        release,
        releaseOperation(release, 'pending'),
        getOperation
      )

      expect(recorded).not.toHaveProperty('remoteOperationId')
      expect(replayed.exitCodes).toEqual([])
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        operation: { operationId, status: 'resolved' },
        result: { operation: releaseOperation(release, 'succeeded') }
      })
      expect(releaseResource).toHaveBeenCalledTimes(2)
      await authenticated.remove()
    }
  )

  test.each(releases)(
    '$command refuses a replay whose release is for another resource',
    async (release) => {
      const getOperation = vi.fn()
      const {
        authenticated,
        invoke,
        operationId,
        recorded,
        releaseResource,
        replayed
      } = await resent(
        release,
        releaseOperation(release, 'pending', {
          resourceId: OTHER_RESOURCE_ID
        }),
        getOperation
      )

      expect(recorded).not.toHaveProperty('remoteOperationId')
      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual({
        error: expect.objectContaining({
          code: 'PROJECT_PROTOCOL_ERROR',
          detail: release.detail,
          operationId,
          remoteOperationId: OPERATION_ID
        })
      })
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        status: 'outcome-unknown'
      })
      expect(getOperation).not.toHaveBeenCalled()
      expect(releaseResource).toHaveBeenCalledTimes(2)
      await authenticated.remove()
    }
  )
})

describe('a replayed release that resumes its recorded operation', () => {
  const resumed = async (release: Release, getOperation: Mock) => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(releaseOperation(release, 'pending')))
    )
    const { projectRawScope, scope } = releaseRun(
      release,
      getOperation,
      releaseResource
    )
    const interrupted = await cliInvoker(authenticated.configDirectory, scope, {
      clock: interruptedPollClock(),
      projectRawScope
    })(releaseArgs(release))
    const { operationId } = (JSON.parse(interrupted.stdout) as ErrorDocument)
      .error
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock: instantPollClock(),
      projectRawScope
    })
    const recorded = await viewOperation(invoke, operationId)
    return {
      authenticated,
      invoke,
      operationId,
      recorded,
      releaseResource,
      replayed: await invoke(['operation', 'replay', operationId, '--yes'])
    }
  }

  test.each(releases)(
    '$command resolves a replay whose operation names the recorded resource',
    async (release) => {
      const getOperation = vi
        .fn()
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running')
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'succeeded')
        })
      const {
        authenticated,
        operationId,
        recorded,
        releaseResource,
        replayed
      } = await resumed(release, getOperation)

      expect(recorded).toMatchObject({ remoteOperationId: OPERATION_ID })
      expect(replayed.exitCodes).toEqual([])
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        operation: { operationId, status: 'resolved' },
        result: { operation: releaseOperation(release, 'succeeded') }
      })
      expect(getOperation).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(releases.flatMap((release) => mismatchesOf(release, true)))(
    '$release.command refuses a replay whose operation is for $name',
    async ({ fields, release }) => {
      const getOperation = vi
        .fn()
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running', fields)
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'succeeded', fields)
        })
      const {
        authenticated,
        invoke,
        operationId,
        recorded,
        releaseResource,
        replayed
      } = await resumed(release, getOperation)

      expect(recorded).toMatchObject({ remoteOperationId: OPERATION_ID })
      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual({
        error: expect.objectContaining({
          code: 'PROJECT_PROTOCOL_ERROR',
          detail: release.detail,
          message: 'Photon returned an invalid project response.',
          operationId,
          remoteOperationId: OPERATION_ID
        })
      })
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledOnce()
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test.each(releases)(
    '$command refuses a replay whose operation ends for another resource',
    async (release) => {
      const getOperation = vi
        .fn()
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'running')
        })
        .mockResolvedValueOnce({
          operation: releaseOperation(release, 'succeeded', {
            resourceId: OTHER_RESOURCE_ID
          })
        })
      const {
        authenticated,
        invoke,
        operationId,
        recorded,
        releaseResource,
        replayed
      } = await resumed(release, getOperation)

      expect(recorded).toMatchObject({ remoteOperationId: OPERATION_ID })
      expect(replayed.exitCodes).toEqual([1])
      expect(JSON.parse(replayed.stdout)).toEqual(protocolError(release))
      expect(await viewOperation(invoke, operationId)).toMatchObject({
        status: 'outcome-unknown'
      })
      expect(getOperation).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )
})
