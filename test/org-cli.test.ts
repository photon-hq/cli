import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  type GetBillingOperationOutput,
  type GetBillingOverviewOutput,
  type GetEffectiveTermsOutput,
  type ListBillingPlansOutput,
  TransportError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import type { CliError } from '../src/core/errors.ts'
import { CliOutput } from '../src/core/output.ts'
import { CLI_ERROR_REFERENCE_URL } from '../src/core/output-basics.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  type OrganizationScope,
  OrganizationService
} from '../src/organization/service.ts'
import { printed } from './help-support.ts'
import {
  asAccountScope,
  asOrganizationScope,
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  ONLY_ORGANIZATION_LINE,
  organizationFixture,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const accountFixture = {
  accountId: 'pho_acc_00000000000000000000000002',
  createdAt: timestamp,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: timestamp
}

const memberFixture = (
  accountId: string,
  overrides: Record<string, unknown> = {}
) => ({
  account: {
    displayName: null,
    email: `${accountId}@example.test`,
    firstName: null,
    lastName: null,
    pictureUrl: 'https://images.example.test/member.png'
  },
  accountId,
  createdAt: timestamp,
  futureField: 'from-a-newer-api',
  joinedVia: 'invitation',
  organizationId: 'pho_org_00000000000000000000000001',
  removedAt: null,
  role: 'member',
  roleManagedAt: null,
  status: 'active',
  updatedAt: timestamp,
  version: `${accountId}-version`,
  ...overrides
})

const invitationFixture = {
  acceptedAt: null,
  acceptedByAccountId: null,
  allProjects: true as const,
  createdAt: timestamp,
  email: 'invitee@example.test',
  expiresAt: '2026-08-07T18:00:00.000Z',
  invitationId: 'pho_oinv_00000000000000000000000001',
  invitedByAccountId: 'pho_acc_00000000000000000000000002',
  organizationId: 'pho_org_00000000000000000000000001',
  role: 'viewer',
  status: 'pending',
  updatedAt: timestamp
}

const projectFixture = (projectId: string) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/agent.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  createdByAccountId: 'pho_acc_00000000000000000000000002',
  createdByActorId: 'pho_acc_00000000000000000000000002',
  createdByActorKind: 'account',
  deletedAt: null,
  name: projectId,
  organizationId: 'pho_org_00000000000000000000000001',
  projectId,
  slug: projectId.replaceAll('_', '-'),
  updatedAt: timestamp
})

const ORGANIZATION_NAMES: Record<string, string> = {
  pho_org_00000000000000000000000001: 'Acme',
  pho_org_00000000000000000000000002: 'Globex'
}

const organizationMocks = (
  organizationIds: readonly string[] = ['pho_org_00000000000000000000000001']
) => {
  const getOrganization = vi.fn((input: { path: { organizationId: string } }) =>
    Promise.resolve(
      organizationFixture(
        input.path.organizationId,
        input.path.organizationId === 'pho_org_00000000000000000000000001'
          ? 'Acme'
          : 'Globex'
      )
    )
  )
  const listOrganizations = vi.fn(() =>
    Promise.resolve({
      acquisitionQuestionnaireExempt: false,
      organizations: organizationIds.map((organizationId) =>
        organizationFixture(
          organizationId,
          ORGANIZATION_NAMES[organizationId] ?? organizationId
        )
      ),
      ownedOrganizationIds: ['pho_org_00000000000000000000000001']
    })
  )
  const listOrganizationMembers = vi.fn(() =>
    Promise.resolve({
      members: [
        memberFixture('pho_acc_00000000000000000000000002', { role: 'owner' }),
        memberFixture('pho_acc_00000000000000000000000001'),
        memberFixture('pho_acc_00000000000000000000000003', {
          removedAt: timestamp,
          status: 'removed'
        })
      ]
    })
  )
  const updateOrganizationMemberRole = vi.fn(() =>
    Promise.resolve({
      ...memberFixture('pho_acc_00000000000000000000000001'),
      role: 'admin'
    })
  )
  const removeOrganizationMember = vi.fn(() =>
    Promise.resolve({
      ...memberFixture('pho_acc_00000000000000000000000001'),
      removedAt: timestamp,
      status: 'removed'
    })
  )
  const leaveOrganization = vi.fn(() =>
    Promise.resolve({
      ...memberFixture('pho_acc_00000000000000000000000002'),
      removedAt: timestamp,
      status: 'removed'
    })
  )
  const createOrganizationInvitation = vi.fn(() =>
    Promise.resolve(invitationFixture)
  )
  const listOrganizationInvitations = vi.fn(() =>
    Promise.resolve({ invitations: [invitationFixture] })
  )
  const previewOrganizationInvitation = vi.fn(() =>
    Promise.resolve({
      allProjects: true as const,
      emailMatches: true,
      expiresAt: invitationFixture.expiresAt,
      inviter: {
        accountId: 'account_owner',
        avatarUrl: 'https://images.example.test/owner.png',
        maskedEmail: 'o***@example.test',
        name: 'Grace Hopper'
      },
      maskedEmail: 'i***@example.test',
      memberCount: 3,
      organizationAvatarUrl: null,
      organizationId: 'pho_org_00000000000000000000000001',
      organizationName: 'Acme',
      role: 'viewer',
      ssoRequired: false,
      status: 'pending'
    })
  )
  const acceptOrganizationInvitation = vi.fn(() =>
    Promise.resolve({
      allProjects: true as const,
      organizationId: 'pho_org_00000000000000000000000001',
      organizationName: 'Acme',
      role: 'viewer',
      status: 'accepted'
    })
  )
  const revokeOrganizationInvitation = vi.fn(() =>
    Promise.resolve({ ...invitationFixture, status: 'revoked' })
  )
  const projects = {
    count: vi.fn(() => Promise.resolve({ count: 2 })),
    create: vi.fn(() =>
      Promise.resolve(projectFixture('pho_prj_00000000000000000000000107'))
    ),
    list: vi.fn(() =>
      Promise.resolve({
        projects: [
          projectFixture('pho_prj_00000000000000000000000001'),
          projectFixture('pho_prj_00000000000000000000000002')
        ]
      })
    )
  }
  const scope = asOrganizationScope({
    acceptOrganizationInvitation,
    createOrganizationInvitation,
    getOrganization,
    leaveOrganization,
    listOrganizationInvitations,
    listOrganizationMembers,
    listOrganizations,
    previewOrganizationInvitation,
    projects,
    removeOrganizationMember,
    revokeOrganizationInvitation,
    updateOrganizationMemberRole
  })
  return {
    acceptOrganizationInvitation,
    createOrganizationInvitation,
    getOrganization,
    leaveOrganization,
    listOrganizationInvitations,
    listOrganizationMembers,
    listOrganizations,
    previewOrganizationInvitation,
    projects,
    removeOrganizationMember,
    revokeOrganizationInvitation,
    scope,
    updateOrganizationMemberRole
  }
}

