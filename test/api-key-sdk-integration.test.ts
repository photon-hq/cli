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
import { photonKey } from './key-support.ts'
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
}

const servers: ReturnType<typeof createServer>[] = []
const timestamp = '2026-07-31T18:00:00.000Z'
const expiresAt = '2026-09-01T01:00:00.000Z'
const apiKeyId = photonKey('sk', '00000000000000000000000001')
const secret = 'photon_sdk_api_key_secret'

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

const apiKey = (overrides: Partial<{ revokedAt: null | string }> = {}) => ({
  apiKeyId,
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  expiresAt,
  futureField: 'from-a-newer-api',
  name: 'SDK key',
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: 'pho_prj_00000000000000000000000001',
  revokedAt: overrides.revokedAt ?? null
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
    'x-request-id': 'request_api_key_integration'
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

describe('generated project API key SDK integration', () => {
  test('uses exact list, create, retry, and revoke wire shapes', async () => {
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
          pathname: url.pathname
        })

        if (
          url.pathname ===
            '/v1/projects/pho_prj_00000000000000000000000001/api-keys' &&
          method === 'GET'
        ) {
          writeJson(response, { apiKeys: [apiKey()] })
          return
        }
        if (
          url.pathname ===
            '/v1/projects/pho_prj_00000000000000000000000001/api-keys' &&
          method === 'POST'
        ) {
          createAttempts += 1
          if (createAttempts === 1) {
            writeJson(response, { code: 'UNAUTHORIZED' }, 401)
            return
          }
          writeJson(response, { apiKey: apiKey(), secret }, 201)
          return
        }
        if (
          url.pathname ===
            `/v1/projects/pho_prj_00000000000000000000000001/api-keys/${apiKeyId}` &&
          method === 'DELETE'
        ) {
          writeJson(response, { apiKey: apiKey({ revokedAt: timestamp }) })
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
      expect(exitCodes).toEqual([])
      return {
        output: JSON.parse(stdout.value()) as Record<string, unknown>,
        stderr: stderr.value()
      }
    }

    const listed = await invoke([
      'project',
      'api-key',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(listed.stderr).toBe('')
    expect(listed.output).toMatchObject({
      apiKeys: [{ apiKeyId, futureField: 'from-a-newer-api', name: 'SDK key' }]
    })
    expect(JSON.stringify(listed.output)).not.toContain(secret)

    const created = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'SDK key',
      '--expires-at',
      '2026-08-31T18:00:00-07:00',
      '--idempotency-key',
      'sdk-api-key-create'
    ])
    expect(created.output).toMatchObject({
      apiKey: { apiKeyId, futureField: 'from-a-newer-api' },
      secret
    })
    expect(created.stderr).toContain('cannot be retrieved again')
    expect(created.stderr).not.toContain('from-a-newer-api')
    expect(created.stderr).not.toContain(secret)

    const revoked = await invoke([
      'project',
      'api-key',
      'revoke',
      apiKeyId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes',
      '--idempotency-key',
      'sdk-api-key-revoke'
    ])
    expect(revoked.stderr).toBe('')
    expect(revoked.output).toEqual({
      apiKey: apiKey({ revokedAt: timestamp })
    })
    expect(JSON.stringify(revoked.output)).not.toContain(secret)

    const listRequest = captured.find(({ method }) => method === 'GET')
    expect(listRequest).toMatchObject({
      body: '',
      pathname: '/v1/projects/pho_prj_00000000000000000000000001/api-keys'
    })
    expect(listRequest?.headers['idempotency-key']).toBeUndefined()

    const createRequests = captured.filter(({ method }) => method === 'POST')
    expect(createRequests).toHaveLength(2)
    expect(createRequests.map(({ body }) => JSON.parse(body))).toEqual([
      { expiresAt, name: 'SDK key', permissions: ['project:read'] },
      { expiresAt, name: 'SDK key', permissions: ['project:read'] }
    ])
    expect(createRequests[0]?.headers.authorization).toBe(
      'Bearer project-access-token'
    )
    expect(createRequests[1]?.headers.authorization).toBe(
      'Bearer rotated-project-access-token'
    )
    expect(createRequests[0]?.headers['idempotency-key']).toBe(
      'sdk-api-key-create'
    )
    expect(createRequests[1]?.headers['idempotency-key']).toBe(
      'sdk-api-key-create'
    )

    const revokeRequest = captured.find(({ method }) => method === 'DELETE')
    expect(revokeRequest).toMatchObject({
      body: '',
      pathname: `/v1/projects/pho_prj_00000000000000000000000001/api-keys/${apiKeyId}`
    })
    expect(revokeRequest?.headers.authorization).toBe(
      'Bearer rotated-project-access-token'
    )
    expect(revokeRequest?.headers['idempotency-key']).toBe('sdk-api-key-revoke')
  })
})
