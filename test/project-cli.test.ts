import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import type { GetBillingOperationOutput } from '@photon-ai/api'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'
import {
  apiCalls,
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  collector,
  createAuthenticatedConfig,
  folderProjectLine,
  instantPollClock,
  lateFailingStdout,
  ONLY_ORGANIZATION_LINE,
  singleOrganizationList,
  TEST_NOW,
  TEST_ORGANIZATION_ID,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const BILLING_OPERATION_ID =
  'pho_bop_0000000000000000000000000000000000000000000000000000000000000001'
const PLATFORM_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const EMAIL_PLATFORM_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn03r'
const PURCHASE_BILLING_OPERATION_ID =
  'pho_bop_0000000000000000000000000000000000000000000000000000000000000002'
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const projectFixture = (projectId: string, name: string) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/agent.png',
    firstName: 'Photon',
    lastName: 'Agent'
  },
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  createdByActorId: 'account_owner',
  createdByActorKind: 'account',
  deletedAt: null,
  flags: ['beta'],
  name,
  organizationId: 'pho_org_00000000000000000000000001',
  projectId,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  updatedAt: timestamp
})

const assignmentFixture = {
  assignedPhoneNumber: '+14155550124',
  assignmentId: 'pho_asg_00000000000000000000000001',
  createdAt: timestamp,
  email: 'user@example.test',
  firstName: 'Ada',
  handle: '+14155550123',
  lastName: 'Lovelace',
  platform: 'imessage',
  projectId: 'pho_prj_00000000000000000000000001',
  updatedAt: timestamp
}

const smsResourceFixture = {
  abilities: ['sms', 'pstn_voice'],
  createdAt: timestamp,
  detail: { phoneNumber: '+14155550125' },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  state: 'active',
  type: 'voip_line',
  updatedAt: timestamp
}

const imessageResourceFixture = {
  abilities: ['imessage', 'pstn_voice'],
  createdAt: timestamp,
  detail: { healthy: true, phoneNumber: '+14155550126' },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000011',
  state: 'active',
  type: 'cosmos_line',
  updatedAt: timestamp
}

const emailResourceFixture = {
  abilities: ['email'],
  createdAt: timestamp,
  detail: { domain: 'xn--bcher-kva.example', healthy: true },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000021',
  state: 'active',
  type: 'email_domain',
  updatedAt: timestamp
}

const emailDnsRecords = [
  {
    name: 'dkim-1._domainkey.xn--bcher-kva.example',
    type: 'CNAME' as const,
    value: 'dkim-1.dkim.amazonses.com'
  },
  {
    name: 'dkim-2._domainkey.xn--bcher-kva.example',
    type: 'CNAME' as const,
    value: 'dkim-2.dkim.amazonses.com'
  },
  {
    name: 'dkim-3._domainkey.xn--bcher-kva.example',
    type: 'CNAME' as const,
    value: 'dkim-3.dkim.amazonses.com'
  },
  {
    name: 'bounce.xn--bcher-kva.example',
    priority: 10,
    type: 'MX' as const,
    value: 'feedback-smtp.us-west-2.amazonses.com'
  },
  {
    name: 'bounce.xn--bcher-kva.example',
    type: 'TXT' as const,
    value: 'v=spf1 include:amazonses.com ~all'
  },
  {
    name: 'xn--bcher-kva.example',
    priority: 10,
    type: 'MX' as const,
    value: 'inbound-smtp.us-west-2.amazonaws.com'
  }
]

const emailVerification = {
  dkimReady: true,
  dnsReady: true,
  identityReady: true,
  lastCheckedAt: timestamp,
  mailFromReady: false
}

const emailAutomaticSetup = {
  applyUrl:
    'https://connect.provider.example/v2/domainTemplates/providers/photon.codes/services/email-sending/apply?domain=example.com&key=_dcpubkeyv1&sig=signed',
  dnsProviderId: 'provider.example',
  providerDisplayName: 'Example DNS'
}

const resourceForOperationId = (operationId: string) => {
  if (
    operationId === EMAIL_PLATFORM_OPERATION_ID ||
    operationId.includes('email')
  ) {
    return emailResourceFixture
  }
  if (operationId.includes('imessage')) {
    return imessageResourceFixture
  }
  return smsResourceFixture
}