const paymentMocks = () => {
  const getOrganizationPaymentMethod = vi.fn<
    OrganizationScope['billing']['getOrganizationPaymentMethod']
  >(() =>
    Promise.resolve({
      cardOnFile: true,
      paymentMethod: {
        brand: 'visa',
        expiresMonth: 12,
        expiresYear: 2028,
        last4: '4242'
      }
    })
  )
  const createOrganizationPaymentMethodCheckout = vi.fn<
    OrganizationScope['billing']['createOrganizationPaymentMethodCheckout']
  >(() =>
    Promise.resolve({
      checkoutUrl: 'https://checkout.example.test/session_123'
    })
  )
  return {
    createOrganizationPaymentMethodCheckout,
    getOrganizationPaymentMethod,
    scope: asOrganizationScope({
      billing: {
        createOrganizationPaymentMethodCheckout,
        getOrganizationPaymentMethod
      }
    })
  }
}

const jsonError = (stderr: string): { error: Record<string, unknown> } => {
  const line = stderr.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line) as { error: Record<string, unknown> }
}

const createInvoke = async (organizationIds?: readonly string[]) => {
  const authenticated = await createAuthenticatedConfig()
  const mocks = organizationMocks(organizationIds)
  const invoke = cliInvoker(authenticated.configDirectory, asProjectScope({}), {
    accountScope: asAccountScope({
      get: () => Promise.resolve(accountFixture)
    }),
    organizationScope: mocks.scope
  })
  return { authenticated, invoke, mocks }
}

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('organization context', () => {
  test('defaults to the only organization the account belongs to', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()

    const shown = await invoke(['org', 'show'])
    expect(JSON.parse(shown.stdout)).toEqual({
      organization: organizationFixture(),
      source: 'default'
    })
    expect(mocks.listOrganizations).toHaveBeenCalledWith({}, undefined)

    const listed = await invoke(['org', 'list'])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      activeOrganizationId: 'pho_org_00000000000000000000000001'
    })
    // org list derives the default from its own listing.
    expect(mocks.listOrganizations).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('requires a selection with several organizations, where --org and the stored one win', async () => {
    const { authenticated, invoke, mocks } = await createInvoke([
      'pho_org_00000000000000000000000001',
      'pho_org_00000000000000000000000002'
    ])

    const unselected = await invoke(['org', 'show'])
    expect(jsonError(unselected.stdout)).toEqual({
      error: {
        code: 'ORGANIZATION_NOT_SELECTED',
        docsUrl: CLI_ERROR_REFERENCE_URL,
        message:
          'Your account belongs to several organizations, and none is selected.',
        next: [
          {
            description: 'List your organizations',
            run: `${CLI_NAME} org list`
          },
          {
            description: `Select one with "${CLI_NAME} org use <organization-id>", or pass --org <organization-id>.`
          }
        ],
        retryable: false
      }
    })
    expect(unselected.exitCodes).toEqual([2])
    const projects = await invoke(['project', 'list'])
    expect(jsonError(projects.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_NOT_SELECTED' }
    })
    expect(mocks.projects.list).not.toHaveBeenCalled()

    const unmarked = await invoke(['org', 'list'])
    expect(JSON.parse(unmarked.stdout)).toEqual({
      acquisitionQuestionnaireExempt: false,
      organizations: [
        organizationFixture('pho_org_00000000000000000000000001', 'Acme'),
        organizationFixture('pho_org_00000000000000000000000002', 'Globex')
      ],
      ownedOrganizationIds: ['pho_org_00000000000000000000000001']
    })

    const flagged = await invoke([
      'org',
      'show',
      '--org',
      'pho_org_00000000000000000000000003'
    ])
    expect(JSON.parse(flagged.stdout)).toMatchObject({
      organization: { organizationId: 'pho_org_00000000000000000000000003' },
      source: 'flag'
    })

    const used = await invoke([
      'org',
      'use',
      'pho_org_00000000000000000000000002'
    ])
    expect(JSON.parse(used.stdout)).toEqual({
      organization: organizationFixture(
        'pho_org_00000000000000000000000002',
        'Globex'
      ),
      source: 'stored'
    })
    expect(mocks.getOrganization).toHaveBeenLastCalledWith(
      { path: { organizationId: 'pho_org_00000000000000000000000002' } },
      undefined
    )
    const stored = await invoke(['org', 'show'])
    expect(JSON.parse(stored.stdout)).toMatchObject({
      organization: { organizationId: 'pho_org_00000000000000000000000002' },
      source: 'stored'
    })
    const overridden = await invoke([
      'org',
      'show',
      '--org',
      'pho_org_00000000000000000000000001'
    ])
    expect(JSON.parse(overridden.stdout)).toMatchObject({
      organization: { organizationId: 'pho_org_00000000000000000000000001' },
      source: 'flag'
    })
    const listed = await invoke(['org', 'list'])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      activeOrganizationId: 'pho_org_00000000000000000000000002'
    })

    const cleared = await invoke(['org', 'clear'])
    expect(JSON.parse(cleared.stdout)).toEqual({ cleared: true })
    const clearedAgain = await invoke(['org', 'clear'])
    expect(JSON.parse(clearedAgain.stdout)).toEqual({ cleared: false })
    const afterClear = await invoke(['org', 'show'])
    expect(jsonError(afterClear.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_NOT_SELECTED' }
    })
    await authenticated.remove()
  })

  test('reports an account without organizations', async () => {
    const { authenticated, invoke } = await createInvoke([])

    const shown = await invoke(['org', 'show'])
    expect(jsonError(shown.stdout)).toMatchObject({
      error: {
        code: 'ORGANIZATION_NOT_SELECTED',
        message: 'Your account does not belong to any organization.'
      }
    })
    expect(shown.exitCodes).toEqual([2])
    await authenticated.remove()
  })

  test('recovers from a corrupt stored organization with org list, org use, and org clear', async () => {
    const { authenticated, invoke } = await createInvoke([
      'pho_org_00000000000000000000000001',
      'pho_org_00000000000000000000000002'
    ])
    await invoke(['org', 'use', 'pho_org_00000000000000000000000002'])
    const contexts = join(
      authenticated.configDirectory,
      'organization-contexts'
    )
    const [contextFile] = await readdir(contexts)
    if (contextFile === undefined) {
      throw new Error('Expected a stored organization context.')
    }
    await writeFile(join(contexts, contextFile), '{not json', { mode: 0o600 })

    const shown = await invoke(['org', 'show'])
    expect(jsonError(shown.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_CONTEXT_CORRUPT' }
    })
    const listed = await invoke(['org', 'list'])
    expect(listed.exitCodes).toEqual([])
    expect(JSON.parse(listed.stdout)).not.toHaveProperty('activeOrganizationId')

    const used = await invoke([
      'org',
      'use',
      'pho_org_00000000000000000000000001'
    ])
    expect(used.exitCodes).toEqual([])
    const stored = await invoke(['org', 'show'])
    expect(JSON.parse(stored.stdout)).toMatchObject({
      organization: { organizationId: 'pho_org_00000000000000000000000001' },
      source: 'stored'
    })

    await writeFile(join(contexts, contextFile), '{not json', { mode: 0o600 })
    const cleared = await invoke(['org', 'clear'])
    expect(JSON.parse(cleared.stdout)).toEqual({ cleared: true })
    await authenticated.remove()
  })

  test('does not store an organization that cannot be read', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()
    mocks.getOrganization.mockRejectedValueOnce(
      new ApiError('missing organization', {
        body: { code: 'NOT_FOUND' },
        headers: new Headers(),
        operationId: 'getOrganization',
        status: 404
      })
    )

    const failed = await invoke([
      'org',
      'use',
      'pho_org_00000000000000000000000102'
    ])
    expect(jsonError(failed.stdout)).toMatchObject({
      error: { code: 'NOT_FOUND', problem: { code: 'NOT_FOUND', status: 404 } }
    })
    expect(failed.exitCodes).toEqual([1])

    const shown = await invoke(['org', 'show'])
    expect(JSON.parse(shown.stdout)).toMatchObject({
      organization: { organizationId: 'pho_org_00000000000000000000000001' },
      source: 'default'
    })
    await authenticated.remove()
  })

  test('scopes project list, count, and create to the current organization or --org', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()

    const listed = await invoke(['project', 'list'])
    expect(JSON.parse(listed.stdout)).toMatchObject({
      projects: [
        {
          organizationId: 'pho_org_00000000000000000000000001',
          projectId: 'pho_prj_00000000000000000000000001'
        },
        {
          organizationId: 'pho_org_00000000000000000000000001',
          projectId: 'pho_prj_00000000000000000000000002'
        }
      ]
    })
    expect(mocks.projects.list).toHaveBeenCalledWith(
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 30 }
      },
      undefined
    )

    await invoke(['org', 'use', 'pho_org_00000000000000000000000002'])
    await expect(
      invoke(['project', 'count', '--search', 'alpha'])
    ).resolves.toMatchObject({ exitCodes: [] })
    expect(mocks.projects.count).toHaveBeenCalledWith(
      {
        path: { organizationId: 'pho_org_00000000000000000000000002' },
        query: { query: 'alpha' }
      },
      undefined
    )

    const created = await invoke([
      'project',
      'create',
      '--name',
      'New Project',
      '--slug',
      'new-project',
      '--org',
      'pho_org_00000000000000000000000003'
    ])
    expect(JSON.parse(created.stdout)).toMatchObject({
      projectId: 'pho_prj_00000000000000000000000107'
    })
    expect(mocks.projects.create).toHaveBeenCalledWith(
      {
        body: { name: 'New Project', slug: 'new-project' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000003' }
      },
      undefined
    )
    await authenticated.remove()
  })
})

