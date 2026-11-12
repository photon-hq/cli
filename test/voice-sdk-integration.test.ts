import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
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
  searchParams: URLSearchParams
}

const servers: ReturnType<typeof createServer>[] = []
const projectId = 'pho_prj_01h455vb4pex5vsknk084sn02q'
const profileId = 'pho_vpf_01h455vb4pex5vsknk084sn02q'
const otherProfileId = 'pho_vpf_01h455vb4pex5vsknk084sn02r'
const timestamp = '2026-08-28T03:00:00.000Z'
const firstPassword = 'first-wire-password'
const rotatedPassword = 'rotated-wire-password'

const profile = (isDefault: boolean, version = 9) => ({
  configuration: {
    inbound: {
      credentials: { username: 'inbound-user' },
      destinationUri: 'sips:agent@example.test:5061'
    },
    outbound: {
      authentication: {
        algorithm: 'sha-256' as const,
        previousPasswordValidUntil: null,
        username: 'outbound-user',
        validFrom: timestamp
      },
      connection: {
        endpoints: [
          {
            host: 'sip.example.test',
            port: 5071,
            transport: 'tls' as const
          }
        ],
        realm: 'sip.example.test'
      }
    }
  },
  createdAt: timestamp,
  isDefault,
  lineCount: 2,
  mediaEncryption: 'auto' as const,
  name: 'Production agent',
  profileId,
  projectId,
  protocol: 'sip' as const,
  updatedAt: timestamp,
  version
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
    'x-request-id': 'request_voice_integration'
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

describe('generated Voice SDK integration', () => {
  test.each([
    {
      algorithm: 'md5',
      before: 'sha-256',
      conflict: undefined,
      reference: 'default'
    },
    {
      algorithm: 'sha-256',
      before: 'md5',
      conflict: undefined,
      reference: profileId
    },
    {
      algorithm: 'md5',
      before: 'md5',
      conflict: undefined,
      reference: 'default'
    },
    {
      algorithm: 'sha-256',
      before: 'sha-256',
      conflict: 'VOICE_PROFILE_VERSION_CONFLICT',
      reference: profileId
    },
    {
      algorithm: 'md5',
      before: 'sha-256',
      conflict: 'VOICE_OUTBOUND_OPERATION_PENDING',
      reference: 'default'
    }
  ] as const)(
    'PATCHes $reference from $before to $algorithm with conflict=$conflict',
    async ({ before, algorithm, reference, conflict }) => {
      const captured: CapturedRequest[] = []
      const profilesPath = `/v1/projects/${projectId}/platforms/voice/profiles`
      const current = profile(reference === 'default', 21)
      const currentOutbound = current.configuration.outbound
      const updatedOutbound = {
        authentication: {
          ...currentOutbound.authentication,
          algorithm,
          previousPasswordValidUntil: timestamp
        },
        connection: {
          endpoints: [
            { host: 'sip.example.test', port: 5060, transport: 'udp' },
            { host: 'sip.example.test', port: 5060, transport: 'tcp' },
            { host: 'sip.example.test', port: 5071, transport: 'tls' }
          ],
          realm: 'sip.example.test'
        }
      }
      const profileVersion = before === algorithm ? 21 : 22
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        captured.push({
          body: await readBody(request),
          headers: request.headers,
          method: request.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams
        })
        if (
          request.method === 'GET' &&
          url.pathname === `${profilesPath}/${reference}`
        ) {
          writeJson(response, {
            ...current,
            configuration: {
              ...current.configuration,
              outbound: {
                ...updatedOutbound,
                authentication: {
                  ...currentOutbound.authentication,
                  algorithm: before,
                  previousPasswordValidUntil: timestamp
                }
              }
            }
          })
          return
        }
        if (
          request.method === 'PATCH' &&
          url.pathname === `${profilesPath}/${profileId}/outbound`
        ) {
          if (conflict !== undefined) {
            writeJson(
              response,
              { code: conflict, status: 409, title: 'Conflict' },
              409
            )
            return
          }
          writeJson(response, { outbound: updatedOutbound, profileVersion })
          return
        }
        writeJson(response, { code: 'NOT_FOUND' }, 404)
      })
      servers.push(server)
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${address.port.toString()}`
      const authenticated = await createAuthenticatedConfig('user_ada', origin)
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []

      await runCli(
        [
          'project',
          'platform',
          'voice',
          'profile',
          'outbound',
          'edit',
          reference,
          '--digest-algorithm',
          algorithm,
          '--yes',
          '--project',
          projectId,
          '--json'
        ],
        {
          baseUrl: origin,
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )

      expect(
        captured.map((request) => ({
          body: request.body === '' ? undefined : JSON.parse(request.body),
          idempotencyKey: request.headers['idempotency-key'],
          method: request.method,
          pathname: request.pathname,
          query: Object.fromEntries(request.searchParams)
        }))
      ).toEqual([
        {
          body: undefined,
          idempotencyKey: undefined,
          method: 'GET',
          pathname: `${profilesPath}/${reference}`,
          query: {}
        },
        {
          body: { authentication: { algorithm }, expectedVersion: 21 },
          idempotencyKey: undefined,
          method: 'PATCH',
          pathname: `${profilesPath}/${profileId}/outbound`,
          query: {}
        }
      ])
      expect(
        captured.every(
          (request) =>
            request.headers.authorization === 'Bearer project-access-token'
        )
      ).toBe(true)
      if (conflict === undefined) {
        expect(exitCodes).toEqual([])
        expect(JSON.parse(stdout.value())).toEqual({
          outbound: updatedOutbound,
          profileVersion
        })
        expect(stderr.value()).toBe('')
      } else {
        expect(exitCodes).toEqual([1])
        expect(stderr.value()).toBe('')
        expect(JSON.parse(stdout.value())).toMatchObject({
          error: { code: conflict }
        })
        expect(JSON.parse(stdout.value()).error).not.toHaveProperty('next')
      }
      expect(stdout.value()).not.toContain('"password"')
      expect(stderr.value()).not.toContain('display-once')
      expect(stdout.value()).not.toContain('display-once')
    }
  )

  test.each([
    { answered: profileId, command: 'enable' },
    { answered: otherProfileId, command: 'enable' },
    { answered: profileId, command: 'rotate' },
    { answered: otherProfileId, command: 'rotate' }
  ] as const)(
    'sends outbound $command only to the profile ID given when Photon reads $answered',
    async ({ answered, command }) => {
      const captured: CapturedRequest[] = []
      const profilesPath = `/v1/projects/${projectId}/platforms/voice/profiles`
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        captured.push({
          body: await readBody(request),
          headers: request.headers,
          method: request.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams
        })
        if (request.method === 'GET') {
          writeJson(response, { ...profile(false), profileId: answered })
          return
        }
        if (request.method === 'PUT') {
          writeJson(response, {
            outbound: profile(false).configuration.outbound,
            password: firstPassword,
            profileVersion: 10
          })
          return
        }
        writeJson(response, {
          password: rotatedPassword,
          previousPasswordValidUntil: null,
          profileVersion: 10
        })
      })
      servers.push(server)
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address() as AddressInfo
      const origin = `http://127.0.0.1:${address.port.toString()}`
      const authenticated = await createAuthenticatedConfig('user_ada', origin)
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []

      await runCli(
        [
          'project',
          'platform',
          'voice',
          'profile',
          'outbound',
          command,
          profileId,
          ...(command === 'rotate' ? ['--yes'] : []),
          '--project',
          projectId,
          '--json'
        ],
        {
          baseUrl: origin,
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          setExitCode: (code) => exitCodes.push(code),
          stderr,
          stdout
        }
      )

      const change =
        command === 'enable'
          ? { method: 'PUT', pathname: `${profilesPath}/${profileId}/outbound` }
          : {
              method: 'POST',
              pathname: `${profilesPath}/${profileId}/outbound/rotate`
            }
      expect(
        captured.map((request) => ({
          method: request.method,
          pathname: request.pathname
        }))
      ).toEqual([
        { method: 'GET', pathname: `${profilesPath}/${profileId}` },
        ...(answered === profileId ? [change] : [])
      ])
      if (answered === profileId) {
        expect(exitCodes).toEqual([])
      } else {
        expect(exitCodes).toEqual([1])
        expect(JSON.parse(stdout.value())).toMatchObject({
          error: {
            code: 'VOICE_PROTOCOL_ERROR',
            message: `Photon returned another Voice profile for ${profileId}. No change was made.`
          }
        })
      }
      await authenticated.remove()
    }
  )

  test('uses every directional route, method, version, and idempotency shape', async () => {
    const captured: CapturedRequest[] = []
    let origin = ''
    const profilesPath = `/v1/projects/${projectId}/platforms/voice/profiles`
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', origin)
      captured.push({
        body: await readBody(request),
        headers: request.headers,
        method: request.method ?? 'GET',
        pathname: url.pathname,
        searchParams: new URLSearchParams(url.searchParams)
      })

      if (
        request.method === 'GET' &&
        url.pathname === `${profilesPath}/default`
      ) {
        writeJson(response, profile(true))
        return
      }
      if (
        request.method === 'GET' &&
        url.pathname === `${profilesPath}/${profileId}`
      ) {
        writeJson(response, profile(false))
        return
      }
      if (
        request.method === 'PATCH' &&
        url.pathname === `${profilesPath}/${profileId}`
      ) {
        writeJson(response, { ...profile(false, 10), name: 'Renamed agent' })
        return
      }
      if (
        (request.method === 'PUT' || request.method === 'PATCH') &&
        url.pathname.endsWith('/inbound')
      ) {
        writeJson(response, {
          inbound: profile(true).configuration.inbound,
          profileVersion: 10
        })
        return
      }
      if (request.method === 'DELETE' && url.pathname.endsWith('/inbound')) {
        writeJson(response, { inbound: null, profileVersion: 10 })
        return
      }
      if (request.method === 'PUT' && url.pathname.endsWith('/outbound')) {
        writeJson(response, {
          outbound: profile(true).configuration.outbound,
          password: firstPassword,
          profileVersion: 10
        })
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname.endsWith('/outbound/rotate')
      ) {
        writeJson(response, {
          password: rotatedPassword,
          previousPasswordValidUntil: null,
          profileVersion: 10
        })
        return
      }
      if (request.method === 'DELETE' && url.pathname.endsWith('/outbound')) {
        writeJson(response, { outbound: null, profileVersion: 10 })
        return
      }
      writeJson(response, { code: 'NOT_FOUND' }, 404)
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
    ): Promise<{ exitCodes: number[]; stderr: string; stdout: string }> => {
      const exitCodes: number[] = []
      const stderr = collector()
      const stdout = collector()
      await runCli([...args, '--project', projectId, '--json'], {
        baseUrl: origin,
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })
      return {
        exitCodes,
        stderr: stderr.value(),
        stdout: stdout.value()
      }
    }

    const results = [
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'edit',
        profileId,
        '--name',
        'Renamed agent'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'inbound',
        'set',
        'default',
        '--sip-uri',
        'sips:replacement@example.test:5061',
        '--yes'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'inbound',
        'edit',
        'default',
        '--clear-sip-credentials',
        '--yes'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'inbound',
        'clear',
        'default',
        '--yes'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'enable',
        'default',
        '--idempotency-key',
        'enable-wire-1'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'rotate',
        'default',
        '--mode',
        'emergency',
        '--idempotency-key',
        'rotate-wire-1',
        '--yes'
      ]),
      await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'revoke',
        'default',
        '--yes'
      ])
    ] as const

    expect(results.map((result) => result.exitCodes)).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
      []
    ])
    expect(results[4].stdout).toContain(firstPassword)
    expect(results[4].stdout).toContain('sha-256')
    expect(results[4].stdout).toContain('tls')
    expect(results[4].stderr).not.toContain(firstPassword)
    expect(results[5].stdout).toContain(rotatedPassword)
    expect(results[5].stderr).not.toContain(rotatedPassword)

    const mutations = captured.filter((request) => request.method !== 'GET')
    expect(
      mutations.map((request) => ({
        body: request.body === '' ? undefined : JSON.parse(request.body),
        idempotencyKey: request.headers['idempotency-key'],
        method: request.method,
        pathname: request.pathname,
        query: Object.fromEntries(request.searchParams)
      }))
    ).toEqual([
      {
        body: { expectedVersion: 9, name: 'Renamed agent' },
        idempotencyKey: undefined,
        method: 'PATCH',
        pathname: `${profilesPath}/${profileId}`,
        query: {}
      },
      {
        body: {
          credentials: null,
          destinationUri: 'sips:replacement@example.test:5061',
          expectedVersion: 9
        },
        idempotencyKey: undefined,
        method: 'PUT',
        pathname: `${profilesPath}/${profileId}/inbound`,
        query: {}
      },
      {
        body: { credentials: null, expectedVersion: 9 },
        idempotencyKey: undefined,
        method: 'PATCH',
        pathname: `${profilesPath}/${profileId}/inbound`,
        query: {}
      },
      {
        body: undefined,
        idempotencyKey: undefined,
        method: 'DELETE',
        pathname: `${profilesPath}/${profileId}/inbound`,
        query: { expectedVersion: '9' }
      },
      {
        body: {
          authentication: { algorithm: 'sha-256' },
          expectedVersion: 9
        },
        idempotencyKey: 'enable-wire-1',
        method: 'PUT',
        pathname: `${profilesPath}/${profileId}/outbound`,
        query: {}
      },
      {
        body: { expectedVersion: 9, mode: 'emergency' },
        idempotencyKey: 'rotate-wire-1',
        method: 'POST',
        pathname: `${profilesPath}/${profileId}/outbound/rotate`,
        query: {}
      },
      {
        body: undefined,
        idempotencyKey: undefined,
        method: 'DELETE',
        pathname: `${profilesPath}/${profileId}/outbound`,
        query: { expectedVersion: '9' }
      }
    ])
    expect(
      captured.every(
        (request) =>
          request.headers.authorization === 'Bearer project-access-token'
      )
    ).toBe(true)
  })
})
