import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DeviceTokenOutput } from '@photon-ai/api'
import { afterEach, describe, expect, test } from 'vitest'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW
} from './project-test-support.ts'

interface CapturedRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string
  pathname: string
  search: string
}

const servers: ReturnType<typeof createServer>[] = []
const timestamp = '2026-07-31T18:00:00.000Z'
const destinationId = 'pho_whd_01h455vb4pex5vsknk084sn02q'
const secondDestinationId = 'pho_whd_01h455vb4pex5vsknk084sn02r'
const signingSecret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`
const rotatedSigningSecret = `whsec_${Buffer.alloc(32, 4).toString('base64')}`

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

const destination = (
  id = destinationId,
  overrides: Record<string, unknown> = {}
) => ({
  apiVersion: '2026-07-01',
  createdAt: timestamp,
  deletedAt: null,
  description: 'SDK destination',
  destinationId: id,
  enabledEvents: ['message.created'],
  futureField: 'from-a-newer-api',
  name: 'SDK hook',
  projectId: 'pho_prj_01h455vb4pex5vsknk084sn02q',
  status: 'enabled',
  updatedAt: timestamp,
  url: 'https://hooks.example.test/sdk',
  ...overrides
})

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
  status = 200
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'request_webhook_integration'
  })
  response.end(JSON.stringify(body))
}

afterEach(async () => {
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

describe('generated project webhook SDK integration', () => {
  test('uses all webhook routes with exact auth, pagination, body, and idempotency shapes', async () => {
    const captured: CapturedRequest[] = []
    let createAttempts = 0
    let origin = ''
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', origin)
        const method = request.method ?? 'GET'
        captured.push({
          body: await readBody(request),
          headers: request.headers,
          method,
          pathname: url.pathname,
          search: url.search
        })

        const collectionPath =
          '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/destinations'
        const destinationPath = `${collectionPath}/${destinationId}`
        if (url.pathname === collectionPath && method === 'GET') {
          if (url.searchParams.get('pageToken') === 'next-page') {
            writeJson(response, {
              destinations: [destination(secondDestinationId)]
            })
            return
          }
          writeJson(response, {
            destinations: [destination()],
            nextPageToken: 'next-page'
          })
          return
        }
        if (url.pathname === collectionPath && method === 'POST') {
          createAttempts += 1
          if (createAttempts === 1) {
            writeJson(response, { code: 'UNAUTHORIZED' }, 401)
            return
          }
          writeJson(
            response,
            {
              destination: destination(destinationId, {
                description: null,
                enabledEvents: ['*']
              }),
              signingSecret
            },
            201
          )
          return
        }
        if (url.pathname === destinationPath && method === 'GET') {
          writeJson(response, destination())
          return
        }
        if (url.pathname === destinationPath && method === 'PATCH') {
          writeJson(
            response,
            destination(destinationId, {
              enabledEvents: ['message.created', 'message.updated'],
              status: 'disabled'
            })
          )
          return
        }
        if (url.pathname === destinationPath && method === 'DELETE') {
          writeJson(
            response,
            destination(destinationId, { deletedAt: timestamp })
          )
          return
        }
        if (
          url.pathname === `${destinationPath}/secret-rotations` &&
          method === 'POST'
        ) {
          writeJson(response, {
            previousSecretExpiresAt: '2026-08-01T19:00:00.000Z',
            signingSecret: rotatedSigningSecret
          })
          return
        }
        if (
          url.pathname ===
            '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/api-versions' &&
          method === 'GET'
        ) {
          writeJson(response, {
            apiVersions: [
              {
                retirement: null,
                selectable: true,
                status: 'latest',
                successor: null,
                version: '2026-07-01'
              }
            ],
            contractNamespace: '@photon-hq/contracts',
            packageVersion: '1.0.0'
          })
          return
        }
        if (
          url.pathname ===
            '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/event-types' &&
          method === 'GET'
        ) {
          writeJson(response, {
            apiVersion: '2026-07-01',
            contractNamespace: '@photon-hq/contracts',
            events: [
              {
                audience: 'agent',
                description: 'A message was created.',
                schemaProfile: 'reader',
                schemaUrl:
                  '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/event-types/message.created/schema',
                type: 'message.created'
              }
            ],
            packageVersion: '1.0.0',
            retirement: null,
            selectable: true,
            status: 'latest',
            successor: null
          })
          return
        }

        writeJson(response, { code: 'NOT_FOUND' }, 404)
      } catch {
        writeJson(response, { code: 'INTERNAL_SERVER_ERROR' }, 500)
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port.toString()}`
    const authenticated = await createAuthenticatedConfig('user_ada', origin)

    const invoke = async (
      args: string[]
    ): Promise<{ output: Record<string, unknown>; stderr: string }> => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      await runCli([...args, '--json'], {
        baseUrl: origin,
        configDirectory: authenticated.configDirectory,
        deviceScope: refreshingDeviceScope,
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })
      expect(exitCodes, stderr.value()).toEqual([])
      return {
        output: JSON.parse(stdout.value()) as Record<string, unknown>,
        stderr: stderr.value()
      }
    }

    const listed = await invoke([
      'project',
      'webhook',
      'list',
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--limit',
      '2'
    ])
    expect(listed.output).toEqual({
      destinations: [destination(), destination(secondDestinationId)]
    })

    const created = await invoke([
      'project',
      'webhook',
      'create',
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--name',
      'SDK hook',
      '--url',
      'https://hooks.example.test/sdk',
      '--api-version',
      '2026-07-01',
      '--all-events',
      '--idempotency-key',
      'sdk-webhook-create',
      '--debug'
    ])
    expect(created.output).toMatchObject({
      destination: { destinationId, enabledEvents: ['*'] },
      signingSecret
    })
    expect(created.stderr).not.toContain(signingSecret)
    expect(created.stderr).toContain('[REDACTED]')

    const viewed = await invoke([
      'project',
      'webhook',
      'view',
      destinationId,
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q'
    ])
    expect(viewed.output).toEqual(destination())

    const edited = await invoke([
      'project',
      'webhook',
      'edit',
      destinationId,
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--event',
      'message.updated',
      '--event',
      'message.created',
      '--status',
      'disabled',
      '--idempotency-key',
      'sdk-webhook-edit'
    ])
    expect(edited.output).toMatchObject({ destinationId, status: 'disabled' })

    const rotated = await invoke([
      'project',
      'webhook',
      'rotate-secret',
      destinationId,
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--overlap-seconds',
      '3600',
      '--idempotency-key',
      'sdk-webhook-rotate',
      '--yes'
    ])
    expect(rotated.output).toEqual({
      previousSecretExpiresAt: '2026-08-01T19:00:00.000Z',
      signingSecret: rotatedSigningSecret
    })
    expect(rotated.stderr).not.toContain(rotatedSigningSecret)

    const versions = await invoke([
      'project',
      'webhook',
      'api-version',
      'list',
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q'
    ])
    expect(versions.output).toMatchObject({
      apiVersions: [{ version: '2026-07-01' }],
      contractNamespace: '@photon-hq/contracts',
      packageVersion: '1.0.0'
    })

    const events = await invoke([
      'project',
      'webhook',
      'event-type',
      'list',
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--api-version',
      '2026-07-01'
    ])
    expect(events.output).toMatchObject({
      apiVersion: '2026-07-01',
      events: [{ type: 'message.created' }]
    })

    const deleted = await invoke([
      'project',
      'webhook',
      'delete',
      destinationId,
      '--project',
      'pho_prj_01h455vb4pex5vsknk084sn02q',
      '--yes'
    ])
    expect(deleted.output).toEqual(
      destination(destinationId, { deletedAt: timestamp })
    )

    const listRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'GET' &&
        pathname ===
          '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/destinations'
    )
    expect(listRequests.map(({ search }) => search)).toEqual([
      '?pageSize=2',
      '?pageSize=1&pageToken=next-page'
    ])

    const createRequests = captured.filter(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/destinations'
    )
    expect(createRequests).toHaveLength(2)
    expect(createRequests.map(({ body }) => JSON.parse(body))).toEqual([
      {
        apiVersion: '2026-07-01',
        enabledEvents: ['*'],
        name: 'SDK hook',
        status: 'enabled',
        url: 'https://hooks.example.test/sdk'
      },
      {
        apiVersion: '2026-07-01',
        enabledEvents: ['*'],
        name: 'SDK hook',
        status: 'enabled',
        url: 'https://hooks.example.test/sdk'
      }
    ])
    expect(createRequests[0]?.headers.authorization).toBe(
      'Bearer project-access-token'
    )
    expect(createRequests[1]?.headers.authorization).toBe(
      'Bearer rotated-project-access-token'
    )
    expect(
      createRequests.map(({ headers }) => headers['idempotency-key'])
    ).toEqual(['sdk-webhook-create', 'sdk-webhook-create'])

    const patchRequest = captured.find(({ method }) => method === 'PATCH')
    expect(patchRequest).toMatchObject({
      pathname: `/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/destinations/${destinationId}`
    })
    expect(JSON.parse(patchRequest?.body ?? '')).toEqual({
      enabledEvents: ['message.created', 'message.updated'],
      status: 'disabled'
    })
    expect(patchRequest?.headers['idempotency-key']).toBe('sdk-webhook-edit')

    const rotationRequest = captured.find(({ pathname }) =>
      pathname.endsWith('/secret-rotations')
    )
    expect(JSON.parse(rotationRequest?.body ?? '')).toEqual({
      overlapSeconds: 3600
    })
    expect(rotationRequest?.headers['idempotency-key']).toBe(
      'sdk-webhook-rotate'
    )

    const eventRequest = captured.find(({ pathname }) =>
      pathname.endsWith('/webhooks/event-types')
    )
    expect(eventRequest?.search).toBe('?apiVersion=2026-07-01')

    const deleteRequest = captured.find(({ method }) => method === 'DELETE')
    expect(deleteRequest).toMatchObject({
      body: '',
      pathname: `/v1/projects/pho_prj_01h455vb4pex5vsknk084sn02q/webhooks/destinations/${destinationId}`
    })
    expect(deleteRequest?.headers['idempotency-key']).toBeUndefined()
  })
})
