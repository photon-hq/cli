import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApiError,
  type DeviceTokenOutput,
  TransportError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { TokenManager } from '../src/auth/token-manager.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { CLI_NAME } from '../src/meta.ts'

const temporaryDirectories: string[] = []
const now = Date.parse('2026-07-30T20:00:00.000Z')

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

afterEach(async () => {
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
      undefined
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
      device: deviceScope(refresh),
      now: () => now,
      repository
    })

    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    await expect(manager.getAccessToken()).resolves.toBe('old-access-token')
    await expect(manager.refreshAfterUnauthorized()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    expect(refresh).toHaveBeenCalledTimes(1)
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
    expect(refresh).toHaveBeenCalledTimes(1)
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
