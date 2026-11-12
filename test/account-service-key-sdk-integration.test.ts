import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { DeviceTokenOutput, GetAccountOutput } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parseAccountServiceKey } from '../src/auth/account-service-key.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { photonKey } from './key-support.ts'
import { collector, TEST_NOW } from './project-test-support.ts'

interface CapturedRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string
  pathname: string
}

type ServerHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void

const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []
const createdAt = '2026-07-31T17:00:00.000Z'
const accountId = 'pho_acc_01h455vb4pex5vsknk084sn02q'
const serviceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const secret = `${serviceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`
const managedServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02t')
const managedSecret = `${managedServiceKeyId}_TWFuYWdlZFNlcnZpY2VLZXk`

const accountFixture: GetAccountOutput = {
  accountId,
  createdAt,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: createdAt
}

const serviceKey = (revokedAt: null | string = null) => ({
  accountId,
  addedByNewerApi: 'from-a-newer-api',
  createdAt,
  expiresAt: null,
  name: 'wire automation',
  revokedAt,
  serviceKeyId
})

const managedServiceKey = (revokedAt: null | string = null) => ({
  ...serviceKey(revokedAt),
  name: 'ASK-managed automation',
  serviceKeyId: managedServiceKeyId
})

const refreshedGrant: DeviceTokenOutput = {
  access_token: 'rotated-account-access-token',
  expires_in: 3600,
  refresh_token: 'rotated-account-refresh-token',
  user: {
    email: 'ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const nonTtyStdin = (contents: string): ReadableInput => {
  const stream = Readable.from([contents]) as ReadableInput
  stream.isTTY = false
  return stream
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'request_account_service_key_wire'
  })
  response.end(JSON.stringify(body))
}

