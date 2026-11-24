import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApiError,
  type DeviceTokenOutput,
  TransportError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  API_ORIGIN,
  AUTH_LOCK_ACQUISITION_TIMEOUT_MS,
  REFRESH_ATTEMPT_TIMEOUT_MS,
  REFRESH_MAX_ATTEMPTS,
  REFRESH_RETRY_BUDGET_MS
} from '../src/auth/constants.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { TokenManager } from '../src/auth/token-manager.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { CLI_NAME } from '../src/meta.ts'

const temporaryDirectories: string[] = []
const now = Date.parse('2026-07-30T20:00:00.000Z')
const WORKOS_REPLAY_WINDOW_MS = 30_000

const refreshedGrant: DeviceTokenOutput = {
  access_token: 'new-access-token',
  expires_in: 300,
  refresh_token: 'new-refresh-token',
  user: {
    email: 'grace@example.test',
    first_name: 'Grace',
    id: 'user_grace',
    last_name: 'Hopper'
  }
}

const createRepository = async (
  accessTokenExpiresAt: number
): Promise<AuthRepository> => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'photon-token-'))
  temporaryDirectories.push(configDirectory)
  const repository = new AuthRepository({
    configDirectory,
    platform: 'linux'
  })
  const backend = await repository.prepareLoginBackend(true, undefined)
  const metadata = repository.createMetadata(backend, {
    email: 'grace@example.test',
    id: 'user_grace',
    name: 'Grace Hopper'
  })
  const credentials = repository.createCredential(
    'old-access-token',
    'old-refresh-token',
    new Date(accessTokenExpiresAt)
  )
  await repository.withLock(async () => {
    await repository.persistSessionLocked(
      credentials,
      metadata,
      backend.backend
    )
  })
  return repository
}

const deviceScope = (token: DeviceAuthScope['token']): DeviceAuthScope => ({
  authorize: () => Promise.reject(new Error('authorize should not be called')),
  token
})

const instantClock = (): Pick<PollClock, 'now' | 'sleep'> => ({
  now: () => 0,
  sleep: () => Promise.resolve()
})

const tokenEndpointError = (
  status: number,
  headers: Record<string, string> = {}
): ApiError =>
  new ApiError('token endpoint failed', {
    body: { error: 'server_error' },
    headers: new Headers(headers),
    operationId: 'deviceToken',
    status
  })

const hangUntilAborted = (
  options: { signal?: AbortSignal } | undefined
): Promise<never> =>
  new Promise((_resolve, reject) => {
    options?.signal?.addEventListener(
      'abort',
      () => {
        reject(
          new TransportError('Photon request failed', {
            cause: options.signal?.reason
          })
        )
      },
      { once: true }
    )
  })

const realTurn = async (): Promise<void> =>
  await new Promise((resolve) => {
    setImmediate(resolve)
  })

const settleWithFakeTime = async <Result>(
  promise: Promise<Result>,
  stepMs = 10
): Promise<PromiseSettledResult<Result>> => {
  let outcome: PromiseSettledResult<Result> | undefined
  promise.then(
    (value) => {
      outcome = { status: 'fulfilled', value }
    },
    (reason: unknown) => {
      outcome = { reason, status: 'rejected' }
    }
  )
  while (outcome === undefined) {
    // biome-ignore lint/performance/noAwaitInLoops: fake time advances one step at a time.
    await realTurn()
    const fileOperationInFlight = process
      .getActiveResourcesInfo()
      .some((resource) => resource.startsWith('FSReq'))
    if (!fileOperationInFlight) {
      await vi.advanceTimersByTimeAsync(stepMs)
    }
  }
  return outcome
}

const useFakeRefreshTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
  })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('token manager', () => {
  test('loads a valid session only once per manager', async () => {
    const repository = await createRepository(now + 120_000)
    const loadSession = vi.spyOn(repository, 'loadSession')
    const manager = new TokenManager({
      device: deviceScope(() => Promise.resolve(refreshedGrant)),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    expect(loadSession).toHaveBeenCalledTimes(1)
  })

  test('persists both members of a rotated token pair', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi.fn(() => Promise.resolve(refreshedGrant))
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).resolves.toBe('new-access-token')

    const session = await repository.loadSession()
    expect(session?.credentials).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token'
    })
    expect(refresh).toHaveBeenCalledWith(
      {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh-token'
        }
      },
      { signal: expect.any(AbortSignal) }
    )
  })

  test('allows only one refresh across concurrent managers', async () => {
    const repository = await createRepository(now + 30_000)
    const refresh = vi.fn(() => Promise.resolve(refreshedGrant))
    const first = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })
    const second = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(
      Promise.all([first.getAccessToken(), second.getAccessToken()])
    ).resolves.toEqual(['new-access-token', 'new-access-token'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('reuses credentials refreshed by another process after a 401', async () => {
    const repository = await createRepository(now + 120_000)
    const refresh = vi.fn(() => Promise.resolve(refreshedGrant))
    const first = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })
    const second = new TokenManager({
      device: deviceScope(refresh),
      now: () => now + 70_000,
      repository
    })

    await expect(first.getAccessToken()).resolves.toBe('old-access-token')
    await expect(second.getAccessToken()).resolves.toBe('new-access-token')
    await expect(first.refreshAfterUnauthorized()).resolves.toBe(
      'new-access-token'
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('requires login when rotated credentials cannot be persisted', async () => {
    const repository = await createRepository(now - 1000)
    vi.spyOn(repository, 'persistSessionLocked').mockRejectedValueOnce(
      new Error('disk unavailable')
    )
    const manager = new TokenManager({
      device: deviceScope(() => Promise.resolve(refreshedGrant)),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_PERSISTENCE_FAILED',
      message: expect.stringContaining(`${CLI_NAME} login`)
    })
  })

  test('deletes credentials after a definitive invalid_grant', async () => {
    const repository = await createRepository(now - 1000)
    const invalidGrant = new ApiError('invalid grant', {
      body: { error: 'invalid_grant' },
      headers: new Headers(),
      operationId: 'deviceToken',
      status: 400
    })
    const manager = new TokenManager({
      device: deviceScope(() => Promise.reject(invalidGrant)),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED'
    })
    await expect(repository.loadSession()).resolves.toBeUndefined()
  })

  test('preserves a still-valid access token after a transient refresh failure', async () => {
    const repository = await createRepository(now + 30_000)
    const refresh = vi.fn(() => Promise.reject(new TransportError('offline')))
    const manager = new TokenManager({
      clock: instantClock(),
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    await expect(manager.refreshAfterUnauthorized()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    expect(refresh).toHaveBeenCalledTimes(REFRESH_MAX_ATTEMPTS)
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token'
      }
    })
  })

  test('retains credentials but fails when a transient error outlives access', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi.fn(() => Promise.reject(new TransportError('offline')))
    const manager = new TokenManager({
      clock: instantClock(),
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    expect(refresh).toHaveBeenCalledTimes(REFRESH_MAX_ATTEMPTS)
    await expect(repository.loadSession()).resolves.toBeDefined()
  })

  test('throws the cancellation, not a connection error, once the refresh is cancelled', async () => {
    const repository = await createRepository(now - 1000)
    const controller = new AbortController()
    const cancelled = new Error('cancelled')
    const refresh = vi.fn(() => {
      controller.abort(cancelled)
      return Promise.reject(new TransportError('request aborted'))
    })
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository,
      signal: controller.signal
    })

    await expect(manager.getAccessToken()).rejects.toBe(cancelled)
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { refreshToken: 'old-refresh-token' }
    })
  })

  test('preserves credentials when the server rejects a refresh', async () => {
    const repository = await createRepository(now - 1000)
    const rejected = new ApiError('invalid request', {
      body: { error: 'invalid_request' },
      headers: new Headers(),
      operationId: 'deviceToken',
      requestId: 'req_refresh',
      status: 400
    })
    const manager = new TokenManager({
      device: deviceScope(() => Promise.reject(rejected)),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_REFRESH_FAILED',
      requestId: 'req_refresh'
    })
    await expect(repository.loadSession()).resolves.toBeDefined()
  })

  test('refuses a refreshed grant with an invalid email and keeps the stored session', async () => {
    const repository = await createRepository(now - 1000)
    const manager = new TokenManager({
      device: deviceScope(() =>
        Promise.resolve({
          ...refreshedGrant,
          user: { ...refreshedGrant.user, email: 'grace.example.test' }
        })
      ),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_ERROR'
    })
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { refreshToken: 'old-refresh-token' },
      metadata: { cachedUser: { email: 'grace@example.test' } }
    })
  })
})