describe('project billing organization', () => {
  test('uses the project organization, not the selected one', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getProject = vi.fn(() =>
      Promise.resolve(projectFixture('pho_prj_00000000000000000000000001'))
    )
    const periodEnd = '2026-08-31T18:00:00.000Z'
    const getOverview = vi.fn(() =>
      Promise.resolve({
        entitlementsVersion: 1,
        subscriptions: [
          { category: 'messaging', planCode: 'pro', planName: 'Pro' }
        ],
        usage: []
      } as unknown as GetBillingOverviewOutput)
    )
    const listBillingPlans = vi.fn(() =>
      Promise.resolve({
        plans: {
          messaging: [{ isDefault: true, name: 'Free', planCode: 'free' }]
        }
      } as unknown as ListBillingPlansOutput)
    )
    const getEffectiveTerms = vi.fn(() =>
      Promise.resolve({
        subscriptions: [
          {
            category: 'messaging',
            scheduledPlanChange: { effectiveAt: periodEnd, planCode: 'free' }
          }
        ],
        timeZone: 'UTC'
      } as unknown as GetEffectiveTermsOutput)
    )
    const changePlan = vi.fn(() =>
      Promise.resolve({
        failure: null,
        kind: 'change_plan',
        operationId:
          'pho_bop_0000000000000000000000000000000000000000000000000000000000000001',
        paymentAction: null,
        resolvedAt: timestamp,
        result: { effectiveAt: periodEnd, type: 'version', version: 'v2' },
        status: 'succeeded',
        submittedAt: timestamp
      } as GetBillingOperationOutput)
    )
    const listInvoices = vi.fn(() =>
      Promise.resolve({ invoices: [], nextCursor: null })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        billing: { getOverview, listBillingPlans },
        get: getProject
      }),
      {
        organizationScope: asOrganizationScope({
          billing: { changePlan, getEffectiveTerms, listInvoices }
        })
      }
    )
    const scope = [
      '--project',
      'pho_prj_00000000000000000000000001',
      '--org',
      'pho_org_00000000000000000000000101'
    ]

    const cancelled = await invoke([
      'project',
      'billing',
      'subscription',
      'cancel',
      '--category',
      'messaging',
      '--yes',
      ...scope
    ])
    expect(cancelled.exitCodes).toEqual([])
    const resumed = await invoke([
      'project',
      'billing',
      'subscription',
      'resume',
      '--category',
      'messaging',
      ...scope
    ])
    expect(resumed.exitCodes).toEqual([])
    const invoices = await invoke([
      'project',
      'billing',
      'invoice',
      'list',
      ...scope
    ])
    expect(JSON.parse(invoices.stdout)).toEqual({
      invoices: [],
      nextCursor: null
    })

    const projectPath = {
      organizationId: 'pho_org_00000000000000000000000001',
      projectId: 'pho_prj_00000000000000000000000001'
    }
    expect(changePlan).toHaveBeenNthCalledWith(
      1,
      {
        body: { category: 'messaging', planCode: 'free' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: projectPath
      },
      undefined
    )
    expect(changePlan).toHaveBeenNthCalledWith(
      2,
      {
        body: { category: 'messaging', planCode: 'pro' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: projectPath
      },
      undefined
    )
    expect(getEffectiveTerms).toHaveBeenCalledWith(
      { path: projectPath },
      undefined
    )
    expect(listInvoices).toHaveBeenCalledWith(
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { limit: 30 }
      },
      undefined
    )
    expect(getProject).toHaveBeenCalledWith(
      { path: { projectId: 'pho_prj_00000000000000000000000001' } },
      undefined
    )
    await authenticated.remove()
  })
})