const remoteOperationFixture = (
  operationId: string,
  resourceType: string,
  state: string,
  detail?: Record<string, unknown>
) => ({
  createdAt: timestamp,
  ...(detail === undefined ? {} : { detail }),
  cancellable: false,
  operationId,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType,
  startedAt: timestamp,
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const releaseOperationFixture = (
  operationId: string,
  released: { resourceId: string; type: string },
  state: string
) => ({
  ...remoteOperationFixture(operationId, released.type, state),
  resourceId: released.resourceId,
  type: 'resource.release'
})

const rawResponse = <Result>(data: Result, retryAfter = '1') => ({
  data,
  headers: new Headers({ 'retry-after': retryAfter }),
  status: 202
})

const platformFixture = {
  description: 'Text messages over a project-owned phone number.',
  displayName: 'SMS',
  type: 'sms'
}

const PERIOD_END = '2026-08-31T18:00:00.000Z'

const billingPlanFixture = (planCode: string, isDefault: boolean) => ({
  baseAmountCents: isDefault ? 0 : 25_000,
  currency: 'USD',
  description: null,
  entitlements: [],
  fixedCharges: [],
  interval: 'monthly',
  isDefault,
  minimumCommitment: null,
  name: isDefault ? 'Free' : 'Business',
  payInAdvance: true,
  planCode,
  tier: isDefault ? 0 : 2,
  tierDisplayName: isDefault ? 'Free' : 'Business',
  usageCharges: [],
  usageThresholds: []
})

const subscriptionTermsFixture = (
  scheduledPlanChange: null | { effectiveAt: string; planCode: string }
) => ({
  cancelsAt: null,
  category: 'platforms',
  currentPeriodEnd: PERIOD_END,
  currentPeriodStart: '2026-08-01T00:00:00.000Z',
  nextBillingAt: PERIOD_END,
  paymentMode: 'automatic',
  plan: billingPlanFixture('business', false),
  planSource: 'catalog',
  scheduledPlanChange
})

const billingOperationFixture = (
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
        ? { effectiveAt: null, type: 'version' as const, version: 'version_1' }
        : null,
    status,
    submittedAt: timestamp
  } as unknown as GetBillingOperationOutput
}

const createScope = () => {
  const get = vi.fn((input: { path: { projectId: string } }) =>
    Promise.resolve(
      input.path.projectId === 'pho_prj_00000000000000000000000002'
        ? projectFixture(
            'pho_prj_00000000000000000000000002',
            'Created Project'
          )
        : projectFixture(input.path.projectId, 'Alpha Project')
    )
  )
  const scope = {
    agentProfile: {
      commitAvatar: vi.fn(() =>
        Promise.resolve(
          projectFixture('pho_prj_00000000000000000000000001', 'Alpha')
            .agentProfile
        )
      ),
      createAvatarUpload: vi.fn(() =>
        Promise.resolve({
          expiresAt: '2026-07-31T18:05:00.000Z',
          formFields: { key: 'avatar/key', policy: 'signed-policy' },
          uploadId: 'upload_1',
          uploadUrl: 'https://storage.example.test/upload'
        })
      ),
      get: vi.fn(() =>
        Promise.resolve(
          projectFixture('pho_prj_00000000000000000000000001', 'Alpha')
            .agentProfile
        )
      ),
      resetAvatar: vi.fn(() =>
        Promise.resolve(
          projectFixture('pho_prj_00000000000000000000000001', 'Alpha')
            .agentProfile
        )
      ),
      update: vi.fn(() =>
        Promise.resolve(
          projectFixture('pho_prj_00000000000000000000000001', 'Alpha')
            .agentProfile
        )
      )
    },
    billing: {
      getOperation: vi.fn((input: { path: { operationId: string } }) =>
        Promise.resolve(
          billingOperationFixture(input.path.operationId, 'SUCCEEDED')
        )
      ),
      getOverview: vi.fn(() =>
        Promise.resolve({
          entitlementsVersion: 1,
          subscriptions: [
            {
              baseAmountCents: 25_000,
              cancelsAt: null,
              category: 'platforms',
              currency: 'USD',
              currentPeriodEnd: PERIOD_END,
              entitlements: [
                {
                  featureKey: 'imessage_shared_lines.max_user_assignments',
                  value: '1'
                }
              ],
              fixedCharges: [],
              minimumCommitment: null,
              planCode: 'business',
              planName: 'Business',
              status: 'active',
              tierDisplayName: 'Business'
            }
          ],
          usage: [
            {
              amountCents: 100,
              category: 'platforms',
              currency: 'USD',
              displayName: 'Usage',
              metricCode: 'imessage_message',
              units: 10
            }
          ]
        })
      ),
      listBillingPlans: vi.fn(() =>
        Promise.resolve({
          plans: {
            platforms: [
              billingPlanFixture('free', true),
              billingPlanFixture('business', false)
            ]
          }
        })
      )
    },
    delete: vi.fn(() =>
      Promise.resolve({
        ...projectFixture(
          'pho_prj_00000000000000000000000001',
          'Alpha Project'
        ),
        deletedAt: timestamp
      })
    ),
    get,
    platforms: {
      cancelOperation: vi.fn((input: { path: { operationId: string } }) =>
        Promise.resolve(
          remoteOperationFixture(
            input.path.operationId,
            'cosmos_line',
            'cancelled'
          )
        )
      ),
      getImessage: vi.fn(() =>
        Promise.resolve({
          dedicatedLineAvailableNow: true,
          maxUserAssignments: 10,
          mode: 'shared' as const
        })
      ),
      getOperation: vi.fn((input: { path: { operationId: string } }) => {
        const resource = resourceForOperationId(input.path.operationId)
        if (input.path.operationId.endsWith('_release')) {
          return Promise.resolve({
            operation: releaseOperationFixture(
              input.path.operationId,
              resource,
              'succeeded'
            ),
            resource
          })
        }
        const isEmail = resource.type === 'email_domain'
        return Promise.resolve({
          operation: remoteOperationFixture(
            input.path.operationId,
            resource.type,
            'succeeded',
            isEmail
              ? {
                  dnsRecords: emailDnsRecords,
                  verification: emailVerification
                }
              : undefined
          ),
          resource
        })
      }),
      getResource: vi.fn((input: { path: { resourceId: string } }) =>
        Promise.resolve(
          input.path.resourceId === emailResourceFixture.resourceId
            ? emailResourceFixture
            : smsResourceFixture
        )
      ),
      imessage: {
        assignments: {
          create: vi.fn(() => Promise.resolve(assignmentFixture)),
          get: vi.fn(() => Promise.resolve(assignmentFixture)),
          list: vi.fn(() =>
            Promise.resolve({ assignments: [assignmentFixture] })
          ),
          release: vi.fn(() =>
            Promise.resolve({ ...assignmentFixture, releasedAt: timestamp })
          )
        }
      },
      listOperations: vi.fn(
        (): Promise<{
          operations: ReturnType<typeof remoteOperationFixture>[]
        }> => Promise.resolve({ operations: [] })
      ),
      listProjectPlatforms: vi.fn(() =>
        Promise.resolve({ platforms: [platformFixture] })
      ),
      listResources: vi.fn(
        (input: {
          query?: { ability?: string | undefined } | undefined
        }): Promise<{
          nextPageToken?: string
          resources: (
            | typeof emailResourceFixture
            | typeof imessageResourceFixture
            | typeof smsResourceFixture
          )[]
        }> => {
          const ability = input.query?.ability
          if (ability === 'imessage') {
            return Promise.resolve({ resources: [imessageResourceFixture] })
          }
          if (ability === 'email') {
            return Promise.resolve({ resources: [emailResourceFixture] })
          }
          return Promise.resolve({ resources: [smsResourceFixture] })
        }
      )
    },
    update: vi.fn((input: { body: { name: string } }) =>
      Promise.resolve(
        projectFixture('pho_prj_00000000000000000000000001', input.body.name)
      )
    )
  }
  const organizationScope = {
    billing: {
      changePlan: vi.fn(() =>
        Promise.resolve(
          billingOperationFixture(PURCHASE_BILLING_OPERATION_ID, 'RUNNING')
        )
      ),
      getEffectiveTerms: vi.fn(() =>
        Promise.resolve({
          subscriptions: [
            subscriptionTermsFixture({
              effectiveAt: PERIOD_END,
              planCode: 'free'
            })
          ],
          timeZone: 'UTC'
        })
      ),
      listInvoices: vi.fn(() =>
        Promise.resolve({
          invoices: [
            {
              currency: 'USD',
              invoiceId: 'invoice_1',
              issuedAt: timestamp,
              kind: 'subscription',
              number: 'INV-1',
              paymentActionRequired: false,
              paymentDueAt: null,
              paymentOverdue: false,
              paymentStatus: 'paid',
              pdfUrl: null,
              status: 'finalized',
              subjects: [],
              totalCents: 1000
            }
          ],
          nextCursor: null
        })
      )
    },
    listOrganizations: vi.fn(singleOrganizationList),
    projects: {
      count: vi.fn(() => Promise.resolve({ count: 1 })),
      create: vi.fn(() =>
        Promise.resolve(
          projectFixture(
            'pho_prj_00000000000000000000000002',
            'Created Project'
          )
        )
      ),
      list: vi.fn(() =>
        Promise.resolve({
          projects: [
            projectFixture(
              'pho_prj_00000000000000000000000001',
              'Alpha Project'
            )
          ]
        })
      )
    }
  }
  const rawScope = {
    platforms: {
      connectEmailDomain: vi.fn(() =>
        Promise.resolve(
          rawResponse(
            remoteOperationFixture(
              'remote_operation_email',
              'email_domain',
              'running',
              { dnsRecords: emailDnsRecords }
            ),
            '60'
          )
        )
      ),
      provisionImessageDedicatedLine: vi.fn(() =>
        Promise.resolve(
          rawResponse(
            remoteOperationFixture(
              'remote_operation_imessage',
              'cosmos_line',
              'pending'
            )
          )
        )
      ),
      purchaseSmsNumber: vi.fn(() =>
        Promise.resolve(
          rawResponse(
            remoteOperationFixture(
              'remote_operation_sms',
              'voip_line',
              'pending'
            )
          )
        )
      ),
      releaseResource: vi.fn((input: { path: { resourceId: string } }) =>
        Promise.resolve(
          rawResponse(
            input.path.resourceId === emailResourceFixture.resourceId
              ? releaseOperationFixture(
                  'remote_operation_email_release',
                  emailResourceFixture,
                  'pending'
                )
              : releaseOperationFixture(
                  'remote_operation_release',
                  smsResourceFixture,
                  'pending'
                )
          )
        )
      )
    }
  }
  return {
    organizationScope: asOrganizationScope(organizationScope),
    rawScope: asProjectRawScope(rawScope),
    scope: asProjectScope(scope),
    spies: {
      ...scope,
      billing: { ...scope.billing, ...organizationScope.billing },
      count: organizationScope.projects.count,
      create: organizationScope.projects.create,
      getOperation: scope.platforms.getOperation,
      getResource: scope.platforms.getResource,
      list: organizationScope.projects.list,
      listOperations: scope.platforms.listOperations,
      listResources: scope.platforms.listResources,
      raw: {
        ...rawScope,
        releaseResource: rawScope.platforms.releaseResource
      }
    }
  }
}

const leafPaths = [
  ['list'],
  ['count'],
  ['create'],
  ['view'],
  ['edit'],
  ['delete'],
  ['current'],
  ['use'],
  ['clear'],
  ['agent-profile', 'view'],
  ['agent-profile', 'edit'],
  ['agent-profile', 'avatar', 'upload'],
  ['agent-profile', 'avatar', 'reset'],
  ['billing', 'overview'],
  ['billing', 'invoice', 'list'],
  ['billing', 'operation', 'view'],
  ['billing', 'plan', 'purchase'],
  ['billing', 'subscription', 'cancel'],
  ['billing', 'subscription', 'resume'],
  ['platform', 'list'],
  ['platform', 'operation', 'cancel'],
  ['platform', 'email', 'list'],
  ['platform', 'email', 'connect'],
  ['platform', 'email', 'disconnect'],
  ['platform', 'email', 'dns'],
  ['platform', 'imessage', 'view'],
  ['platform', 'imessage', 'list'],
  ['platform', 'imessage', 'purchase'],
  ['platform', 'imessage', 'assignment', 'list'],
  ['platform', 'imessage', 'assignment', 'create'],
  ['platform', 'imessage', 'assignment', 'view'],
  ['platform', 'imessage', 'assignment', 'release'],
  ['platform', 'sms', 'list'],
  ['platform', 'sms', 'purchase'],
  ['platform', 'sms', 'delete'],
  ['platform', 'telegram', 'list'],
  ['platform', 'telegram', 'connect'],
  ['platform', 'telegram', 'view'],
  ['platform', 'telegram', 'disconnect'],
  ['platform', 'voice', 'list'],
  ['platform', 'whatsapp-business', 'account', 'list'],
  ['platform', 'whatsapp-business', 'number', 'add'],
  ['platform', 'whatsapp-business', 'number', 'list'],
  ['platform', 'whatsapp-business', 'number', 'view'],
  ['platform', 'whatsapp-business', 'number', 'delete']
] as const

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('project CLI command tree', () => {
  test('renders help for every leaf command', async () => {
    const help: string[] = []

    for (const path of leafPaths) {
      // biome-ignore lint/performance/noAwaitInLoops: CLI invocations must complete independently.
      help.push(await printed(['project', ...path, '--help']))
    }

    expect(help.join('')).not.toBe('')
    expect(process.exitCode).toBeUndefined()
  })

  test('executes every project operation with stable JSON envelopes', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const avatarFile = join(authenticated.configDirectory, 'avatar.png')
    await writeFile(
      avatarFile,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      { mode: 0o600 }
    )
    const uploadFetch = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response(null, { status: 204 }))
    )
    const run = async (
      args: string[],
      expectedStderr = ''
    ): Promise<Record<string, unknown>> => {
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli([...args, '--json'], {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        cwd: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        fetch: uploadFetch,
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      })
      expect(stderr.value()).toBe(expectedStderr)
      expect(exitCodes).toEqual([])
      return JSON.parse(stdout.value()) as Record<string, unknown>
    }
    const stored = folderProjectLine(
      'pho_prj_00000000000000000000000001',
      authenticated.configDirectory
    )
    // Resuming a subscription reads the project first, so its line names it.
    const loaded = folderProjectLine(
      'Alpha Project (pho_prj_00000000000000000000000001), organization pho_org_00000000000000000000000001',
      authenticated.configDirectory
    )

    await expect(
      run(['project', 'list', '--limit', '1'])
    ).resolves.toMatchObject({
      projects: [{ projectId: 'pho_prj_00000000000000000000000001' }]
    })
    await expect(run(['project', 'count'])).resolves.toEqual({ count: 1 })
    await expect(
      run(
        [
          'project',
          'create',
          '--slug',
          'test-project',
          '--name',
          'Created Project',
          '--link'
        ],
        ONLY_ORGANIZATION_LINE
      )
    ).resolves.toMatchObject({
      path: join(authenticated.configDirectory, '.photon', 'project.json'),
      project: { projectId: 'pho_prj_00000000000000000000000002' },
      source: 'folder'
    })
    await expect(run(['project', 'current'])).resolves.toMatchObject({
      path: join(authenticated.configDirectory, '.photon', 'project.json'),
      project: { projectId: 'pho_prj_00000000000000000000000002' },
      source: 'folder'
    })
    await expect(
      run(['link', '--project', 'pho_prj_00000000000000000000000001'])
    ).resolves.toMatchObject({
      path: join(authenticated.configDirectory, '.photon', 'project.json'),
      project: { projectId: 'pho_prj_00000000000000000000000001' },
      source: 'folder'
    })
    await expect(run(['project', 'view'])).resolves.toMatchObject({
      projectId: 'pho_prj_00000000000000000000000001'
    })
    await expect(
      run(['project', 'edit', '--name', 'Renamed Project'], stored)
    ).resolves.toMatchObject({ name: 'Renamed Project' })
    await expect(
      run(['project', 'agent-profile', 'view'])
    ).resolves.toHaveProperty('firstName')
    await expect(
      run(
        [
          'project',
          'agent-profile',
          'edit',
          '--first-name',
          'Nova',
          '--clear-last-name'
        ],
        stored
      )
    ).resolves.toHaveProperty('firstName')
    await expect(
      run(['project', 'agent-profile', 'avatar', 'upload', avatarFile], stored)
    ).resolves.toHaveProperty('avatarUrl')
    await expect(
      run(['project', 'agent-profile', 'avatar', 'reset', '--yes'], stored)
    ).resolves.toHaveProperty('avatarUrl')
    await expect(
      run(['project', 'billing', 'overview'])
    ).resolves.toHaveProperty('billing')
    await expect(
      run(['project', 'billing', 'invoice', 'list'])
    ).resolves.toHaveProperty('invoices')
    await expect(
      run(['project', 'billing', 'operation', 'view', BILLING_OPERATION_ID])
    ).resolves.toHaveProperty('operationId', BILLING_OPERATION_ID)
    await expect(
      run(
        [
          'project',
          'billing',
          'plan',
          'purchase',
          '--category',
          'platforms',
          '--plan-code',
          'business',
          '--yes'
        ],
        stored
      )
    ).resolves.toMatchObject({
      operationId: PURCHASE_BILLING_OPERATION_ID,
      status: 'SUCCEEDED'
    })
    await expect(
      run(
        [
          'project',
          'billing',
          'subscription',
          'cancel',
          '--category',
          'platforms',
          '--yes'
        ],
        stored
      )
    ).resolves.toHaveProperty('subscription')
    await expect(
      run(
        [
          'project',
          'billing',
          'subscription',
          'resume',
          '--category',
          'platforms'
        ],
        loaded
      )
    ).resolves.toHaveProperty('subscription')
    await expect(run(['project', 'platform', 'list'])).resolves.toEqual({
      platforms: [platformFixture]
    })
    expect(spies.platforms.listProjectPlatforms).toHaveBeenCalledWith(
      { path: { id: 'pho_prj_00000000000000000000000001' } },
      undefined
    )
    const cancelledOperation = await run([
      'project',
      'platform',
      'operation',
      'cancel',
      PLATFORM_OPERATION_ID,
      '--yes'
    ])
    expect(cancelledOperation).toMatchObject({
      operationId: PLATFORM_OPERATION_ID,
      state: 'cancelled'
    })
    expect(spies.platforms.cancelOperation).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          operationId: PLATFORM_OPERATION_ID
        }
      },
      undefined
    )
    await expect(
      run(['project', 'platform', 'email', 'list'])
    ).resolves.toEqual({
      provisioning: [],
      resources: [emailResourceFixture]
    })
    await expect(
      run(['project', 'platform', 'email', 'dns', EMAIL_PLATFORM_OPERATION_ID])
    ).resolves.toMatchObject({
      operation: {
        detail: { dnsRecords: emailDnsRecords },
        operationId: EMAIL_PLATFORM_OPERATION_ID,
        resourceType: 'email_domain'
      },
      resource: emailResourceFixture
    })
    const emailConnect = await run(
      [
        'project',
        'platform',
        'email',
        'connect',
        ' BÜCHER.Example. ',
        '--idempotency-key',
        'email-connect-1',
        '--no-wait'
      ],
      stored
    )
    expect(emailConnect).toEqual({
      operation: {
        cancellable: false,
        createdAt: timestamp,
        detail: { dnsRecords: emailDnsRecords },
        operationId: 'remote_operation_email',
        projectId: 'pho_prj_00000000000000000000000001',
        resourceType: 'email_domain',
        startedAt: timestamp,
        state: 'running',
        type: 'resource.provision',
        updatedAt: timestamp
      }
    })
    expect(spies.raw.platforms.connectEmailDomain).toHaveBeenCalledWith(
      {
        body: { domain: 'xn--bcher-kva.example' },
        headers: { idempotencyKey: 'email-connect-1' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    await expect(
      run(
        [
          'project',
          'platform',
          'email',
          'disconnect',
          emailResourceFixture.resourceId,
          '--yes'
        ],
        stored
      )
    ).resolves.toEqual({
      operation: releaseOperationFixture(
        'remote_operation_email_release',
        emailResourceFixture,
        'succeeded'
      ),
      resource: emailResourceFixture
    })
    await expect(
      run(['project', 'platform', 'imessage', 'view'])
    ).resolves.toEqual({
      dedicatedLineAvailableNow: true,
      maxUserAssignments: 10,
      mode: 'shared'
    })
    const imessageList = await run(['project', 'platform', 'imessage', 'list'])
    expect(imessageList).toEqual({
      provisioning: [],
      resources: [imessageResourceFixture]
    })
    expect((imessageList.resources as { type: string }[])[0]?.type).toBe(
      'cosmos_line'
    )
    await expect(
      run(['project', 'platform', 'imessage', 'assignment', 'list'])
    ).resolves.toHaveProperty('assignments')
    await expect(
      run(
        [
          'project',
          'platform',
          'imessage',
          'assignment',
          'create',
          '--phone-number',
          '+14155550123',
          '--email',
          'user@example.test'
        ],
        stored
      )
    ).resolves.toEqual(assignmentFixture)
    await expect(
      run([
        'project',
        'platform',
        'imessage',
        'assignment',
        'view',
        'pho_asg_00000000000000000000000001'
      ])
    ).resolves.toEqual(assignmentFixture)
    await expect(
      run(
        [
          'project',
          'platform',
          'imessage',
          'assignment',
          'release',
          'pho_asg_00000000000000000000000001',
          '--yes'
        ],
        stored
      )
    ).resolves.toEqual({ ...assignmentFixture, releasedAt: timestamp })
    spies.listResources.mockResolvedValueOnce({
      nextPageToken: 'sms-next',
      resources: [
        {
          ...smsResourceFixture,
          futureField: 'from-a-newer-api'
        } as typeof smsResourceFixture
      ]
    })
    const smsList = await run([
      'project',
      'platform',
      'sms',
      'list',
      '--limit',
      '1'
    ])
    expect(smsList).toEqual({
      nextPageToken: 'sms-next',
      provisioning: [],
      resources: [{ ...smsResourceFixture, futureField: 'from-a-newer-api' }]
    })
    expect(JSON.stringify(smsList)).toContain('from-a-newer-api')
    spies.listResources.mockResolvedValueOnce({ resources: [] })
    await expect(run(['project', 'platform', 'sms', 'list'])).resolves.toEqual({
      provisioning: [],
      resources: []
    })
    const smsPurchase = await run(
      [
        'project',
        'platform',
        'sms',
        'purchase',
        '--yes',
        '--idempotency-key',
        'sms-purchase-1'
      ],
      stored
    )
    expect(smsPurchase).toEqual({
      operation: remoteOperationFixture(
        'remote_operation_sms',
        'voip_line',
        'succeeded'
      ),
      resource: smsResourceFixture
    })
    expect(spies.raw.platforms.purchaseSmsNumber).toHaveBeenCalledWith(
      {
        body: { countryCode: 'US' },
        headers: { idempotencyKey: 'sms-purchase-1' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    const smsDelete = await run(
      [
        'project',
        'platform',
        'sms',
        'delete',
        'pho_res_00000000000000000000000001',
        '--yes'
      ],
      stored
    )
    expect(smsDelete).toEqual({
      operation: releaseOperationFixture(
        'remote_operation_release',
        smsResourceFixture,
        'succeeded'
      ),
      resource: smsResourceFixture
    })
    expect(spies.raw.releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000001'
        }
      },
      undefined
    )
    await expect(
      run(
        [
          'project',
          'platform',
          'imessage',
          'purchase',
          '--yes',
          '--idempotency-key',
          'imessage-purchase-1'
        ],
        stored
      )
    ).resolves.toEqual({
      operation: remoteOperationFixture(
        'remote_operation_imessage',
        'cosmos_line',
        'succeeded'
      ),
      resource: imessageResourceFixture
    })
    await expect(
      run(['project', 'platform', 'voice', 'list'])
    ).resolves.toEqual({ resources: [smsResourceFixture] })
    await expect(
      run(['project', 'delete', 'pho_prj_00000000000000000000000001', '--yes'])
    ).resolves.toMatchObject({
      deletedAt: timestamp,
      projectId: 'pho_prj_00000000000000000000000001'
    })
    // Deleting pho_prj_00000000000000000000000001 clears the active project, so unlink has nothing left to remove.
    await expect(run(['unlink'])).resolves.toEqual({ cleared: false })

    expect(uploadFetch).toHaveBeenCalledOnce()
    const uploadOptions = uploadFetch.mock.calls[0]?.[1]
    expect([...new Headers(uploadOptions?.headers).keys()]).toEqual([
      'user-agent'
    ])
    expect(uploadOptions?.body).toBeInstanceOf(FormData)
    if (!(uploadOptions?.body instanceof FormData)) {
      throw new Error('Expected a multipart avatar upload body.')
    }
    const formKeys = [...uploadOptions.body.keys()]
    expect(formKeys).toEqual(['key', 'policy', 'file'])
    expect(spies.list).toHaveBeenCalledWith(
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 1 }
      },
      undefined
    )
    expect(spies.count).toHaveBeenCalledWith(
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: {}
      },
      undefined
    )
    expect(spies.create).toHaveBeenCalledWith(
      {
        body: { name: 'Created Project', slug: 'test-project' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
    await expect(run(['operation', 'list'])).resolves.toEqual({
      operations: []
    })
    await authenticated.remove()
  })

  test('prints email DNS records before waiting for verification', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'wait-for-email-verification'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(exitCodes).toEqual([])
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toContain('Started connecting example.com.')
    expect(stdout.value()).toContain('┌')
    expect(stdout.value()).toContain('│ TYPE')
    expect(stdout.value()).toContain('Publish these DNS records.')
    expect(stdout.value()).toContain(
      'Waiting for Photon to verify the records.'
    )
    expect(stdout.value()).toContain('Connected example.com.')
    expect(spies.getOperation).toHaveBeenCalledOnce()

    const noWaitStdout = collector()
    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'no-wait.example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'do-not-wait-for-email-verification',
        '--no-wait'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: noWaitStdout
      }
    )
    expect(noWaitStdout.value()).toContain(
      'Started connecting no-wait.example.com.'
    )
    expect(noWaitStdout.value()).not.toContain(
      'Waiting for Photon to verify the records.'
    )
    expect(spies.getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test.each([
    [
      'ENOSPC',
      'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)\n'
    ],
    ['EPIPE', '']
  ] as const)(
    'stops before waiting for email verification when stdout fails with %s, and reports it as every command without a record does',
    async (code, expected) => {
      const authenticated = await createAuthenticatedConfig()
      const { organizationScope, rawScope, scope, spies } = createScope()
      const stderr = collector()
      const exitCodes: number[] = []

      await runCli(
        [
          'project',
          'platform',
          'email',
          'connect',
          'example.com',
          '--project',
          'pho_prj_00000000000000000000000001',
          '--idempotency-key',
          'wait-for-email-verification'
        ],
        {
          clock: instantPollClock(),
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          setExitCode: (exitCode) => exitCodes.push(exitCode),
          stderr,
          stdout: lateFailingStdout(code)
        }
      )

      expect(stderr.value()).toBe(expected)
      expect(exitCodes).toEqual([1])
      expect(spies.raw.platforms.connectEmailDomain).toHaveBeenCalledOnce()
      expect(spies.getOperation).not.toHaveBeenCalled()
      await authenticated.remove()
    }
  )

  test('opens automatic email DNS setup, prints its URL, and keeps manual records available', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(
        remoteOperationFixture(
          'remote_operation_email_automatic',
          'email_domain',
          'running',
          {
            automaticSetup: emailAutomaticSetup,
            dnsRecords: emailDnsRecords
          }
        )
      )
    )
    const browserLauncher = vi.fn(() => Promise.resolve())
    const stdout = collector()

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'automatic-email-dns',
        '--no-wait'
      ],
      {
        browserLauncher,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(browserLauncher).toHaveBeenCalledWith(emailAutomaticSetup.applyUrl)
    expect(stdout.value()).toContain(
      'Opened automatic DNS setup with Example DNS in your browser.'
    )
    expect(stdout.value()).toContain(
      'If automatic setup does not complete, publish these DNS records manually:'
    )
    expect(stdout.value()).toContain(emailAutomaticSetup.applyUrl)
    await authenticated.remove()
  })

  test('opens an automatic DNS setup URL with a NUL in it as a browser reads it', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(
        remoteOperationFixture(
          'remote_operation_email_automatic_nul',
          'email_domain',
          'running',
          {
            automaticSetup: {
              ...emailAutomaticSetup,
              applyUrl:
                'https://connect.provider.example/apply?sig=signed\u0000x'
            },
            dnsRecords: emailDnsRecords
          }
        )
      )
    )
    const browserLauncher = vi.fn(() => Promise.resolve())
    const stdout = collector()

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'automatic-email-dns-nul',
        '--no-wait'
      ],
      {
        browserLauncher,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(browserLauncher).toHaveBeenCalledWith(
      'https://connect.provider.example/apply?sig=signed%00x'
    )
    expect(stdout.value()).toContain(
      'Opened automatic DNS setup with Example DNS in your browser.'
    )
    expect(stdout.value()).toContain('apply?sig=signed^@x')
    await authenticated.remove()
  })

  test('prints automatic email DNS setup for no-browser, no-wait JSON automation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(
        remoteOperationFixture(
          'remote_operation_email_automatic_json',
          'email_domain',
          'running',
          {
            automaticSetup: emailAutomaticSetup,
            dnsRecords: emailDnsRecords
          }
        )
      )
    )
    const browserLauncher = vi.fn(() => Promise.resolve())
    const stdout = collector()

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'automatic-email-dns-json',
        '--no-browser',
        '--no-wait',
        '--json'
      ],
      {
        browserLauncher,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(JSON.parse(stdout.value())).toMatchObject({
      operation: { detail: { automaticSetup: emailAutomaticSetup } }
    })
    expect(browserLauncher).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('accepts the domain and dnsVerification fields Platforms sends with the DNS records', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const detail = {
      dnsRecords: emailDnsRecords,
      dnsVerification: {
        lastCheckedAt: timestamp,
        records: emailDnsRecords.map((record) => ({
          record,
          status: 'missing'
        }))
      },
      domain: 'xn--bcher-kva.example'
    }
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(
        remoteOperationFixture(
          'remote_operation_email_platforms_detail',
          'email_domain',
          'running',
          detail
        )
      )
    )
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'xn--bcher-kva.example',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'platforms-email-detail',
        '--no-wait',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(stderr.value()).not.toContain('PROJECT_PROTOCOL_ERROR')
    expect(exitCodes).toEqual([])
    expect(JSON.parse(stdout.value())).toMatchObject({
      operation: { detail: { dnsRecords: emailDnsRecords } }
    })
    await authenticated.remove()
  })

  test('email connect waits with or without --json, unless --no-wait, and sends the same requests', async () => {
    const connect = async (flags: string[]) => {
      const authenticated = await createAuthenticatedConfig()
      const { organizationScope, rawScope, scope, spies } = createScope()
      spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
        rawResponse(
          remoteOperationFixture(
            'remote_operation_email_parity',
            'email_domain',
            'running',
            { dnsRecords: emailDnsRecords }
          )
        )
      )
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(
        [
          'project',
          'platform',
          'email',
          'connect',
          'example.com',
          '--project',
          'pho_prj_00000000000000000000000001',
          '--idempotency-key',
          'email-parity',
          ...flags
        ],
        {
          clock: instantPollClock(),
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )
      await authenticated.remove()
      return {
        calls: apiCalls(spies),
        exitCodes,
        stderr: stderr.value(),
        stdout: stdout.value()
      }
    }

    const text = await connect([])
    const json = await connect(['--json'])
    const noWait = await connect(['--json', '--no-wait'])

    expect(json.calls).toEqual(text.calls)
    expect(text.calls.map(([name]) => name)).toContain('platforms.getOperation')
    expect(noWait.calls.map(([name]) => name)).toEqual([
      'raw.platforms.connectEmailDomain'
    ])
    expect([text.exitCodes, json.exitCodes, noWait.exitCodes]).toEqual([
      [],
      [],
      []
    ])
    expect(text.stderr).toBe('')
    expect(json.stderr).toContain('Waiting for Photon to verify the records.')
    expect(text.stdout.startsWith(json.stderr)).toBe(true)
    expect(text.stdout).toContain(
      'Resource ID  pho_res_00000000000000000000000021'
    )
    expect(JSON.parse(json.stdout)).toMatchObject({
      operation: { state: 'succeeded' },
      resource: {
        resourceId: 'pho_res_00000000000000000000000021',
        state: 'active'
      }
    })
    expect(noWait.stderr).toBe('')
    expect(JSON.parse(noWait.stdout)).toMatchObject({
      operation: { state: 'running' }
    })
  })

  test('email connect --json prints only the error document when the wait ends in failure', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const operation = (state: string) =>
      remoteOperationFixture(
        'remote_operation_email_failed',
        'email_domain',
        state,
        {
          dnsRecords: emailDnsRecords
        }
      )
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(operation('running'))
    )
    spies.getOperation.mockResolvedValueOnce({
      operation: operation('failed'),
      resource: emailResourceFixture
    })
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'email-wait-failure',
        '--json'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { remoteOperationId: 'remote_operation_email_failed' }
    })
    expect(stderr.value()).toContain(
      'Waiting for Photon to verify the records.'
    )
    expect(stderr.value()).not.toContain('{')
    expect(exitCodes).toEqual([1])
    await authenticated.remove()
  })

  test('prints automatic email DNS setup when browser launch fails', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.raw.platforms.connectEmailDomain.mockResolvedValueOnce(
      rawResponse(
        remoteOperationFixture(
          'remote_operation_email_browser_failure',
          'email_domain',
          'running',
          {
            automaticSetup: emailAutomaticSetup,
            dnsRecords: emailDnsRecords
          }
        )
      )
    )
    const browserLauncher = vi.fn(() => Promise.reject(new Error('no browser')))
    const stdout = collector()
    const stderr = collector()

    await runCli(
      [
        'project',
        'platform',
        'email',
        'connect',
        'example.com',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'automatic-email-dns-browser-failure',
        '--no-wait'
      ],
      {
        browserLauncher,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr,
        stdout
      }
    )

    expect(browserLauncher).toHaveBeenCalledWith(emailAutomaticSetup.applyUrl)
    expect(stderr.value()).toContain('browser could not be opened')
    expect(stdout.value()).toContain(emailAutomaticSetup.applyUrl)
    await authenticated.remove()
  })

  test('prints email DNS records from a remote operation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []
    const browserLauncher = vi.fn(() => Promise.resolve())
    spies.getOperation.mockResolvedValueOnce({
      operation: remoteOperationFixture(
        EMAIL_PLATFORM_OPERATION_ID,
        'email_domain',
        'running',
        {
          automaticSetup: emailAutomaticSetup,
          dnsRecords: emailDnsRecords,
          verification: emailVerification
        }
      ),
      resource: emailResourceFixture
    })

    await runCli(
      [
        'project',
        'platform',
        'email',
        'dns',
        EMAIL_PLATFORM_OPERATION_ID,
        '--project',
        'pho_prj_00000000000000000000000001'
      ],
      {
        browserLauncher,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(exitCodes).toEqual([])
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toContain('Platform operation')
    expect(stdout.value()).toContain('Verification')
    expect(stdout.value()).toContain('MAIL FROM ready')
    expect(stdout.value()).toContain(timestamp)
    expect(stdout.value()).toContain('DNS records')
    expect(stdout.value()).toContain('Automatic DNS setup')
    expect(stdout.value()).toContain('Example DNS')
    expect(stdout.value()).toContain(emailAutomaticSetup.applyUrl)
    expect(stdout.value()).toContain('inbound-smtp.us-west-2.amazonaws.com')
    expect(browserLauncher).not.toHaveBeenCalled()
    expect(spies.getOperation).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          operationId: EMAIL_PLATFORM_OPERATION_ID
        }
      },
      undefined
    )
    await authenticated.remove()
  })

  test.each([
    {
      answer: {
        operation: remoteOperationFixture(
          EMAIL_PLATFORM_OPERATION_ID,
          'email_domain',
          'running',
          {
            dnsRecords: [
              ...emailDnsRecords.slice(0, 5),
              { name: 'xn--bcher-kva.example', type: 'A', value: '192.0.2.1' }
            ]
          }
        ),
        resource: emailResourceFixture
      },
      name: 'invalid DNS records'
    }
  ])(
    'email dns fails with PROJECT_PROTOCOL_ERROR on $name, with and without --json',
    async ({ answer }) => {
      const authenticated = await createAuthenticatedConfig()
      const { organizationScope, rawScope, scope, spies } = createScope()
      spies.getOperation.mockResolvedValue(answer)
      const run = async (format: '--json' | '--no-color') => {
        const stdout = collector()
        const stderr = collector()
        const exitCodes: number[] = []
        await runCli(
          [
            'project',
            'platform',
            'email',
            'dns',
            EMAIL_PLATFORM_OPERATION_ID,
            '--project',
            'pho_prj_00000000000000000000000001',
            format
          ],
          {
            configDirectory: authenticated.configDirectory,
            deviceScope: unusedDeviceScope(),
            now: () => TEST_NOW,
            organizationScope,
            platform: 'linux',
            projectRawScope: rawScope,
            projectScope: scope,
            setExitCode: (code) => exitCodes.push(code),
            stderr,
            stdout
          }
        )
        return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
      }

      const json = await run('--json')
      const text = await run('--no-color')

      expect(json.exitCodes).toEqual([1])
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual({
        error: expect.objectContaining({
          code: 'PROJECT_PROTOCOL_ERROR',
          remoteOperationId: EMAIL_PLATFORM_OPERATION_ID
        })
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain('PROJECT_PROTOCOL_ERROR')
      expect(text.stderr).toContain(EMAIL_PLATFORM_OPERATION_ID)
      expect(spies.getOperation).toHaveBeenCalledTimes(2)
      await authenticated.remove()
    }
  )

  const runEmailDns = async (
    answer: Awaited<
      ReturnType<ReturnType<typeof createScope>['spies']['getOperation']>
    >
  ) => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.getOperation.mockResolvedValue(answer)
    const run = async (format: '--json' | '--no-color') => {
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(
        [
          'project',
          'platform',
          'email',
          'dns',
          EMAIL_PLATFORM_OPERATION_ID,
          '--project',
          'pho_prj_00000000000000000000000001',
          format
        ],
        {
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )
      return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
    }
    const json = await run('--json')
    const text = await run('--no-color')
    await authenticated.remove()
    return { getOperation: spies.getOperation, json, text }
  }

  test.each([
    {
      answer: {
        operation: remoteOperationFixture(
          EMAIL_PLATFORM_OPERATION_ID,
          'voip_line',
          'succeeded'
        ),
        resource: smsResourceFixture
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is an SMS number operation, not an email-domain setup.`,
      name: 'an SMS number purchase'
    },
    {
      answer: {
        operation: remoteOperationFixture(
          EMAIL_PLATFORM_OPERATION_ID,
          imessageResourceFixture.type,
          'running'
        ),
        resource: imessageResourceFixture
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is an iMessage line operation, not an email-domain setup.`,
      name: 'an operation that is not an email-domain setup'
    },
    {
      answer: {
        operation: remoteOperationFixture(
          EMAIL_PLATFORM_OPERATION_ID,
          'fax_line',
          'succeeded'
        ),
        resource: { ...smsResourceFixture, type: 'fax_line' }
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is not an email-domain setup.`,
      name: 'an operation of a resource type the CLI has no name for'
    },
    {
      answer: {
        operation: {
          ...remoteOperationFixture(
            EMAIL_PLATFORM_OPERATION_ID,
            'email_domain',
            'succeeded'
          ),
          type: 'resource.release'
        },
        resource: emailResourceFixture
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is an email-domain removal, not an email-domain setup.`,
      name: 'an email-domain removal'
    },
    {
      answer: {
        operation: {
          ...remoteOperationFixture(
            EMAIL_PLATFORM_OPERATION_ID,
            'voip_line',
            'succeeded'
          ),
          type: 'resource.release'
        },
        resource: smsResourceFixture
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is an SMS number removal, not an email-domain setup.`,
      name: 'an SMS number removal'
    },
    {
      answer: {
        operation: {
          ...remoteOperationFixture(
            EMAIL_PLATFORM_OPERATION_ID,
            'fax_line',
            'succeeded'
          ),
          type: 'resource.release'
        },
        resource: { ...smsResourceFixture, type: 'fax_line' }
      },
      detail: `Operation ${EMAIL_PLATFORM_OPERATION_ID} is a removal, not an email-domain setup.`,
      name: 'a removal of a resource type the CLI has no name for'
    }
  ])(
    'email dns fails with ARGUMENT_VALIDATION on $name, with and without --json',
    async ({ answer, detail }) => {
      const { getOperation, json, text } = await runEmailDns(answer)

      expect(json.exitCodes).toEqual([2])
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual({
        error: expect.objectContaining({
          code: 'ARGUMENT_VALIDATION',
          detail,
          message: 'The command contains invalid input.'
        })
      })
      expect(text.exitCodes).toEqual([2])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain('ARGUMENT_VALIDATION')
      expect(text.stderr).toContain(detail)
      expect(text.stderr).toContain(
        'Pass the operation ID of an email-domain setup.'
      )
      expect(text.stderr).not.toContain('PROJECT_PROTOCOL_ERROR')
      expect(getOperation).toHaveBeenCalledTimes(2)
    }
  )

  test.each([
    {
      name: 'an operation in another project',
      overrides: { projectId: 'pho_prj_00000000000000000000000002' }
    },
    {
      name: 'a removal in another project',
      overrides: {
        projectId: 'pho_prj_00000000000000000000000002',
        type: 'resource.release'
      }
    },
    {
      name: 'an operation that is neither a resource.provision nor a resource.release',
      overrides: { type: 'sms.campaign.assign' }
    }
  ])(
    'email dns keeps PROJECT_PROTOCOL_ERROR for $name of another kind',
    async ({ overrides }) => {
      const { json, text } = await runEmailDns({
        operation: {
          ...remoteOperationFixture(
            EMAIL_PLATFORM_OPERATION_ID,
            'voip_line',
            'succeeded'
          ),
          ...overrides
        },
        resource: smsResourceFixture
      })

      expect(json.exitCodes).toEqual([1])
      expect(JSON.parse(json.stdout)).toEqual({
        error: expect.objectContaining({
          code: 'PROJECT_PROTOCOL_ERROR',
          message: 'Photon returned an invalid email-domain operation.',
          remoteOperationId: EMAIL_PLATFORM_OPERATION_ID
        })
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stderr).toContain('PROJECT_PROTOCOL_ERROR')
      expect(text.stderr).not.toContain('ARGUMENT_VALIDATION')
    }
  )

  test('preserves successful mutations when local context updates fail', async () => {
    const authenticated = await createAuthenticatedConfig()
    // A file where the .photon folder would go, so the project can't be
    // saved for the folder.
    await writeFile(
      join(authenticated.configDirectory, '.photon'),
      'not a folder'
    )
    const { organizationScope, rawScope, scope, spies } = createScope()
    const exitCodes: number[] = []
    const common = {
      configDirectory: authenticated.configDirectory,
      cwd: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope,
      platform: 'linux' as const,
      projectRawScope: rawScope,
      projectScope: scope,
      setExitCode: (code: number) => exitCodes.push(code)
    }
    const createStdout = collector()
    const createStderr = collector()

    await runCli(
      [
        'project',
        'create',
        '--slug',
        'test-project',
        '--name',
        'Created Project',
        '--link',
        '--json'
      ],
      {
        ...common,
        stderr: createStderr,
        stdout: createStdout
      }
    )

    expect(JSON.parse(createStdout.value())).toEqual({
      project: expect.objectContaining({
        projectId: 'pho_prj_00000000000000000000000002'
      })
    })
    expect(createStderr.value()).toContain('could not save it for this folder')
    expect(spies.create).toHaveBeenCalledOnce()

    // A folder where .photon/project.json would be, so it can't be read.
    await rm(join(authenticated.configDirectory, '.photon'))
    await mkdir(
      join(authenticated.configDirectory, '.photon', 'project.json'),
      {
        recursive: true
      }
    )
    const deleteStdout = collector()
    const deleteStderr = collector()
    await runCli(
      [
        'project',
        'delete',
        'pho_prj_00000000000000000000000001',
        '--yes',
        '--json'
      ],
      {
        ...common,
        stderr: deleteStderr,
        stdout: deleteStdout
      }
    )

    expect(JSON.parse(deleteStdout.value())).toMatchObject({
      deletedAt: timestamp,
      projectId: 'pho_prj_00000000000000000000000001'
    })
    expect(deleteStderr.value()).toContain(
      'could not remove the .photon/project.json that names it'
    )
    expect(spies.delete).toHaveBeenCalledOnce()
    expect(exitCodes).toEqual([])
    await authenticated.remove()
  })

  test('validates input and confirmation before mutations', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const invoke = async (args: string[]) => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      await runCli(
        [...args, '--json', '--project', 'pho_prj_00000000000000000000000001'],
        {
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )
      return {
        error: JSON.parse(stdout.value()) as {
          error: { code: string; message: string }
        },
        exitCodes
      }
    }

    await expect(
      invoke([
        'project',
        'platform',
        'imessage',
        'assignment',
        'create',
        '--phone-number',
        '4155550123'
      ])
    ).resolves.toMatchObject({
      error: { error: { code: 'ARGUMENT_VALIDATION' } },
      exitCodes: [2]
    })
    await expect(
      invoke(['project', 'list', '--limit', '0'])
    ).resolves.toMatchObject({
      error: { error: { code: 'ARGUMENT_VALIDATION' } },
      exitCodes: [2]
    })
    await expect(
      invoke(['project', 'list', '--created-after', 'July 2026'])
    ).resolves.toMatchObject({
      error: { error: { code: 'ARGUMENT_VALIDATION' } },
      exitCodes: [2]
    })
    await expect(
      invoke(['project', 'platform', 'sms', 'list', '--limit', '0'])
    ).resolves.toMatchObject({
      error: { error: { code: 'ARGUMENT_VALIDATION' } },
      exitCodes: [2]
    })
    await expect(
      invoke(['project', 'platform', 'email', 'connect', 'https://example.com'])
    ).resolves.toMatchObject({
      error: { error: { code: 'ARGUMENT_VALIDATION' } },
      exitCodes: [2]
    })
    await expect(
      invoke([
        'project',
        'platform',
        'email',
        'disconnect',
        emailResourceFixture.resourceId
      ])
    ).resolves.toMatchObject({
      error: { error: { code: 'CONFIRMATION_REQUIRED' } },
      exitCodes: [2]
    })
    await expect(
      invoke(['project', 'platform', 'sms', 'purchase'])
    ).resolves.toMatchObject({
      error: { error: { code: 'CONFIRMATION_REQUIRED' } },
      exitCodes: [2]
    })
    await expect(
      invoke([
        'project',
        'platform',
        'sms',
        'delete',
        'pho_res_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      error: { error: { code: 'CONFIRMATION_REQUIRED' } },
      exitCodes: [2]
    })
    expect(spies.platforms.imessage.assignments.create).not.toHaveBeenCalled()
    expect(spies.listResources).not.toHaveBeenCalled()
    expect(spies.raw.platforms.purchaseSmsNumber).not.toHaveBeenCalled()
    expect(spies.raw.platforms.connectEmailDomain).not.toHaveBeenCalled()
    expect(spies.raw.releaseResource).not.toHaveBeenCalled()
    expect(spies.list).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('reports missing required options and option conflicts with exit code 2', async () => {
    const authenticated = await createAuthenticatedConfig()
    const cases = [
      ['project', 'create'],
      ['project', 'edit'],
      ['project', 'billing', 'plan', 'purchase'],
      ['project', 'billing', 'subscription', 'resume'],
      ['project', 'platform', 'email', 'connect'],
      ['project', 'platform', 'email', 'disconnect'],
      ['project', 'platform', 'imessage', 'assignment', 'create'],
      ['project', 'platform', 'sms', 'delete'],
      [
        'project',
        'agent-profile',
        'edit',
        '--last-name',
        'Agent',
        '--clear-last-name'
      ]
    ]

    for (const args of cases) {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      // biome-ignore lint/performance/noAwaitInLoops: each validation case is an independent invocation.
      await runCli([...args, '--json'], {
        configDirectory: authenticated.configDirectory,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      })
      expect(JSON.parse(stdout.value())).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
      expect(exitCodes).toEqual([2])
    }
    await authenticated.remove()
  })

  const runDelete = async (
    args: string[],
    terminal: { answer?: string } = {}
  ): Promise<{
    deletes: string[]
    exitCodes: number[]
    stderr: string
    stdout: string
  }> => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const atTerminal = terminal.answer !== undefined
    const stdin = Readable.from([terminal.answer ?? '']) as ReadableInput
    stdin.isTTY = atTerminal
    const stdout = collector(atTerminal)
    const stderr = collector(atTerminal)
    const exitCodes: number[] = []

    await runCli(['project', 'delete', ...args, '--no-color'], {
      clock: instantPollClock(),
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope,
      platform: 'linux',
      projectRawScope: rawScope,
      projectScope: scope,
      setExitCode: (code) => exitCodes.push(code),
      stderr,
      stdin,
      stdout
    })
    await authenticated.remove()
    return {
      deletes: spies.delete.mock.calls.map(
        (call) =>
          ((call as unknown[])[0] as { path: { projectId: string } }).path
            .projectId
      ),
      exitCodes,
      stderr: stderr.value(),
      stdout: stdout.value()
    }
  }

  test('project delete without a terminal or --yes fails with CONFIRMATION_REQUIRED and deletes nothing', async () => {
    const text = await runDelete(['pho_prj_00000000000000000000000001'])
    const json = await runDelete([
      'pho_prj_00000000000000000000000001',
      '--json'
    ])

    expect(text.deletes).toEqual([])
    expect(text.exitCodes).toEqual([2])
    expect(text.stdout).toBe('')
    expect(text.stderr).toBe(
      [
        'Error: This would delete project "Alpha Project" (pho_prj_00000000000000000000000001). Confirm it with --yes. (CONFIRMATION_REQUIRED)',
        "Detail: Photon can't ask because standard input is not a terminal.",
        `Next: Run it again with --yes: ${CLI_NAME} project delete pho_prj_00000000000000000000000001 --no-color --yes`,
        'Docs: https://photon.codes/docs/cli/output#errors',
        ''
      ].join('\n')
    )
    expect(json.deletes).toEqual([])
    expect(json.exitCodes).toEqual([2])
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message:
          'This would delete project "Alpha Project" (pho_prj_00000000000000000000000001). Confirm it with --yes.',
        next: [
          {
            description: 'Run it again with --yes',
            run: `${CLI_NAME} project delete pho_prj_00000000000000000000000001 --no-color --json --yes`
          }
        ]
      }
    })
  })

  test('project delete with --yes or -y deletes the project it names', async () => {
    for (const yes of ['--yes', '-y']) {
      // biome-ignore lint/performance/noAwaitInLoops: one run per spelling.
      const result = await runDelete([
        'pho_prj_00000000000000000000000001',
        yes,
        '--json'
      ])
      expect(result.deletes).toEqual(['pho_prj_00000000000000000000000001'])
      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toMatchObject({
        deletedAt: timestamp,
        projectId: 'pho_prj_00000000000000000000000001'
      })
    }
  })

  test('project delete at a terminal deletes only when the typed name matches', async () => {
    const matched = await runDelete(['pho_prj_00000000000000000000000001'], {
      answer: 'Alpha Project\n'
    })
    expect(matched.deletes).toEqual(['pho_prj_00000000000000000000000001'])
    expect(matched.exitCodes).toEqual([])
    expect(matched.stderr).toBe(
      'Delete project "Alpha Project" (pho_prj_00000000000000000000000001)?\nType Alpha Project to confirm: '
    )
    expect(matched.stdout).toContain('Deleted project')

    for (const answer of ['alpha project\n', 'y\n', '\n']) {
      // biome-ignore lint/performance/noAwaitInLoops: one run per answer.
      const declined = await runDelete(['pho_prj_00000000000000000000000001'], {
        answer
      })
      expect(declined.deletes).toEqual([])
      expect(declined.exitCodes).toEqual([1])
      expect(declined.stdout).toBe('')
      expect(declined.stderr).toBe(
        'Delete project "Alpha Project" (pho_prj_00000000000000000000000001)?\nType Alpha Project to confirm: Cancelled.\n'
      )
    }
  })

  test('project delete requires the project ID as its argument', async () => {
    const result = await runDelete([
      '--yes',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(result.deletes).toEqual([])
    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toContain(
      "Positional argument 'project-id' is required"
    )
  })

  test('uses the documented SMS purchase confirmation and allows rejection', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()
    const confirm = vi.fn(() => Promise.resolve(false))
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'platform',
        'sms',
        'purchase',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        confirm,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr: collector(),
        stdout
      }
    )

    expect(confirm).toHaveBeenCalledWith(
      'Purchase one US local SMS number for project pho_prj_00000000000000000000000001? The project will be charged once provisioning succeeds.'
    )
    expect(stdout.value()).toBe('')
    expect(exitCodes).toEqual([1])
    expect(spies.raw.platforms.purchaseSmsNumber).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('uses the SMS delete resource ID in confirmation and allows rejection', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()
    const confirm = vi.fn(() => Promise.resolve(false))

    await runCli(
      [
        'project',
        'platform',
        'sms',
        'delete',
        'pho_res_00000000000000000000000001',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        confirm,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(confirm).toHaveBeenCalledWith(
      'Delete SMS number pho_res_00000000000000000000000001 from project pho_prj_00000000000000000000000001? This releases the number and removes its charge.'
    )
    expect(stdout.value()).toBe('')
    expect(spies.raw.releaseResource).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('uses the remote operation ID in cancellation confirmation and allows rejection', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()
    const confirm = vi.fn(() => Promise.resolve(false))

    await runCli(
      [
        'project',
        'platform',
        'operation',
        'cancel',
        PLATFORM_OPERATION_ID,
        '--project',
        'pho_prj_00000000000000000000000001',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        confirm,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(confirm).toHaveBeenCalledWith(
      `Cancel platform operation ${PLATFORM_OPERATION_ID} for project pho_prj_00000000000000000000000001?`
    )
    expect(stdout.value()).toBe('')
    expect(spies.platforms.cancelOperation).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('polls pending SMS purchase and delete results to completion', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope } = createScope()
    const clock = instantPollClock()
    const invoke = async (args: string[]): Promise<Record<string, unknown>> => {
      const stdout = collector()
      const stderr = collector()
      await runCli(
        [...args, '--project', 'pho_prj_00000000000000000000000001', '--json'],
        {
          clock,
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          stderr,
          stdout
        }
      )
      expect(stderr.value()).toBe('')
      return JSON.parse(stdout.value()) as Record<string, unknown>
    }

    await expect(
      invoke([
        'project',
        'platform',
        'sms',
        'purchase',
        '--yes',
        '--idempotency-key',
        'pending-sms-purchase'
      ])
    ).resolves.toMatchObject({
      operation: { operationId: 'remote_operation_sms', state: 'succeeded' },
      resource: { resourceId: 'pho_res_00000000000000000000000001' }
    })
    await expect(
      invoke([
        'project',
        'platform',
        'sms',
        'delete',
        'pho_res_00000000000000000000000001',
        '--yes'
      ])
    ).resolves.toMatchObject({
      operation: {
        operationId: 'remote_operation_release',
        state: 'succeeded'
      }
    })
    expect(clock.sleeps).toEqual([1000, 1000])

    await authenticated.remove()
  })

  test('shows an Ora spinner while purchasing an SMS number', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope } = createScope()
    const stdout = collector(true)
    const stderr = collector(true)

    await runCli(
      [
        'project',
        'platform',
        'sms',
        'purchase',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--no-color'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toContain(
      'Provisioning a US local SMS number for project pho_prj_00000000000000000000000001'
    )
    expect(stdout.value()).toContain('Provisioned SMS number +14155550125.')
    await authenticated.remove()
  })

  test('shows an Ora spinner while provisioning iMessage without a type field', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope } = createScope()
    const stdout = collector(true)
    const stderr = collector(true)

    await runCli(
      [
        'project',
        'platform',
        'imessage',
        'purchase',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--no-color'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toContain(
      'Provisioning a dedicated iMessage line for project pho_prj_00000000000000000000000001'
    )
    expect(stdout.value()).toContain('Provisioned iMessage line +14155550126.')
    expect(stdout.value()).not.toContain('Type')
    expect(stdout.value()).not.toContain('cosmos_line')
    await authenticated.remove()
  })

  test('rejects deleting a resource without SMS ability', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.getResource.mockResolvedValueOnce(imessageResourceFixture)
    const stdout = collector()
    const stderr = collector()

    await runCli(
      [
        'project',
        'platform',
        'sms',
        'delete',
        'pho_res_00000000000000000000000001',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toBe('')
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(spies.raw.releaseResource).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('renders SMS list, purchase, and delete fields in human output', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const invoke = async (args: string[]): Promise<string> => {
      const stdout = collector()
      await runCli(
        [...args, '--project', 'pho_prj_00000000000000000000000001'],
        {
          clock: instantPollClock(),
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          stderr: collector(),
          stdout
        }
      )
      return stdout.value()
    }

    const listed = await invoke(['project', 'platform', 'sms', 'list'])
    expect(listed).toContain('PHONE NUMBER')
    expect(listed).toContain('RESOURCE ID')
    expect(listed).toContain('TYPE')
    expect(listed).toContain('STATE')
    expect(listed).toContain('ABILITIES')
    expect(listed).toContain('CREATED')
    expect(listed).toContain('+14155550125')
    spies.listResources.mockResolvedValueOnce({ resources: [] })
    await expect(invoke(['project', 'platform', 'sms', 'list'])).resolves.toBe(
      ''
    )

    const purchased = await invoke([
      'project',
      'platform',
      'sms',
      'purchase',
      '--yes'
    ])
    expect(purchased).toContain('Provisioned SMS number +14155550125.')
    expect(purchased).toContain('Phone number')
    expect(purchased).toContain('Resource ID')
    expect(purchased).toContain('Project')
    expect(purchased).toContain('State')
    expect(purchased).toContain('Abilities')
    expect(purchased).toContain('Created')
    expect(purchased).toContain('Updated')
    expect(spies.raw.platforms.purchaseSmsNumber).toHaveBeenCalledWith(
      {
        body: { countryCode: 'US' },
        headers: {
          idempotencyKey: expect.stringMatching(UUID_V4_PATTERN)
        },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )

    const deleted = await invoke([
      'project',
      'platform',
      'sms',
      'delete',
      'pho_res_00000000000000000000000001',
      '--yes'
    ])
    expect(deleted).toContain(
      'Deleted SMS number pho_res_00000000000000000000000001.'
    )

    spies.listOperations.mockResolvedValueOnce({
      operations: [
        remoteOperationFixture(
          'remote_operation_imessage_pending',
          'cosmos_line',
          'running'
        )
      ]
    })
    const imessage = await invoke(['project', 'platform', 'imessage', 'list'])
    expect(imessage).toContain('HEALTH')
    expect(imessage).toContain('remote_operation_imessage_pending')
    expect(imessage).not.toContain('RESOURCE TYPE')
    expect(imessage).not.toContain('cosmos_line')
    await authenticated.remove()
  })

  test('renders complete billing details and truthful no-op results for humans', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.billing.listBillingPlans.mockResolvedValueOnce({
      plans: { platforms: [billingPlanFixture('business', true)] }
    })
    spies.billing.getEffectiveTerms.mockResolvedValueOnce({
      subscriptions: [
        subscriptionTermsFixture({ effectiveAt: PERIOD_END, planCode: 'free' })
      ],
      timeZone: 'UTC'
    })
    spies.billing.getEffectiveTerms.mockResolvedValueOnce({
      subscriptions: [subscriptionTermsFixture(null)],
      timeZone: 'UTC'
    })
    const invoke = async (args: string[]): Promise<string> => {
      const stdout = collector()
      const stderr = collector()
      await runCli(
        [...args, '--project', 'pho_prj_00000000000000000000000001'],
        {
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          stderr,
          stdout
        }
      )
      expect(stderr.value()).toBe('')
      return stdout.value()
    }

    const overview = await invoke(['project', 'billing', 'overview'])
    expect(overview).toContain('SCHEDULED')
    expect(overview).toContain(`free on ${PERIOD_END}`)
    expect(overview).toContain('Entitlements (version 1)')
    expect(overview).toContain('imessage_shared_lines.max_user_assignments')
    expect(overview).toContain('imessage_message')
    expect(overview).toContain('1.00')

    const invoices = await invoke(['project', 'billing', 'invoice', 'list'])
    expect(invoices).toContain('10.00')

    const cancelledSubscription = await invoke([
      'project',
      'billing',
      'subscription',
      'cancel',
      '--category',
      'platforms',
      '--yes'
    ])
    expect(cancelledSubscription).toContain('nothing changed')
    expect(cancelledSubscription).not.toContain('Scheduled cancellation')

    const resumedSubscription = await invoke([
      'project',
      'billing',
      'subscription',
      'resume',
      '--category',
      'platforms'
    ])
    expect(resumedSubscription).toContain('nothing changed')
    expect(resumedSubscription).not.toContain('Kept the')
    expect(spies.billing.changePlan).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('cancels by moving to the default plan and resumes by keeping the held plan', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const succeeded = {
      ...billingOperationFixture(PURCHASE_BILLING_OPERATION_ID, 'SUCCEEDED'),
      result: { effectiveAt: PERIOD_END, type: 'version', version: 'v2' }
    } as GetBillingOperationOutput
    spies.billing.changePlan.mockResolvedValue(succeeded)
    const invoke = async (args: string[]) => {
      const stdout = collector()
      const stderr = collector()
      await runCli(
        [...args, '--project', 'pho_prj_00000000000000000000000001', '--json'],
        {
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          stderr,
          stdout
        }
      )
      expect(stderr.value()).toBe('')
      return JSON.parse(stdout.value()) as unknown
    }

    const cancelled = await invoke([
      'project',
      'billing',
      'subscription',
      'cancel',
      '--category',
      'platforms',
      '--yes',
      '--idempotency-key',
      'cancel-key-1'
    ])
    expect(cancelled).toMatchObject({
      operation: { result: { effectiveAt: PERIOD_END }, status: 'SUCCEEDED' },
      subscription: {
        cancellationScheduled: true,
        cancelsAt: PERIOD_END,
        category: 'platforms'
      }
    })
    expect(spies.billing.changePlan).toHaveBeenLastCalledWith(
      {
        body: { category: 'platforms', planCode: 'free' },
        headers: { idempotencyKey: 'cancel-key-1' },
        path: {
          organizationId: TEST_ORGANIZATION_ID,
          projectId: 'pho_prj_00000000000000000000000001'
        }
      },
      undefined
    )

    const resumed = await invoke([
      'project',
      'billing',
      'subscription',
      'resume',
      '--category',
      'platforms'
    ])
    expect(resumed).toMatchObject({
      subscription: { category: 'platforms', resumed: true }
    })
    expect(spies.billing.changePlan).toHaveBeenLastCalledWith(
      {
        body: { category: 'platforms', planCode: 'business' },
        headers: { idempotencyKey: expect.any(String) },
        path: {
          organizationId: TEST_ORGANIZATION_ID,
          projectId: 'pho_prj_00000000000000000000000001'
        }
      },
      undefined
    )
    expect(spies.billing.changePlan).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('writes rejected billing operations as actionable errors', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    spies.billing.changePlan.mockResolvedValueOnce(
      billingOperationFixture(
        'pho_bop_0000000000000000000000000000000000000000000000000000000000000003',
        'failed',
        {
          code: 'payment_failed',
          detail: 'Payment method declined.',
          retryable: false
        }
      )
    )
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'billing',
        'plan',
        'purchase',
        '--category',
        'platforms',
        '--plan-code',
        'business',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toBe('')
    const failure = JSON.parse(stdout.value())
    expect(failure).toMatchObject({
      error: {
        code: 'BILLING_OPERATION_REJECTED',
        detail: 'Payment method declined.',
        reason: 'payment_failed',
        remoteOperationId:
          'pho_bop_0000000000000000000000000000000000000000000000000000000000000003',
        retryable: false
      }
    })
    expect(failure.error).not.toHaveProperty('idempotencyKey')
    expect(failure.error).not.toHaveProperty('operationId')
    expect(exitCodes).toEqual([1])
    await authenticated.remove()
  })

  test('shows a failed billing operation in operation view and exits 0', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const operationId =
      'pho_bop_0000000000000000000000000000000000000000000000000000000000000004'
    const failed = billingOperationFixture(operationId, 'failed', {
      code: 'payment_failed',
      detail: 'payment_declined',
      retryable: false
    })
    const pending = billingOperationFixture(operationId, 'pending')
    const view = async (...flags: string[]) => {
      spies.billing.getOperation.mockClear()
      spies.billing.getOperation
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(failed)
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(
        [
          'project',
          'billing',
          'operation',
          'view',
          operationId,
          '--project',
          'pho_prj_00000000000000000000000001',
          '--no-color',
          ...flags
        ],
        {
          clock: instantPollClock(),
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          organizationScope,
          platform: 'linux',
          projectRawScope: rawScope,
          projectScope: scope,
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )
      return {
        exitCodes,
        reads: spies.billing.getOperation.mock.calls.length,
        stderr: stderr.value(),
        stdout: stdout.value()
      }
    }

    const text = await view()
    expect(text.reads).toBe(2)
    expect(text.exitCodes).toEqual([])
    expect(text.stderr).toBe('')
    expect(text.stdout).toContain('Billing operation')
    expect(text.stdout).toContain(
      [
        'Status          failed',
        'Failure         payment_failed',
        'Failure detail  payment_declined',
        'Retryable       false'
      ].join('\n')
    )

    const json = await view('--json')
    expect(json.reads).toBe(2)
    expect(json.exitCodes).toEqual([])
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toEqual(failed)
    await authenticated.remove()
  })

  test('unlink warns when the environment still overrides stored context', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { rawScope, scope } = createScope()
    const common = {
      configDirectory: authenticated.configDirectory,
      cwd: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux' as const,
      projectRawScope: rawScope,
      projectScope: scope
    }
    await runCli(
      ['link', '--project', 'pho_prj_00000000000000000000000103', '--json'],
      {
        ...common,
        stderr: collector(),
        stdout: collector()
      }
    )
    const stdout = collector()
    const stderr = collector()

    await runCli(['unlink', '--json'], {
      ...common,
      env: { PHOTON_PROJECT_ID: 'pho_prj_00000000000000000000000105' },
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toEqual({
      active: {
        projectId: 'pho_prj_00000000000000000000000105',
        source: 'environment'
      },
      cleared: true,
      path: join(authenticated.configDirectory, '.photon', 'project.json')
    })
    expect(stderr.value()).toContain(
      'PHOTON_PROJECT_ID still selects project pho_prj_00000000000000000000000105.'
    )
    await authenticated.remove()
  })

  test('accepts an inline global project selector before the command tree', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdout = collector()

    await runCli(
      [
        '--project=pho_prj_00000000000000000000000104',
        'project',
        'view',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        stderr: collector(),
        stdout
      }
    )

    expect(JSON.parse(stdout.value())).toMatchObject({
      projectId: 'pho_prj_00000000000000000000000104'
    })
    expect(spies.get).toHaveBeenCalledWith(
      { path: { projectId: 'pho_prj_00000000000000000000000104' } },
      undefined
    )
    await authenticated.remove()
  })
})

const SGR_TAIL = /^[\d;]*m/u

describe('prompts, color and spinners in each terminal mode', () => {
  // Ora draws a spinner's first frame on start() and later frames from a
  // setInterval. With the clock faked and never advanced, and nothing else
  // writing to stderr while it spins, standard error holds that first frame
  // alone, however long the purchase takes on a slow runner.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  interface TerminalMode {
    args?: string[]
    env?: NodeJS.ProcessEnv
    stderr?: boolean
    stdin?: boolean
    stdout?: boolean
  }

  interface Expected {
    color: boolean
    /** Why Photon can't ask, when it can't. */
    noPrompt?: string
    spinner: boolean
  }

  const colored = (text: string): boolean =>
    text
      .split('\u001b[')
      .slice(1)
      .some((sequence) => SGR_TAIL.test(sequence))
  const plain = stripVTControlCharacters
  const NOTICE = 'Project: pho_prj_00000000000000000000000001, from --project\n'
  const QUESTION =
    'Purchase one US local SMS number for project pho_prj_00000000000000000000000001? The project will be charged once provisioning succeeds. [y/N] '
  const SPINNER =
    '⠋ Provisioning a US local SMS number for project pho_prj_00000000000000000000000001'
  const PROVISIONED = [
    'Provisioned SMS number +14155550125.',
    'SMS resource',
    'Phone number  +14155550125',
    'Resource ID   pho_res_00000000000000000000000001',
    'Type          voip_line',
    'State         active',
    'Health        —',
    'Abilities     sms, pstn_voice',
    'Project       pho_prj_00000000000000000000000001',
    'Created       2026-07-31T18:00:00.000Z',
    'Updated       2026-07-31T18:00:00.000Z',
    ''
  ].join('\n')
  const LISTED = [
    'SMS resources',
    'PHONE NUMBER  RESOURCE ID                         TYPE       STATE   ABILITIES        CREATED',
    '+14155550125  pho_res_00000000000000000000000001  voip_line  active  sms, pstn_voice  2026-07-31T18:00:00.000Z',
    ''
  ].join('\n')

  const runIn = async (mode: TerminalMode, args: string[], answer = '') => {
    const authenticated = await createAuthenticatedConfig()
    const { organizationScope, rawScope, scope, spies } = createScope()
    const stdin = Readable.from([answer]) as ReadableInput
    stdin.isTTY = mode.stdin ?? true
    const stdout = collector(mode.stdout ?? true)
    const stderr = collector(mode.stderr ?? true)
    const exitCodes: number[] = []
    await runCli(
      [
        'project',
        'platform',
        'sms',
        ...args,
        '--project',
        'pho_prj_00000000000000000000000001',
        ...(mode.args ?? [])
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        env: mode.env ?? {},
        now: () => TEST_NOW,
        organizationScope,
        platform: 'linux',
        projectRawScope: rawScope,
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdin,
        stdout
      }
    )
    await authenticated.remove()
    return {
      exitCodes,
      purchases: spies.raw.platforms.purchaseSmsNumber.mock.calls.length,
      stderr: stderr.value(),
      stdout: stdout.value()
    }
  }

  const MODES: [string, TerminalMode, Expected][] = [
    ['all three streams terminals', {}, { color: true, spinner: true }],
    [
      'stdout redirected',
      { stdout: false },
      {
        color: true,
        noPrompt: 'standard output is not a terminal',
        spinner: false
      }
    ],
    [
      'stderr redirected',
      { stderr: false },
      {
        color: true,
        noPrompt: 'standard error is not a terminal',
        spinner: false
      }
    ],
    [
      'stdin piped',
      { stdin: false },
      {
        color: true,
        noPrompt: 'standard input is not a terminal',
        spinner: true
      }
    ],
    [
      '--json on a terminal',
      { args: ['--json'] },
      { color: false, noPrompt: '--json is set', spinner: false }
    ],
    [
      '--no-input',
      { args: ['--no-input'] },
      { color: true, noPrompt: '--no-input is set', spinner: true }
    ],
    [
      'PHOTON_NO_INPUT=1',
      { env: { PHOTON_NO_INPUT: '1' } },
      { color: true, noPrompt: 'PHOTON_NO_INPUT is set', spinner: true }
    ],
    [
      'PHOTON_NO_INPUT=0',
      { env: { PHOTON_NO_INPUT: '0' } },
      { color: true, spinner: true }
    ],
    [
      'CI=1',
      { env: { CI: '1' } },
      { color: true, noPrompt: 'CI is set', spinner: false }
    ],
    ['CI=false', { env: { CI: 'false' } }, { color: true, spinner: true }],
    ['NO_COLOR=1', { env: { NO_COLOR: '1' } }, { color: false, spinner: true }],
    [
      'NO_COLOR=1 with --color',
      { args: ['--color'], env: { NO_COLOR: '1' } },
      { color: true, spinner: true }
    ]
  ]

  test.each(MODES)('%s', async (_name, mode, expected) => {
    const json = mode.args?.includes('--json') === true
    const stdoutColor = expected.color && (mode.stdout ?? true)
    const stderrColor = expected.color && (mode.stderr ?? true)
    // The answer is there in every mode; only a terminal question reads it.
    const asked = await runIn(mode, ['purchase'], 'y\n')
    const confirmed = await runIn(mode, ['purchase', '--yes'])
    const listed = await runIn(mode, ['list'])

    if (expected.noPrompt === undefined) {
      expect(asked.exitCodes).toEqual([])
      expect(asked.purchases).toBe(1)
      expect(plain(asked.stderr)).toBe(
        `${NOTICE}${QUESTION}${expected.spinner ? SPINNER : ''}`
      )
      expect(plain(asked.stdout)).toBe(PROVISIONED)
    } else {
      expect(asked.exitCodes).toEqual([2])
      expect(asked.purchases).toBe(0)
      expect(json ? asked.stderr : asked.stdout).toBe('')
      const next = [
        CLI_NAME,
        'project platform sms purchase',
        ...(mode.args ?? []),
        '--project pho_prj_00000000000000000000000001 --yes'
      ].join(' ')
      if (json) {
        expect(JSON.parse(asked.stdout)).toMatchObject({
          error: {
            code: 'CONFIRMATION_REQUIRED',
            detail: `The project will be charged once provisioning succeeds. Photon can't ask because ${expected.noPrompt}.`,
            message:
              'This would purchase one US local SMS number for project pho_prj_00000000000000000000000001. Confirm it with --yes.',
            next: [{ description: 'Run it again with --yes', run: next }]
          }
        })
      } else {
        expect(plain(asked.stderr)).toBe(
          [
            'Error: This would purchase one US local SMS number for project pho_prj_00000000000000000000000001. Confirm it with --yes. (CONFIRMATION_REQUIRED)',
            `Detail: The project will be charged once provisioning succeeds. Photon can't ask because ${expected.noPrompt}.`,
            `Next: Run it again with --yes: ${next}`,
            'Docs: https://photon.codes/docs/cli/output#errors',
            ''
          ].join('\n')
        )
        expect(colored(asked.stderr)).toBe(stderrColor)
      }
    }

    expect(confirmed.exitCodes).toEqual([])
    expect(confirmed.purchases).toBe(1)
    expect(plain(confirmed.stderr)).toBe(expected.spinner ? SPINNER : '')
    expect(listed.exitCodes).toEqual([])
    expect(listed.stderr).toBe('')
    expect(colored(listed.stdout)).toBe(stdoutColor)
    expect(colored(confirmed.stdout)).toBe(stdoutColor)
    if (json) {
      expect(JSON.parse(confirmed.stdout)).toMatchObject({
        resource: { resourceId: 'pho_res_00000000000000000000000001' }
      })
      expect(JSON.parse(listed.stdout)).toMatchObject({
        provisioning: [],
        resources: [{ resourceId: 'pho_res_00000000000000000000000001' }]
      })
    } else {
      // Off a terminal the text loses its color and spinner, not its content.
      expect(plain(confirmed.stdout)).toBe(PROVISIONED)
      expect(plain(listed.stdout)).toBe(LISTED)
    }
  })
})
