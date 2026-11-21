import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Photon } from '@photon-ai/api'
import { afterEach, describe, expect, test } from 'vitest'
import type { PollClock } from '../src/auth/device-flow.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { captureApiVersions } from './api-version-test-support.ts'
import { createAuthenticatedConfig, TEST_NOW } from './project-test-support.ts'

interface CapturedRequest {
  authorization?: string
  body: unknown
  method?: string
  url?: string
  versions: string[]
}

const servers: ReturnType<typeof createServer>[] = []
const temporaryDirectories: string[] = []
const wallClock = Date.parse('2026-07-30T20:00:00.000Z')

const account = {
  accountId: 'account_123',
  createdAt: null,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: null
}

const collector = (): WritableOutput & { value: () => string } => {
  let contents = ''
  return {
    value: () => contents,
    write: (chunk) => {
      contents += chunk
    }
  }
}

const clock = (): PollClock => {
  let monotonicNow = 0
  return {
    now: () => monotonicNow,
    sleep: (durationMs) => {
      monotonicNow += durationMs
      return Promise.resolve()
    },
    wallNow: () => wallClock + monotonicNow
  }
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const serialized = Buffer.concat(chunks).toString('utf8')
  return serialized.length === 0 ? undefined : JSON.parse(serialized)
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'req_sdk_contract'
  })
  response.end(JSON.stringify(body))
}