describe('organization members and invitations', () => {
  test('lists members and changes roles with the current membership version', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()

    const listed = await invoke(['org', 'member', 'list'])
    expect(JSON.parse(listed.stdout)).toEqual({
      members: [
        memberFixture('pho_acc_00000000000000000000000002', { role: 'owner' }),
        memberFixture('pho_acc_00000000000000000000000001'),
        memberFixture('pho_acc_00000000000000000000000003', {
          removedAt: timestamp,
          status: 'removed'
        })
      ]
    })

    const edited = await invoke([
      'org',
      'member',
      'edit',
      'pho_acc_00000000000000000000000001',
      '--role',
      'admin',
      '--idempotency-key',
      'member-edit-1'
    ])
    expect(JSON.parse(edited.stdout)).toEqual({
      ...memberFixture('pho_acc_00000000000000000000000001'),
      role: 'admin'
    })
    expect(mocks.updateOrganizationMemberRole).toHaveBeenCalledWith(
      {
        body: {
          expectedVersion: 'pho_acc_00000000000000000000000001-version',
          role: 'admin'
        },
        headers: { idempotencyKey: 'member-edit-1' },
        path: {
          memberAccountId: 'pho_acc_00000000000000000000000001',
          organizationId: 'pho_org_00000000000000000000000001'
        }
      },
      undefined
    )

    const missing = await invoke([
      'org',
      'member',
      'edit',
      'pho_acc_00000000000000000000000003',
      '--role',
      'viewer'
    ])
    expect(jsonError(missing.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_MEMBER_NOT_FOUND' }
    })
    expect(missing.exitCodes).toEqual([2])
    expect(mocks.updateOrganizationMemberRole).toHaveBeenCalledOnce()

    const unconfirmed = await invoke([
      'org',
      'member',
      'remove',
      'pho_acc_00000000000000000000000001'
    ])
    expect(jsonError(unconfirmed.stdout)).toMatchObject({
      error: { code: 'CONFIRMATION_REQUIRED' }
    })
    expect(mocks.removeOrganizationMember).not.toHaveBeenCalled()

    const removed = await invoke([
      'org',
      'member',
      'remove',
      'pho_acc_00000000000000000000000001',
      '--yes'
    ])
    expect(JSON.parse(removed.stdout)).toEqual({
      ...memberFixture('pho_acc_00000000000000000000000001'),
      removedAt: timestamp,
      status: 'removed'
    })
    expect(mocks.removeOrganizationMember).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 'pho_acc_00000000000000000000000001-version' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: {
          memberAccountId: 'pho_acc_00000000000000000000000001',
          organizationId: 'pho_org_00000000000000000000000001'
        }
      },
      undefined
    )
    await authenticated.remove()
  })

  test('invites with an organization role and rejects roles invitations cannot grant', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()

    const invited = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'invitee@example.test',
      '--role',
      'viewer'
    ])
    expect(JSON.parse(invited.stdout)).toEqual(invitationFixture)
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledWith(
      {
        body: { email: 'invitee@example.test', role: 'viewer' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )

    const rejected = await invoke([
      'org',
      'member',
      'invite',
      '--email',
      'invitee@example.test',
      '--role',
      'admin'
    ])
    expect(jsonError(rejected.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(rejected.exitCodes).toEqual([2])
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('lists, previews, accepts, and revokes invitations without exposing tokens', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()
    const tokenFile = join(authenticated.configDirectory, 'invitation-token')
    await writeFile(tokenFile, 'private-invitation-token\n', { mode: 0o600 })

    const listed = await invoke(['org', 'invitation', 'list'])
    expect(JSON.parse(listed.stdout)).toEqual({
      invitations: [invitationFixture]
    })
    expect(mocks.listOrganizationInvitations).toHaveBeenCalledWith(
      { path: { organizationId: 'pho_org_00000000000000000000000001' } },
      undefined
    )

    const previewed = await invoke([
      'org',
      'invitation',
      'preview',
      '--token-file',
      tokenFile
    ])
    expect(JSON.parse(previewed.stdout)).toEqual({
      allProjects: true,
      emailMatches: true,
      expiresAt: invitationFixture.expiresAt,
      inviter: {
        accountId: 'account_owner',
        avatarUrl: 'https://images.example.test/owner.png',
        maskedEmail: 'o***@example.test',
        name: 'Grace Hopper'
      },
      maskedEmail: 'i***@example.test',
      memberCount: 3,
      organizationAvatarUrl: null,
      organizationId: 'pho_org_00000000000000000000000001',
      organizationName: 'Acme',
      role: 'viewer',
      ssoRequired: false,
      status: 'pending'
    })
    expect(mocks.previewOrganizationInvitation).toHaveBeenCalledWith(
      { body: { token: 'private-invitation-token' } },
      undefined
    )

    const accepted = await invoke([
      'org',
      'invitation',
      'accept',
      '--token-file',
      tokenFile
    ])
    expect(JSON.parse(accepted.stdout)).toEqual({
      allProjects: true,
      organizationId: 'pho_org_00000000000000000000000001',
      organizationName: 'Acme',
      role: 'viewer',
      status: 'accepted'
    })
    expect(accepted.stdout).not.toContain('private-invitation-token')

    const revoked = await invoke([
      'org',
      'invitation',
      'revoke',
      'pho_oinv_00000000000000000000000001',
      '--yes'
    ])
    expect(JSON.parse(revoked.stdout)).toEqual({
      ...invitationFixture,
      status: 'revoked'
    })
    expect(mocks.revokeOrganizationInvitation).toHaveBeenCalledWith(
      {
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: {
          invitationId: 'pho_oinv_00000000000000000000000001',
          organizationId: 'pho_org_00000000000000000000000001'
        }
      },
      undefined
    )
    await authenticated.remove()
  })

  test('keeps a membership change whose outcome is unknown after a connection failure', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()
    mocks.updateOrganizationMemberRole.mockRejectedValueOnce(
      new TransportError('offline')
    )

    const failed = await invoke([
      'org',
      'member',
      'edit',
      'pho_acc_00000000000000000000000001',
      '--role',
      'admin',
      '--idempotency-key',
      'member-edit-offline'
    ])
    expect(failed.stderr).toBe(ONLY_ORGANIZATION_LINE)
    const failure = JSON.parse(failed.stdout) as {
      error: { code: string; operationId: string }
    }
    expect(failure.error.code).toBe('API_CONNECTION_ERROR')
    // The change may have reached Photon, so the record stays for replay.
    const inspected = JSON.parse(
      (await invoke(['operation', 'view', failure.error.operationId])).stdout
    ) as { operation: { status: string } }
    expect(inspected.operation.status).toBe('outcome-unknown')
    await authenticated.remove()
  })

  test('leaves the organization with the caller membership version and clears it when stored', async () => {
    const { authenticated, invoke, mocks } = await createInvoke()
    await invoke(['org', 'use', 'pho_org_00000000000000000000000001'])

    const left = await invoke(['org', 'leave', '--yes'])
    expect(JSON.parse(left.stdout)).toEqual({
      ...memberFixture('pho_acc_00000000000000000000000002'),
      removedAt: timestamp,
      status: 'removed'
    })
    expect(mocks.leaveOrganization).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 'pho_acc_00000000000000000000000002-version' },
        headers: { idempotencyKey: expect.stringMatching(UUID_V4_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
    const shown = await invoke(['org', 'show'])
    expect(JSON.parse(shown.stdout)).toMatchObject({ source: 'default' })
    await authenticated.remove()
  })

  test('never includes invitation tokens echoed by an upstream error', async () => {
    const token = 'private-invitation-token'
    const previewOrganizationInvitation = vi.fn(() =>
      Promise.reject(
        new ApiError('invalid invitation', {
          body: {
            code: 'INVITATION_INVALID',
            title: `Invalid invitation ${token}`
          },
          headers: new Headers(),
          operationId: 'previewOrganizationInvitation',
          status: 400
        })
      )
    )
    const service = new OrganizationService({
      request: new AuthenticatedRequest({
        tokenManager: {
          getAccessToken: () => Promise.resolve('access-token'),
          refreshAfterUnauthorized: () => Promise.resolve('rotated-token')
        }
      }),
      scope: asOrganizationScope({ previewOrganizationInvitation })
    })

    const error = await service
      .previewInvitation(token)
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'INVITATION_INVALID' })
    expect((error as Error).message).not.toContain(token)
    const stdout = collector()
    new CliOutput({ json: true, stdout }).error(error as CliError)
    expect(stdout.value()).toContain('INVITATION_INVALID')
    expect(stdout.value()).not.toContain(token)
  })
})

