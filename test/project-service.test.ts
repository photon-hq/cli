import { truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  ResponseValidationError,
  TransportError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import { MAXIMUM_AVATAR_BYTES } from '../src/core/avatar.ts'
import type { CliError } from '../src/core/errors.ts'
import {
  isBillingOperationInProgress,
  ProjectService
} from '../src/project/service.ts'
import {
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  createAuthenticatedConfig,
  instantPollClock
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const project = (projectId: string) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/avatar.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  createdByActorId: 'account_owner',
  createdByActorKind: 'account',
  deletedAt: null,
  flags: [],
  name: projectId,
  organizationId: 'pho_org_00000000000000000000000001',
  projectId,
  slug: projectId,
  updatedAt: timestamp
})

const platformResource = (
  index: number,
  abilities: string[] = ['sms'],
  type = 'voip_line'
) => ({
  abilities,
  createdAt: timestamp,
  detail: { phoneNumber: '+14155550125' },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: `resource_${index.toString()}`,
  state: 'active',
  type,
  updatedAt: timestamp
})

const resourceOperation = (
  state: string,
  operationId = 'remote_operation_1',
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
  ...resourceOperation(state, operationId, released.type),
  resourceId: released.resourceId,
  type: 'resource.release'
})

const rawResponse = <Result>(data: Result, retryAfter = '5', status = 202) => ({
  data,
  headers: new Headers({ 'retry-after': retryAfter }),
  status
})

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

