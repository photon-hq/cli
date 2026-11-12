import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  type GetBillingOperationOutput,
  ResponseValidationError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { API_ORIGIN } from '../src/auth/constants.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { CliError } from '../src/core/errors.ts'
import {
  type InterruptSignal,
  listenForInterrupt
} from '../src/core/interrupt.ts'
import { CLI_ERROR_REFERENCE_URL } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { OperationRepository } from '../src/operation/repository.ts'
import {
  type OperationIntent,
  requestFingerprint
} from '../src/operation/types.ts'
import { photonKey } from './key-support.ts'
import {
  asAccountScope,
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  ONLY_ORGANIZATION_LINE,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'

const invitation = {
  acceptedAt: null,
  acceptedByAccountId: null,
  allProjects: true as const,
  createdAt: timestamp,
  email: 'member@example.test',
  expiresAt: '2026-08-07T18:00:00.000Z',
  invitationId: 'pho_oinv_00000000000000000000000001',
  invitedByAccountId: 'account_owner',
  organizationId: 'pho_org_00000000000000000000000001',
  role: 'member' as const,
  status: 'pending',
  updatedAt: timestamp
}

const member = {
  accountId: 'pho_acc_00000000000000000000000001',
  createdAt: timestamp,
  joinedVia: 'invitation',
  organizationId: 'pho_org_00000000000000000000000001',
  removedAt: null,
  role: 'member' as const,
  roleManagedAt: null,
  status: 'active',
  updatedAt: timestamp,
  version: 'member-version-1'
}

const accountFixture = {
  accountId: 'pho_acc_00000000000000000000000001',
  createdAt: timestamp,
  deletedAt: null,
  email: 'member@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: timestamp
}

const projectFixture = {
  agentProfile: {
    avatarUrl: 'https://images.example.test/avatar.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  createdByAccountId: 'pho_acc_00000000000000000000000001',
  createdByActorId: 'pho_acc_00000000000000000000000001',
  createdByActorKind: 'account',
  deletedAt: null,
  name: 'Alpha',
  organizationId: 'pho_org_00000000000000000000000001',
  projectId: 'pho_prj_00000000000000000000000001',
  slug: 'alpha',
  updatedAt: timestamp
}

const agentProfile = {
  avatarUrl: 'https://images.example.test/avatar.png',
  firstName: 'Photon',
  lastName: null
}

const newerProject = { ...projectFixture, futureField: 'from-a-newer-api' }

const newerAgentProfile = { ...agentProfile, futureField: 'from-a-newer-api' }

const newerAccount = { ...accountFixture, futureField: 'from-a-newer-api' }

const replayServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')

const newerServiceKey = {
  accountId: accountFixture.accountId,
  createdAt: timestamp,
  expiresAt: null,
  futureField: 'from-a-newer-api',
  name: 'Deploy key',
  revokedAt: null,
  serviceKeyId: replayServiceKeyId
}

const newerApiKey = {
  apiKeyId: photonKey('sk', '01h455vb4pex5vsknk084sn02q'),
  createdAt: timestamp,
  createdByAccountId: 'pho_acc_00000000000000000000000001',
  expiresAt: null,
  futureField: 'from-a-newer-api',
  name: 'Deploy key',
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: 'pho_prj_00000000000000000000000001',
  revokedAt: null
}

const REPLAY_PROJECT = ['--project', 'pho_prj_00000000000000000000000001']
const REPLAY_ORGANIZATION = ['--org', 'pho_org_00000000000000000000000001']

const newerMember = { ...member, futureField: 'from-a-newer-api' }
const newerInvitation = { ...invitation, futureField: 'from-a-newer-api' }

// The members a membership change reads to find the member's version.
const activeMembers = () =>
  Promise.resolve({ members: [{ ...member, account: null }] })

const smsResource = {
  abilities: ['sms', 'pstn_voice'],
  createdAt: timestamp,
  detail: { phoneNumber: '+14155550125' },
  futureField: 'from-a-newer-api',
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  state: 'active',
  type: 'voip_line',
  updatedAt: timestamp
}

const imessageResource = {
  abilities: ['imessage', 'pstn_voice'],
  createdAt: timestamp,
  detail: { healthy: true, phoneNumber: '+14155550126' },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000011',
  state: 'active',
  type: 'cosmos_line',
  updatedAt: timestamp
}

const emailDnsRecords = [
  { name: 'a._domainkey.example.com', type: 'CNAME' as const, value: 'a.dkim' },
  { name: 'b._domainkey.example.com', type: 'CNAME' as const, value: 'b.dkim' },
  { name: 'c._domainkey.example.com', type: 'CNAME' as const, value: 'c.dkim' },
  {
    name: 'bounce.example.com',
    priority: 10,
    type: 'MX' as const,
    value: 'feedback-smtp.us-west-2.amazonses.com'
  },
  {
    name: 'bounce.example.com',
    type: 'TXT' as const,
    value: 'v=spf1 include:amazonses.com ~all'
  },
  {
    name: 'example.com',
    priority: 10,
    type: 'MX' as const,
    value: 'inbound-smtp.us-west-2.amazonaws.com'
  }
]

const emailAutomaticSetup = {
  applyUrl:
    'https://connect.provider.example/v2/domainTemplates/providers/photon.codes/services/email-sending/apply?domain=example.com&key=_dcpubkeyv1&sig=signed',
  dnsProviderId: 'provider.example',
  providerDisplayName: 'Example DNS'
}

const emailResource = {
  abilities: ['email'],
  createdAt: timestamp,
  detail: { domain: 'example.com', healthy: true },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000021',
  state: 'active',
  type: 'email_domain',
  updatedAt: timestamp
}

const remoteOperation = (
  state: string,
  operationId = 'remote_operation_sms',
  resourceType = 'voip_line'
) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType,
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const releaseOperation = (
  state: string,
  operationId: string,
  released: { resourceId: string; type: string }
) => ({
  ...remoteOperation(state, operationId, released.type),
  resourceId: released.resourceId,
  type: 'resource.release'
})

const rawResponse = <Result>(data: Result, retryAfter = '2') => ({
  data,
  headers: new Headers({ 'retry-after': retryAfter }),
  status: 202
})

const billingOperation = (
  operationId: string,
  status: string,
  failure: null | {
    code: string
    detail: null | string
    retryable: boolean
  } = null
) => {
  const normalizedStatus = status.toUpperCase()
  const inProgress =
    normalizedStatus === 'PENDING' || normalizedStatus === 'RUNNING'
  return {
    failure,
    kind: 'purchase_plan',
    operationId,
    resolvedAt: inProgress ? null : timestamp,
    result:
      normalizedStatus === 'SUCCEEDED'
        ? { type: 'version' as const, version: 'version_1' }
        : null,
    status,
    submittedAt: timestamp
  } as unknown as GetBillingOperationOutput
}

const unavailable = (): ApiError =>
  new ApiError('service unavailable', {
    body: {
      code: 'PROJECTS_UNAVAILABLE',
      detail: 'The project service returned a temporary server error.'
    },
    headers: new Headers({ 'retry-after': '3' }),
    operationId: 'createProjectInvitation',
    requestId: 'req_operation_test',
    status: 503
  })

const upstreamUnavailable = (): ApiError =>
  new ApiError('upstream unavailable', {
    body: {
      code: 'UPSTREAM_UNAVAILABLE',
      detail: 'The project dependency rejected this request.'
    },
    headers: new Headers(),
    operationId: 'createProjectInvitation',
    requestId: 'req_upstream_operation_test',
    status: 503
  })

const notFound = (): ApiError =>
  new ApiError('not found', {
    body: { code: 'ASSIGNMENT_NOT_FOUND', detail: 'Assignment not found.' },
    headers: new Headers(),
    operationId: 'releaseSharedLineAssignment',
    status: 404
  })

const operationNotFound = (): ApiError =>
  new ApiError('not found', {
    body: { code: 'OPERATION_NOT_FOUND', detail: 'Operation not found.' },
    headers: new Headers(),
    operationId: 'getOperation',
    status: 404
  })

const retiredSmsResource = {
  ...smsResource,
  abilities: [],
  retiredAt: timestamp,
  state: 'retired'
}

const SMS_DELETE = [
  'project',
  'platform',
  'sms',
  'delete',
  'pho_res_00000000000000000000000001',
  '--project',
  'pho_prj_00000000000000000000000001',
  '--yes'
]

const retiredEmailResource = {
  ...emailResource,
  abilities: [],
  retiredAt: timestamp,
  state: 'retired'
}

const EMAIL_DISCONNECT = [
  'project',
  'platform',
  'email',
  'disconnect',
  emailResource.resourceId,
  '--project',
  'pho_prj_00000000000000000000000001',
  '--yes'
]

const interruptedPollClock = (): PollClock => ({
  now: () => 0,
  sleep: () => {
    throw new DOMException('cancelled', 'AbortError')
  },
  wallNow: () => TEST_NOW
})

const failsOnceThen = (response: object) =>
  vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValue(response)

type ReplayCall = ReturnType<typeof failsOnceThen>

const failedOperationId = (stdout: string): string =>
  (JSON.parse(stdout) as { error: { operationId: string } }).error.operationId

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

/**
 * Starts an iMessage purchase that Ctrl-C leaves pending, replays it, and
 * sends the signal while the replay holds the operation's lock and waits on
 * the remote operation's long poll. The journal comes back with its random
 * operation ID written as op_<random>, so two runs can be compared.
 */
const interruptReplay = async (signal: InterruptSignal) => {
  const authenticated = await createAuthenticatedConfig()
  const remoteOperationId = 'remote_operation_imessage'
  const provisionImessageDedicatedLine = vi.fn(() =>
    Promise.resolve(
      rawResponse(
        remoteOperation('pending', remoteOperationId, 'cosmos_line'),
        '5'
      )
    )
  )
  const getOperation = vi.fn(() =>
    Promise.resolve({
      operation: remoteOperation('running', remoteOperationId, 'cosmos_line')
    })
  )
  const projectScope = asProjectScope({ platforms: { getOperation } })
  const projectRawScope = asProjectRawScope({
    platforms: { provisionImessageDedicatedLine }
  })
  const purchaseClock = instantPollClock()
  vi.spyOn(purchaseClock, 'sleep').mockRejectedValueOnce(
    new DOMException('interrupted', 'AbortError')
  )
  const purchased = await cliInvoker(
    authenticated.configDirectory,
    projectScope,
    { clock: purchaseClock, projectRawScope }
  )([
    'project',
    'platform',
    'imessage',
    'purchase',
    '--project',
    'pho_prj_00000000000000000000000001',
    '--idempotency-key',
    'imessage-signal',
    '--yes'
  ])
  const { operationId } = (
    JSON.parse(purchased.stdout) as { error: { operationId: string } }
  ).error

  const emitter = new EventEmitter()
  const exit = vi.fn()
  const interrupt = listenForInterrupt({
    exit,
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener)
  })
  const replayClock = instantPollClock()
  let reachLongPoll = (): void => undefined
  const longPollReached = new Promise<void>((resolve) => {
    reachLongPoll = resolve
  })
  vi.spyOn(replayClock, 'sleep').mockImplementation(
    (_durationMs, abort) =>
      new Promise<void>((_resolve, reject) => {
        reachLongPoll()
        abort?.addEventListener('abort', () => reject(abort.reason), {
          once: true
        })
      })
  )
  const lockRoot = join(authenticated.configDirectory, 'operation-locks')
  const replay = cliInvoker(authenticated.configDirectory, projectScope, {
    clock: replayClock,
    projectRawScope,
    signal: interrupt.signal
  })(['operation', 'replay', operationId, '--yes'])
  await longPollReached
  const locksWhilePolling = await readdir(lockRoot)
  emitter.emit(signal)
  const replayed = await replay
  interrupt.dispose()

  const [scope] = await readdir(
    join(authenticated.configDirectory, 'operations')
  )
  const record = await readFile(
    join(
      authenticated.configDirectory,
      'operations',
      scope ?? '',
      `${operationId}.json`
    ),
    'utf8'
  )
  return {
    error: (JSON.parse(replayed.stdout) as { error: unknown }).error,
    exitCodes: replayed.exitCodes,
    exits: exit.mock.calls,
    journal: JSON.parse(
      record.replaceAll(operationId, 'op_<random>')
    ) as unknown,
    locksAfter: await readdir(lockRoot),
    locksWhilePolling,
    remoteOperationId
  }
}

describe('recoverable operation CLI', () => {
  test('winds a replay down alike on SIGINT, SIGTERM and SIGHUP and exits 128 plus the signal number', async () => {
    const outcomes = await Promise.all([
      interruptReplay('SIGINT'),
      interruptReplay('SIGTERM'),
      interruptReplay('SIGHUP')
    ])
    const [sigint, sigterm, sighup] = outcomes

    expect(outcomes.map(({ exitCodes }) => exitCodes)).toEqual([
      [130],
      [143],
      [129]
    ])
    for (const outcome of outcomes) {
      expect(outcome.error).toMatchObject({
        code: 'COMMAND_INTERRUPTED',
        remoteOperationId: outcome.remoteOperationId,
        replayable: true
      })
      expect(outcome.exits).toEqual([])
      expect(outcome.locksWhilePolling).toHaveLength(1)
      expect(outcome.locksAfter).toEqual([])
    }
    expect(sigint?.journal).toMatchObject({
      attemptCount: 2,
      failure: { code: 'COMMAND_INTERRUPTED' },
      remoteOperationId: sigint?.remoteOperationId,
      status: 'outcome-unknown'
    })
    expect(sigterm?.journal).toEqual(sigint?.journal)
    expect(sighup?.journal).toEqual(sigint?.journal)
  })

  test('records and replays an SMS purchase with its original key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const purchaseSmsNumber = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('purchaseSmsNumber', [], { status: 200 })
      )
      .mockResolvedValueOnce(rawResponse(remoteOperation('pending')))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: remoteOperation('succeeded'),
        resource: smsResource
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { purchaseSmsNumber }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'sms',
      'purchase',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'sms-purchase-replay',
      '--area-code',
      '415',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'API_PROTOCOL_ERROR',
        idempotencyKey: 'sms-purchase-replay',
        replayable: true,
        retryable: false
      }
    })
    expect(purchaseSmsNumber).toHaveBeenCalledOnce()

    const viewed = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project platform sms purchase',
        input: { projectId: 'pho_prj_00000000000000000000000001' },
        kind: 'sms-number.purchase',
        status: 'outcome-unknown'
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    const replayResult = JSON.parse(replayed.stdout)
    expect(replayed.stderr).toBe('')
    expect(replayResult).toMatchObject({
      operation: {
        kind: 'sms-number.purchase',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: {
        operation: { operationId: 'remote_operation_sms', state: 'succeeded' },
        resource: { resourceId: 'pho_res_00000000000000000000000001' }
      }
    })
    expect(JSON.stringify(replayResult)).toContain('from-a-newer-api')
    expect(purchaseSmsNumber).toHaveBeenCalledTimes(2)
    expect(purchaseSmsNumber.mock.calls[1]?.[0]).toEqual(
      purchaseSmsNumber.mock.calls[0]?.[0]
    )
    expect(purchaseSmsNumber.mock.calls[1]?.[0]).toEqual({
      body: { areaCode: '415', countryCode: 'US' },
      headers: { idempotencyKey: 'sms-purchase-replay' },
      path: { id: 'pho_prj_00000000000000000000000001' }
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    await authenticated.remove()
  })

  test('resumes an interrupted iMessage purchase from its remote operation ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const remoteOperationId = 'remote_operation_imessage'
    const provisionImessageDedicatedLine = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          remoteOperation('pending', remoteOperationId, 'cosmos_line'),
          '5'
        )
      )
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: remoteOperation(
          'succeeded',
          remoteOperationId,
          'cosmos_line'
        ),
        resource: imessageResource
      })
    )
    const clock = instantPollClock()
    vi.spyOn(clock, 'sleep').mockRejectedValueOnce(
      new DOMException('interrupted', 'AbortError')
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock,
        projectRawScope: asProjectRawScope({
          platforms: { provisionImessageDedicatedLine }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'imessage',
      'purchase',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'imessage-interrupted',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; remoteOperationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'COMMAND_INTERRUPTED',
        remoteOperationId,
        replayable: true
      }
    })

    const viewed = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project platform imessage purchase',
        kind: 'imessage-dedicated-line.purchase',
        remoteOperationId
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'imessage-dedicated-line.purchase',
        status: 'resolved'
      },
      result: { resource: { resourceId: 'pho_res_00000000000000000000000011' } }
    })
    expect(provisionImessageDedicatedLine).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('resumes an interrupted email connection until DNS instructions exist', async () => {
    const authenticated = await createAuthenticatedConfig()
    const remoteOperationId = 'remote_operation_email'
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          remoteOperation('pending', remoteOperationId, 'email_domain'),
          '60'
        )
      )
    )
    const operation = {
      ...remoteOperation('running', remoteOperationId, 'email_domain'),
      detail: {
        automaticSetup: emailAutomaticSetup,
        dnsRecords: emailDnsRecords
      }
    }
    const getOperation = vi.fn(() => Promise.resolve({ operation }))
    const clock = instantPollClock()
    vi.spyOn(clock, 'sleep').mockRejectedValueOnce(
      new DOMException('interrupted', 'AbortError')
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation } }),
      {
        clock,
        projectRawScope: asProjectRawScope({
          platforms: { connectEmailDomain }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'email',
      'connect',
      'Example.COM.',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'email-interrupted'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; remoteOperationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'COMMAND_INTERRUPTED',
        remoteOperationId,
        replayable: true
      }
    })
    expect(
      JSON.parse(
        (await invoke(['operation', 'view', failure.error.operationId])).stdout
      )
    ).toMatchObject({
      operation: {
        command: 'project platform email connect',
        input: {
          domain: 'example.com',
          projectId: 'pho_prj_00000000000000000000000001'
        },
        kind: 'email-domain.connect',
        remoteOperationId
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'email-domain.connect', status: 'resolved' },
      result: {
        operation: {
          detail: {
            automaticSetup: emailAutomaticSetup,
            dnsRecords: emailDnsRecords
          },
          operationId: remoteOperationId,
          state: 'running'
        }
      }
    })
    expect(connectEmailDomain).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('records and replays an SMS delete by its natural resource key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation('pending', 'remote_operation_release', smsResource)
        )
      )
    const getResource = vi.fn(() => Promise.resolve(smsResource))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: {
          ...releaseOperation(
            'succeeded',
            'remote_operation_release',
            smsResource
          ),
          futureField: 'from-a-newer-api'
        }
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'sms',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'API_PROTOCOL_ERROR',
        replayable: true,
        retryable: false
      }
    })

    const viewed = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project platform sms delete',
        input: {
          projectId: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000001'
        },
        kind: 'sms-number.delete',
        status: 'outcome-unknown'
      }
    })
    expect(JSON.parse(viewed.stdout).operation).not.toHaveProperty(
      'idempotencyKey'
    )

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    const replayResult = JSON.parse(replayed.stdout)
    expect(replayed.stderr).toBe('')
    expect(replayResult).toMatchObject({
      operation: {
        kind: 'sms-number.delete',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: {
        operation: {
          operationId: 'remote_operation_release',
          state: 'succeeded'
        }
      }
    })
    expect(JSON.stringify(replayResult)).toContain('from-a-newer-api')
    expect(releaseResource).toHaveBeenCalledTimes(2)
    expect(releaseResource.mock.calls[1]?.[0]).toEqual(
      releaseResource.mock.calls[0]?.[0]
    )
    expect(releaseResource.mock.calls[1]?.[0]).toEqual({
      path: {
        id: 'pho_prj_00000000000000000000000001',
        resourceId: 'pho_res_00000000000000000000000001'
      }
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    await authenticated.remove()
  })

  test('records and replays email disconnection by resource ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation(
            'pending',
            'remote_operation_email_release',
            emailResource
          ),
          '60'
        )
      )
    const getResource = vi.fn(() => Promise.resolve(emailResource))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: releaseOperation(
          'succeeded',
          'remote_operation_email_release',
          emailResource
        )
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'email',
      'disconnect',
      emailResource.resourceId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(
      JSON.parse(
        (await invoke(['operation', 'view', failure.error.operationId])).stdout
      )
    ).toMatchObject({
      operation: {
        command: 'project platform email disconnect',
        input: {
          projectId: 'pho_prj_00000000000000000000000001',
          resourceId: emailResource.resourceId
        },
        kind: 'email-domain.disconnect'
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'email-domain.disconnect', status: 'resolved' },
      result: {
        operation: {
          operationId: 'remote_operation_email_release',
          state: 'succeeded'
        }
      }
    })
    expect(releaseResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('polls pending SMS operation replays to terminal results', async () => {
    const authenticated = await createAuthenticatedConfig()
    const purchaseSmsNumber = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('purchaseSmsNumber', [], { status: 200 })
      )
      .mockResolvedValueOnce(rawResponse(remoteOperation('pending')))
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation('pending', 'remote_operation_release', smsResource)
        )
      )
    const getOperation = vi.fn((input: { path: { operationId: string } }) =>
      Promise.resolve(
        input.path.operationId === 'remote_operation_sms'
          ? {
              operation: remoteOperation('succeeded', input.path.operationId),
              resource: smsResource
            }
          : {
              operation: releaseOperation(
                'succeeded',
                input.path.operationId,
                smsResource
              )
            }
      )
    )
    const clock = instantPollClock()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: {
          getOperation,
          getResource: () => Promise.resolve(smsResource)
        }
      }),
      {
        clock,
        projectRawScope: asProjectRawScope({
          platforms: { purchaseSmsNumber, releaseResource }
        })
      }
    )

    const purchaseFailure = JSON.parse(
      (
        await invoke([
          'project',
          'platform',
          'sms',
          'purchase',
          '--project',
          'pho_prj_00000000000000000000000001',
          '--idempotency-key',
          'pending-purchase-replay',
          '--yes'
        ])
      ).stdout
    ) as { error: { operationId: string } }
    const purchaseReplay = await invoke([
      'operation',
      'replay',
      purchaseFailure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(purchaseReplay.stdout)).toMatchObject({
      operation: { kind: 'sms-number.purchase', status: 'resolved' },
      result: { resource: { resourceId: 'pho_res_00000000000000000000000001' } }
    })

    const deleteFailure = JSON.parse(
      (
        await invoke([
          'project',
          'platform',
          'sms',
          'delete',
          'pho_res_00000000000000000000000001',
          '--project',
          'pho_prj_00000000000000000000000001',
          '--yes'
        ])
      ).stdout
    ) as { error: { operationId: string } }
    const deleteReplay = await invoke([
      'operation',
      'replay',
      deleteFailure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(deleteReplay.stdout)).toMatchObject({
      operation: { kind: 'sms-number.delete', status: 'resolved' },
      result: {
        operation: {
          operationId: 'remote_operation_release',
          state: 'succeeded'
        }
      }
    })
    expect(clock.sleeps).toEqual([2000, 2000])

    await authenticated.remove()
  })

  test('records and replays leaving an organization with the original key and version', async () => {
    const authenticated = await createAuthenticatedConfig()
    const leaveOrganization = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('leaveOrganization', [], { status: 200 })
      )
      .mockResolvedValueOnce({ ...member, removedAt: timestamp })
    const listOrganizationMembers = vi.fn(() =>
      Promise.resolve({ members: [{ ...member, account: null }] })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        accountScope: asAccountScope({
          get: () => Promise.resolve(accountFixture)
        }),
        organizationScope: asOrganizationScope({
          leaveOrganization,
          listOrganizationMembers
        })
      }
    )

    const failed = await invoke([
      'org',
      'leave',
      '--idempotency-key',
      'leave-organization-replay',
      '--yes'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        idempotencyKey: 'leave-organization-replay',
        replayable: true
      }
    })
    expect(
      JSON.parse(
        (await invoke(['operation', 'view', failure.error.operationId])).stdout
      )
    ).toMatchObject({
      operation: {
        command: 'org leave',
        input: {
          expectedVersion: 'member-version-1',
          organizationId: 'pho_org_00000000000000000000000001'
        },
        kind: 'organization.leave'
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'organization.leave',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: { ...member, removedAt: timestamp }
    })
    expect(leaveOrganization.mock.calls[0]?.[0]).toEqual({
      body: { expectedVersion: 'member-version-1' },
      headers: { idempotencyKey: 'leave-organization-replay' },
      path: { organizationId: 'pho_org_00000000000000000000000001' }
    })
    expect(leaveOrganization.mock.calls[1]?.[0]).toEqual(
      leaveOrganization.mock.calls[0]?.[0]
    )
    expect(listOrganizationMembers).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test.each([
    ['CHARGE_REJECTED', 402],
    ['VALIDATION_FAILED', 422]
  ] as const)(
    'does not replay a definitive SMS purchase failure: %s',
    async (code, status) => {
      const authenticated = await createAuthenticatedConfig()
      const purchaseSmsNumber = vi.fn(() =>
        Promise.reject(
          new ApiError('purchase rejected', {
            body: {
              code,
              detail: 'The SMS purchase was definitively rejected.'
            },
            headers: new Headers(),
            operationId: 'purchaseSmsNumber',
            requestId: 'request_sms_rejected',
            status
          })
        )
      )
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        {
          projectRawScope: asProjectRawScope({
            platforms: { purchaseSmsNumber }
          })
        }
      )

      const failed = await invoke([
        'project',
        'platform',
        'sms',
        'purchase',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--yes'
      ])
      const failure = JSON.parse(failed.stdout)
      expect(failure).toMatchObject({
        error: {
          code,
          message: 'The SMS purchase was definitively rejected.',
          problem: { code, status },
          requestId: 'request_sms_rejected',
          retryable: false
        }
      })

      expect(failure.error).not.toHaveProperty('operationId')
      expect(failure.error).not.toHaveProperty('idempotencyKey')
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      expect(purchaseSmsNumber).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test('records a keyed failure and replays the same payload and key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(invitation)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )

    const failed = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'deployment-member-invite'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: {
        idempotencyKey: string
        operationId: string
        replayable: boolean
        requestId: string
        retryAfterSeconds: number
        retryable: boolean
      }
    }
    expect(failed.exitCodes).toEqual([1])
    expect(failure.error).toMatchObject({
      idempotencyKey: 'deployment-member-invite',
      problem: { status: 503 },
      replayable: true,
      requestId: 'req_operation_test',
      retryAfterSeconds: 3,
      retryable: true
    })

    const listed = await invoke(['operation', 'list'])
    expect(listed.stderr).toBe('')
    expect(JSON.parse(listed.stdout)).toMatchObject({
      operations: [
        {
          kind: 'organization-member.invite',
          operationId: failure.error.operationId,
          replayable: true,
          status: 'failed'
        }
      ]
    })
    expect(createInvitation).toHaveBeenCalledOnce()

    const inspected = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      operation: {
        command: 'org member invite',
        idempotencyKey: 'deployment-member-invite',
        input: {
          email: 'member@example.test',
          organizationId: 'pho_org_00000000000000000000000001',
          role: 'member'
        }
      }
    })
    expect(createInvitation).toHaveBeenCalledOnce()

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'organization-member.invite',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: invitation
    })
    expect(createInvitation).toHaveBeenCalledTimes(2)
    expect(createInvitation.mock.calls[0]?.[0]).toEqual(
      createInvitation.mock.calls[1]?.[0]
    )
    expect(createInvitation.mock.calls[1]?.[0].headers.idempotencyKey).toBe(
      'deployment-member-invite'
    )

    const empty = await invoke(['operation', 'list'])
    expect(JSON.parse(empty.stdout)).toEqual({ operations: [] })
    await authenticated.remove()
  })

  test('allows safe replay when an upstream failure is not retryable', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(upstreamUnavailable())
      .mockResolvedValueOnce(invitation)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )
    const failed = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'upstream-member-invite'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure.error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      replayable: true,
      retryable: false
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { status: 'resolved' },
      result: invitation
    })
    expect(createInvitation).toHaveBeenCalledTimes(2)
    expect(createInvitation.mock.calls[0]?.[0]).toEqual(
      createInvitation.mock.calls[1]?.[0]
    )
    await authenticated.remove()
  })

  test('skips corrupt records without blocking an unrelated supplied key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(invitation)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )

    await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'first@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'first-invitation'
    ])
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    if (scopeName === undefined) {
      throw new Error('Expected a scoped operation directory.')
    }
    await writeFile(
      join(
        operationsRoot,
        scopeName,
        'op_00000000-0000-4000-8000-000000000001.json'
      ),
      '{"schemaVersion":999}\n',
      { mode: 0o600 }
    )

    const continued = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'second@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'second-invitation'
    ])
    expect(JSON.parse(continued.stdout)).toEqual(invitation)
    expect(continued.stderr).toContain(
      'op_00000000-0000-4000-8000-000000000001.json'
    )
    expect(continued.exitCodes).toEqual([])
    const automatic = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'automatic@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(automatic.stdout)).toEqual(invitation)
    expect(automatic.stderr).toContain(
      'op_00000000-0000-4000-8000-000000000001.json'
    )
    expect(createInvitation).toHaveBeenCalledTimes(3)

    const corruptOperationId = 'op_00000000-0000-4000-8000-000000000001'
    const listed = await invoke(['operation', 'list'])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      operations: [
        expect.objectContaining({ kind: 'organization-member.invite' })
      ]
    })
    expect(listed.stdout).not.toContain('idempotencyKey')
    expect(listed.stderr).toContain(`${corruptOperationId}.json`)
    const inspections = await Promise.all(
      (['view', 'replay'] as const).map(
        async (command) =>
          await invoke([
            'operation',
            command,
            corruptOperationId,
            ...(command === 'replay' ? ['--yes'] : [])
          ])
      )
    )
    for (const inspected of inspections) {
      expect(inspected.stderr).toBe('')
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        error: { code: 'OPERATION_JOURNAL_CORRUPT' }
      })
    }
    const removed = await invoke([
      'operation',
      'remove',
      corruptOperationId,
      '--yes'
    ])
    expect(JSON.parse(removed.stdout)).toEqual({
      operationId: corruptOperationId,
      removed: true
    })
    await authenticated.remove()
  })

  test('sanitizes diagnostic identifiers before journaling them', async () => {
    const authenticated = await createAuthenticatedConfig()
    const create = vi.fn().mockRejectedValueOnce(
      new CliError(
        'PROJECTS_UNAVAILABLE',
        'Photon could not reach the project service.',
        {
          remoteOperationId: ' remote operation\n',
          requestId: ' request id\n',
          retryable: true,
          transportCode: ' ECONN RESET\n'
        }
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { organizationScope: asOrganizationScope({ projects: { create } }) }
    )

    const failed = await invoke([
      'project',
      'create',
      '--slug',
      'test-project',
      '--name',
      'Diagnostics'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const inspected = JSON.parse(
      (await invoke(['operation', 'view', failure.error.operationId])).stdout
    )
    expect(inspected).toMatchObject({
      operation: {
        failure: {
          remoteOperationId: 'remoteoperation',
          requestId: 'requestid',
          transportCode: 'ECONNRESET'
        },
        remoteOperationId: 'remoteoperation'
      }
    })
    await authenticated.remove()
  })

  test('retains an invitation token privately and replays without re-entry', async () => {
    const authenticated = await createAuthenticatedConfig()
    const privateToken = 'private-invitation-token-with-entropy'
    const acceptInvitation = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({
        allProjects: true,
        organizationId: 'pho_org_00000000000000000000000001',
        organizationName: 'Acme',
        role: 'member',
        status: 'accepted'
      })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          acceptOrganizationInvitation: acceptInvitation
        })
      }
    )

    const tokenFile = join(authenticated.configDirectory, 'initial-token')
    await writeFile(tokenFile, `${privateToken}\n`, { mode: 0o600 })
    const failed = await invoke([
      'org',
      'invitation',
      'accept',
      '--token-file',
      tokenFile
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const operation = JSON.parse(
      (await invoke(['operation', 'view', failure.error.operationId])).stdout
    ) as { operation: { input: object } }
    expect(operation.operation.input).toEqual({ tokenStored: true })

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    if (scopeName === undefined) {
      throw new Error('Expected a scoped operation directory.')
    }
    const serialized = await readFile(
      join(operationsRoot, scopeName, `${failure.error.operationId}.json`),
      'utf8'
    )
    expect(serialized).toContain(privateToken)
    expect(serialized).not.toContain(tokenFile)

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      result: {
        allProjects: true,
        organizationId: 'pho_org_00000000000000000000000001',
        organizationName: 'Acme',
        role: 'member',
        status: 'accepted'
      }
    })
    expect(acceptInvitation).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('loads records of the removed subscription intents and refuses their replay', async () => {
    const authenticated = await createAuthenticatedConfig()
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      now: () => TEST_NOW
    })
    const identity = await repository.identity()
    const created = new Date(TEST_NOW).toISOString()
    const intents: OperationIntent[] = [
      {
        category: 'messaging',
        kind: 'billing.subscription.cancel',
        projectId: 'pho_prj_00000000000000000000000001'
      },
      {
        category: 'messaging',
        kind: 'billing.subscription.resume',
        projectId: 'pho_prj_00000000000000000000000001'
      }
    ]
    const operationIds = intents.map(() => `op_${randomUUID()}`)
    for (const [index, intent] of intents.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: the journal takes one write at a time, as the CLI writes it.
      await repository.create({
        apiOrigin: identity.apiOrigin,
        attemptCount: 1,
        createdAt: created,
        expiresAt: new Date(TEST_NOW + 24 * 60 * 60 * 1000).toISOString(),
        failure: {
          code: 'PROJECTS_UNAVAILABLE',
          message: 'Photon could not reach the project service.',
          remediation: ['Recheck the subscription state.'],
          retryable: true
        },
        identityId: identity.identityId,
        intent,
        operationId: operationIds[index] ?? '',
        replayable: false,
        replayPolicy: 'none',
        requestFingerprint: requestFingerprint(intent),
        status: 'failed',
        updatedAt: created
      })
    }
    const changePlan = vi.fn()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({ billing: { changePlan } })
      }
    )

    const listed = await invoke(['operation', 'list'])
    expect(listed.stderr).toBe('')
    for (const operationId of operationIds) {
      expect(listed.stdout).toContain(operationId)
    }

    for (const operationId of operationIds) {
      // biome-ignore lint/performance/noAwaitInLoops: each run reads the journal the previous run left.
      const viewed = await invoke(['operation', 'view', operationId])
      expect(viewed.stderr).toBe('')
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        error: { code: 'OPERATION_NOT_REPLAYABLE', operationId }
      })
    }
    expect(changePlan).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('continues identical keys and rejects conflicting reuse before the API call', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createInvitation = vi.fn(() => Promise.reject(unavailable()))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )
    const invite = (email: string, key: string): string[] => [
      'org',
      'member',
      'invite',
      '--email',
      email,
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      key
    ]

    const invalid = await invoke(invite('member@example.test', 'has spaces'))
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail: expect.stringContaining('printable, non-whitespace ASCII'),
        retryable: false
      }
    })
    expect(invalid.exitCodes).toEqual([2])
    expect(createInvitation).not.toHaveBeenCalled()

    const original = await invoke(
      invite('member@example.test', 'logical-member-invite')
    )
    expect(original.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const originalError = JSON.parse(original.stdout) as {
      error: { operationId: string }
    }
    const duplicate = await invoke(
      invite('member@example.test', 'logical-member-invite')
    )
    expect(duplicate.stderr).toBe(ONLY_ORGANIZATION_LINE)
    expect(JSON.parse(duplicate.stdout)).toMatchObject({
      error: {
        code: 'PROJECTS_UNAVAILABLE',
        operationId: originalError.error.operationId
      }
    })
    const conflicting = await invoke(
      invite('other@example.test', 'logical-member-invite')
    )
    expect(JSON.parse(conflicting.stdout)).toMatchObject({
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        operationId: originalError.error.operationId
      }
    })
    expect(createInvitation).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(
        (await invoke(['operation', 'view', originalError.error.operationId]))
          .stdout
      )
    ).toMatchObject({ operation: { attemptCount: 2 } })

    const removed = await invoke([
      'operation',
      'remove',
      originalError.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(removed.stdout)).toEqual({
      operationId: originalError.error.operationId,
      removed: true
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    await authenticated.remove()
  })

  test('returns the original command output when a supplied key auto-resumes', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(invitation)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )
    const list = vi.spyOn(OperationRepository.prototype, 'list')
    const command = [
      'org',
      'member',
      'invite',
      '--email',
      invitation.email,
      '--role',
      invitation.role,
      '--idempotency-key',
      'resume-member-invite'
    ]

    const interrupted = await invoke(command)
    expect(interrupted.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failed = JSON.parse(interrupted.stdout) as {
      error: { operationId: string }
    }
    expect(list).toHaveBeenCalledOnce()
    const lease = vi.spyOn(OperationRepository.prototype, 'withReplayLease')
    list.mockClear()
    const resumed = await invoke(command)

    expect(resumed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    expect(JSON.parse(resumed.stdout)).toEqual(invitation)
    expect(resumed.stdout).not.toContain('operationId')
    expect(resumed.stdout).not.toContain('idempotencyKey')
    expect(list).toHaveBeenCalledOnce()
    expect(lease).toHaveBeenCalledWith(
      failed.error.operationId,
      expect.any(Function)
    )
    expect(createInvitation).toHaveBeenCalledTimes(2)
    expect(createInvitation.mock.calls[1]?.[0]).toEqual(
      createInvitation.mock.calls[0]?.[0]
    )
    const viewed = await invoke(['operation', 'view', failed.error.operationId])
    expect(viewed).toMatchObject({ exitCodes: [1], stderr: '' })
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      error: { code: 'OPERATION_NOT_FOUND' }
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })

    list.mockClear()
    const serverReplay = await invoke(command)
    expect(serverReplay.stderr).toBe(ONLY_ORGANIZATION_LINE)
    expect(JSON.parse(serverReplay.stdout)).toEqual(invitation)
    expect(list).toHaveBeenCalledOnce()
    expect(createInvitation).toHaveBeenCalledTimes(3)
    await authenticated.remove()
  })

  test('replays a pre-commit avatar failure from its private stored copy', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'agent.png')
    await writeFile(
      avatarFile,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      { mode: 0o600 }
    )
    const createAvatarUpload = vi
      .fn()
      .mockResolvedValueOnce({
        expiresAt: timestamp,
        formFields: {},
        uploadId: 'upload_1',
        uploadUrl: 'https://storage.example.test/upload-1'
      })
      .mockResolvedValueOnce({
        expiresAt: timestamp,
        formFields: {},
        uploadId: 'upload_2',
        uploadUrl: 'https://storage.example.test/upload-2'
      })
    const commitAvatar = vi.fn((_input: unknown) =>
      Promise.resolve(agentProfile)
    )
    const uploadFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const scope = asProjectScope({
      agentProfile: { commitAvatar, createAvatarUpload }
    })
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      fetch: uploadFetch
    })

    const failed = await invoke([
      'project',
      'agent-profile',
      'avatar',
      'upload',
      avatarFile,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'avatar-operation-key'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; replayable: boolean }
    }
    expect(failure.error.replayable).toBe(true)
    expect(commitAvatar).not.toHaveBeenCalled()
    const inspected = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      operation: { input: { fileName: 'agent.png', phase: 'upload' } }
    })
    await writeFile(avatarFile, 'the original file is no longer available')

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout).result).toEqual(agentProfile)
    expect(createAvatarUpload).toHaveBeenCalledTimes(2)
    expect(uploadFetch).toHaveBeenCalledTimes(2)
    expect(commitAvatar).toHaveBeenCalledOnce()
    expect(commitAvatar.mock.calls[0]?.[0]).toMatchObject({
      body: { uploadId: 'upload_2' },
      headers: { idempotencyKey: 'avatar-operation-key' }
    })
    await authenticated.remove()
  })

  test('resumes an uncertain avatar commit without uploading the file again', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'agent.webp')
    await writeFile(
      avatarFile,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    const createAvatarUpload = vi.fn(() =>
      Promise.resolve({
        expiresAt: timestamp,
        formFields: {},
        uploadId: 'upload_commit',
        uploadUrl: 'https://storage.example.test/upload'
      })
    )
    const commitAvatar = vi
      .fn((_input: unknown) => Promise.resolve(agentProfile))
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(agentProfile)
    const uploadFetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const scope = asProjectScope({
      agentProfile: { commitAvatar, createAvatarUpload }
    })
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      fetch: uploadFetch
    })

    const failed = await invoke([
      'project',
      'agent-profile',
      'avatar',
      'upload',
      avatarFile,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      'avatar-commit-key'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(
      JSON.parse(
        (await invoke(['operation', 'view', failure.error.operationId])).stdout
      )
    ).toMatchObject({ operation: { input: { phase: 'commit' } } })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(createAvatarUpload).toHaveBeenCalledOnce()
    expect(uploadFetch).toHaveBeenCalledOnce()
    expect(commitAvatar).toHaveBeenCalledTimes(2)
    expect(commitAvatar.mock.calls[1]?.[0]).toEqual(
      commitAvatar.mock.calls[0]?.[0]
    )
    await authenticated.remove()
  })

  test('serializes concurrent local replays so the mutation runs once', async () => {
    const authenticated = await createAuthenticatedConfig()
    let resolveReplay: ((value: typeof invitation) => void) | undefined
    const pendingReplay = new Promise<typeof invitation>((resolve) => {
      resolveReplay = resolve
    })
    const createInvitation = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockImplementationOnce(() => pendingReplay)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: createInvitation
        })
      }
    )

    const failed = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const replayArgs = [
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ]
    const firstReplay = invoke(replayArgs)
    await vi.waitFor(() => expect(createInvitation).toHaveBeenCalledTimes(2))
    const secondReplay = invoke(replayArgs)
    resolveReplay?.(invitation)
    const [first, second] = await Promise.all([firstReplay, secondReplay])

    expect(JSON.parse(first.stdout)).toMatchObject({
      operation: { status: 'resolved' }
    })
    expect(JSON.parse(second.stdout)).toMatchObject({
      error: { code: 'OPERATION_NOT_FOUND' }
    })
    expect(createInvitation).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test.each([
    {
      firstReplay: 'fails again',
      result: () => Promise.reject(unavailable()),
      view: (operationId: string) => ({
        operation: { operationId, status: 'failed' }
      })
    },
    {
      firstReplay: 'resolves it',
      result: () => Promise.resolve(invitation),
      view: (operationId: string) => ({
        error: {
          code: 'OPERATION_NOT_FOUND',
          detail: `No unresolved operation exists with ID ${operationId}.`
        }
      })
    }
  ])(
    'names the operation another process is running, and its step shows the result when that process $firstReplay',
    async ({ result, view }) => {
      const authenticated = await createAuthenticatedConfig()
      let finishFirstReplay:
        | ((outcome: Promise<typeof invitation>) => void)
        | undefined
      const pendingReplay = new Promise<typeof invitation>((resolve) => {
        finishFirstReplay = resolve
      })
      const createInvitation = vi
        .fn()
        .mockRejectedValueOnce(unavailable())
        .mockImplementationOnce(() => pendingReplay)
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        {
          organizationScope: asOrganizationScope({
            createOrganizationInvitation: createInvitation
          })
        }
      )
      const failed = await invoke([
        'org',
        'member',
        'invite',
        '--email',
        'member@example.test',
        '--role',
        'member',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
      const { operationId } = (
        JSON.parse(failed.stdout) as { error: { operationId: string } }
      ).error
      const replayArgs = ['operation', 'replay', operationId, '--yes']
      const firstReplay = invoke(replayArgs)
      await vi.waitFor(() => expect(createInvitation).toHaveBeenCalledTimes(2))

      // The second replay waits for the first one's lock until the acquisition
      // timeout. The clock moves only while it sleeps between attempts.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      let settled = false
      const secondReplay = invoke(replayArgs).finally(() => {
        settled = true
      })
      try {
        while (!settled) {
          // biome-ignore lint/performance/noAwaitInLoops: each attempt to take the lock waits on the one before it.
          await (vi.getTimerCount() > 0
            ? vi.advanceTimersToNextTimerAsync()
            : new Promise((resolve) => setImmediate(resolve)))
        }
      } finally {
        vi.useRealTimers()
      }
      const second = await secondReplay
      finishFirstReplay?.(result())
      await firstReplay

      const viewCommand = `${CLI_NAME} operation view ${operationId}`
      expect(second.exitCodes).toEqual([1])
      expect(JSON.parse(second.stdout)).toEqual({
        error: {
          code: 'OPERATION_LOCK_TIMEOUT',
          docsUrl: CLI_ERROR_REFERENCE_URL,
          message: 'Another Photon process is running this operation.',
          next: [
            {
              description:
                'Wait for the other process to finish, then check whether the operation is still unresolved',
              run: viewCommand
            }
          ],
          operationId,
          retryable: true
        }
      })
      expect(createInvitation).toHaveBeenCalledTimes(2)

      const viewed = await invoke(viewCommand.split(' ').slice(1))
      expect(JSON.parse(viewed.stdout)).toMatchObject(view(operationId))
      await authenticated.remove()
    }
  )

  test('names a record from another sign-in and the command that removes it', async () => {
    const authenticated = await createAuthenticatedConfig()
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      now: () => TEST_NOW
    })
    const identity = await repository.identity()
    const intent: OperationIntent = {
      activate: false,
      kind: 'project.create',
      name: 'Another sign-in'
    }
    const operationId = `op_${randomUUID()}`
    const created = new Date(TEST_NOW).toISOString()
    await repository.create({
      apiOrigin: identity.apiOrigin,
      attemptCount: 1,
      createdAt: created,
      expiresAt: new Date(TEST_NOW + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'another-sign-in',
      identityId: identity.identityId,
      intent,
      operationId,
      replayable: true,
      replayPolicy: 'keyed',
      requestFingerprint: requestFingerprint(intent),
      status: 'outcome-unknown',
      updatedAt: created
    })
    // Another sign-in's record, copied into this sign-in's journal folder.
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeKey = ''] = await readdir(operationsRoot)
    const recordPath = join(operationsRoot, scopeKey, `${operationId}.json`)
    const stored = JSON.parse(await readFile(recordPath, 'utf8')) as object
    await writeFile(
      recordPath,
      JSON.stringify({ ...stored, identityId: 'user_grace' })
    )
    const createInvitation = vi.fn(() => Promise.resolve(invitation))
    const scope = asProjectScope({})
    const overrides = {
      organizationScope: asOrganizationScope({
        createOrganizationInvitation: createInvitation
      })
    }
    const invoke = cliInvoker(authenticated.configDirectory, scope, overrides)
    const removeCommand = `${CLI_NAME} operation remove ${operationId} --yes`

    const listed = await terminalInvoker(
      authenticated.configDirectory,
      scope,
      overrides
    )(['operation', 'list'])
    expect(listed.stdout).toBe('')
    expect(listed.stderr).toBe(
      [
        'Error: The local operation belongs to a different Photon sign-in or API origin. (OPERATION_SCOPE_MISMATCH)',
        `Next: Remove the local record: ${removeCommand}`,
        `Operation ID: ${operationId}`,
        `Docs: ${CLI_ERROR_REFERENCE_URL}`,
        ''
      ].join('\n')
    )

    const invited = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(invited.stdout)).toMatchObject({
      error: {
        code: 'OPERATION_SCOPE_MISMATCH',
        next: [{ description: 'Remove the local record', run: removeCommand }],
        operationId
      }
    })
    expect(createInvitation).not.toHaveBeenCalled()

    const removed = await invoke(removeCommand.split(' ').slice(1))
    expect(JSON.parse(removed.stdout)).toEqual({ operationId, removed: true })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    await authenticated.remove()
  })

  test('marks a timed-out mutation as outcome-unknown', async () => {
    const authenticated = await createAuthenticatedConfig()
    const create = vi.fn(() =>
      Promise.reject(new DOMException('request timed out', 'TimeoutError'))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { organizationScope: asOrganizationScope({ projects: { create } }) }
    )

    const failed = await invoke([
      'project',
      'create',
      '--slug',
      'test-project',
      '--name',
      'Possibly Created'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; replayable: boolean }
    }
    expect(failure.error.replayable).toBe(true)
    const listed = await invoke([
      'operation',
      'list',
      '--status',
      'outcome-unknown'
    ])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      operations: [
        {
          operationId: failure.error.operationId,
          status: 'outcome-unknown'
        }
      ]
    })
    await authenticated.remove()
  })

  test('refreshes retention after a repeated replay failure', async () => {
    const authenticated = await createAuthenticatedConfig()
    let currentNow = TEST_NOW
    const create = vi.fn(() => Promise.reject(unavailable()))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        now: () => currentNow,
        organizationScope: asOrganizationScope({ projects: { create } })
      }
    )

    const failed = await invoke([
      'project',
      'create',
      '--slug',
      'test-project',
      '--name',
      'Retry Later'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const firstView = JSON.parse(
      (await invoke(['operation', 'view', failure.error.operationId])).stdout
    ) as { operation: { expiresAt: string } }

    currentNow += 60_000
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: { operationId: failure.error.operationId }
    })
    const secondView = JSON.parse(
      (await invoke(['operation', 'view', failure.error.operationId])).stdout
    ) as { operation: { expiresAt: string } }
    expect(Date.parse(secondView.operation.expiresAt)).toBeGreaterThan(
      Date.parse(firstView.operation.expiresAt)
    )
    expect(create).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('fails closed when the write-ahead record cannot be persisted', async () => {
    const authenticated = await createAuthenticatedConfig()
    await writeFile(
      join(authenticated.configDirectory, 'operations'),
      'not a directory',
      { mode: 0o600 }
    )
    const create = vi.fn()
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []
    await runCli(
      [
        'project',
        'create',
        '--slug',
        'test-project',
        '--name',
        'Never Sent',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope: asOrganizationScope({ projects: { create } }),
        platform: 'linux',
        projectScope: asProjectScope({}),
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toBe('')
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'OPERATION_PERSISTENCE_FAILED',
        detail: 'No mutation request was sent.',
        retryable: false
      }
    })
    expect(exitCodes).toEqual([1])
    expect(create).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('blocks replay when failure details cannot be persisted', async () => {
    const authenticated = await createAuthenticatedConfig()
    vi.spyOn(OperationRepository.prototype, 'update').mockRejectedValueOnce(
      new Error('simulated journal update failure')
    )
    const create = vi.fn().mockRejectedValueOnce(unavailable())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { organizationScope: asOrganizationScope({ projects: { create } }) }
    )

    const failed = await invoke([
      'project',
      'create',
      '--slug',
      'test-project',
      '--name',
      'Persist Me'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'OPERATION_PERSISTENCE_FAILED',
        replayable: false
      }
    })

    const listed = await invoke(['operation', 'list'])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      operations: [
        {
          operationId: failure.error.operationId,
          replayable: false,
          status: 'failed'
        }
      ]
    })
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: { code: 'OPERATION_NOT_REPLAYABLE' }
    })
    expect(create).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('does not mark local operation errors as replayable', async () => {
    const authenticated = await createAuthenticatedConfig()
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new CliError(
          'OPERATION_STORAGE_UNAVAILABLE',
          'Photon could not access the local operation journal.',
          { retryable: true }
        )
      )
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []
    await runCli(
      [
        'project',
        'create',
        '--slug',
        'test-project',
        '--name',
        'No Replay',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope: asOrganizationScope({ projects: { create } }),
        platform: 'linux',
        projectScope: asProjectScope({}),
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(stdout.value()) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'OPERATION_STORAGE_UNAVAILABLE',
        replayable: false,
        retryable: true
      }
    })
    expect(exitCodes).toEqual([1])

    const listStderr = collector()
    const listStdout = collector()
    await runCli(['operation', 'list', '--json'], {
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope: asOrganizationScope({ projects: { create } }),
      platform: 'linux',
      projectScope: asProjectScope({}),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: listStderr,
      stdout: listStdout
    })
    expect(listStderr.value()).toBe('')
    expect(JSON.parse(listStdout.value())).toMatchObject({
      operations: [
        {
          operationId: failure.error.operationId,
          replayable: false,
          status: 'failed'
        }
      ]
    })
    await authenticated.remove()
  })

  test('removes a stale record when failure updates keep failing', async () => {
    const authenticated = await createAuthenticatedConfig()
    vi.spyOn(OperationRepository.prototype, 'update')
      .mockRejectedValueOnce(new Error('simulated detailed update failure'))
      .mockRejectedValueOnce(new Error('simulated blocking update failure'))
    const create = vi.fn().mockRejectedValueOnce(unavailable())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { organizationScope: asOrganizationScope({ projects: { create } }) }
    )

    const failed = await invoke([
      'project',
      'create',
      '--slug',
      'test-project',
      '--name',
      'Remove Me'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    expect(JSON.parse(failed.stdout)).toMatchObject({
      error: {
        code: 'OPERATION_PERSISTENCE_FAILED',
        detail: expect.stringContaining(
          'The stale local record was removed to prevent replay.'
        ),
        replayable: false
      }
    })
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    expect(create).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('removes terminal billing rejection and settles a running purchase', async () => {
    const authenticated = await createAuthenticatedConfig()
    const changePlan = vi
      .fn()
      .mockResolvedValueOnce(
        billingOperation('billing_rejected', 'failed', {
          code: 'payment_failed',
          detail: 'Payment method declined.',
          retryable: false
        })
      )
      .mockResolvedValueOnce(billingOperation('billing_running', 'RUNNING'))
      .mockResolvedValueOnce(billingOperation('billing_completed', 'succeeded'))
    const getOperation = vi.fn(() =>
      Promise.resolve(billingOperation('billing_running', 'SUCCEEDED'))
    )
    const scope = asProjectScope({
      billing: { getOperation },
      get: () => Promise.resolve(projectFixture)
    })
    const clock = instantPollClock()
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock,
      organizationScope: asOrganizationScope({ billing: { changePlan } })
    })
    const purchase = (key: string): string[] => [
      'project',
      'billing',
      'plan',
      'purchase',
      '--category',
      'imessage',
      '--plan-code',
      'starter',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--idempotency-key',
      key,
      '--yes'
    ]

    const rejected = await invoke(purchase('billing-rejection-key'))
    const rejection = JSON.parse(rejected.stdout)
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      error: {
        code: 'BILLING_OPERATION_REJECTED',
        reason: 'payment_failed',
        remoteOperationId: 'billing_rejected'
      }
    })
    expect(rejection.error).not.toHaveProperty('operationId')
    expect(rejection.error).not.toHaveProperty('idempotencyKey')
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
    expect(changePlan).toHaveBeenCalledOnce()

    const settled = await invoke(purchase('billing-running-key'))
    expect(settled.stderr).toBe('')
    expect(JSON.parse(settled.stdout)).toEqual({
      failure: null,
      kind: 'purchase_plan',
      operationId: 'billing_running',
      resolvedAt: timestamp,
      result: { type: 'version', version: 'version_1' },
      status: 'SUCCEEDED',
      submittedAt: timestamp
    })
    expect(getOperation).toHaveBeenCalledOnce()
    expect(clock.sleeps).toEqual([2000])
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })

    const completed = await invoke(purchase('billing-completed-key'))
    expect(JSON.parse(completed.stdout)).toEqual({
      failure: null,
      kind: 'purchase_plan',
      operationId: 'billing_completed',
      resolvedAt: timestamp,
      result: { type: 'version', version: 'version_1' },
      status: 'succeeded',
      submittedAt: timestamp
    })
    await authenticated.remove()
  })

  test.each([
    {
      args: ['--category', 'platforms', '--yes'],
      command: 'cancel',
      subscription: {
        cancellationScheduled: true,
        cancelsAt: '2026-08-31T18:00:00.000Z',
        category: 'platforms'
      }
    },
    {
      args: ['--category', 'platforms'],
      command: 'resume',
      subscription: { category: 'platforms', resumed: true }
    }
  ])(
    'replays the plan change of subscription $command with the operation the command prints under operation',
    async ({ args, command, subscription }) => {
      const authenticated = await createAuthenticatedConfig()
      const plan = (planCode: string, isDefault: boolean) => ({
        isDefault,
        name: planCode === 'free' ? 'Free' : 'Business',
        planCode
      })
      const settled = {
        failure: null,
        futureField: 'from-a-newer-api',
        kind: 'change_plan',
        operationId: `pho_bop_${'a'.repeat(64)}`,
        paymentAction: null,
        resolvedAt: timestamp,
        result: {
          effectiveAt: '2026-08-31T18:00:00.000Z',
          type: 'version',
          version: 'version_2'
        },
        status: 'succeeded',
        submittedAt: timestamp
      }
      const changePlan = vi
        .fn()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue(settled)
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({
          billing: {
            getOverview: vi.fn().mockResolvedValue({
              entitlementsVersion: 1,
              subscriptions: [
                {
                  category: 'platforms',
                  planCode: 'business',
                  planName: 'Business'
                }
              ],
              usage: []
            }),
            listBillingPlans: vi.fn().mockResolvedValue({
              plans: {
                platforms: [plan('free', true), plan('business', false)]
              }
            })
          },
          get: () => Promise.resolve(projectFixture)
        }),
        {
          organizationScope: asOrganizationScope({
            billing: {
              changePlan,
              getEffectiveTerms: vi.fn().mockResolvedValue({
                subscriptions: [
                  {
                    category: 'platforms',
                    scheduledPlanChange: {
                      effectiveAt: '2026-08-31T18:00:00.000Z',
                      planCode: 'free'
                    }
                  }
                ],
                timeZone: 'UTC'
              })
            }
          })
        }
      )
      const change = [
        'project',
        'billing',
        'subscription',
        command,
        ...args,
        '--project',
        'pho_prj_00000000000000000000000001'
      ]

      const failed = await invoke(change)
      const operationId = failedOperationId(failed.stdout)
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])
      const changed = await invoke(change)

      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: {
          kind: 'billing.plan.purchase',
          operationId,
          status: 'resolved'
        },
        result: settled
      })
      expect(JSON.parse(changed.stdout)).toEqual({
        operation: settled,
        subscription
      })
      expect(changePlan).toHaveBeenCalledTimes(3)
      await authenticated.remove()
    }
  )

  test('converges a naturally idempotent delete replay on not found', async () => {
    const authenticated = await createAuthenticatedConfig()
    const release = vi.fn(() => Promise.reject(notFound()))
    const scope = asProjectScope({
      platforms: { imessage: { assignments: { release } } }
    })
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const failed = await invoke([
      'project',
      'platform',
      'imessage',
      'assignment',
      'release',
      'pho_asg_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; replayable: boolean }
    }
    expect(failure.error.replayable).toBe(true)
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'assignment.release',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: {
        assignmentId: 'pho_asg_00000000000000000000000001',
        released: true
      }
    })
    expect(release).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('replays an iMessage assignment create and release with the response the commands print', async () => {
    const authenticated = await createAuthenticatedConfig()
    const assignment = {
      assignedPhoneNumber: '+14155550124',
      assignmentId: 'pho_asg_00000000000000000000000001',
      createdAt: timestamp,
      futureField: 'from-a-newer-api',
      handle: '+14155550123',
      platform: 'imessage',
      projectId: 'pho_prj_00000000000000000000000001',
      updatedAt: timestamp
    }
    const released = { ...assignment, releasedAt: timestamp }
    const create = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(assignment)
    const release = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(released)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: { imessage: { assignments: { create, release } } }
      })
    )
    const assignments = ['project', 'platform', 'imessage', 'assignment']
    const project = ['--project', 'pho_prj_00000000000000000000000001']
    const createArgs = [
      ...assignments,
      'create',
      '--phone-number',
      '+14155550123',
      ...project,
      '--idempotency-key',
      'assignment-create-replay'
    ]
    const releaseArgs = [
      ...assignments,
      'release',
      assignment.assignmentId,
      ...project,
      '--yes'
    ]

    const createFailed = await invoke(createArgs)
    const createReplayed = await invoke([
      'operation',
      'replay',
      failedOperationId(createFailed.stdout),
      '--yes'
    ])
    const created = await invoke(createArgs)
    const releaseFailed = await invoke(releaseArgs)
    const releaseReplayed = await invoke([
      'operation',
      'replay',
      failedOperationId(releaseFailed.stdout),
      '--yes'
    ])
    const releasedDirectly = await invoke(releaseArgs)

    expect(JSON.parse(createReplayed.stdout)).toEqual({
      operation: {
        kind: 'assignment.create',
        operationId: failedOperationId(createFailed.stdout),
        status: 'resolved'
      },
      result: assignment
    })
    expect(JSON.parse(created.stdout)).toEqual(assignment)
    expect(JSON.parse(releaseReplayed.stdout)).toEqual({
      operation: {
        kind: 'assignment.release',
        operationId: failedOperationId(releaseFailed.stdout),
        status: 'resolved'
      },
      result: released
    })
    expect(JSON.parse(releasedDirectly.stdout)).toEqual(released)
    await authenticated.remove()
  })

  test.each([
    {
      args: () => [
        'project',
        'create',
        '--slug',
        'alpha',
        '--name',
        'Alpha',
        '--idempotency-key',
        'replay-project-create'
      ],
      kind: 'project.create',
      response: newerProject,
      scopes: (call: ReplayCall) => ({
        organizationScope: asOrganizationScope({ projects: { create: call } }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: () => [
        'project',
        'edit',
        '--name',
        'Alpha',
        ...REPLAY_PROJECT,
        '--idempotency-key',
        'replay-project-edit'
      ],
      kind: 'project.update',
      response: newerProject,
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({ update: call })
      })
    },
    {
      args: () => [
        'project',
        'delete',
        'pho_prj_00000000000000000000000001',
        '--yes'
      ],
      kind: 'project.delete',
      response: { ...newerProject, deletedAt: timestamp },
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({
          delete: call,
          get: vi.fn(() => Promise.resolve(projectFixture))
        })
      })
    },
    {
      args: () => [
        'project',
        'agent-profile',
        'edit',
        '--first-name',
        'Photon',
        ...REPLAY_PROJECT,
        '--idempotency-key',
        'replay-agent-profile-edit'
      ],
      kind: 'agent-profile.update',
      response: newerAgentProfile,
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({ agentProfile: { update: call } })
      })
    },
    {
      args: () => [
        'project',
        'agent-profile',
        'avatar',
        'reset',
        ...REPLAY_PROJECT,
        '--yes',
        '--idempotency-key',
        'replay-avatar-reset'
      ],
      kind: 'agent-avatar.reset',
      response: newerAgentProfile,
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({ agentProfile: { resetAvatar: call } })
      })
    },
    {
      args: () => [
        'project',
        'api-key',
        'create',
        '--permission',
        'project:read',
        '--name',
        'Deploy key',
        '--no-expiry',
        ...REPLAY_PROJECT,
        '--idempotency-key',
        'replay-api-key-create'
      ],
      kind: 'api-key.create',
      response: { apiKey: newerApiKey, secret: 'photon_api_key_private_value' },
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({ createProjectApiKey: call })
      })
    },
    {
      args: () => [
        'project',
        'api-key',
        'revoke',
        newerApiKey.apiKeyId,
        ...REPLAY_PROJECT,
        '--yes',
        '--idempotency-key',
        'replay-api-key-revoke'
      ],
      kind: 'api-key.revoke',
      response: { apiKey: { ...newerApiKey, revokedAt: timestamp } },
      scopes: (call: ReplayCall) => ({
        projectScope: asProjectScope({ revokeProjectApiKey: call })
      })
    },
    {
      args: (folder: string) => [
        'project',
        'agent-profile',
        'avatar',
        'upload',
        join(folder, 'agent.png'),
        ...REPLAY_PROJECT,
        '--idempotency-key',
        'replay-avatar-upload'
      ],
      kind: 'agent-avatar.upload',
      response: newerAgentProfile,
      scopes: (call: ReplayCall) => ({
        fetch: vi.fn(() =>
          Promise.resolve(new Response(null, { status: 204 }))
        ),
        projectScope: asProjectScope({
          agentProfile: {
            commitAvatar: call,
            createAvatarUpload: vi.fn(() =>
              Promise.resolve({
                expiresAt: timestamp,
                formFields: {},
                uploadId: 'upload_1',
                uploadUrl: 'https://storage.example.test/upload-1'
              })
            )
          }
        })
      }),
      setUp: async (folder: string) => {
        await writeFile(
          join(folder, 'agent.png'),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
        )
      }
    },
    {
      args: () => [
        'org',
        'member',
        'edit',
        member.accountId,
        '--role',
        'admin',
        ...REPLAY_ORGANIZATION,
        '--idempotency-key',
        'replay-member-edit'
      ],
      kind: 'organization-member.update',
      response: { ...newerMember, role: 'admin' },
      scopes: (call: ReplayCall) => ({
        organizationScope: asOrganizationScope({
          listOrganizationMembers: activeMembers,
          updateOrganizationMemberRole: call
        }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: () => [
        'org',
        'member',
        'remove',
        member.accountId,
        ...REPLAY_ORGANIZATION,
        '--yes',
        '--idempotency-key',
        'replay-member-remove'
      ],
      kind: 'organization-member.remove',
      response: { ...newerMember, removedAt: timestamp, status: 'removed' },
      scopes: (call: ReplayCall) => ({
        organizationScope: asOrganizationScope({
          listOrganizationMembers: activeMembers,
          removeOrganizationMember: call
        }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: () => [
        'org',
        'invitation',
        'revoke',
        invitation.invitationId,
        ...REPLAY_ORGANIZATION,
        '--yes',
        '--idempotency-key',
        'replay-invitation-revoke'
      ],
      kind: 'organization-invitation.revoke',
      response: { ...newerInvitation, status: 'revoked' },
      scopes: (call: ReplayCall) => ({
        organizationScope: asOrganizationScope({
          revokeOrganizationInvitation: call
        }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: (folder: string) => [
        'org',
        'invitation',
        'accept',
        '--token-file',
        join(folder, 'invitation-token'),
        '--idempotency-key',
        'replay-invitation-accept'
      ],
      kind: 'organization-invitation.accept',
      response: {
        allProjects: true,
        futureField: 'from-a-newer-api',
        organizationId: invitation.organizationId,
        organizationName: 'Acme',
        role: 'member',
        status: 'accepted'
      },
      scopes: (call: ReplayCall) => ({
        organizationScope: asOrganizationScope({
          acceptOrganizationInvitation: call
        }),
        projectScope: asProjectScope({})
      }),
      setUp: async (folder: string) => {
        await writeFile(
          join(folder, 'invitation-token'),
          'replay-invitation-token\n',
          { mode: 0o600 }
        )
      }
    },
    {
      args: () => [
        'account',
        'edit',
        '--first-name',
        'Ada',
        '--idempotency-key',
        'replay-account-edit'
      ],
      kind: 'account.update',
      response: newerAccount,
      scopes: (call: ReplayCall) => ({
        accountScope: asAccountScope({ update: call }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: () => [
        'account',
        'avatar',
        'reset',
        '--yes',
        '--idempotency-key',
        'replay-account-avatar-reset'
      ],
      kind: 'account-avatar.reset',
      response: newerAccount,
      scopes: (call: ReplayCall) => ({
        accountScope: asAccountScope({ resetProfilePicture: call }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: (folder: string) => [
        'account',
        'avatar',
        'upload',
        join(folder, 'account.png'),
        '--idempotency-key',
        'replay-account-avatar-upload'
      ],
      kind: 'account-avatar.upload',
      response: newerAccount,
      scopes: (call: ReplayCall) => ({
        accountScope: asAccountScope({
          commitProfilePicture: call,
          createProfilePictureUpload: vi.fn(() =>
            Promise.resolve({
              expiresAt: timestamp,
              formFields: {},
              uploadId: 'upload_1',
              uploadUrl: 'https://storage.example.test/upload-1'
            })
          )
        }),
        fetch: vi.fn(() =>
          Promise.resolve(new Response(null, { status: 204 }))
        ),
        projectScope: asProjectScope({})
      }),
      setUp: async (folder: string) => {
        await writeFile(
          join(folder, 'account.png'),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
        )
      }
    },
    {
      args: () => [
        'account',
        'service-key',
        'create',
        '--name',
        'Deploy key',
        '--no-expiry',
        '--idempotency-key',
        'replay-service-key-create'
      ],
      kind: 'account-service-key.create',
      response: {
        secret: `${replayServiceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`,
        serviceKey: newerServiceKey
      },
      scopes: (call: ReplayCall) => ({
        accountScope: asAccountScope({ createAccountServiceKey: call }),
        projectScope: asProjectScope({})
      })
    },
    {
      args: () => [
        'account',
        'service-key',
        'revoke',
        replayServiceKeyId,
        '--yes',
        '--idempotency-key',
        'replay-service-key-revoke'
      ],
      kind: 'account-service-key.revoke',
      response: { serviceKey: { ...newerServiceKey, revokedAt: timestamp } },
      scopes: (call: ReplayCall) => ({
        accountScope: asAccountScope({ revokeAccountServiceKey: call }),
        projectScope: asProjectScope({})
      })
    }
  ])(
    'replays $kind with the response the command prints',
    async ({ args, kind, response, scopes, setUp }) => {
      const authenticated = await createAuthenticatedConfig()
      await setUp?.(authenticated.configDirectory)
      const call = failsOnceThen(response)
      const { projectScope, ...overrides } = scopes(call)
      const invoke = cliInvoker(
        authenticated.configDirectory,
        projectScope,
        overrides
      )

      const failed = await invoke(args(authenticated.configDirectory))
      const replayed = await invoke([
        'operation',
        'replay',
        failedOperationId(failed.stdout),
        '--yes'
      ])
      const direct = await invoke(args(authenticated.configDirectory))

      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: {
          kind,
          operationId: failedOperationId(failed.stdout),
          status: 'resolved'
        },
        result: response
      })
      expect(JSON.parse(direct.stdout)).toEqual(response)
      expect(call).toHaveBeenCalledTimes(3)
      await authenticated.remove()
    }
  )

  test('replays an edit whose response has a next field with that field in its result', async () => {
    const authenticated = await createAuthenticatedConfig()
    const response = {
      ...newerProject,
      next: [
        { description: 'API \u001b[31mfield\u202e', run: 'curl example.test' }
      ]
    }
    const update = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue(response)
    const scope = asProjectScope({ update })
    const edit = (idempotencyKey: string) => [
      'project',
      'edit',
      '--name',
      'Alpha',
      ...REPLAY_PROJECT,
      '--idempotency-key',
      idempotencyKey
    ]
    const invoke = cliInvoker(authenticated.configDirectory, scope)
    const failedJson = await invoke(edit('replay-next-json'))
    const failedText = await invoke(edit('replay-next-text'))

    const json = await invoke([
      'operation',
      'replay',
      failedOperationId(failedJson.stdout),
      '--yes'
    ])
    const text = await terminalInvoker(
      authenticated.configDirectory,
      scope
    )(['operation', 'replay', failedOperationId(failedText.stdout), '--yes'])

    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout).result).toEqual(response)
    expect(json.stderr).not.toContain('Next:')
    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toContain(
      `Replayed operation ${failedOperationId(failedText.stdout)}.`
    )
    for (const output of [text.stdout, text.stderr]) {
      expect(output).not.toContain('Next:')
      expect(output).not.toContain('\u001b[31m')
      expect(output).not.toContain('\u202e')
    }
    expect(update).toHaveBeenCalledTimes(4)
    await authenticated.remove()
  })

  test('converges an SMS delete replay when its resource is already gone', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() => Promise.reject(notFound()))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } })
    )

    const failed = await invoke([
      'project',
      'platform',
      'sms',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string; replayable: boolean }
    }
    expect(failure.error.replayable).toBe(true)

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'sms-number.delete', status: 'resolved' },
      result: {
        deleted: true,
        resourceId: 'pho_res_00000000000000000000000001'
      }
    })
    expect(getResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('resolves an SMS delete replay without a remote ID when the number is retired', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(smsResource)
      .mockResolvedValueOnce(retiredSmsResource)
    const releaseResource = vi.fn(() =>
      Promise.reject(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } }),
      {
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const operationId = failedOperationId((await invoke(SMS_DELETE)).stdout)
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'sms-number.delete', status: 'resolved' },
      result: {
        resource: {
          resourceId: 'pho_res_00000000000000000000000001',
          state: 'retired'
        }
      }
    })
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('keeps an SMS delete unresolved when its operation is not found and the number is active', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
    const getResource = vi.fn(() => Promise.resolve(smsResource))
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          releaseOperation('pending', 'remote_operation_release', smsResource)
        )
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: interruptedPollClock(),
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const operationId = failedOperationId((await invoke(SMS_DELETE)).stdout)
    expect(
      JSON.parse((await invoke(['operation', 'view', operationId])).stdout)
    ).toMatchObject({
      operation: { remoteOperationId: 'remote_operation_release' }
    })
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
      failure: { code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN' },
      replayable: true,
      status: 'outcome-unknown'
    })
    expect(viewed.operation).not.toHaveProperty('remoteOperationId')
    expect(getOperation).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test.each([
    ['retired', () => Promise.resolve(retiredSmsResource)],
    ['gone', () => Promise.reject(notFound())]
  ])(
    'resolves an SMS delete when its operation is not found and the number is %s',
    async (_target, readTarget) => {
      const authenticated = await createAuthenticatedConfig()
      const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
      const getResource = vi
        .fn()
        .mockResolvedValueOnce(smsResource)
        .mockImplementationOnce(readTarget)
      const releaseResource = vi.fn(() =>
        Promise.resolve(
          rawResponse(
            releaseOperation('pending', 'remote_operation_release', smsResource)
          )
        )
      )
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({ platforms: { getOperation, getResource } }),
        {
          clock: interruptedPollClock(),
          projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
        }
      )

      const operationId = failedOperationId((await invoke(SMS_DELETE)).stdout)
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.stderr).toBe('')
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        operation: { kind: 'sms-number.delete', status: 'resolved' },
        result: {
          deleted: true,
          resourceId: 'pho_res_00000000000000000000000001'
        }
      })
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      expect(getOperation).toHaveBeenCalledOnce()
      expect(getResource).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test('sends an SMS delete again on the replay after its operation was not found', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn((input: { path: { operationId: string } }) =>
      input.path.operationId === 'remote_operation_release'
        ? Promise.reject(operationNotFound())
        : Promise.resolve({
            operation: releaseOperation(
              'succeeded',
              input.path.operationId,
              smsResource
            )
          })
    )
    const getResource = vi.fn(() => Promise.resolve(smsResource))
    const releaseResource = vi
      .fn()
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation('pending', 'remote_operation_release', smsResource)
        )
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation('pending', 'remote_operation_resent', smsResource)
        )
      )
    const scope = asProjectScope({ platforms: { getOperation, getResource } })
    const projectRawScope = asProjectRawScope({
      platforms: { releaseResource }
    })
    const interrupted = cliInvoker(authenticated.configDirectory, scope, {
      clock: interruptedPollClock(),
      projectRawScope
    })
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock: instantPollClock(),
      projectRawScope
    })

    const operationId = failedOperationId(
      (await interrupted(SMS_DELETE)).stdout
    )
    const first = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(first.stdout)).toMatchObject({
      error: { code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN', operationId }
    })
    const second = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(second.stderr).toBe('')
    expect(JSON.parse(second.stdout)).toMatchObject({
      operation: { kind: 'sms-number.delete', operationId, status: 'resolved' },
      result: {
        operation: {
          operationId: 'remote_operation_resent',
          state: 'succeeded'
        }
      }
    })
    expect(
      getOperation.mock.calls.map(([input]) => input.path.operationId)
    ).toEqual(['remote_operation_release', 'remote_operation_resent'])
    expect(releaseResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('reads the number after a replayed SMS delete loses the operation it just started', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
    const getResource = vi.fn(() => Promise.resolve(smsResource))
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation('pending', 'remote_operation_release', smsResource)
        )
      )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
      }
    )

    const operationId = failedOperationId((await invoke(SMS_DELETE)).stdout)
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.exitCodes).toEqual([1])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: { code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN', operationId }
    })
    expect(
      JSON.parse((await invoke(['operation', 'view', operationId])).stdout)
        .operation
    ).not.toHaveProperty('remoteOperationId')
    expect(getOperation).toHaveBeenCalledOnce()
    expect(getResource).toHaveBeenCalledTimes(3)
    expect(releaseResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test.each([
    {
      answer: 'Photon answers its domain read with 404',
      getResource: () =>
        vi
          .fn()
          .mockResolvedValueOnce(emailResource)
          .mockRejectedValue(notFound()),
      releaseResource: () => vi.fn().mockRejectedValueOnce(unavailable()),
      releases: 1
    },
    {
      answer: 'Photon answers its release with 404',
      getResource: () => vi.fn(() => Promise.resolve(emailResource)),
      releaseResource: () =>
        vi
          .fn()
          .mockRejectedValueOnce(unavailable())
          .mockRejectedValueOnce(notFound()),
      releases: 2
    },
    {
      answer:
        'the domain reads retired and Photon answers its release with 404',
      getResource: () =>
        vi
          .fn()
          .mockResolvedValueOnce(emailResource)
          .mockResolvedValue(retiredEmailResource),
      releaseResource: () =>
        vi
          .fn()
          .mockRejectedValueOnce(unavailable())
          .mockRejectedValueOnce(notFound()),
      releases: 2
    }
  ])(
    'resolves a replayed email disconnect when $answer',
    async ({ releases, ...api }) => {
      const authenticated = await createAuthenticatedConfig()
      const getResource = api.getResource()
      const releaseResource = api.releaseResource()
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({ platforms: { getResource } }),
        {
          projectRawScope: asProjectRawScope({ platforms: { releaseResource } })
        }
      )

      const operationId = failedOperationId(
        (await invoke(EMAIL_DISCONNECT)).stdout
      )
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([])
      expect(replayed.stderr).toBe('')
      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: {
          kind: 'email-domain.disconnect',
          operationId,
          status: 'resolved'
        },
        result: { disconnected: true, resourceId: emailResource.resourceId }
      })
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      expect(getResource).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledTimes(releases)
      await authenticated.remove()
    }
  )

  test('prints a replayed email disconnect that Photon answers with 404 in text', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = asProjectScope({
      platforms: { getResource: vi.fn(() => Promise.reject(notFound())) }
    })

    const operationId = failedOperationId(
      (await cliInvoker(authenticated.configDirectory, scope)(EMAIL_DISCONNECT))
        .stdout
    )
    const replayed = await terminalInvoker(
      authenticated.configDirectory,
      scope
    )(['operation', 'replay', operationId, '--yes'])

    expect(replayed.exitCodes).toEqual([])
    expect(replayed.stdout).toBe(`Replayed operation ${operationId}.\n`)
    expect(
      JSON.parse(
        (
          await cliInvoker(
            authenticated.configDirectory,
            scope
          )(['operation', 'list'])
        ).stdout
      )
    ).toEqual({ operations: [] })
    await authenticated.remove()
  })

  test.each([
    ['retired', () => Promise.resolve(retiredEmailResource)],
    ['gone', () => Promise.reject(notFound())]
  ])(
    'resolves an email disconnect when its operation is not found and the domain is %s',
    async (_target, readTarget) => {
      const authenticated = await createAuthenticatedConfig()
      const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
      const getResource = vi
        .fn()
        .mockResolvedValueOnce(emailResource)
        .mockImplementationOnce(readTarget)
      const releaseResource = vi.fn(() =>
        Promise.resolve(
          rawResponse(
            releaseOperation(
              'pending',
              'remote_operation_email_release',
              emailResource
            )
          )
        )
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
        (await invoke(EMAIL_DISCONNECT)).stdout
      )
      expect(
        JSON.parse((await invoke(['operation', 'view', operationId])).stdout)
      ).toMatchObject({
        operation: { remoteOperationId: 'remote_operation_email_release' }
      })
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.exitCodes).toEqual([])
      expect(replayed.stderr).toBe('')
      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: {
          kind: 'email-domain.disconnect',
          operationId,
          status: 'resolved'
        },
        result: { disconnected: true, resourceId: emailResource.resourceId }
      })
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      expect(getOperation).toHaveBeenCalledOnce()
      expect(getResource).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test('sends an email disconnect again after its operation was not found and the domain is still active', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn((input: { path: { operationId: string } }) =>
      input.path.operationId === 'remote_operation_email_release'
        ? Promise.reject(operationNotFound())
        : Promise.resolve({
            operation: releaseOperation(
              'succeeded',
              input.path.operationId,
              emailResource
            )
          })
    )
    const getResource = vi.fn(() => Promise.resolve(emailResource))
    const releaseResource = vi
      .fn()
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation(
            'pending',
            'remote_operation_email_release',
            emailResource
          )
        )
      )
      .mockResolvedValueOnce(
        rawResponse(
          releaseOperation(
            'pending',
            'remote_operation_email_resent',
            emailResource
          )
        )
      )
    const scope = asProjectScope({ platforms: { getOperation, getResource } })
    const projectRawScope = asProjectRawScope({
      platforms: { releaseResource }
    })
    const interrupted = cliInvoker(authenticated.configDirectory, scope, {
      clock: interruptedPollClock(),
      projectRawScope
    })
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      clock: instantPollClock(),
      projectRawScope
    })

    const operationId = failedOperationId(
      (await interrupted(EMAIL_DISCONNECT)).stdout
    )
    const first = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(first.exitCodes).toEqual([1])
    expect(JSON.parse(first.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN',
        operationId,
        replayable: true
      }
    })
    const viewed = JSON.parse(
      (await invoke(['operation', 'view', operationId])).stdout
    ) as { operation: Record<string, unknown> }
    expect(viewed.operation).toMatchObject({
      failure: { code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN' },
      replayable: true,
      status: 'outcome-unknown'
    })
    expect(viewed.operation).not.toHaveProperty('remoteOperationId')

    const second = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(second.exitCodes).toEqual([])
    expect(second.stderr).toBe('')
    expect(JSON.parse(second.stdout)).toMatchObject({
      operation: {
        kind: 'email-domain.disconnect',
        operationId,
        status: 'resolved'
      },
      result: {
        operation: {
          operationId: 'remote_operation_email_resent',
          state: 'succeeded'
        }
      }
    })
    expect(
      getOperation.mock.calls.map(([input]) => input.path.operationId)
    ).toEqual([
      'remote_operation_email_release',
      'remote_operation_email_resent'
    ])
    expect(releaseResource).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('converges a project delete replay when the project is already gone', async () => {
    const authenticated = await createAuthenticatedConfig()
    const deleteProject = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('deleteProject', [], { status: 200 })
      )
      .mockRejectedValueOnce(
        new ApiError('not found', {
          body: { code: 'PROJECT_NOT_FOUND', detail: 'Project not found.' },
          headers: new Headers(),
          operationId: 'deleteProject',
          status: 404
        })
      )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        delete: deleteProject,
        get: () => Promise.resolve(projectFixture)
      })
    )

    const failed = await invoke([
      'project',
      'delete',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    expect(JSON.parse(failed.stdout)).toMatchObject({
      error: { code: 'API_PROTOCOL_ERROR', replayable: true }
    })
    const replayed = await invoke([
      'operation',
      'replay',
      failedOperationId(failed.stdout),
      '--yes'
    ])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'project.delete', status: 'resolved' }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual({
      deleted: true,
      projectId: 'pho_prj_00000000000000000000000001'
    })
    expect(deleteProject).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('converges a project delete replay on not found when a damaged record holds a remote operation ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const deleteProject = vi
      .fn()
      .mockRejectedValueOnce(
        new ResponseValidationError('deleteProject', [], { status: 200 })
      )
      .mockRejectedValueOnce(
        new ApiError('not found', {
          body: { code: 'PROJECT_NOT_FOUND', detail: 'Project not found.' },
          headers: new Headers(),
          operationId: 'deleteProject',
          status: 404
        })
      )
    const getResource = vi.fn()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        delete: deleteProject,
        get: () => Promise.resolve(projectFixture),
        platforms: { getResource }
      })
    )

    const operationId = failedOperationId(
      (
        await invoke([
          'project',
          'delete',
          'pho_prj_00000000000000000000000001',
          '--yes'
        ])
      ).stdout
    )
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeDirectory] = await readdir(operationsRoot)
    if (scopeDirectory === undefined) {
      throw new Error('Expected a scoped operation directory.')
    }
    const recordPath = join(
      operationsRoot,
      scopeDirectory,
      `${operationId}.json`
    )
    await writeFile(
      recordPath,
      JSON.stringify({
        ...(JSON.parse(await readFile(recordPath, 'utf8')) as object),
        remoteOperationId: 'remote_operation_never_issued'
      })
    )
    expect(
      JSON.parse((await invoke(['operation', 'view', operationId])).stdout)
    ).toMatchObject({
      operation: { remoteOperationId: 'remote_operation_never_issued' }
    })
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'project.delete', status: 'resolved' }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual({
      deleted: true,
      projectId: 'pho_prj_00000000000000000000000001'
    })
    expect(getResource).not.toHaveBeenCalled()
    expect(deleteProject).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })
})