describe('token refresh retry', () => {
  test('keeps every attempt inside the replay window and the lock wait above the refresh', () => {
    expect(REFRESH_ATTEMPT_TIMEOUT_MS).toBeLessThan(REFRESH_RETRY_BUDGET_MS)
    expect(REFRESH_RETRY_BUDGET_MS).toBeLessThan(WORKOS_REPLAY_WINDOW_MS)
    expect(AUTH_LOCK_ACQUISITION_TIMEOUT_MS).toBeGreaterThan(
      REFRESH_RETRY_BUDGET_MS + REFRESH_ATTEMPT_TIMEOUT_MS
    )
  })

  test('replays the same refresh token after a 504 and stores the new pair', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi
      .fn<DeviceAuthScope['token']>()
      .mockRejectedValueOnce(tokenEndpointError(504))
      .mockResolvedValueOnce(refreshedGrant)
    const manager = new TokenManager({
      clock: instantClock(),
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).resolves.toBe('new-access-token')

    expect(refresh.mock.calls.map(([input]) => input)).toEqual([
      {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh-token'
        }
      },
      {
        body: {
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh-token'
        }
      }
    ])
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token'
      }
    })
  })

  test('spaces three attempts with jittered exponential backoff', async () => {
    const repository = await createRepository(now - 1000)
    useFakeRefreshTimers()
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75)
    const starts: number[] = []
    const refresh = vi.fn<DeviceAuthScope['token']>(() => {
      starts.push(performance.now())
      return Promise.reject(tokenEndpointError(503))
    })
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    const outcome = await settleWithFakeTime(manager.getAccessToken())

    expect(outcome).toMatchObject({
      reason: { code: 'AUTH_TEMPORARILY_UNAVAILABLE', retryable: true },
      status: 'rejected'
    })
    expect(starts.map((start) => start - (starts[0] ?? 0))).toEqual([
      0, 250, 1750
    ])
  })

  test('replays after a first attempt that hangs until its per-attempt limit', async () => {
    const repository = await createRepository(now - 1000)
    useFakeRefreshTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const starts: number[] = []
    const refresh = vi
      .fn<DeviceAuthScope['token']>((_input, options) => {
        starts.push(performance.now())
        return hangUntilAborted(options)
      })
      .mockImplementationOnce((_input, options) => {
        starts.push(performance.now())
        return hangUntilAborted(options)
      })
      .mockImplementationOnce(() => {
        starts.push(performance.now())
        return Promise.resolve(refreshedGrant)
      })
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    const outcome = await settleWithFakeTime(manager.getAccessToken())

    expect(outcome).toEqual({ status: 'fulfilled', value: 'new-access-token' })
    expect(starts.map((start) => start - (starts[0] ?? 0))).toEqual([
      0,
      REFRESH_ATTEMPT_TIMEOUT_MS + 500
    ])
    expect(refresh.mock.calls.map(([input]) => input.body)).toEqual([
      { grant_type: 'refresh_token', refresh_token: 'old-refresh-token' },
      { grant_type: 'refresh_token', refresh_token: 'old-refresh-token' }
    ])
  })

  test('makes no attempt that would start more than 20 seconds after the first', async () => {
    const repository = await createRepository(now - 1000)
    useFakeRefreshTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const starts: number[] = []
    const refresh = vi.fn<DeviceAuthScope['token']>((_input, options) => {
      starts.push(performance.now())
      return hangUntilAborted(options)
    })
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    const outcome = await settleWithFakeTime(manager.getAccessToken())

    expect(starts.map((start) => start - (starts[0] ?? 0))).toEqual([
      0,
      REFRESH_ATTEMPT_TIMEOUT_MS + 500
    ])
    expect(outcome).toMatchObject({
      reason: {
        code: 'AUTH_TEMPORARILY_UNAVAILABLE',
        detail: `${new URL(API_ORIGIN).host} didn't answer within 10 seconds.`,
        retryable: true,
        transportCode: 'TimeoutError'
      },
      status: 'rejected'
    })
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { refreshToken: 'old-refresh-token' }
    })
  })

  test('honors a Retry-After that fits in the budget', async () => {
    const repository = await createRepository(now - 1000)
    useFakeRefreshTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const starts: number[] = []
    const refresh = vi
      .fn<DeviceAuthScope['token']>(() => {
        starts.push(performance.now())
        return Promise.resolve(refreshedGrant)
      })
      .mockImplementationOnce(() => {
        starts.push(performance.now())
        return Promise.reject(tokenEndpointError(429, { 'retry-after': '5' }))
      })
    const manager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    const outcome = await settleWithFakeTime(manager.getAccessToken())

    expect(outcome).toEqual({ status: 'fulfilled', value: 'new-access-token' })
    expect(starts.map((start) => start - (starts[0] ?? 0))).toEqual([0, 5000])
  })

  test('fails at once when a Retry-After would start the next attempt after the budget', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(tokenEndpointError(503, { 'retry-after': '30' }))
    )
    const sleep = vi.fn<PollClock['sleep']>(() => Promise.resolve())
    const manager = new TokenManager({
      clock: { now: () => 0, sleep },
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE',
      retryAfterSeconds: 30,
      retryable: true
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  test('makes no attempt when the backoff wakes after the budget', async () => {
    const repository = await createRepository(now - 1000)
    let monotonicNow = 0
    const refresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(tokenEndpointError(503, { 'retry-after': '20' }))
    )
    const manager = new TokenManager({
      clock: {
        now: () => monotonicNow,
        sleep: (durationMs) => {
          monotonicNow += durationMs + 100
          return Promise.resolve()
        }
      },
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('never retries invalid_grant', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(
        new ApiError('invalid grant', {
          body: { error: 'invalid_grant' },
          headers: new Headers(),
          operationId: 'deviceToken',
          status: 400
        })
      )
    )
    const manager = new TokenManager({
      clock: instantClock(),
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED'
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('never retries invalid_grant, even with a 5xx status', async () => {
    const repository = await createRepository(now - 1000)
    const refresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(
        new ApiError('invalid grant', {
          body: { error: 'invalid_grant' },
          headers: new Headers(),
          operationId: 'deviceToken',
          status: 503
        })
      )
    )
    const manager = new TokenManager({
      clock: instantClock(),
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED'
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('stops retrying with the cancellation when the command is cancelled during the backoff', async () => {
    const repository = await createRepository(now - 1000)
    const controller = new AbortController()
    const cancelled = new Error('cancelled')
    const refresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(tokenEndpointError(503))
    )
    const manager = new TokenManager({
      clock: {
        now: () => 0,
        sleep: () => {
          controller.abort(cancelled)
          return Promise.reject(cancelled)
        }
      },
      device: deviceScope(refresh),
      now: () => now,
      repository,
      signal: controller.signal
    })

    await expect(manager.getAccessToken()).rejects.toBe(cancelled)
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { refreshToken: 'old-refresh-token' }
    })
  })

  test('lets one of two concurrent managers make every request after a 503', async () => {
    const repository = await createRepository(now + 30_000)
    const answers: (() => Promise<DeviceTokenOutput>)[] = [
      () => Promise.reject(tokenEndpointError(503)),
      () => Promise.resolve(refreshedGrant)
    ]
    const tokenEndpoint = (): Promise<DeviceTokenOutput> =>
      answers.shift()?.() ??
      Promise.reject(new Error('the refresh token was exchanged twice'))
    const firstRefresh = vi.fn<DeviceAuthScope['token']>(tokenEndpoint)
    const secondRefresh = vi.fn<DeviceAuthScope['token']>(tokenEndpoint)
    const first = new TokenManager({
      clock: instantClock(),
      device: deviceScope(firstRefresh),
      now: () => now,
      repository
    })
    const second = new TokenManager({
      clock: instantClock(),
      device: deviceScope(secondRefresh),
      now: () => now,
      repository
    })

    await expect(
      Promise.all([first.getAccessToken(), second.getAccessToken()])
    ).resolves.toEqual(['new-access-token', 'new-access-token'])
    expect(
      [firstRefresh.mock.calls.length, secondRefresh.mock.calls.length].sort()
    ).toEqual([0, 2])
  })

  test('makes a second manager wait out a refresh that retries past the old 10-second lock wait', async () => {
    const repository = await createRepository(now - 1000)
    useFakeRefreshTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const starts: number[] = []
    const firstRefresh = vi
      .fn<DeviceAuthScope['token']>(() => {
        starts.push(performance.now())
        return Promise.resolve(refreshedGrant)
      })
      .mockImplementationOnce((_input, options) => {
        starts.push(performance.now())
        return hangUntilAborted(options)
      })
      .mockImplementationOnce(() => {
        starts.push(performance.now())
        return Promise.reject(tokenEndpointError(503))
      })
    const secondRefresh = vi.fn<DeviceAuthScope['token']>(() =>
      Promise.reject(new Error('the second manager must not refresh'))
    )
    const first = new TokenManager({
      device: deviceScope(firstRefresh),
      now: () => now,
      repository
    })
    const second = new TokenManager({
      device: deviceScope(secondRefresh),
      now: () => now,
      repository
    })

    const firstToken = first.getAccessToken()
    while (starts.length === 0) {
      // biome-ignore lint/performance/noAwaitInLoops: waits for the first manager to hold the lock.
      await realTurn()
    }
    const outcomes = await settleWithFakeTime(
      Promise.all([firstToken, second.getAccessToken()]),
      50
    )

    expect(outcomes).toEqual({
      status: 'fulfilled',
      value: ['new-access-token', 'new-access-token']
    })
    expect(starts.at(-1)).toBeGreaterThan((starts[0] ?? 0) + 10_000)
    expect(firstRefresh).toHaveBeenCalledTimes(3)
    expect(secondRefresh).not.toHaveBeenCalled()
  })
})