const listen = async (
  server: ReturnType<typeof createServer>
): Promise<string> => {
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('generated Photon SDK integration', () => {
  test('follows same-origin redirects without dropping authorization', async () => {
    const requests: CapturedRequest[] = []
    const server = createServer((request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        body: undefined,
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
        versions: request.headersDistinct['photon-version'] ?? []
      })

      if (request.url === '/v1/projects/pho_prj_00000000000000000000000109') {
        response.writeHead(307, { location: '/redirected/project' })
        response.end()
        return
      }

      if (request.url === '/redirected/project') {
        writeJson(response, {
          agentProfile: {
            avatarUrl: 'https://images.example.test/redirected-project.png',
            firstName: 'Redirected',
            lastName: null
          },
          createdAt: '2026-08-08T18:00:00.000Z',
          createdByAccountId: 'account_owner',
          createdByActorId: 'account_owner',
          createdByActorKind: 'account',
          deletedAt: null,
          flags: [],
          name: 'Redirected Project',
          organizationId: 'pho_org_00000000000000000000000001',
          projectId: 'pho_prj_00000000000000000000000109',
          slug: 'redirected-project',
          updatedAt: '2026-08-08T18:00:00.000Z'
        })
        return
      }

      writeJson(response, { error: 'not_found' }, 404)
    })
    const photon = new Photon({
      baseUrl: await listen(server),
      headers: { authorization: 'Bearer redirect-token' },
      retry: false
    })

    await expect(
      photon.projects.get({
        path: { projectId: 'pho_prj_00000000000000000000000109' }
      })
    ).resolves.toMatchObject({
      projectId: 'pho_prj_00000000000000000000000109'
    })
    expect(requests).toEqual([
      {
        authorization: 'Bearer redirect-token',
        body: undefined,
        method: 'GET',
        url: '/v1/projects/pho_prj_00000000000000000000000109',
        versions: []
      },
      {
        authorization: 'Bearer redirect-token',
        body: undefined,
        method: 'GET',
        url: '/redirected/project',
        versions: []
      }
    ])
  })

  test('uses generated device and account scopes with exact wire shapes', async () => {
    const requests: CapturedRequest[] = []
    let authorizationCount = 0
    const server = createServer(async (request, response) => {
      try {
        const body = await readJsonBody(request)
        requests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
          versions: request.headersDistinct['photon-version'] ?? []
        })

        if (request.url === '/v1/auth/device/code') {
          authorizationCount += 1
          const denied = authorizationCount > 1
          writeJson(response, {
            device_code: denied ? 'denied-device' : 'private-device',
            expires_in: 600,
            interval: 1,
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.example.test/device',
            verification_uri_complete:
              'https://auth.example.test/device?user_code=ABCD-EFGH'
          })
          return
        }

        if (request.url === '/v1/auth/device/token') {
          if (
            typeof body === 'object' &&
            body !== null &&
            'device_code' in body &&
            body.device_code === 'denied-device'
          ) {
            writeJson(response, { error: 'access_denied' }, 400)
            return
          }

          const refreshing =
            typeof body === 'object' &&
            body !== null &&
            'grant_type' in body &&
            body.grant_type === 'refresh_token'
          writeJson(response, {
            access_token: refreshing ? 'rotated-access' : 'initial-access',
            expires_in: 300,
            refresh_token: refreshing ? 'rotated-refresh' : 'initial-refresh',
            user: {
              email: 'ada@example.test',
              first_name: 'Ada',
              id: 'user_ada',
              last_name: 'Lovelace'
            }
          })
          return
        }

        if (request.url === '/v1/account') {
          const accountRequests = requests.filter(
            (captured) => captured.url === '/v1/account'
          )
          if (accountRequests.length === 1) {
            writeJson(response, { code: 'UNAUTHORIZED' }, 401)
            return
          }
          writeJson(response, account)
          return
        }

        writeJson(response, { error: 'not_found' }, 404)
      } catch {
        writeJson(response, { error: 'invalid_json' }, 400)
      }
    })
    const baseUrl = await listen(server)
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-sdk-'))
    temporaryDirectories.push(configDirectory)
    const exitCodes: number[] = []

    const loginStdout = collector()
    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      baseUrl,
      clock: clock(),
      configDirectory,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: loginStdout
    })
    expect(JSON.parse(loginStdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      email: 'ada@example.test'
    })

    const whoamiStdout = collector()
    await runCli(['whoami', '--json'], {
      baseUrl,
      configDirectory,
      now: () => wallClock + 120_000,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: whoamiStdout
    })
    expect(JSON.parse(whoamiStdout.value())).toEqual({
      accountId: 'account_123',
      email: 'ada@example.test',
      name: 'Ada Lovelace'
    })

    const deniedStdout = collector()
    await runCli(['login', '--force', '--no-browser', '--json'], {
      baseUrl,
      clock: clock(),
      configDirectory,
      now: () => wallClock + 120_000,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: deniedStdout
    })
    expect(JSON.parse(deniedStdout.value())).toEqual({
      error: {
        code: 'AUTH_ACCESS_DENIED',
        docsUrl: 'https://photon.codes/docs/cli/output#errors',
        message: 'Login was denied in the browser.',
        requestId: 'req_sdk_contract',
        retryable: false
      }
    })
    expect(exitCodes).toEqual([1])

    expect(requests).toEqual([
      {
        body: undefined,
        method: 'POST',
        url: '/v1/auth/device/code',
        versions: []
      },
      {
        body: {
          device_code: 'private-device',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        method: 'POST',
        url: '/v1/auth/device/token',
        versions: []
      },
      {
        authorization: 'Bearer initial-access',
        body: undefined,
        method: 'GET',
        url: '/v1/account',
        versions: ['2026-07-01']
      },
      {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'initial-refresh'
        },
        method: 'POST',
        url: '/v1/auth/device/token',
        versions: []
      },
      {
        authorization: 'Bearer rotated-access',
        body: undefined,
        method: 'GET',
        url: '/v1/account',
        versions: ['2026-07-01']
      },
      {
        body: undefined,
        method: 'POST',
        url: '/v1/auth/device/code',
        versions: []
      },
      {
        body: {
          device_code: 'denied-device',
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        method: 'POST',
        url: '/v1/auth/device/token',
        versions: []
      }
    ])
  })

  test.each([
    {
      env: {},
      exitCodes: [],
      expectedOutput: { accountId: account.accountId },
      name: 'sends the default once on each SDK attempt',
      responses: [
        { body: { code: 'UPSTREAM_UNAVAILABLE' }, status: 503 },
        { body: account, status: 200 }
      ],
      versions: [['2026-07-01'], ['2026-07-01']]
    },
    {
      env: { PHOTON_API_VERSION: '1999-01-01' },
      exitCodes: [1],
      expectedOutput: { error: { code: 'INVALID_API_VERSION' } },
      name: 'sends the environment override unchanged without retrying a 400',
      responses: [{ body: { code: 'INVALID_API_VERSION' }, status: 400 }],
      versions: [['1999-01-01']]
    },
    {
      env: { PHOTON_API_VERSION: '' },
      exitCodes: [],
      expectedOutput: { accountId: account.accountId },
      name: 'uses the default when the environment override is empty',
      responses: [{ body: account, status: 200 }],
      versions: [['2026-07-01']]
    },
    {
      env: { PHOTON_API_VERSION: ' 2026-07-01 ' },
      exitCodes: [],
      expectedOutput: { accountId: account.accountId },
      name: 'trims the environment override',
      responses: [{ body: account, status: 200 }],
      versions: [['2026-07-01']]
    }
  ])(
    '$name',
    async ({ env, exitCodes, expectedOutput, responses, versions }) => {
      let attempts = 0
      const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/v1/account') {
          writeJson(response, { code: 'NOT_FOUND' }, 404)
          return
        }
        attempts += 1
        const result = responses[attempts - 1] ?? responses.at(-1)
        if (result?.status === 503) {
          response.setHeader('Retry-After', '0')
        }
        writeJson(response, result?.body, result?.status ?? 500)
      })
      const captured = captureApiVersions(server)
      const baseUrl = await listen(server)
      const { configDirectory } = await createAuthenticatedConfig(
        'user_ada',
        baseUrl
      )
      const stdout = collector()
      const actualExitCodes: number[] = []
      await runCli(['whoami', '--json'], {
        baseUrl,
        configDirectory,
        env,
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (code) => actualExitCodes.push(code),
        stderr: collector(),
        stdout
      })
      expect(captured).toEqual(
        versions.map((headers) => ({
          method: 'GET',
          url: '/v1/account',
          versions: headers
        }))
      )
      expect(actualExitCodes).toEqual(exitCodes)
      expect(JSON.parse(stdout.value())).toMatchObject(expectedOutput)
    }
  )
})
