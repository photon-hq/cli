import { writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { DeviceTokenOutput } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  ONLY_ORGANIZATION_LINE,
  TEST_NOW
} from './project-test-support.ts'

interface CapturedRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string
  pathname: string
  searchParams: URLSearchParams
}

const servers: ReturnType<typeof createServer>[] = []
const timestamp = '2026-07-31T18:00:00.000Z'
const billingOperationId =
  'pho_bop_0000000000000000000000000000000000000000000000000000000000000001'
const cancellableOperationId = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const smsOperationId = 'pho_opr_00000000000000000000000001'
const imessageOperationId = 'pho_opr_00000000000000000000000003'
const releaseOperationId = 'pho_opr_00000000000000000000000002'
const periodEnd = '2026-08-31T18:00:00.000Z'

const billingPlan = (planCode: string, isDefault: boolean) => ({
  baseAmountCents: isDefault ? 0 : 25_000,
  currency: 'USD',
  description: null,
  entitlements: [],
  fixedCharges: [],
  interval: 'monthly',
  isDefault,
  minimumCommitment: null,
  name: planCode === 'free' ? 'Free' : 'Business',
  payInAdvance: true,
  planCode,
  tier: null,
  tierDisplayName: null,
  usageCharges: [],
  usageThresholds: []
})

const refreshedGrant: DeviceTokenOutput = {
  access_token: 'rotated-project-access-token',
  expires_in: 3600,
  refresh_token: 'rotated-project-refresh-token',
  user: {
    email: 'user_ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const refreshingDeviceScope: DeviceAuthScope = {
  authorize: () => Promise.reject(new Error('authorize should not be called')),
  token: () => Promise.resolve(refreshedGrant)
}

const project = (projectId: string, name = projectId) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/avatar.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  createdByAccountId: 'user_ada',
  createdByActorId: 'user_ada',
  createdByActorKind: 'account',
  deletedAt: null,
  flags: [],
  futureField: 'from-a-newer-api',
  name,
  organizationId: 'pho_org_00000000000000000000000001',
  projectId,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  updatedAt: timestamp
})

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

const resourceOperation = (
  operationId: string,
  resourceType: string,
  state: string,
  type: 'resource.provision' | 'resource.release' = 'resource.provision'
) => ({
  cancellable: resourceType === 'cosmos_line',
  createdAt: timestamp,
  operationId,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType,
  startedAt: timestamp,
  state,
  type,
  updatedAt: timestamp
})

const platform = {
  description: 'Text messages over a project-owned phone number.',
  displayName: 'SMS',
  type: 'sms'
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
    'x-request-id': 'request_project_integration'
  })
  response.end(JSON.stringify(body))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
    )
  )
})

