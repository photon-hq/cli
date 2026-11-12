import { readdir, readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

interface CapturedRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string
  pathname: string
}

const servers: ReturnType<typeof createServer>[] = []
const timestamp = '2026-08-07T04:24:09.000Z'
const applicationId = 'connect_app_sdk'
const clientId = 'client_sdk'
const plaintextSecret = 'oauth-sdk-secret-value'
const rotatedSecret = 'oauth-sdk-rotated-secret-value'
const oauthClientEtag = `"${'a'.repeat(43)}"`

const oauthClient = {
  clientId,
  createdAt: timestamp,
  description: 'SDK integration client',
  name: 'SDK Client',
  redirectUris: [{ default: true, uri: 'https://sdk.example/callback' }],
  scopes: ['account:read'],
  updatedAt: timestamp
}

const clientSecret = {
  current: { createdAt: timestamp, hint: '…sdk123', lastUsedAt: null },
  previous: null
}

const oauthConnection = {
  application: {
    applicationType: 'web',
    clientId,
    createdAt: timestamp,
    description: 'SDK integration client',
    id: applicationId,
    isFirstParty: false,
    name: 'SDK Client',
    redirectUris: oauthClient.redirectUris,
    scopes: oauthClient.scopes,
    updatedAt: timestamp,
    usesPkce: true
  },
  authorizationId: 'authorized_connect_app_sdk',
  grantedScopes: ['account:read'],
  oauthResource: BUILD_CONFIG.apiOrigin
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
    'x-request-id': 'request_oauth_integration',
    ...headers
  })
  response.end(JSON.stringify(body))
}