describe('organization payment method', () => {
  test('reports payment status and opens hosted setup, keeping its URL in the document', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      browserLauncher,
      organizationScope: mocks.scope
    })

    const status = await invoke(['org', 'billing', 'payment-method', 'status'])
    expect(JSON.parse(status.stdout)).toEqual({
      cardOnFile: true,
      paymentMethod: {
        brand: 'visa',
        expiresMonth: 12,
        expiresYear: 2028,
        last4: '4242'
      }
    })

    const setup = await invoke(['org', 'billing', 'payment-method', 'setup'])
    expect(JSON.parse(setup.stdout)).toEqual({
      checkout: { checkoutUrl: 'https://checkout.example.test/session_123' },
      opened: true
    })
    expect(setup.stderr).toBe('Opened secure payment setup in your browser.\n')
    expect(browserLauncher).toHaveBeenCalledWith(
      'https://checkout.example.test/session_123'
    )
  })

  test('renders safe payment details for humans', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    const stdout = collector()

    await runCli(['org', 'billing', 'payment-method', 'status'], {
      configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope: mocks.scope,
      platform: 'linux',
      stderr: collector(),
      stdout
    })

    expect(stdout.value()).toContain('Payment method')
    expect(stdout.value()).toContain('Card on file  yes')
    expect(stdout.value()).toContain('Brand         Visa')
    expect(stdout.value()).toContain('Last four     4242')
    expect(stdout.value()).toContain('Expires       12/2028')
  })

  test('prints nullable payment metadata as sent without inventing details', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    const staleMethod = {
      cardOnFile: false,
      paymentMethod: {
        brand: 'visa',
        expiresMonth: 12,
        expiresYear: 2028,
        last4: '4242'
      }
    }
    mocks.getOrganizationPaymentMethod
      .mockResolvedValueOnce({ cardOnFile: true, paymentMethod: null })
      .mockResolvedValueOnce({ cardOnFile: false, paymentMethod: null })
      .mockResolvedValueOnce(staleMethod)
      .mockResolvedValueOnce(staleMethod)
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      organizationScope: mocks.scope
    })

    const unavailable = await invoke([
      'org',
      'billing',
      'payment-method',
      'status'
    ])
    expect(JSON.parse(unavailable.stdout)).toEqual({
      cardOnFile: true,
      paymentMethod: null
    })

    const empty = await invoke(['org', 'billing', 'payment-method', 'status'])
    expect(JSON.parse(empty.stdout)).toEqual({
      cardOnFile: false,
      paymentMethod: null
    })

    // Without a card on file, text output shows no card details, and JSON
    // prints the response as the API sent it.
    const stale = await invoke(['org', 'billing', 'payment-method', 'status'])
    expect(JSON.parse(stale.stdout)).toEqual(staleMethod)
    const staleText = await terminalInvoker(
      configDirectory,
      asProjectScope({}),
      { organizationScope: mocks.scope }
    )(['org', 'billing', 'payment-method', 'status'])
    expect(staleText.stdout).toContain('Card on file  no')
    expect(staleText.stdout).not.toContain('4242')
  })

  test('rejects malformed payment details as a protocol error', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    mocks.getOrganizationPaymentMethod.mockResolvedValueOnce({
      cardOnFile: true,
      paymentMethod: {
        brand: 'visa',
        expiresMonth: 13,
        expiresYear: 2028,
        last4: '4242'
      }
    })
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      organizationScope: mocks.scope
    })

    const result = await invoke(['org', 'billing', 'payment-method', 'status'])

    expect(jsonError(result.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_PROTOCOL_ERROR' }
    })
    expect(result.stderr).toBe('')
  })

  test('returns the checkout URL unopened for no-browser or launch fallback', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    const browserLauncher = vi.fn(() => Promise.reject(new Error('no browser')))
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      browserLauncher,
      organizationScope: mocks.scope
    })

    const noBrowser = await invoke([
      'org',
      'billing',
      'payment-method',
      'setup',
      '--no-browser'
    ])
    expect(JSON.parse(noBrowser.stdout)).toEqual({
      checkout: { checkoutUrl: 'https://checkout.example.test/session_123' },
      opened: false
    })
    expect(noBrowser.stderr).toBe('')
    expect(browserLauncher).not.toHaveBeenCalled()

    const fallback = await invoke(['org', 'billing', 'payment-method', 'setup'])
    expect(JSON.parse(fallback.stdout)).toEqual({
      checkout: { checkoutUrl: 'https://checkout.example.test/session_123' },
      opened: false
    })
    expect(fallback.stderr).toContain('browser could not be opened')
    expect(fallback.stderr).not.toContain('session_123')
  })

  test('rejects insecure checkout URLs before opening or printing them', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = paymentMocks()
    mocks.createOrganizationPaymentMethodCheckout.mockResolvedValueOnce({
      checkoutUrl: 'http://checkout.example.test/private-session'
    })
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      browserLauncher,
      organizationScope: mocks.scope
    })

    const result = await invoke([
      'org',
      'billing',
      'payment-method',
      'setup',
      '--no-browser'
    ])

    expect(jsonError(result.stdout)).toMatchObject({
      error: { code: 'ORGANIZATION_PROTOCOL_ERROR' }
    })
    expect(result.stderr).not.toContain('private-session')
    expect(result.stdout).not.toContain('private-session')
    expect(result.stderr).toBe('')
    expect(browserLauncher).not.toHaveBeenCalled()
  })
})

