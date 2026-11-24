import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  REFRESH_ATTEMPT_TIMEOUT_MS,
  REFRESH_BACKOFF_BASE_MS
} from '../src/auth/constants.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW
} from './project-test-support.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

interface CapturedRequest {
  authorization?: string
  body: unknown
  route: string
}

const EXPIRED_NOW = TEST_NOW + 2 * 3_600_000

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => {
            resolve()
          })
        })
    )
  )
})

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

const rotatedGrant = {
  access_token: 'rotated-access',
  expires_in: 300,
  refresh_token: 'rotated-refresh',
  user: {
    email: 'ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const refreshBody = {
  grant_type: 'refresh_token',
  refresh_token: 'project-refresh-token'
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200
): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const serialized = Buffer.concat(chunks).toString('utf8')
  return serialized.length === 0 ? undefined : JSON.parse(serialized)
}

const answerAccount: Handler = (_request, response) => {
  writeJson(response, account)
}

// A fake API whose token endpoint answers each refresh with the next handler,
// the last one answering every refresh after it.
const fakeApi = async (...tokenHandlers: Handler[]) => {
  const requests: CapturedRequest[] = []
  let tokenRequests = 0
  const server = createServer(async (request, response) => {
    const route = `${request.method} ${request.url}`
    requests.push({
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
      body: await readJsonBody(request),
      route
    })
    if (route === 'POST /v1/auth/device/token') {
      tokenRequests += 1
      const handler =
        tokenHandlers[Math.min(tokenRequests, tokenHandlers.length) - 1]
      handler?.(request, response)
      return
    }
    if (route === 'GET /v1/account') {
      answerAccount(request, response)
      return
    }
    writeJson(response, { error: 'not_found' }, 404)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port.toString()}`,
    host: `127.0.0.1:${port.toString()}`,
    requests
  }
}

const waitUntil = async (done: () => boolean): Promise<void> => {
  while (!done()) {
    // biome-ignore lint/performance/noAwaitInLoops: real I/O settles one event-loop turn at a time while fake time stands still.
    await new Promise((resolve) => {
      setImmediate(resolve)
    })
  }
}

const advancingClock = (): PollClock => {
  let monotonicNow = 0
  return {
    now: () => monotonicNow,
    sleep: (durationMs) => {
      monotonicNow += durationMs
      return Promise.resolve()
    },
    wallNow: () => EXPIRED_NOW + monotonicNow
  }
}

const whoami = (
  baseUrl: string,
  configDirectory: string,
  clock?: PollClock
) => {
  const stdout = collector()
  const exitCodes: number[] = []
  const run = runCli(['whoami', '--json'], {
    baseUrl,
    ...(clock === undefined ? {} : { clock }),
    configDirectory,
    now: () => EXPIRED_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr: collector(),
    stdout
  })
  return { exitCodes, run, stdout }
}

const storedCredentials = async (baseUrl: string, configDirectory: string) => {
  const session = await new AuthRepository({
    apiOrigin: baseUrl,
    configDirectory,
    platform: 'linux'
  }).loadSession()
  return session?.kind === 'device'
    ? {
        accessToken: session.credentials.accessToken,
        refreshToken: session.credentials.refreshToken
      }
    : undefined
}

describe('a session refresh that fails transiently', () => {
  test('replays the same refresh token after a 504 and the command succeeds', async () => {
    const api = await fakeApi(
      (_request, response) => {
        writeJson(response, { error: 'gateway_timeout' }, 504)
      },
      (_request, response) => {
        writeJson(response, rotatedGrant)
      }
    )
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.baseUrl
    )

    const { exitCodes, run, stdout } = whoami(
      api.baseUrl,
      configDirectory,
      advancingClock()
    )
    await run

    expect(api.requests).toEqual([
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      {
        authorization: 'Bearer rotated-access',
        body: undefined,
        route: 'GET /v1/account'
      }
    ])
    expect(JSON.parse(stdout.value())).toEqual({
      accountId: 'account_123',
      email: 'ada@example.test',
      name: 'Ada Lovelace'
    })
    expect(exitCodes).toEqual([])
    await expect(
      storedCredentials(api.baseUrl, configDirectory)
    ).resolves.toEqual({
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh'
    })
  })

  test('keeps the credentials and fails as retryable when every attempt answers 503', async () => {
    const api = await fakeApi((_request, response) => {
      writeJson(response, { error: 'temporarily_unavailable' }, 503)
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.baseUrl
    )

    const { exitCodes, run, stdout } = whoami(
      api.baseUrl,
      configDirectory,
      advancingClock()
    )
    await run

    expect(api.requests).toEqual([
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: refreshBody, route: 'POST /v1/auth/device/token' }
    ])
    expect(JSON.parse(stdout.value())).toEqual({
      error: {
        code: 'AUTH_TEMPORARILY_UNAVAILABLE',
        detail: 'The refresh request did not produce a usable final response.',
        docsUrl: 'https://photon.codes/docs/cli/output#errors',
        message:
          'Photon could not refresh your session. Your credentials were preserved; retry later.',
        problem: { status: 503 },
        retryable: true,
        transportCode: 'ApiError'
      }
    })
    expect(exitCodes).toEqual([1])
    await expect(
      storedCredentials(api.baseUrl, configDirectory)
    ).resolves.toEqual({
      accessToken: 'project-access-token',
      refreshToken: 'project-refresh-token'
    })
  })

  test('ends a hung attempt at its per-attempt limit and replays the refresh token', async () => {
    let held: ServerResponse | undefined
    const api = await fakeApi(
      (_request, response) => {
        held = response
      },
      (_request, response) => {
        writeJson(response, rotatedGrant)
      }
    )
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.baseUrl
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })

    const { exitCodes, run, stdout } = whoami(api.baseUrl, configDirectory)
    await waitUntil(() => held !== undefined)
    await vi.advanceTimersByTimeAsync(REFRESH_ATTEMPT_TIMEOUT_MS)
    await waitUntil(() => vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(REFRESH_BACKOFF_BASE_MS)
    await run

    expect(api.requests.map(({ body, route }) => ({ body, route }))).toEqual([
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: undefined, route: 'GET /v1/account' }
    ])
    expect(JSON.parse(stdout.value())).toMatchObject({
      accountId: 'account_123'
    })
    expect(exitCodes).toEqual([])
  })

  test('names the host and the per-attempt limit when every attempt hangs', async () => {
    const api = await fakeApi(() => undefined)
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.baseUrl
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })

    const { exitCodes, run, stdout } = whoami(api.baseUrl, configDirectory)
    await waitUntil(() => api.requests.length === 1)
    await vi.advanceTimersByTimeAsync(REFRESH_ATTEMPT_TIMEOUT_MS)
    await waitUntil(() => vi.getTimerCount() > 0)
    await vi.advanceTimersByTimeAsync(REFRESH_BACKOFF_BASE_MS)
    await waitUntil(() => api.requests.length === 2)
    await vi.advanceTimersByTimeAsync(REFRESH_ATTEMPT_TIMEOUT_MS)
    await run

    expect(api.requests).toEqual([
      { body: refreshBody, route: 'POST /v1/auth/device/token' },
      { body: refreshBody, route: 'POST /v1/auth/device/token' }
    ])
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'AUTH_TEMPORARILY_UNAVAILABLE',
        detail: `${api.host} didn't answer within 10 seconds.`,
        retryable: true,
        transportCode: 'TimeoutError'
      }
    })
    expect(exitCodes).toEqual([1])
  })
})