const createRequest = () => {
  const tokenManager = {
    getAccessToken: vi.fn(() => Promise.resolve('access-token')),
    refreshAfterUnauthorized: vi.fn(() => Promise.resolve('rotated-token'))
  }
  return {
    request: new AuthenticatedRequest({ tokenManager }),
    tokenManager
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('project service', () => {
  test.each([
    ['PENDING', true],
    ['pending', true],
    ['RUNNING', true],
    ['running', true],
    ['SUCCEEDED', false],
    ['FAILED', false]
  ])('classifies billing operation status %s', (status, expected) => {
    expect(isBillingOperationInProgress(status)).toBe(expected)
  })

  test('polls billing operations without a total timeout', async () => {
    const pending = {
      failure: null,
      kind: 'change_plan',
      operationId: 'billing_operation_1',
      paymentAction: null,
      resolvedAt: null,
      result: null,
      status: 'pending' as const,
      submittedAt: timestamp
    }
    const succeeded = {
      ...pending,
      resolvedAt: timestamp,
      result: {
        effectiveAt: null,
        type: 'version' as const,
        version: 'version_1'
      },
      status: 'succeeded' as const
    }
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(succeeded)
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ billing: { getOperation } })
    })

    await expect(
      service.pollBillingOperation(
        'pho_prj_00000000000000000000000001',
        pending
      )
    ).resolves.toEqual(succeeded)
    expect(clock.sleeps).toEqual([2000, 2000])
    expect(getOperation).toHaveBeenCalledTimes(2)
  })

  test('lists the project-scoped platform catalog with its envelope', async () => {
    const platforms = [
      {
        description: 'Text messages over a project-owned phone number.',
        displayName: 'SMS',
        type: 'sms'
      }
    ]
    const listProjectPlatforms = vi.fn(() => Promise.resolve({ platforms }))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { listProjectPlatforms } })
    })

    await expect(
      service.listProjectPlatforms('pho_prj_00000000000000000000000001')
    ).resolves.toEqual({
      platforms
    })
    expect(listProjectPlatforms).toHaveBeenCalledWith(
      { path: { id: 'pho_prj_00000000000000000000000001' } },
      undefined
    )
  })

  test('cancels a project-scoped platform operation', async () => {
    const operation = resourceOperation(
      'cancelled',
      'pho_opr_01h455vb4pex5vsknk084sn02q',
      'cosmos_line'
    )
    const cancelOperation = vi.fn(() => Promise.resolve(operation))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { cancelOperation } })
    })

    await expect(
      service.cancelOperation(
        'pho_prj_00000000000000000000000001',
        operation.operationId
      )
    ).resolves.toEqual(operation)
    expect(cancelOperation).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          operationId: operation.operationId
        }
      },
      undefined
    )
  })

  test('paginates sequentially, preserves order, and returns the continuation', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        nextPageToken: 'page_2',
        projects: [
          project('pho_prj_00000000000000000000000001'),
          project('pho_prj_00000000000000000000000002')
        ]
      })
      .mockResolvedValueOnce({
        nextPageToken: 'page_3',
        projects: [project('pho_prj_00000000000000000000000003')]
      })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { list } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.list('pho_org_00000000000000000000000001', {}, { limit: 3 })
    ).resolves.toMatchObject({
      nextPageToken: 'page_3',
      projects: [
        { projectId: 'pho_prj_00000000000000000000000001' },
        { projectId: 'pho_prj_00000000000000000000000002' },
        { projectId: 'pho_prj_00000000000000000000000003' }
      ]
    })
    expect(list).toHaveBeenNthCalledWith(
      1,
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 3 }
      },
      undefined
    )
    expect(list).toHaveBeenNthCalledWith(
      2,
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 1, pageToken: 'page_2' }
      },
      undefined
    )
  })

  test('caps API page sizes and honors a starting token', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        nextPageToken: 'next',
        projects: Array.from({ length: 100 }, (_, index) =>
          project(`project_${index.toString()}`)
        )
      })
      .mockResolvedValueOnce({
        projects: Array.from({ length: 20 }, (_, index) =>
          project(`project_${(index + 100).toString()}`)
        )
      })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { list } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.list(
        'pho_org_00000000000000000000000001',
        {},
        { limit: 120, pageToken: 'start' }
      )
    ).resolves.toHaveProperty('projects', expect.any(Array))
    expect(list).toHaveBeenNthCalledWith(
      1,
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 100, pageToken: 'start' }
      },
      undefined
    )
    expect(list).toHaveBeenNthCalledWith(
      2,
      {
        path: { organizationId: 'pho_org_00000000000000000000000001' },
        query: { pageSize: 20, pageToken: 'next' }
      },
      undefined
    )
  })

  test('paginates ability-filtered resources with the endpoint page cap', async () => {
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({
        nextPageToken: 'next',
        resources: Array.from({ length: 200 }, (_, index) =>
          platformResource(index)
        )
      })
      .mockResolvedValueOnce({
        resources: Array.from({ length: 20 }, (_, index) =>
          platformResource(index + 200)
        )
      })
    const listOperations = vi.fn(() => Promise.resolve({ operations: [] }))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { listOperations, listResources } })
    })

    const result = await service.listPlatformResources(
      'pho_prj_00000000000000000000000001',
      'sms',
      {
        limit: 220,
        pageToken: 'start'
      }
    )
    expect(result.resources).toHaveLength(220)
    expect(result.resources[0]?.resourceId).toBe('resource_0')
    expect(result.resources.at(-1)?.resourceId).toBe('resource_219')
    expect(result.provisioning).toEqual([])
    expect(listResources).toHaveBeenNthCalledWith(
      1,
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'sms', pageSize: 200, pageToken: 'start' }
      },
      undefined
    )
    expect(listResources).toHaveBeenNthCalledWith(
      2,
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'sms', pageSize: 20, pageToken: 'next' }
      },
      undefined
    )
    expect(listOperations).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: {
          pageSize: 200,
          state: 'pending,running',
          type: 'resource.provision'
        }
      },
      undefined
    )
  })

  test('rejects repeated resource page tokens', async () => {
    const listResources = vi.fn(() =>
      Promise.resolve({
        nextPageToken: 'repeated',
        resources: [platformResource(1)]
      })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({
        platforms: {
          listOperations: () => Promise.resolve({ operations: [] }),
          listResources
        }
      })
    })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'sms',
        { limit: 3 }
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    expect(listResources).toHaveBeenCalledTimes(2)
  })

  test('exhausts operation pages and keeps only matching in-flight provisioning', async () => {
    const listOperations = vi
      .fn()
      .mockResolvedValueOnce({
        nextPageToken: 'operations-next',
        operations: [
          resourceOperation('pending', 'sms_pending'),
          resourceOperation('running', 'imessage_running', 'cosmos_line'),
          resourceOperation('succeeded', 'sms_succeeded')
        ]
      })
      .mockResolvedValueOnce({
        operations: [resourceOperation('running', 'sms_running')]
      })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({
        platforms: {
          listOperations,
          listResources: () => Promise.resolve({ resources: [] })
        }
      })
    })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'sms',
        { limit: 1 }
      )
    ).resolves.toMatchObject({
      provisioning: [
        { operationId: 'sms_pending' },
        { operationId: 'sms_running' }
      ]
    })
    expect(listOperations).toHaveBeenNthCalledWith(
      2,
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: {
          pageSize: 200,
          pageToken: 'operations-next',
          state: 'pending,running',
          type: 'resource.provision'
        }
      },
      undefined
    )
  })

  test('rejects repeated operation page tokens', async () => {
    const listOperations = vi.fn(() =>
      Promise.resolve({
        nextPageToken: 'repeated',
        operations: [resourceOperation('pending')]
      })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({
        platforms: {
          listOperations,
          listResources: () => Promise.resolve({ resources: [] })
        }
      })
    })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'sms',
        { limit: 1 }
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    expect(listOperations).toHaveBeenCalledTimes(2)
  })

  test('caps exhaustive operation pagination at one hundred pages', async () => {
    let pageNumber = 0
    const listOperations = vi.fn(() => {
      pageNumber += 1
      return Promise.resolve({
        nextPageToken: `operations_${pageNumber.toString()}`,
        operations: []
      })
    })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({
        platforms: {
          listOperations,
          listResources: () => Promise.resolve({ resources: [] })
        }
      })
    })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'sms',
        { limit: 1 }
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned too many operation pagination pages.'
    })
    expect(listOperations).toHaveBeenCalledTimes(100)
  })

  test('does not request operations for PSTN voice resources', async () => {
    const listOperations = vi.fn()
    const listResources = vi.fn(() =>
      Promise.resolve({ resources: [platformResource(1, ['pstn_voice'])] })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { listOperations, listResources } })
    })

    await expect(
      service.listPlatformResources(
        'pho_prj_00000000000000000000000001',
        'pstn_voice',
        { limit: 1 }
      )
    ).resolves.toMatchObject({ provisioning: [] })
    expect(listOperations).not.toHaveBeenCalled()
    expect(listResources).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'pstn_voice', pageSize: 1 }
      },
      undefined
    )
  })

  test('rejects repeated page tokens as a protocol error', async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        nextPageToken: 'repeated',
        projects: [project('pho_prj_00000000000000000000000110')]
      })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { list } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.list('pho_org_00000000000000000000000001', {}, { limit: 3 })
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR'
    })
    expect(list).toHaveBeenCalledTimes(2)
  })

  test('stops pagination when a page is empty despite a continuation', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ nextPageToken: 'unexpected', projects: [] })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { list } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.list('pho_org_00000000000000000000000001', {}, { limit: 2 })
    ).resolves.toEqual({
      projects: []
    })
    expect(list).toHaveBeenCalledOnce()
  })

  test('caps pagination requests when continuation tokens remain unique', async () => {
    let pageNumber = 0
    const list = vi.fn(() => {
      pageNumber += 1
      return Promise.resolve({
        nextPageToken: `page_${pageNumber.toString()}`,
        projects: [project(`project_${pageNumber.toString()}`)]
      })
    })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { list } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.list('pho_org_00000000000000000000000001', {}, { limit: 101 })
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned too many project pagination pages.'
    })
    expect(list).toHaveBeenCalledTimes(100)
  })

  test('reuses one idempotency key across the post-401 retry', async () => {
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'createProject',
      status: 401
    })
    const create = vi
      .fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(project('pho_prj_00000000000000000000000001'))
    const { request, tokenManager } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { create } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.create(
        'pho_org_00000000000000000000000001',
        'Alpha',
        'test-project'
      )
    ).resolves.toMatchObject({
      projectId: 'pho_prj_00000000000000000000000001'
    })
    expect(create).toHaveBeenCalledTimes(2)
    const firstKey = create.mock.calls[0]?.[0].headers.idempotencyKey
    const secondKey = create.mock.calls[1]?.[0].headers.idempotencyKey
    expect(firstKey).toEqual(expect.any(String))
    expect(secondKey).toBe(firstKey)
    expect(tokenManager.refreshAfterUnauthorized).toHaveBeenCalledOnce()
  })

  test('preserves a caller-supplied idempotency key across the post-401 retry', async () => {
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'createProject',
      status: 401
    })
    const create = vi
      .fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(project('pho_prj_00000000000000000000000001'))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { create } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.create(
        'pho_org_00000000000000000000000001',
        'Alpha',
        'test-project',
        'automation-create-alpha'
      )
    ).resolves.toMatchObject({
      projectId: 'pho_prj_00000000000000000000000001'
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0].headers.idempotencyKey).toBe(
      'automation-create-alpha'
    )
    expect(create.mock.calls[1]?.[0].headers.idempotencyKey).toBe(
      'automation-create-alpha'
    )
  })

  test('starts SMS provisioning once and reuses its key after 401', async () => {
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'purchaseSmsNumber',
      status: 401
    })
    const purchaseSmsNumber = vi
      .fn()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(rawResponse(resourceOperation('pending'), '2'))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: resourceOperation('succeeded'),
        resource: platformResource(1)
      })
    )
    const { request, tokenManager } = createRequest()
    const clock = instantPollClock()
    const accepted = vi.fn(() => Promise.resolve())
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { purchaseSmsNumber }
      }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.purchaseSmsNumber(
        'pho_prj_00000000000000000000000001',
        { countryCode: 'US' },
        'sms-purchase-key',
        accepted
      )
    ).resolves.toMatchObject({ resource: { resourceId: 'resource_1' } })
    expect(purchaseSmsNumber).toHaveBeenCalledTimes(2)
    expect(purchaseSmsNumber.mock.calls[0]?.[0]).toEqual({
      body: { countryCode: 'US' },
      headers: { idempotencyKey: 'sms-purchase-key' },
      path: { id: 'pho_prj_00000000000000000000000001' }
    })
    expect(purchaseSmsNumber.mock.calls[1]?.[0]).toEqual(
      purchaseSmsNumber.mock.calls[0]?.[0]
    )
    expect(getOperation).toHaveBeenCalledOnce()
    expect(accepted).toHaveBeenCalledWith('remote_operation_1')
    expect(clock.sleeps).toEqual([2000])
    expect(tokenManager.refreshAfterUnauthorized).toHaveBeenCalledOnce()
  })

  test('polls Operations without repeating the SMS purchase', async () => {
    const purchaseSmsNumber = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('pending'), '3'))
    )
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: resourceOperation('running') })
      .mockResolvedValueOnce({
        operation: resourceOperation('succeeded'),
        resource: platformResource(1)
      })
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { purchaseSmsNumber }
      }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.purchaseSmsNumber(
        'pho_prj_00000000000000000000000001',
        { countryCode: 'US' },
        'pending-purchase'
      )
    ).resolves.toEqual({
      operation: resourceOperation('succeeded'),
      resource: platformResource(1)
    })
    expect(clock.sleeps).toEqual([3000, 3000])
    expect(purchaseSmsNumber).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledTimes(2)
  })

  test('polls every ten seconds until email DNS instructions exist', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          resourceOperation('pending', 'email_operation_1', 'email_domain'),
          '60'
        )
      )
    )
    const operation = {
      ...resourceOperation('running', 'email_operation_1', 'email_domain'),
      detail: {
        automaticSetup: emailAutomaticSetup,
        dnsRecords: emailDnsRecords
      }
    }
    const getOperation = vi.fn(() => Promise.resolve({ operation }))
    const { request } = createRequest()
    const clock = instantPollClock()
    const accepted = vi.fn(() => Promise.resolve())
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { connectEmailDomain }
      }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com',
        'email-connect-key',
        accepted
      )
    ).resolves.toEqual({
      automaticSetup: emailAutomaticSetup,
      dnsRecords: emailDnsRecords,
      response: { operation }
    })
    expect(connectEmailDomain).toHaveBeenCalledWith(
      {
        body: { domain: 'example.com' },
        headers: { idempotencyKey: 'email-connect-key' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(accepted).toHaveBeenCalledWith('email_operation_1')
    expect(clock.sleeps).toEqual([10_000])
    expect(getOperation).toHaveBeenCalledOnce()
  })

  test('reads email DNS instructions without polling', async () => {
    const operation = {
      ...resourceOperation('running', 'email_operation_1', 'email_domain'),
      detail: {
        automaticSetup: emailAutomaticSetup,
        dnsRecords: emailDnsRecords,
        verification: emailVerification
      }
    }
    const getOperation = vi.fn(() => Promise.resolve({ operation }))
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.getEmailDomainDnsRecords(
        'pho_prj_00000000000000000000000001',
        'email_operation_1'
      )
    ).resolves.toEqual({
      automaticSetup: emailAutomaticSetup,
      dnsRecords: emailDnsRecords,
      response: { operation },
      verification: emailVerification
    })
    expect(clock.sleeps).toEqual([])
    expect(getOperation).toHaveBeenCalledOnce()
  })

  test('polls every ten seconds until an email domain is verified', async () => {
    const runningOperation = {
      ...resourceOperation('running', 'email_operation_1', 'email_domain'),
      detail: { dnsRecords: emailDnsRecords }
    }
    const succeededOperation = {
      ...runningOperation,
      state: 'succeeded'
    }
    const resource = platformResource(1, ['email'], 'email_domain')
    const getOperation = vi
      .fn()
      .mockResolvedValueOnce({ operation: runningOperation })
      .mockResolvedValueOnce({ operation: succeededOperation, resource })
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.waitForEmailDomainVerification(
        'pho_prj_00000000000000000000000001',
        'email_operation_1'
      )
    ).resolves.toEqual({
      dnsRecords: emailDnsRecords,
      response: { operation: succeededOperation, resource }
    })
    expect(clock.sleeps).toEqual([10_000])
    expect(getOperation).toHaveBeenCalledTimes(2)
  })

  test('rejects an accepted email-domain connect that is an SMS number purchase', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse(resourceOperation('pending', 'email_operation_1'))
      )
    )
    const getOperation = vi.fn()
    const { request } = createRequest()
    const service = new ProjectService({
      clock: instantPollClock(),
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { connectEmailDomain } }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned an invalid email-domain operation.',
      remoteOperationId: 'email_operation_1'
    })
    expect(getOperation).not.toHaveBeenCalled()
  })

  test.each([
    {
      kind: 'an SMS number purchase',
      polled: resourceOperation('running', 'email_operation_1')
    },
    {
      kind: 'an email-domain removal',
      polled: {
        ...resourceOperation('running', 'email_operation_1', 'email_domain'),
        type: 'resource.release'
      }
    }
  ])('rejects an email-domain poll that returns $kind', async ({ polled }) => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          resourceOperation('pending', 'email_operation_1', 'email_domain')
        )
      )
    )
    const getOperation = vi.fn(() => Promise.resolve({ operation: polled }))
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { connectEmailDomain } }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned an invalid email-domain operation.',
      remoteOperationId: 'email_operation_1'
    })
    expect(clock.sleeps).toEqual([5000])
    expect(getOperation).toHaveBeenCalledOnce()
  })

  test('rejects an accepted email-domain connect that is a removal', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse({
          ...resourceOperation('pending', 'email_operation_1', 'email_domain'),
          type: 'resource.release'
        })
      )
    )
    const getOperation = vi.fn()
    const { request } = createRequest()
    const service = new ProjectService({
      clock: instantPollClock(),
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { connectEmailDomain } }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      message: 'Photon returned an invalid email-domain operation.',
      remoteOperationId: 'email_operation_1'
    })
    expect(getOperation).not.toHaveBeenCalled()
  })

  const smsNumberPurchase = resourceOperation('running', 'email_operation_1')
  const emailDomainRemoval = {
    ...resourceOperation('running', 'email_operation_1', 'email_domain'),
    type: 'resource.release'
  }
  const waitForVerification = (service: ProjectService) =>
    service.waitForEmailDomainVerification(
      'pho_prj_00000000000000000000000001',
      'email_operation_1'
    )
  const resumeConnect = (service: ProjectService) =>
    service.resumeEmailDomainConnection(
      'pho_prj_00000000000000000000000001',
      'email_operation_1'
    )

  test.each([
    {
      kind: 'an SMS number purchase',
      name: 'waiting for verification',
      operation: smsNumberPurchase,
      read: waitForVerification
    },
    {
      kind: 'an SMS number purchase',
      name: 'resuming a connect',
      operation: smsNumberPurchase,
      read: resumeConnect
    },
    {
      kind: 'an email-domain removal',
      name: 'waiting for verification',
      operation: emailDomainRemoval,
      read: waitForVerification
    },
    {
      kind: 'an email-domain removal',
      name: 'resuming a connect',
      operation: emailDomainRemoval,
      read: resumeConnect
    }
  ])(
    'rejects an email-domain operation that reads back as $kind when $name',
    async ({ operation, read }) => {
      const getOperation = vi.fn(() => Promise.resolve({ operation }))
      const { request } = createRequest()
      const clock = instantPollClock()
      const service = new ProjectService({
        clock,
        organizationScope: asOrganizationScope(),
        request,
        scope: asProjectScope({ platforms: { getOperation } })
      })

      await expect(read(service)).rejects.toMatchObject({
        code: 'PROJECT_PROTOCOL_ERROR',
        message: 'Photon returned an invalid email-domain operation.',
        remoteOperationId: 'email_operation_1'
      })
      expect(clock.sleeps).toEqual([])
      expect(getOperation).toHaveBeenCalledOnce()
    }
  )

  test('rejects malformed email DNS instructions as a protocol error', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse({
          ...resourceOperation('running', 'email_operation_1', 'email_domain'),
          detail: { dnsRecords: [{ type: 'TXT' }] }
        })
      )
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { connectEmailDomain }
      }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      remoteOperationId: 'email_operation_1'
    })
  })

  test('rejects unsafe automatic DNS setup as a protocol error', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse({
          ...resourceOperation('running', 'email_operation_1', 'email_domain'),
          detail: {
            automaticSetup: {
              ...emailAutomaticSetup,
              applyUrl: 'http://connect.provider.example/apply?sig=signed'
            },
            dnsRecords: emailDnsRecords
          }
        })
      )
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { connectEmailDomain }
      }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      remoteOperationId: 'email_operation_1'
    })
  })

  test('keeps control characters in automatic DNS setup URLs as the API sent them', async () => {
    const connectEmailDomain = vi.fn(() =>
      Promise.resolve(
        rawResponse({
          ...resourceOperation('running', 'email_operation_1', 'email_domain'),
          detail: {
            automaticSetup: {
              ...emailAutomaticSetup,
              applyUrl:
                'https://connect.provider.example/apply?sig=signed\ninjected'
            },
            dnsRecords: emailDnsRecords
          }
        })
      )
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { connectEmailDomain }
      }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.connectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'example.com'
      )
    ).resolves.toMatchObject({
      automaticSetup: {
        applyUrl: 'https://connect.provider.example/apply?sig=signed\ninjected'
      }
    })
  })

  test('uses a five-second fallback for an invalid Retry-After header', async () => {
    const purchaseSmsNumber = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('pending'), 'tomorrow'))
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: resourceOperation('succeeded'),
        resource: platformResource(1)
      })
    )
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { purchaseSmsNumber }
      }),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await service.purchaseSmsNumber(
      'pho_prj_00000000000000000000000001',
      { countryCode: 'US' },
      'fallback-retry-after'
    )
    expect(clock.sleeps).toEqual([5000])
  })

  test.each([
    {
      expectedCode: 'RESOURCE_PROVIDER_REJECTED',
      operation: {
        ...resourceOperation('failed'),
        error: {
          code: 'RESOURCE_PROVIDER_REJECTED',
          detail: 'The provider rejected the resource request.'
        }
      }
    },
    {
      expectedCode: 'PROJECT_OPERATION_CANCELLED',
      operation: resourceOperation('cancelled')
    },
    {
      expectedCode: 'PROJECT_PROTOCOL_ERROR',
      operation: resourceOperation('future-state')
    }
  ])(
    'maps terminal resource operation state to $expectedCode',
    async ({ expectedCode, operation }) => {
      const { request } = createRequest()
      const service = new ProjectService({
        organizationScope: asOrganizationScope(),
        request,
        scope: asProjectScope({
          platforms: { getOperation: () => Promise.resolve({ operation }) }
        })
      })

      await expect(
        service.resumeResourceProvisioning(
          'pho_prj_00000000000000000000000001',
          operation.operationId,
          'sms'
        )
      ).rejects.toMatchObject({
        code: expectedCode,
        remoteOperationId: operation.operationId
      })
    }
  )

  test('requires a successful operation to include the requested resource', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: resourceOperation('succeeded') })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.resumeResourceProvisioning(
        'pho_prj_00000000000000000000000001',
        'remote_operation_1',
        'sms'
      )
    ).rejects.toMatchObject({
      code: 'PROJECT_PROTOCOL_ERROR',
      remoteOperationId: 'remote_operation_1'
    })
    expect(getOperation).toHaveBeenCalledTimes(2)
  })

  test('requires the final resource to have the requested ability', async () => {
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: resourceOperation('succeeded'),
        resource: platformResource(1, ['pstn_voice'])
      })
    )
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ platforms: { getOperation } })
    })

    await expect(
      service.resumeResourceProvisioning(
        'pho_prj_00000000000000000000000001',
        'remote_operation_1',
        'sms'
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
  })

  test('verifies SMS ability and polls a generic resource release', async () => {
    const getResource = vi.fn(() => Promise.resolve(platformResource(1)))
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          releaseOperation(
            'pending',
            'remote_operation_1',
            platformResource(1)
          ),
          '4'
        )
      )
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: releaseOperation(
          'succeeded',
          'remote_operation_1',
          platformResource(1)
        )
      })
    )
    const { request } = createRequest()
    const clock = instantPollClock()
    const accepted = vi.fn(() => Promise.resolve())
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { releaseResource } }),
      request,
      scope: asProjectScope({ platforms: { getOperation, getResource } })
    })

    await expect(
      service.releaseSmsNumber(
        'pho_prj_00000000000000000000000001',
        'resource_1',
        accepted
      )
    ).resolves.toEqual({
      operation: releaseOperation(
        'succeeded',
        'remote_operation_1',
        platformResource(1)
      )
    })
    expect(getResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'resource_1'
        }
      },
      undefined
    )
    expect(releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'resource_1'
        }
      },
      undefined
    )
    expect(accepted).toHaveBeenCalledWith('remote_operation_1')
    expect(clock.sleeps).toEqual([4000])
  })

  test('validates and disconnects an email-domain resource', async () => {
    const emailResource = platformResource(1, ['email'], 'email_domain')
    const getResource = vi.fn(() => Promise.resolve(emailResource))
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(
          releaseOperation('pending', 'email_release_1', emailResource),
          '60'
        )
      )
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: releaseOperation(
          'succeeded',
          'email_release_1',
          emailResource
        )
      })
    )
    const { request } = createRequest()
    const clock = instantPollClock()
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { releaseResource } }),
      request,
      scope: asProjectScope({ platforms: { getOperation, getResource } })
    })

    await expect(
      service.disconnectEmailDomain(
        'pho_prj_00000000000000000000000001',
        'resource_1'
      )
    ).resolves.toEqual({
      operation: releaseOperation('succeeded', 'email_release_1', emailResource)
    })
    expect(releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'resource_1'
        }
      },
      undefined
    )
    expect(clock.sleeps).toEqual([10_000])
  })

  test.each([
    {
      code: 'NUMBER_NOT_FOUND',
      expectedCode: 'NUMBER_NOT_FOUND',
      retryable: false,
      status: 404
    },
    {
      code: 'NUMBER_RELEASE_FAILED',
      expectedCode: 'NUMBER_RELEASE_FAILED',
      retryable: true,
      status: 502
    }
  ])(
    'normalizes SMS release error $code',
    async ({ code, expectedCode, retryable, status }) => {
      const releaseResource = vi.fn(() =>
        Promise.reject(
          new ApiError('SMS release failed', {
            body: { code, detail: 'Safe SMS release failure detail.' },
            headers: new Headers(),
            operationId: 'releaseSmsNumber',
            requestId: 'request_sms_release_failure',
            status
          })
        )
      )
      const { request } = createRequest()
      const service = new ProjectService({
        organizationScope: asOrganizationScope(),
        rawScope: asProjectRawScope({ platforms: { releaseResource } }),
        request,
        scope: asProjectScope({
          platforms: {
            getResource: () => Promise.resolve(platformResource(1))
          }
        })
      })

      await expect(
        service.releaseSmsNumber(
          'pho_prj_00000000000000000000000001',
          'resource_1'
        )
      ).rejects.toMatchObject({
        code: expectedCode,
        detail: undefined,
        httpStatus: status,
        message: 'Safe SMS release failure detail.',
        requestId: 'request_sms_release_failure',
        retryable
      })
    }
  )

  test.each([
    {
      code: 'CHARGE_REJECTED',
      expectedCode: 'CHARGE_REJECTED',
      retryable: false,
      status: 402
    },
    {
      code: 'NUMBER_LIMIT_REACHED',
      expectedCode: 'NUMBER_LIMIT_REACHED',
      retryable: false,
      status: 409
    },
    {
      code: 'RATE_LIMITED',
      expectedCode: 'RATE_LIMITED',
      retryable: true,
      status: 429
    },
    {
      code: 'NUMBER_ORDER_FAILED',
      expectedCode: 'NUMBER_ORDER_FAILED',
      retryable: true,
      status: 502
    },
    {
      code: 'NUMBER_INVENTORY_EXHAUSTED',
      expectedCode: 'NUMBER_INVENTORY_EXHAUSTED',
      retryable: true,
      status: 503
    }
  ])(
    'normalizes SMS purchase error $code',
    async ({ code, expectedCode, retryable, status }) => {
      const purchaseSmsNumber = vi.fn(() =>
        Promise.reject(
          new ApiError('SMS purchase failed', {
            body: {
              code,
              detail: 'Safe SMS purchase failure detail.'
            },
            headers: new Headers({ 'retry-after': '9' }),
            operationId: 'purchaseSmsNumber',
            requestId: 'request_sms_failure',
            status
          })
        )
      )
      const { request } = createRequest()
      const service = new ProjectService({
        organizationScope: asOrganizationScope(),
        rawScope: asProjectRawScope({
          platforms: { purchaseSmsNumber }
        }),
        request,
        scope: asProjectScope({})
      })

      await expect(
        service.purchaseSmsNumber(
          'pho_prj_00000000000000000000000001',
          { countryCode: 'US' },
          'sms-error-key'
        )
      ).rejects.toMatchObject({
        code: expectedCode,
        detail: undefined,
        httpStatus: status,
        message: 'Safe SMS purchase failure detail.',
        requestId: 'request_sms_failure',
        retryAfterSeconds: 9,
        retryable
      })
    }
  )

  test('throws the cancellation, not a connection error, once the command is cancelled', async () => {
    const controller = new AbortController()
    const cancelled = new Error('cancelled')
    const getOverview = vi.fn(() => {
      controller.abort(cancelled)
      return Promise.reject(new TransportError('request aborted'))
    })
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ billing: { getOverview } }),
      signal: controller.signal
    })

    await expect(
      service.getBillingOverview('pho_prj_00000000000000000000000001')
    ).rejects.toBe(cancelled)
  })

  test.each([
    {
      error: new ResponseValidationError('purchaseSmsNumber', [], {
        status: 200
      }),
      expectedCode: 'API_PROTOCOL_ERROR',
      retryable: false,
      transportCode: undefined
    },
    {
      error: new TransportError('connection interrupted', {
        operationId: 'purchaseSmsNumber'
      }),
      expectedCode: 'API_CONNECTION_ERROR',
      retryable: true,
      transportCode: 'TransportError'
    }
  ])(
    'normalizes malformed or interrupted SMS purchase responses as $expectedCode',
    async ({ error, expectedCode, retryable, transportCode }) => {
      const purchaseSmsNumber = vi.fn(() => Promise.reject(error))
      const { request } = createRequest()
      const service = new ProjectService({
        organizationScope: asOrganizationScope(),
        rawScope: asProjectRawScope({
          platforms: { purchaseSmsNumber }
        }),
        request,
        scope: asProjectScope({})
      })

      await expect(
        service.purchaseSmsNumber(
          'pho_prj_00000000000000000000000001',
          { countryCode: 'US' },
          'sms-ambiguous-key'
        )
      ).rejects.toMatchObject({
        code: expectedCode,
        retryable,
        ...(transportCode === undefined ? {} : { transportCode })
      })
    }
  )

  test('maps statuses consistently and preserves safe problem codes', async () => {
    const forbidden = new ApiError('forbidden', {
      body: { title: 'Access denied.' },
      headers: new Headers(),
      operationId: 'getProject',
      requestId: 'request_1',
      status: 403
    })
    const get = vi.fn(() => Promise.reject(forbidden))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ get })
    })

    await expect(
      service.get('pho_prj_00000000000000000000000001')
    ).rejects.toMatchObject({
      code: 'API_ERROR',
      httpStatus: 403,
      message: 'Access denied.',
      requestId: 'request_1'
    })

    const coded = new ApiError('missing', {
      body: { code: 'ASSIGNMENT_NOT_FOUND', title: 'Assignment not found.' },
      headers: new Headers(),
      operationId: 'getProject',
      status: 404
    })
    get.mockRejectedValueOnce(coded)
    await expect(
      service.get('pho_prj_00000000000000000000000001')
    ).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      httpStatus: 404,
      message: 'Assignment not found.'
    })

    const conflict = new ApiError('conflict', {
      body: { code: 'PROJECT_CONFLICT', title: 'Project conflict.' },
      headers: new Headers(),
      operationId: 'getProject',
      status: 409
    })
    get.mockRejectedValueOnce(conflict)
    await expect(
      service.get('pho_prj_00000000000000000000000001')
    ).rejects.toMatchObject({
      code: 'PROJECT_CONFLICT',
      message: 'Project conflict.'
    })
  })

  test('extracts only validated problem details and HTTP diagnostics', async () => {
    const unavailable = new ApiError('unavailable', {
      body: {
        code: 'PROJECTS_UNAVAILABLE',
        detail: 'A project dependency is unavailable.',
        issues: [
          {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'The project index is rebuilding.',
            path: ['projectId']
          }
        ],
        remediation: ['Run an untrusted upstream shell command.'],
        title: 'Project service unavailable',
        type: 'https://api.photon.test/problems/projects-unavailable'
      },
      headers: new Headers({ 'retry-after': '7' }),
      operationId: 'getProject',
      requestId: 'request_problem_1',
      status: 503
    })
    const get = vi.fn(() => Promise.reject(unavailable))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({ get })
    })

    const error = await service
      .get('pho_prj_00000000000000000000000001')
      .catch((caught) => caught)
    expect(error).toMatchObject({
      code: 'PROJECTS_UNAVAILABLE',
      httpStatus: 503,
      issues: [
        {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'The project index is rebuilding.',
          path: ['projectId']
        }
      ],
      message: 'A project dependency is unavailable.',
      problemType: 'https://api.photon.test/problems/projects-unavailable',
      requestId: 'request_problem_1',
      retryAfterSeconds: 7,
      retryable: true
    })
    expect((error as CliError).next).toEqual([])
  })

  test('preserves deterministic upstream-unavailable 503 responses', async () => {
    const upstreamUnavailable = new ApiError('upstream unavailable', {
      body: {
        code: 'UPSTREAM_UNAVAILABLE',
        detail: 'The staging project dependency rejected this request.'
      },
      headers: new Headers(),
      operationId: 'createProject',
      requestId: 'request_upstream_1',
      status: 503
    })
    const create = vi.fn(() => Promise.reject(upstreamUnavailable))
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope({ projects: { create } }),
      request,
      scope: asProjectScope({})
    })

    await expect(
      service.create(
        'pho_org_00000000000000000000000001',
        'Staging',
        'test-project'
      )
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      httpStatus: 503,
      message: 'The staging project dependency rejected this request.',
      requestId: 'request_upstream_1',
      retryable: false
    })
  })

  test('does not commit an avatar after storage upload failure', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'avatar.webp')
    await writeFile(
      avatarFile,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    const commitAvatar = vi.fn()
    const scope = asProjectScope({
      agentProfile: {
        commitAvatar,
        createAvatarUpload: vi.fn(() =>
          Promise.resolve({
            expiresAt: timestamp,
            formFields: { key: 'avatar' },
            uploadId: 'upload_1',
            uploadUrl: 'https://storage.example.test/upload'
          })
        )
      }
    })
    const { request } = createRequest()
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 500 }))
    )
    const service = new ProjectService({
      fetch,
      organizationScope: asOrganizationScope(),
      request,
      scope
    })

    await expect(
      service.uploadAgentAvatar(
        'pho_prj_00000000000000000000000001',
        avatarFile
      )
    ).rejects.toMatchObject({ code: 'AVATAR_UPLOAD_FAILED' })
    expect(commitAvatar).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('rejects oversized avatars before reading or starting an upload', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'oversized.webp')
    await writeFile(
      avatarFile,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    await truncate(avatarFile, MAXIMUM_AVATAR_BYTES + 1)
    const createAvatarUpload = vi.fn()
    const { request } = createRequest()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request,
      scope: asProjectScope({
        agentProfile: { createAvatarUpload }
      })
    })

    await expect(
      service.uploadAgentAvatar(
        'pho_prj_00000000000000000000000001',
        avatarFile
      )
    ).rejects.toMatchObject({
      code: 'AVATAR_FILE_INVALID',
      message: 'Avatar file cannot exceed 5 MiB.'
    })
    expect(createAvatarUpload).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('rejects insecure avatar upload URLs before fetching storage', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'avatar.webp')
    await writeFile(
      avatarFile,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    const scope = asProjectScope({
      agentProfile: {
        createAvatarUpload: () =>
          Promise.resolve({
            expiresAt: timestamp,
            formFields: {},
            uploadId: 'upload_1',
            uploadUrl: 'http://storage.example.test/upload'
          })
      }
    })
    const { request } = createRequest()
    const fetch = vi.fn()
    const service = new ProjectService({
      fetch,
      organizationScope: asOrganizationScope(),
      request,
      scope
    })

    await expect(
      service.uploadAgentAvatar(
        'pho_prj_00000000000000000000000001',
        avatarFile
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('times out stalled avatar storage uploads', async () => {
    const authenticated = await createAuthenticatedConfig()
    const avatarFile = join(authenticated.configDirectory, 'avatar.webp')
    await writeFile(
      avatarFile,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    const scope = asProjectScope({
      agentProfile: {
        createAvatarUpload: () =>
          Promise.resolve({
            expiresAt: timestamp,
            formFields: {},
            uploadId: 'upload_1',
            uploadUrl: 'https://storage.example.test/upload'
          })
      }
    })
    const { request } = createRequest()
    const fetch = vi.fn(
      (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          )
        })
    )
    const service = new ProjectService({
      fetch,
      organizationScope: asOrganizationScope(),
      request,
      scope,
      timeoutMs: 1
    })

    await expect(
      service.uploadAgentAvatar(
        'pho_prj_00000000000000000000000001',
        avatarFile
      )
    ).rejects.toMatchObject({ code: 'AVATAR_UPLOAD_FAILED' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