describe('moved command pointers', () => {
  test.each([
    [
      ['project', 'member', 'list'],
      `${CLI_NAME} project member`,
      `${CLI_NAME} org member`,
      `${CLI_NAME} org member list`
    ],
    [
      [
        'project',
        'invitation',
        'revoke',
        'pho_oinv_00000000000000000000000001'
      ],
      `${CLI_NAME} project invitation`,
      `${CLI_NAME} org invitation`,
      `${CLI_NAME} org invitation revoke pho_oinv_00000000000000000000000001`
    ],
    [
      ['project', 'leave', '--yes'],
      `${CLI_NAME} project leave`,
      `${CLI_NAME} org leave`,
      `${CLI_NAME} org leave`
    ],
    [
      ['account', 'oauth', 'client', 'view', 'client_1'],
      `${CLI_NAME} account oauth client`,
      `${CLI_NAME} org oauth-client`,
      `${CLI_NAME} org oauth-client view client_1`
    ],
    [
      ['account', 'oauth', 'secret', 'create', 'client_1'],
      `${CLI_NAME} account oauth secret`,
      `${CLI_NAME} org oauth-client secret`,
      `${CLI_NAME} org oauth-client secret create client_1`
    ],
    [
      ['account', 'oauth', 'secret', 'list', 'client_1'],
      `${CLI_NAME} account oauth secret list`,
      `${CLI_NAME} org oauth-client secret view`,
      `${CLI_NAME} org oauth-client secret view client_1`
    ],
    [
      ['org', 'oauth-client', 'secret', 'list', 'client_1'],
      `${CLI_NAME} org oauth-client secret list`,
      `${CLI_NAME} org oauth-client secret view`,
      `${CLI_NAME} org oauth-client secret view client_1`
    ],
    [
      ['account', 'billing', 'payment', 'status'],
      `${CLI_NAME} account billing payment`,
      `${CLI_NAME} org billing payment-method`,
      `${CLI_NAME} org billing payment-method status`
    ],
    [
      ['--json', 'project', 'member', 'list'],
      `${CLI_NAME} project member`,
      `${CLI_NAME} org member`,
      `${CLI_NAME} org member list --json`
    ],
    [
      [
        'project',
        '--no-color',
        'member',
        'edit',
        'pho_acc_00000000000000000000000001',
        '--role',
        'admin'
      ],
      `${CLI_NAME} project member`,
      `${CLI_NAME} org member`,
      `${CLI_NAME} org member edit pho_acc_00000000000000000000000001 --no-color`
    ],
    [
      [
        '--org',
        'pho_org_00000000000000000000000001',
        'project',
        'invitation',
        'revoke',
        'pho_oinv_00000000000000000000000001'
      ],
      `${CLI_NAME} project invitation`,
      `${CLI_NAME} org invitation`,
      `${CLI_NAME} org invitation revoke pho_oinv_00000000000000000000000001 --org pho_org_00000000000000000000000001`
    ],
    [
      [
        'project',
        '--project=pho_prj_00000000000000000000000001',
        'leave',
        '--yes'
      ],
      `${CLI_NAME} project leave`,
      `${CLI_NAME} org leave`,
      `${CLI_NAME} org leave --project=pho_prj_00000000000000000000000001`
    ],
    [
      ['account', 'billing'],
      `${CLI_NAME} account billing`,
      `${CLI_NAME} org billing`,
      `${CLI_NAME} org billing`
    ],
    [
      ['project', '--no-input', 'member', 'list'],
      `${CLI_NAME} project member`,
      `${CLI_NAME} org member`,
      `${CLI_NAME} org member list --no-input`
    ],
    [
      [
        'project',
        'member',
        'edit',
        "pho_acc_00000000000000000000000001'; touch /tmp/moved"
      ],
      `${CLI_NAME} project member`,
      `${CLI_NAME} org member`,
      `${CLI_NAME} org member edit 'pho_acc_00000000000000000000000001'\\''; touch /tmp/moved'`
    ]
  ])(
    'points %j to its replacement without running it',
    async (args, from, to, replacement) => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []

      await runCli([...args, '--json'], {
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })

      expect(stderr.value()).toBe('')
      expect(JSON.parse(stdout.value())).toEqual({
        error: {
          code: 'COMMAND_MOVED',
          docsUrl: CLI_ERROR_REFERENCE_URL,
          message: `"${from}" moved to "${to}".`,
          next: [
            { description: 'Use the new command', run: `${replacement} --json` }
          ],
          retryable: false
        }
      })
      expect(exitCodes).toEqual([2])
    }
  )

  test('prints the pointer for humans, including --help', async () => {
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(['project', 'member', '--help'], {
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout: collector()
    })

    expect(stderr.value()).toContain(
      `"${CLI_NAME} project member" moved to "${CLI_NAME} org member".`
    )
    expect(stderr.value()).toContain(
      `Next: Use the new command: ${CLI_NAME} org member`
    )
    expect(exitCodes).toEqual([2])
  })

  test('keeps the options the user gave in the new command, but never --force or --yes', async () => {
    const human = collector()
    const json = collector()
    const exitCodes: number[] = []
    const setExitCode = (exitCode: number) => exitCodes.push(exitCode)

    await runCli(
      [
        'account',
        'billing',
        'payment',
        '--org',
        'pho_org_00000000000000000000000001'
      ],
      {
        setExitCode,
        stderr: human,
        stdout: collector()
      }
    )
    await runCli(
      [
        '--debug',
        'account',
        'billing',
        'payment',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--force',
        '--no-color',
        '--yes',
        '--org=pho_org_00000000000000000000000001',
        '--json'
      ],
      { setExitCode, stderr: collector(), stdout: json }
    )

    expect(human.value()).toContain(
      `Next: Use the new command: ${CLI_NAME} org billing payment-method --org pho_org_00000000000000000000000001\n`
    )
    expect(JSON.parse(json.value()).error.next).toEqual([
      {
        description: 'Use the new command',
        run: `${CLI_NAME} org billing payment-method --debug --project pho_prj_00000000000000000000000001 --no-color --org=pho_org_00000000000000000000000001 --json`
      }
    ])
    expect(exitCodes).toEqual([2, 2])
  })

  test('leaves out an option without a value instead of taking the next option as its value', async () => {
    const json = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'account',
        'billing',
        'payment',
        '--org',
        '--force',
        '--project=',
        '--yes',
        '--json',
        '--org'
      ],
      {
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr: collector(),
        stdout: json
      }
    )

    expect(JSON.parse(json.value()).error.next).toEqual([
      {
        description: 'Use the new command',
        run: `${CLI_NAME} org billing payment-method --json`
      }
    ])
    expect(exitCodes).toEqual([2])
  })

  test('carries a boolean option in the forms the parser accepts, and no --no- form it rejects', async () => {
    const json = collector()

    await runCli(
      [
        'account',
        'billing',
        'payment',
        '--json=true',
        '--debug=false',
        '--no-debug',
        '--no-color'
      ],
      { setExitCode: () => undefined, stderr: collector(), stdout: json }
    )

    expect(JSON.parse(json.value()).error.next).toEqual([
      {
        description: 'Use the new command',
        run: `${CLI_NAME} org billing payment-method --json=true --debug=false --no-color`
      }
    ])
  })

  test('reads --json=true among the command words as the parser does', async () => {
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['account', '--json=true', 'billing', 'payment'], {
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout
    })

    expect(JSON.parse(stdout.value())).toEqual({
      error: {
        code: 'COMMAND_MOVED',
        docsUrl: CLI_ERROR_REFERENCE_URL,
        message: `"${CLI_NAME} account billing payment" moved to "${CLI_NAME} org billing payment-method".`,
        next: [
          {
            description: 'Use the new command',
            run: `${CLI_NAME} org billing payment-method --json=true`
          }
        ],
        retryable: false
      }
    })
    expect(exitCodes).toEqual([2])
  })

  test.each(['--json=false', '--debug=true', '--no-input=true'])(
    'reads %s among the command words as the parser does',
    async (option) => {
      const stderr = collector()
      const exitCodes: number[] = []

      await runCli(['account', option, 'billing', 'payment'], {
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout: collector()
      })

      expect(stderr.value()).toContain(
        `Error: "${CLI_NAME} account billing payment" moved to "${CLI_NAME} org billing payment-method". (COMMAND_MOVED)\n`
      )
      expect(stderr.value()).toContain(
        `Next: Use the new command: ${CLI_NAME} org billing payment-method ${option}\n`
      )
      expect(exitCodes).toEqual([2])
    }
  )

  test('reads an option after a value option as an option, as the parser does', async () => {
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        '--org',
        '--project',
        'pho_prj_00000000000000000000000001',
        'project',
        'member',
        'list'
      ],
      {
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout: collector()
      }
    )

    expect(stderr.value()).toContain(
      `Error: "${CLI_NAME} project member" moved to "${CLI_NAME} org member". (COMMAND_MOVED)\n`
    )
    expect(stderr.value()).toContain(
      `Next: Use the new command: ${CLI_NAME} org member list --project pho_prj_00000000000000000000000001\n`
    )
    expect(exitCodes).toEqual([2])
  })

  test('reads an empty argument after a value option as its value, and leaves both out', async () => {
    const json = collector()

    await runCli(['--org', '', 'account', 'billing', 'payment', '--json'], {
      setExitCode: () => undefined,
      stderr: collector(),
      stdout: json
    })

    expect(JSON.parse(json.value()).error.next).toEqual([
      {
        description: 'Use the new command',
        run: `${CLI_NAME} org billing payment-method --json`
      }
    ])
  })

  test('ends the command words at a --no- form the parser rejects', async () => {
    const json = collector()
    const exitCodes: number[] = []

    await runCli(['--no-debug', 'account', 'billing', 'payment', '--json'], {
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: json
    })

    expect(JSON.parse(json.value()).error).toMatchObject({
      code: 'ARGUMENT_VALIDATION',
      issues: expect.arrayContaining([
        { message: 'Unknown option: --no-debug' }
      ])
    })
    expect(exitCodes).toEqual([2])
  })

  test('keeps commands that did not move', async () => {
    const help = [
      await printed(['account', 'oauth', 'connection', '--help']),
      await printed(['project', 'list', '--help'])
    ]

    expect(help.join('')).not.toBe('')
    expect(process.exitCode).toBeUndefined()
  })
})