const startServer = async (
  handler: ServerHandler
): Promise<{ origin: string }> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${address.port.toString()}` }
}

const createDeviceConfig = async (apiOrigin: string): Promise<string> => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'photon-ask-wire-'))
  directories.push(configDirectory)
  const repository = new AuthRepository({
    apiOrigin,
    configDirectory,
    platform: 'linux'
  })
  const backend = await repository.prepareLoginBackend(true, undefined)
  const metadata = repository.createMetadata(backend, {
    email: 'ada@example.test',
    id: 'user_ada',
    name: 'Ada Lovelace'
  })
  await repository.withLock(async () => {
    await repository.persistSessionLocked(
      repository.createCredential(
        'device-access-token',
        'device-refresh-token',
        new Date(TEST_NOW + 3_600_000)
      ),
      metadata,
      backend.backend
    )
  })
  return configDirectory
}

const createAccountServiceKeyConfig = async (
  apiOrigin: string
): Promise<string> => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'photon-ask-auth-wire-'))
  directories.push(configDirectory)
  const repository = new AuthRepository({
    apiOrigin,
    configDirectory,
    platform: 'linux'
  })
  const backend = await repository.prepareAccountServiceKeyBackend(
    true,
    undefined
  )
  const parsed = parseAccountServiceKey(secret)
  if (parsed === undefined) {
    throw new Error('test Account Service Key fixture is invalid')
  }
  const metadata = repository.createAccountServiceKeyMetadata(
    backend,
    accountFixture,
    parsed
  )
  await repository.withLock(async () => {
    await repository.persistSessionLocked(
      repository.createAccountServiceKeyCredential(parsed),
      metadata,
      backend.backend
    )
  })
  return configDirectory
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
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('Account Service Key HTTP compatibility integration', () => {
  test('uses exact list, create/retry, and revoke wire contracts', async () => {
    const captured: CapturedRequest[] = []
    let createAttempts = 0
    const started = await startServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const method = request.method ?? 'GET'
        captured.push({
          body: await readBody(request),
          headers: request.headers,
          method,
          pathname: url.pathname
        })
        if (url.pathname === '/v1/account/service-keys' && method === 'GET') {
          writeJson(response, { serviceKeys: [serviceKey()] })
          return
        }
        if (url.pathname === '/v1/account/service-keys' && method === 'POST') {
          createAttempts += 1
          if (createAttempts === 1) {
            writeJson(response, { code: 'UNAUTHORIZED' }, 401)
            return
          }
          writeJson(response, { secret, serviceKey: serviceKey() }, 201)
          return
        }
        if (
          url.pathname === `/v1/account/service-keys/${serviceKeyId}` &&
          method === 'DELETE'
        ) {
          writeJson(response, { serviceKey: serviceKey(createdAt) })
          return
        }
        writeJson(response, { code: 'ROUTE_NOT_FOUND' }, 404)
      } catch {
        writeJson(response, { code: 'INTERNAL_ERROR' }, 500)
      }
    })
    const { origin } = started
    const configDirectory = await createDeviceConfig(origin)
    const token = vi.fn(() => Promise.resolve(refreshedGrant))
    const deviceScope: DeviceAuthScope = {
      authorize: () =>
        Promise.reject(new Error('authorize should not be called')),
      token
    }
    const invoke = async (
      args: string[]
    ): Promise<{ stderr: string; value: Record<string, unknown> }> => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      await runCli([...args, '--json'], {
        baseUrl: origin,
        configDirectory,
        deviceScope,
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      })
      expect(exitCodes).toEqual([])
      return {
        stderr: stderr.value(),
        value: JSON.parse(stdout.value()) as Record<string, unknown>
      }
    }

    const listed = await invoke(['account', 'service-key', 'list'])
    expect(listed.stderr).toBe('')
    expect(listed.value).toEqual({ serviceKeys: [serviceKey()] })

    const created = await invoke([
      'account',
      'service-key',
      'create',
      '--name',
      'wire automation',
      '--no-expiry',
      '--idempotency-key',
      'wire-create'
    ])
    expect(created.value).toMatchObject({
      secret,
      serviceKey: { serviceKeyId }
    })
    expect(created.stderr).toContain('Save this account service key now')
    expect(created.stderr).not.toContain(secret)

    const revoked = await invoke([
      'account',
      'service-key',
      'revoke',
      serviceKeyId,
      '--yes',
      '--idempotency-key',
      'wire-revoke'
    ])
    expect(revoked.stderr).toBe('')
    expect(revoked.value).toEqual({ serviceKey: serviceKey(createdAt) })
    expect(JSON.stringify(revoked.value)).not.toContain(secret)

    expect(
      captured.map(({ method, pathname }) => ({ method, pathname }))
    ).toEqual([
      { method: 'GET', pathname: '/v1/account/service-keys' },
      { method: 'POST', pathname: '/v1/account/service-keys' },
      { method: 'POST', pathname: '/v1/account/service-keys' },
      {
        method: 'DELETE',
        pathname: `/v1/account/service-keys/${serviceKeyId}`
      }
    ])
    expect(captured[0]?.body).toBe('')
    expect(captured[0]?.headers.authorization).toBe(
      'Bearer device-access-token'
    )
    expect(captured[0]?.headers['idempotency-key']).toBeUndefined()

    const createRequests = captured.slice(1, 3)
    expect(createRequests.map(({ body }) => JSON.parse(body))).toEqual([
      { name: 'wire automation' },
      { name: 'wire automation' }
    ])
    expect(createRequests.map(({ headers }) => headers.authorization)).toEqual([
      'Bearer device-access-token',
      'Bearer rotated-account-access-token'
    ])
    expect(
      createRequests.map(({ headers }) => headers['idempotency-key'])
    ).toEqual(['wire-create', 'wire-create'])

    expect(captured[3]?.body).toBe('')
    expect(captured[3]?.headers.authorization).toBe(
      'Bearer rotated-account-access-token'
    )
    expect(captured[3]?.headers['idempotency-key']).toBe('wire-revoke')
    expect(token).toHaveBeenCalledOnce()
  })

  test('uses an Account Service Key bearer for a successful management chain', async () => {
    const captured: CapturedRequest[] = []
    const started = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const method = request.method ?? 'GET'
      captured.push({
        body: await readBody(request),
        headers: request.headers,
        method,
        pathname: url.pathname
      })
      if (url.pathname === '/v1/account' && method === 'GET') {
        writeJson(response, accountFixture)
        return
      }
      if (url.pathname === '/v1/account/service-keys' && method === 'GET') {
        writeJson(response, { serviceKeys: [managedServiceKey()] })
        return
      }
      if (url.pathname === '/v1/account/service-keys' && method === 'POST') {
        writeJson(
          response,
          { secret: managedSecret, serviceKey: managedServiceKey() },
          201
        )
        return
      }
      if (
        url.pathname === `/v1/account/service-keys/${managedServiceKeyId}` &&
        method === 'DELETE'
      ) {
        writeJson(response, { serviceKey: managedServiceKey(createdAt) })
        return
      }
      writeJson(response, { code: 'ROUTE_NOT_FOUND' }, 404)
    })
    const { origin } = started
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'photon-ask-login-wire-')
    )
    directories.push(configDirectory)
    const authorize = vi.fn(() =>
      Promise.reject(new Error('authorize should not be called'))
    )
    const token = vi.fn(() => Promise.resolve(refreshedGrant))
    const deviceScope: DeviceAuthScope = { authorize, token }

    const loginStderr = collector()
    const loginStdout = collector()
    const loginExitCodes: number[] = []
    await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
      baseUrl: origin,
      configDirectory,
      deviceScope,
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (code) => loginExitCodes.push(code),
      stderr: loginStderr,
      stdin: nonTtyStdin(`${secret}\n`),
      stdout: loginStdout
    })
    expect(loginExitCodes, loginStderr.value()).toEqual([])
    expect(JSON.parse(loginStdout.value())).toMatchObject({
      accountId,
      credentialKind: 'account_service_key',
      serviceKeyId,
      storage: 'file'
    })
    expect(`${loginStdout.value()}${loginStderr.value()}`).not.toContain(secret)
    await expect(
      new AuthRepository({
        apiOrigin: origin,
        configDirectory,
        platform: 'linux'
      }).loadSession()
    ).resolves.toMatchObject({
      credentials: { credential: secret },
      kind: 'account_service_key',
      metadata: { accountId, apiOrigin: origin, serviceKeyId }
    })

    const invoke = async (
      args: string[]
    ): Promise<{ stderr: string; value: Record<string, unknown> }> => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      await runCli([...args, '--json'], {
        baseUrl: origin,
        configDirectory,
        deviceScope,
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout
      })
      expect(exitCodes).toEqual([])
      return {
        stderr: stderr.value(),
        value: JSON.parse(stdout.value()) as Record<string, unknown>
      }
    }

    const listed = await invoke(['account', 'service-key', 'list'])
    expect(listed.stderr).toBe('')
    expect(listed.value).toMatchObject({
      serviceKeys: [{ serviceKeyId: managedServiceKeyId }]
    })

    const created = await invoke([
      'account',
      'service-key',
      'create',
      '--name',
      'ASK-managed automation',
      '--no-expiry',
      '--idempotency-key',
      'ask-wire-create'
    ])
    expect(created.value).toMatchObject({
      secret: managedSecret,
      serviceKey: { serviceKeyId: managedServiceKeyId }
    })
    expect(created.stderr).not.toContain(managedSecret)

    const revoked = await invoke([
      'account',
      'service-key',
      'revoke',
      managedServiceKeyId,
      '--yes',
      '--idempotency-key',
      'ask-wire-revoke'
    ])
    expect(revoked.stderr).toBe('')
    expect(revoked.value).toEqual({
      serviceKey: managedServiceKey(createdAt)
    })

    expect(
      captured.map(({ method, pathname }) => ({ method, pathname }))
    ).toEqual([
      { method: 'GET', pathname: '/v1/account' },
      { method: 'GET', pathname: '/v1/account/service-keys' },
      { method: 'POST', pathname: '/v1/account/service-keys' },
      {
        method: 'DELETE',
        pathname: `/v1/account/service-keys/${managedServiceKeyId}`
      }
    ])
    expect(captured.map(({ headers }) => headers.authorization)).toEqual([
      `Bearer ${secret}`,
      `Bearer ${secret}`,
      `Bearer ${secret}`,
      `Bearer ${secret}`
    ])
    expect(captured[0]?.body).toBe('')
    expect(captured[0]?.headers['idempotency-key']).toBeUndefined()
    expect(captured[1]?.body).toBe('')
    expect(captured[1]?.headers['idempotency-key']).toBeUndefined()
    const createRequest = captured.at(2)
    if (createRequest === undefined) {
      throw new Error('Expected an Account Service Key create request.')
    }
    expect(JSON.parse(createRequest.body)).toEqual({
      name: 'ASK-managed automation'
    })
    expect(createRequest.headers['idempotency-key']).toBe('ask-wire-create')
    expect(captured[3]?.body).toBe('')
    expect(captured[3]?.headers['idempotency-key']).toBe('ask-wire-revoke')
    expect(authorize).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
  })

  test('answers an Account whose email address is invalid as a protocol error and saves nothing', async () => {
    const invalidEmail = 'ada.example.test'
    const started = await startServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/v1/account' && request.method === 'GET') {
        writeJson(response, { ...accountFixture, email: invalidEmail })
        return
      }
      writeJson(response, { code: 'ROUTE_NOT_FOUND' }, 404)
    })
    const { origin } = started
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'photon-ask-login-wire-')
    )
    directories.push(configDirectory)
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
      baseUrl: origin,
      configDirectory,
      deviceScope: {
        authorize: () =>
          Promise.reject(new Error('authorize should not be called')),
        token: () => Promise.reject(new Error('token should not be called'))
      },
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (code) => exitCodes.push(code),
      stderr,
      stdin: nonTtyStdin(`${secret}\n`),
      stdout
    })

    expect(exitCodes).toEqual([1])
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'AUTH_PROTOCOL_ERROR',
        detail: 'The Account response did not contain a valid email address.'
      }
    })
    expect(`${stdout.value()}${stderr.value()}`).not.toContain(invalidEmail)
    await expect(
      new AuthRepository({
        apiOrigin: origin,
        configDirectory,
        platform: 'linux'
      }).loadSession()
    ).resolves.toBeUndefined()
  })

  test('does not retry or refresh an Account Service Key after a 401', async () => {
    const captured: CapturedRequest[] = []
    const started = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      captured.push({
        body: await readBody(request),
        headers: request.headers,
        method: request.method ?? 'GET',
        pathname: url.pathname
      })
      writeJson(
        response,
        { code: 'UNAUTHORIZED', detail: `rejected ${secret}` },
        401
      )
    })
    const { origin } = started
    const configDirectory = await createAccountServiceKeyConfig(origin)
    const token = vi.fn(() => Promise.resolve(refreshedGrant))
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['account', 'service-key', 'list', '--json', '--debug'], {
      baseUrl: origin,
      configDirectory,
      deviceScope: {
        authorize: () =>
          Promise.reject(new Error('authorize should not be called')),
        token
      },
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (code) => exitCodes.push(code),
      stderr,
      stdout
    })

    expect(exitCodes).toEqual([4])
    expect(stderr.value()).toBe('')
    expect(stderr.value()).not.toContain(secret)
    expect(stdout.value()).not.toContain(secret)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      body: '',
      method: 'GET',
      pathname: '/v1/account/service-keys'
    })
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${secret}`)
    expect(token).not.toHaveBeenCalled()
  })
})