describe('generated project SDK integration', () => {
  test('uses SDK wire shapes for CRUD, pagination, organization billing, and upload', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const captured: CapturedRequest[] = []
    const billingOperationStatuses: string[] = []
    let billingOperationPolls = 0
    let createAttempts = 0
    let origin = ''
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', origin)
      const method = request.method ?? 'GET'
      const capturedRequest: CapturedRequest = {
        body: '',
        headers: request.headers,
        method,
        pathname: url.pathname,
        searchParams: new URLSearchParams(url.searchParams)
      }
      captured.push(capturedRequest)
      const body = await readBody(request)
      capturedRequest.body = body

      if (url.pathname === '/storage/avatar' && method === 'POST') {
        response.writeHead(204)
        response.end()
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms' &&
        method === 'GET'
      ) {
        writeJson(response, { platforms: [platform] })
        return
      }
      if (url.pathname === '/v1/organizations' && method === 'GET') {
        writeJson(response, {
          acquisitionQuestionnaireExempt: false,
          organizations: [
            {
              avatarUrl: null,
              createdAt: timestamp,
              name: 'Acme',
              organizationId: 'pho_org_00000000000000000000000001',
              updatedAt: timestamp,
              version: '1'
            }
          ],
          ownedOrganizationIds: ['pho_org_00000000000000000000000001']
        })
        return
      }
      if (
        url.pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/projects' &&
        method === 'GET'
      ) {
        if (url.searchParams.get('pageToken') === 'page_2') {
          writeJson(response, {
            projects: [project('pho_prj_00000000000000000000000003')]
          })
          return
        }
        writeJson(response, {
          nextPageToken: 'page_2',
          projects: [
            project('pho_prj_00000000000000000000000001'),
            project('pho_prj_00000000000000000000000002')
          ]
        })
        return
      }
      if (
        url.pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/projects' &&
        method === 'POST'
      ) {
        createAttempts += 1
        if (createAttempts === 1) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 'UNAUTHORIZED' }))
          return
        }
        writeJson(
          response,
          project('pho_prj_00000000000000000000000108', 'Created Project'),
          201
        )
        return
      }
      if (
        url.pathname === '/v1/projects/pho_prj_00000000000000000000000001' &&
        method === 'PATCH'
      ) {
        writeJson(
          response,
          project('pho_prj_00000000000000000000000001', 'Renamed Project')
        )
        return
      }
      if (
        url.pathname === '/v1/projects/pho_prj_00000000000000000000000001' &&
        method === 'DELETE'
      ) {
        writeJson(response, {
          ...project('pho_prj_00000000000000000000000001'),
          deletedAt: timestamp
        })
        return
      }
      if (
        url.pathname === '/v1/projects/pho_prj_00000000000000000000000001' &&
        method === 'GET'
      ) {
        writeJson(
          response,
          project('pho_prj_00000000000000000000000001', 'Alpha Project')
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/billing' &&
        method === 'GET'
      ) {
        writeJson(response, {
          entitlementsVersion: 1,
          subscriptions: [
            {
              baseAmountCents: 25_000,
              cancelsAt: null,
              category: 'platforms',
              currency: 'USD',
              currentPeriodEnd: periodEnd,
              entitlements: [
                {
                  featureKey: 'imessage_shared_lines.max_user_assignments',
                  value: '5'
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
              displayName: 'iMessage messages',
              metricCode: 'imessage_message',
              units: 10
            }
          ]
        })
        return
      }
      if (
        url.pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/billing/invoices' &&
        method === 'GET'
      ) {
        writeJson(response, {
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
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/billing/plans' &&
        method === 'GET'
      ) {
        writeJson(response, {
          plans: {
            platforms: [
              billingPlan('free', true),
              billingPlan('business', false)
            ]
          }
        })
        return
      }
      if (
        url.pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/terms' &&
        method === 'GET'
      ) {
        writeJson(response, {
          subscriptions: [
            {
              cancelsAt: null,
              category: 'platforms',
              currentPeriodEnd: periodEnd,
              currentPeriodStart: timestamp,
              nextBillingAt: periodEnd,
              paymentMode: 'automatic',
              plan: billingPlan('business', false),
              planSource: 'catalog',
              scheduledPlanChange: { effectiveAt: periodEnd, planCode: 'free' }
            }
          ],
          timeZone: 'UTC'
        })
        return
      }
      if (
        url.pathname ===
          `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}` &&
        method === 'GET'
      ) {
        billingOperationPolls += 1
        const pending = billingOperationPolls === 1
        const status = pending ? 'pending' : 'succeeded'
        billingOperationStatuses.push(status)
        writeJson(response, {
          failure: null,
          kind: 'change_plan',
          operationId: billingOperationId,
          paymentAction: null,
          resolvedAt: pending ? null : timestamp,
          result: pending
            ? null
            : { effectiveAt: periodEnd, type: 'version', version: 'version_1' },
          status,
          submittedAt: timestamp
        })
        return
      }
      if (
        url.pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/purchase' &&
        method === 'POST'
      ) {
        billingOperationStatuses.push('pending')
        writeJson(
          response,
          {
            failure: null,
            kind: 'change_plan',
            operationId: billingOperationId,
            paymentAction: null,
            resolvedAt: null,
            result: null,
            status: 'pending',
            submittedAt: timestamp
          },
          202
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources' &&
        method === 'GET'
      ) {
        writeJson(response, {
          resources:
            url.searchParams.get('ability') === 'imessage'
              ? [imessageResource]
              : [smsResource]
        })
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/operations' &&
        method === 'GET'
      ) {
        writeJson(response, {
          operations: [
            resourceOperation(smsOperationId, 'voip_line', 'running'),
            resourceOperation(imessageOperationId, 'cosmos_line', 'pending')
          ]
        })
        return
      }
      if (
        url.pathname ===
          `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${cancellableOperationId}/cancel` &&
        method === 'POST'
      ) {
        writeJson(
          response,
          resourceOperation(cancellableOperationId, 'cosmos_line', 'cancelled')
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/sms/numbers' &&
        method === 'POST'
      ) {
        writeJson(
          response,
          resourceOperation(smsOperationId, 'voip_line', 'pending'),
          202,
          {
            location: `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${smsOperationId}`,
            'retry-after': '2'
          }
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/imessage/dedicated' &&
        method === 'POST'
      ) {
        writeJson(
          response,
          resourceOperation(imessageOperationId, 'cosmos_line', 'pending'),
          202,
          {
            location: `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${imessageOperationId}`,
            'retry-after': '5'
          }
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources/pho_res_00000000000000000000000001' &&
        method === 'GET'
      ) {
        writeJson(response, smsResource)
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources/pho_res_00000000000000000000000001' &&
        method === 'DELETE'
      ) {
        writeJson(
          response,
          {
            ...resourceOperation(
              releaseOperationId,
              'voip_line',
              'pending',
              'resource.release'
            ),
            resourceId: smsResource.resourceId
          },
          202,
          {
            location: `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${releaseOperationId}`,
            'retry-after': '2'
          }
        )
        return
      }
      if (
        url.pathname.startsWith(
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/'
        ) &&
        method === 'GET'
      ) {
        const operationId = url.pathname.split('/').at(-1)
        if (operationId === smsOperationId) {
          writeJson(response, {
            operation: resourceOperation(
              smsOperationId,
              'voip_line',
              'succeeded'
            ),
            resource: smsResource
          })
          return
        }
        if (operationId === imessageOperationId) {
          writeJson(response, {
            operation: resourceOperation(
              imessageOperationId,
              'cosmos_line',
              'succeeded'
            ),
            resource: imessageResource
          })
          return
        }
        if (operationId === releaseOperationId) {
          writeJson(response, {
            operation: {
              ...resourceOperation(
                releaseOperationId,
                'voip_line',
                'succeeded',
                'resource.release'
              ),
              resourceId: smsResource.resourceId
            }
          })
          return
        }
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/agent-profile/avatar/uploads' &&
        method === 'POST'
      ) {
        writeJson(
          response,
          {
            expiresAt: '2026-07-31T18:05:00.000Z',
            formFields: { key: 'avatar/key', policy: 'signed-policy' },
            uploadId: 'upload_1',
            uploadUrl: 'https://storage.example.test/storage/avatar'
          },
          201
        )
        return
      }
      if (
        url.pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/agent-profile/avatar' &&
        method === 'PUT'
      ) {
        writeJson(
          response,
          project('pho_prj_00000000000000000000000001').agentProfile
        )
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'NOT_FOUND' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port.toString()}`
    const authenticated = await createAuthenticatedConfig('user_ada', origin)
    const avatarFile = join(authenticated.configDirectory, 'avatar.png')
    await writeFile(
      avatarFile,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      { mode: 0o600 }
    )

    const integrationFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== 'https://storage.example.test') {
        return await globalThis.fetch(request)
      }
      captured.push({
        body: await request.text(),
        headers: Object.fromEntries(request.headers),
        method: request.method,
        pathname: url.pathname,
        searchParams: new URLSearchParams(url.searchParams)
      })
      return new Response(null, { status: 204 })
    }

    const clock = instantPollClock()
    const invoke = async (
      args: string[],
      expectedStderr = ''
    ): Promise<Record<string, unknown>> => {
      const stdout = collector()
      const stderr = collector()
      await runCli([...args, '--json'], {
        baseUrl: origin,
        clock,
        configDirectory: authenticated.configDirectory,
        deviceScope: refreshingDeviceScope,
        fetch: integrationFetch,
        now: () => TEST_NOW,
        platform: 'linux',
        stderr,
        stdout
      })
      expect(
        stderr.value(),
        JSON.stringify(captured.at(-1), undefined, 2)
      ).toBe(expectedStderr)
      return JSON.parse(stdout.value()) as Record<string, unknown>
    }

    const listed = await invoke(['project', 'list', '--limit', '3'])
    expect(listed).toMatchObject({
      projects: [
        {
          createdByActorKind: 'account',
          futureField: 'from-a-newer-api',
          projectId: 'pho_prj_00000000000000000000000001'
        },
        { projectId: 'pho_prj_00000000000000000000000002' },
        { projectId: 'pho_prj_00000000000000000000000003' }
      ]
    })
    await expect(
      invoke(
        [
          'project',
          'create',
          '--slug',
          'test-project',
          '--name',
          'Created Project'
        ],
        ONLY_ORGANIZATION_LINE
      )
    ).resolves.toMatchObject({
      projectId: 'pho_prj_00000000000000000000000108'
    })
    await expect(
      invoke([
        'project',
        'edit',
        '--name',
        'Renamed Project',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({ name: 'Renamed Project' })
    await expect(
      invoke([
        'project',
        'billing',
        'overview',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      billing: {
        entitlementsVersion: 1,
        subscriptions: [{ category: 'platforms', planCode: 'business' }]
      },
      terms: {
        subscriptions: [
          {
            category: 'platforms',
            scheduledPlanChange: { effectiveAt: periodEnd, planCode: 'free' }
          }
        ],
        timeZone: 'UTC'
      }
    })
    await expect(
      invoke([
        'project',
        'billing',
        'invoice',
        'list',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      invoices: [{ invoiceId: 'invoice_1', kind: 'subscription' }]
    })
    await expect(
      invoke([
        'project',
        'billing',
        'operation',
        'view',
        billingOperationId,
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      operationId: billingOperationId,
      result: {
        effectiveAt: periodEnd,
        type: 'version',
        version: 'version_1'
      },
      status: 'succeeded'
    })
    await expect(
      invoke([
        'project',
        'billing',
        'plan',
        'purchase',
        '--category',
        'platforms',
        '--plan-code',
        'business',
        '--idempotency-key',
        'integration-plan-purchase',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      operationId: billingOperationId,
      result: { type: 'version', version: 'version_1' },
      status: 'succeeded'
    })
    await expect(
      invoke([
        'project',
        'billing',
        'subscription',
        'cancel',
        '--category',
        'platforms',
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      subscription: { cancellationScheduled: true, cancelsAt: periodEnd }
    })
    await expect(
      invoke([
        'project',
        'billing',
        'subscription',
        'resume',
        '--category',
        'platforms',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({ subscription: { resumed: true } })
    await expect(
      invoke([
        'project',
        'platform',
        'list',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toEqual({ platforms: [platform] })
    await expect(
      invoke([
        'project',
        'platform',
        'operation',
        'cancel',
        cancellableOperationId,
        '--yes',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      operationId: cancellableOperationId,
      state: 'cancelled'
    })
    const listedSmsResources = await invoke([
      'project',
      'platform',
      'sms',
      'list',
      '--limit',
      '1',
      '--page-token',
      'sms-start',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(listedSmsResources).toMatchObject({
      provisioning: [
        { operationId: smsOperationId, resourceType: 'voip_line' }
      ],
      resources: [
        { resourceId: 'pho_res_00000000000000000000000001', type: 'voip_line' }
      ]
    })
    expect(JSON.stringify(listedSmsResources)).toContain('from-a-newer-api')
    const listedImessageResources = await invoke([
      'project',
      'platform',
      'imessage',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(listedImessageResources).toMatchObject({
      provisioning: [
        { operationId: imessageOperationId, resourceType: 'cosmos_line' }
      ],
      resources: [
        {
          resourceId: 'pho_res_00000000000000000000000011',
          type: 'cosmos_line'
        }
      ]
    })
    await expect(
      invoke([
        'project',
        'platform',
        'voice',
        'list',
        '--project',
        'pho_prj_00000000000000000000000001'
      ])
    ).resolves.toMatchObject({
      resources: [{ resourceId: 'pho_res_00000000000000000000000001' }]
    })
    const purchasedSmsResource = await invoke([
      'project',
      'platform',
      'sms',
      'purchase',
      '--yes',
      '--idempotency-key',
      'integration-sms-purchase',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(purchasedSmsResource).toMatchObject({
      operation: { state: 'succeeded' },
      resource: { resourceId: 'pho_res_00000000000000000000000001' }
    })
    expect(JSON.stringify(purchasedSmsResource)).toContain('from-a-newer-api')
    const purchasedImessageResource = await invoke([
      'project',
      'platform',
      'imessage',
      'purchase',
      '--yes',
      '--idempotency-key',
      'integration-imessage-purchase',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(purchasedImessageResource).toMatchObject({
      resource: { resourceId: 'pho_res_00000000000000000000000011' }
    })
    const deletedSmsResource = await invoke([
      'project',
      'platform',
      'sms',
      'delete',
      'pho_res_00000000000000000000000001',
      '--yes',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(deletedSmsResource).toMatchObject({
      operation: {
        operationId: 'pho_opr_00000000000000000000000002',
        state: 'succeeded',
        type: 'resource.release'
      }
    })
    expect(clock.sleeps).toContain(2000)
    expect(clock.sleeps).toContain(5000)
    const avatarOutput = await invoke([
      'project',
      'agent-profile',
      'avatar',
      'upload',
      avatarFile,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(avatarOutput).toEqual(
      project('pho_prj_00000000000000000000000001').agentProfile
    )
    expect(JSON.stringify(avatarOutput)).not.toContain('/storage/avatar')
    expect(JSON.stringify(avatarOutput)).not.toContain('signed-policy')
    await expect(
      invoke([
        'project',
        'delete',
        'pho_prj_00000000000000000000000001',
        '--yes'
      ])
    ).resolves.toEqual({
      ...project('pho_prj_00000000000000000000000001'),
      deletedAt: timestamp
    })

    const listRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'GET' &&
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/projects'
    )
    expect(
      listRequests.map(({ searchParams }) => searchParams.get('pageSize'))
    ).toEqual(['3', '1'])
    expect(listRequests[1]?.searchParams.get('pageToken')).toBe('page_2')
    expect(
      captured.filter(({ pathname }) => pathname === '/v1/organizations')
    ).toHaveLength(2)
    expect(
      listRequests.every(
        ({ headers }) => headers['idempotency-key'] === undefined
      )
    ).toBe(true)
    const storageRequest = captured.find(
      ({ pathname }) => pathname === '/storage/avatar'
    )
    expect(storageRequest?.headers.authorization).toBeUndefined()
    expect(storageRequest?.headers['content-type']).toContain(
      'multipart/form-data; boundary='
    )
    expect(storageRequest?.body).toContain('avatar/key')
    expect(storageRequest?.body).toContain('name="file"')

    const apiRequests = captured.filter(
      ({ pathname }) => pathname !== '/storage/avatar'
    )
    expect(
      apiRequests.every(
        ({ headers }) => headers.authorization?.startsWith('Bearer ') === true
      )
    ).toBe(true)
    const createRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/projects'
    )
    expect(createRequests).toHaveLength(2)
    expect(createRequests[0]?.headers.authorization).toBe(
      'Bearer project-access-token'
    )
    expect(createRequests[1]?.headers.authorization).toBe(
      'Bearer rotated-project-access-token'
    )
    expect(createRequests[1]?.headers['idempotency-key']).toBe(
      createRequests[0]?.headers['idempotency-key']
    )
    const resourceListRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'GET' &&
        pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources'
    )
    expect(
      resourceListRequests.map(({ searchParams }) =>
        searchParams.get('ability')
      )
    ).toEqual(['sms', 'imessage', 'pstn_voice'])
    expect(resourceListRequests[0]?.searchParams.get('pageSize')).toBe('1')
    expect(resourceListRequests[0]?.searchParams.get('pageToken')).toBe(
      'sms-start'
    )
    const provisioningListRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'GET' &&
        pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/operations'
    )
    expect(provisioningListRequests).toHaveLength(2)
    expect(
      provisioningListRequests.every(
        ({ searchParams }) =>
          searchParams.get('state') === 'pending,running' &&
          searchParams.get('type') === 'resource.provision' &&
          searchParams.get('pageSize') === '200'
      )
    ).toBe(true)
    const smsPurchaseRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/sms/numbers'
    )
    expect(smsPurchaseRequests).toHaveLength(1)
    expect(smsPurchaseRequests[0]).toMatchObject({
      body: JSON.stringify({ countryCode: 'US' }),
      method: 'POST'
    })
    expect(smsPurchaseRequests[0]?.headers['idempotency-key']).toBe(
      'integration-sms-purchase'
    )
    const imessagePurchaseRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/imessage/dedicated'
    )
    expect(imessagePurchaseRequests).toHaveLength(1)
    expect(imessagePurchaseRequests[0]?.headers['idempotency-key']).toBe(
      'integration-imessage-purchase'
    )
    const smsResourceRequests = captured.filter(
      ({ pathname }) =>
        pathname ===
        '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources/pho_res_00000000000000000000000001'
    )
    expect(smsResourceRequests).toHaveLength(2)
    expect(smsResourceRequests.map(({ method }) => method)).toEqual([
      'GET',
      'DELETE'
    ])
    expect(smsResourceRequests[1]?.headers['idempotency-key']).toBeUndefined()
    const resourceOperationPolls = captured.filter(
      ({ method, pathname }) =>
        method === 'GET' &&
        pathname.startsWith(
          '/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/'
        )
    )
    expect(resourceOperationPolls.map(({ pathname }) => pathname)).toEqual([
      `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${smsOperationId}`,
      `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${imessageOperationId}`,
      `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${releaseOperationId}`
    ])
    const platformRequest = captured.find(
      ({ pathname }) =>
        pathname === '/v1/projects/pho_prj_00000000000000000000000001/platforms'
    )
    expect(platformRequest).toMatchObject({ body: '', method: 'GET' })
    const billingRequests = captured.filter(
      ({ pathname }) =>
        pathname.startsWith(
          '/v1/projects/pho_prj_00000000000000000000000001/billing'
        ) ||
        pathname.startsWith(
          '/v1/organizations/pho_org_00000000000000000000000001/billing'
        )
    )
    expect(billingOperationStatuses).toEqual([
      'pending',
      'succeeded',
      'pending',
      'succeeded',
      'pending',
      'succeeded',
      'pending',
      'succeeded'
    ])
    expect(
      billingRequests
        .slice(0, 2)
        .map(({ body, method, pathname }) => `${method} ${pathname} ${body}`)
        .sort()
    ).toEqual([
      'GET /v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/terms ',
      'GET /v1/projects/pho_prj_00000000000000000000000001/billing '
    ])
    expect(
      billingRequests.slice(2, 7).map(({ body, method, pathname }) => ({
        body,
        method,
        pathname
      }))
    ).toEqual([
      {
        body: '',
        method: 'GET',
        pathname:
          '/v1/organizations/pho_org_00000000000000000000000001/billing/invoices'
      },
      {
        body: '',
        method: 'GET',
        pathname: `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}`
      },
      {
        body: '',
        method: 'GET',
        pathname: `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}`
      },
      {
        body: JSON.stringify({ category: 'platforms', planCode: 'business' }),
        method: 'POST',
        pathname:
          '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/purchase'
      },
      {
        body: '',
        method: 'GET',
        pathname: `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}`
      }
    ])
    const changeRequests = billingRequests.slice(7)
    expect(
      changeRequests
        .filter(({ method }) => method === 'GET')
        .map(({ pathname }) => pathname)
        .sort()
    ).toEqual(
      [
        '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/terms',
        '/v1/projects/pho_prj_00000000000000000000000001/billing',
        '/v1/projects/pho_prj_00000000000000000000000001/billing',
        '/v1/projects/pho_prj_00000000000000000000000001/billing/plans',
        `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}`,
        `/v1/projects/pho_prj_00000000000000000000000001/billing/operations/${billingOperationId}`
      ].sort()
    )
    const planChanges = billingRequests.filter(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/purchase'
    )
    expect(planChanges.map(({ body }) => JSON.parse(body))).toEqual([
      { category: 'platforms', planCode: 'business' },
      { category: 'platforms', planCode: 'free' },
      { category: 'platforms', planCode: 'business' }
    ])
    expect(planChanges[0]?.headers['idempotency-key']).toBe(
      'integration-plan-purchase'
    )
    expect(
      planChanges.every(
        ({ headers }) => typeof headers['idempotency-key'] === 'string'
      )
    ).toBe(true)
    expect(
      billingRequests
        .filter(({ method }) => method === 'GET')
        .every(({ headers }) => headers['idempotency-key'] === undefined)
    ).toBe(true)
    const idempotentMethods = captured.filter(
      ({ headers }) => headers['idempotency-key'] !== undefined
    )
    expect(idempotentMethods.map(({ pathname }) => pathname)).toEqual(
      expect.arrayContaining([
        '/v1/organizations/pho_org_00000000000000000000000001/projects',
        '/v1/projects/pho_prj_00000000000000000000000001',
        '/v1/organizations/pho_org_00000000000000000000000001/billing/projects/pho_prj_00000000000000000000000001/purchase',
        '/v1/projects/pho_prj_00000000000000000000000001/platforms/imessage/dedicated',
        '/v1/projects/pho_prj_00000000000000000000000001/platforms/sms/numbers',
        '/v1/projects/pho_prj_00000000000000000000000001/agent-profile/avatar'
      ])
    )
    expect(timeoutSpy).toHaveBeenCalledWith(60_000)
    await authenticated.remove()
  })
})