const listen = async (captured: CapturedRequest[]): Promise<string> => {
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request)
      const method = request.method ?? 'GET'
      const { pathname } = new URL(request.url ?? '/', 'http://localhost')
      captured.push({ body, headers: request.headers, method, pathname })

      if (pathname === '/v1/auth/oauth/scopes' && method === 'GET') {
        writeJson(response, { scopes: ['openid', 'account:read'] })
        return
      }
      if (
        pathname === '/v1/account/oauth/authorized-applications' &&
        method === 'GET'
      ) {
        writeJson(response, {
          authorizedApplications: [oauthConnection],
          listMetadata: { after: null, before: null }
        })
        return
      }
      if (
        pathname ===
          `/v1/account/oauth/authorized-applications/${applicationId}` &&
        method === 'DELETE'
      ) {
        response.writeHead(204).end()
        return
      }
      if (
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/oauth/clients' &&
        method === 'GET'
      ) {
        writeJson(response, { oauthClients: [oauthClient] })
        return
      }
      if (
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/oauth/clients' &&
        method === 'POST'
      ) {
        writeJson(response, oauthClient, 201)
        return
      }
      if (
        pathname ===
          `/v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}` &&
        method === 'GET'
      ) {
        writeJson(response, oauthClient, 200, { etag: oauthClientEtag })
        return
      }
      if (
        pathname ===
          `/v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}` &&
        method === 'PATCH'
      ) {
        writeJson(
          response,
          { ...oauthClient, name: 'Updated SDK Client' },
          200,
          { etag: oauthClientEtag }
        )
        return
      }
      if (
        pathname ===
          `/v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}` &&
        method === 'DELETE'
      ) {
        writeJson(response, {
          operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
          status: 'deleted'
        })
        return
      }
      const secretPath = `/v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}/secret`
      if (pathname === secretPath && method === 'GET') {
        writeJson(response, clientSecret)
        return
      }
      if (pathname === secretPath && method === 'PUT') {
        writeJson(response, { value: plaintextSecret }, 201, {
          'cache-control': 'no-store',
          pragma: 'no-cache'
        })
        return
      }
      if (pathname === `${secretPath}/rotate` && method === 'POST') {
        writeJson(
          response,
          { previousSecretValidUntil: timestamp, value: rotatedSecret },
          200,
          { 'cache-control': 'no-store', pragma: 'no-cache' }
        )
        return
      }
      if (pathname === secretPath && method === 'DELETE') {
        response.writeHead(204).end()
        return
      }
      writeJson(response, { code: 'NOT_FOUND' }, 404)
    } catch {
      if (response.headersSent) {
        response.end()
        return
      }
      writeJson(response, { code: 'INTERNAL_SERVER_ERROR' }, 500)
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port.toString()}`
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

describe('generated OAuth SDK integration', () => {
  test('uses every OAuth route and redacts the one-time secret', async () => {
    const captured: CapturedRequest[] = []
    const baseUrl = await listen(captured)
    const authenticated = await createAuthenticatedConfig(
      'user_ada',
      new URL(baseUrl).origin
    )

    const invoke = async (args: string[]) => {
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      // An explicit organization keeps the request list to the OAuth routes.
      const organizationArgs =
        args[0] === 'org' ? ['--org', 'pho_org_00000000000000000000000001'] : []
      await runCli([...args, ...organizationArgs, '--json'], {
        baseUrl,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })
      expect(
        exitCodes,
        `${stderr.value()}\n${JSON.stringify(captured)}`
      ).toEqual([])
      return { stderr: stderr.value(), stdout: stdout.value() }
    }

    await invoke(['account', 'oauth', 'scope', 'list'])
    await invoke(['account', 'oauth', 'connection', 'list'])
    await invoke([
      'account',
      'oauth',
      'connection',
      'revoke',
      applicationId,
      '--yes'
    ])
    await invoke(['org', 'oauth-client', 'list'])
    await invoke(['org', 'oauth-client', 'view', clientId])
    await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      'SDK Client',
      '--description',
      'SDK integration client',
      '--redirect-uri',
      'https://sdk.example/callback',
      '--default-redirect-uri',
      'https://sdk.example/callback',
      '--scope',
      'account:read'
    ])
    await invoke([
      'org',
      'oauth-client',
      'update',
      clientId,
      '--name',
      'Updated SDK Client'
    ])
    await invoke(['org', 'oauth-client', 'secret', 'view', clientId])
    const createdSecret = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId,
      '--debug'
    ])
    expect(JSON.parse(createdSecret.stdout)).toHaveProperty(
      'value',
      plaintextSecret
    )
    expect(createdSecret.stderr).not.toContain(plaintextSecret)
    expect(createdSecret.stderr).toContain('[REDACTED]')
    const persistedEntries = await readdir(authenticated.configDirectory, {
      recursive: true,
      withFileTypes: true
    })
    for (const entry of persistedEntries) {
      if (!entry.isFile()) {
        continue
      }
      // biome-ignore lint/performance/noAwaitInLoops: every persisted file must be inspected before the assertion can pass.
      const persistedContents = await readFile(
        join(entry.parentPath, entry.name),
        'utf8'
      )
      expect(persistedContents).not.toContain(plaintextSecret)
    }
    const rotated = await invoke([
      'org',
      'oauth-client',
      'secret',
      'rotate',
      clientId,
      '--yes',
      '--debug'
    ])
    expect(JSON.parse(rotated.stdout)).toHaveProperty('value', rotatedSecret)
    expect(rotated.stderr).not.toContain(rotatedSecret)
    expect(rotated.stderr).toContain('[REDACTED]')
    await invoke(['org', 'oauth-client', 'secret', 'revoke', clientId, '--yes'])
    await invoke(['org', 'oauth-client', 'delete', clientId, '--yes'])

    expect(
      captured.map(({ method, pathname }) => `${method} ${pathname}`)
    ).toEqual([
      'GET /v1/auth/oauth/scopes',
      'GET /v1/account/oauth/authorized-applications',
      `DELETE /v1/account/oauth/authorized-applications/${applicationId}`,
      'GET /v1/organizations/pho_org_00000000000000000000000001/oauth/clients',
      `GET /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}`,
      'POST /v1/organizations/pho_org_00000000000000000000000001/oauth/clients',
      `GET /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}`,
      `PATCH /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}`,
      `GET /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}/secret`,
      `PUT /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}/secret`,
      `POST /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}/secret/rotate`,
      `DELETE /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}/secret`,
      `DELETE /v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}`
    ])
    const [scopeRequest, ...authenticatedRequests] = captured
    expect(scopeRequest?.headers.authorization).toBeUndefined()
    expect(
      authenticatedRequests.every(
        ({ headers }) => headers.authorization === 'Bearer project-access-token'
      )
    ).toBe(true)
    const createRequest = captured.find(
      ({ method, pathname }) =>
        method === 'POST' &&
        pathname ===
          '/v1/organizations/pho_org_00000000000000000000000001/oauth/clients'
    )
    const updateRequest = captured.find(
      ({ method, pathname }) =>
        method === 'PATCH' &&
        pathname ===
          `/v1/organizations/pho_org_00000000000000000000000001/oauth/clients/${clientId}`
    )
    if (createRequest === undefined || updateRequest === undefined) {
      throw new Error('Expected OAuth client create and update requests.')
    }
    expect(createRequest.headers['idempotency-key']).toEqual(expect.any(String))
    expect(JSON.parse(createRequest.body)).toEqual({
      description: 'SDK integration client',
      name: 'SDK Client',
      redirectUris: [{ default: true, uri: 'https://sdk.example/callback' }],
      scopes: ['account:read']
    })
    expect(JSON.parse(updateRequest.body)).toEqual({
      name: 'Updated SDK Client'
    })
    expect(updateRequest.headers['if-match']).toBe(oauthClientEtag)
  })
})
