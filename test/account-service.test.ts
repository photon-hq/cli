import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, type GetAccountOutput, TransportError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type AccountScope, AccountService } from '../src/account/service.ts'
import { ACCESS_TOKEN_REFRESH_SKEW_MS } from '../src/auth/constants.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { TokenManager } from '../src/auth/token-manager.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'

const directories: string[] = []
const now = Date.parse('2026-07-30T20:00:00.000Z')

const accountFixture: GetAccountOutput = {
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

const deviceScope = (token: DeviceAuthScope['token']): DeviceAuthScope => ({
  authorize: () => Promise.reject(new Error('not used')),
  token
})

const createAccountScope = (get: AccountScope['get']): AccountScope => ({
  commitProfilePicture: () => Promise.reject(new Error('not used')),
  createProfilePictureUpload: () => Promise.reject(new Error('not used')),
  get,
  resetProfilePicture: () => Promise.reject(new Error('not used')),
  update: () => Promise.reject(new Error('not used'))
})

const createRepository = async (): Promise<AuthRepository> => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'photon-account-'))
  directories.push(configDirectory)
  const repository = new AuthRepository({
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
        'old-access',
        'old-refresh',
        new Date(now + ACCESS_TOKEN_REFRESH_SKEW_MS + 240_000)
      ),
      metadata,
      backend.backend
    )
  })
  return repository
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('authenticated account requests', () => {
  test('forces one refresh and one replay after a 401', async () => {
    const repository = await createRepository()
    const refresh = vi.fn(() =>
      Promise.resolve({
        access_token: 'rotated-access',
        expires_in: 300,
        refresh_token: 'rotated-refresh',
        user: {
          email: 'ada@example.test',
          first_name: 'Ada',
          id: 'user_ada',
          last_name: 'Lovelace'
        }
      })
    )
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 401
    })
    const get = vi
      .fn<AccountScope['get']>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(accountFixture)
    const tokenManager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })
    const service = new AccountService({
      account: createAccountScope(get),
      repository,
      tokenManager
    })

    await expect(service.get()).resolves.toMatchObject({
      accountId: 'account_123'
    })
    expect(get).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh'
      }
    })
  })

  test('does not replay a rejected token after a transient refresh failure', async () => {
    const repository = await createRepository()
    const refresh = vi.fn(() => Promise.reject(new TransportError('offline')))
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 401
    })
    const get = vi.fn<AccountScope['get']>().mockRejectedValue(unauthorized)
    const tokenManager = new TokenManager({
      device: deviceScope(refresh),
      now: () => now,
      repository
    })
    const service = new AccountService({
      account: createAccountScope(get),
      repository,
      tokenManager
    })

    await expect(service.get()).rejects.toMatchObject({
      code: 'AUTH_TEMPORARILY_UNAVAILABLE'
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(repository.loadSession()).resolves.toBeDefined()
  })

  test('clears local credentials only for an account-deleted response', async () => {
    const repository = await createRepository()
    const deleted = new ApiError('deleted', {
      body: { code: 'ACCOUNT_DELETED' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 410
    })
    const tokenManager = new TokenManager({
      device: deviceScope(() => Promise.reject(new Error('not used'))),
      now: () => now,
      repository
    })
    const service = new AccountService({
      account: createAccountScope(() => Promise.reject(deleted)),
      repository,
      tokenManager
    })

    await expect(service.get()).rejects.toMatchObject({
      code: 'ACCOUNT_DELETED',
      message:
        'This Photon account was deleted. Local credentials were removed.'
    })
    await expect(repository.loadSession()).resolves.toBeUndefined()
  })

  test('preserves local credentials for other API failures', async () => {
    const repository = await createRepository()
    const serverError = new ApiError('server error', {
      body: { code: 'INTERNAL_ERROR' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 500
    })
    const tokenManager = new TokenManager({
      device: deviceScope(() => Promise.reject(new Error('not used'))),
      now: () => now,
      repository
    })
    const service = new AccountService({
      account: createAccountScope(() => Promise.reject(serverError)),
      repository,
      tokenManager
    })

    await expect(service.get()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500
    })
    await expect(repository.loadSession()).resolves.toBeDefined()
  })

  test('warns instead of failing after a successful account cache refresh', async () => {
    const repository = await createRepository()
    vi.spyOn(repository, 'updateVerifiedAccountLocked').mockRejectedValueOnce(
      new Error('disk full')
    )
    const update = vi.fn<AccountScope['update']>(() =>
      Promise.resolve({ ...accountFixture, firstName: 'Grace' })
    )
    const tokenManager = new TokenManager({
      device: deviceScope(() => Promise.reject(new Error('not used'))),
      now: () => now,
      repository
    })
    const warning = vi.fn()
    const service = new AccountService({
      account: {
        ...createAccountScope(() => Promise.resolve(accountFixture)),
        update
      },
      repository,
      tokenManager,
      warning
    })

    await expect(
      service.update({ firstName: 'Grace' }, 'account-cache-warning')
    ).resolves.toMatchObject({ firstName: 'Grace' })
    expect(update).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(
      'The account request succeeded, but Photon could not refresh cached local identity metadata.'
    )
  })

  test('reuses one derived idempotency key when creating an upload slot', async () => {
    const repository = await createRepository()
    const refresh = vi.fn(() =>
      Promise.resolve({
        access_token: 'rotated-access',
        expires_in: 300,
        refresh_token: 'rotated-refresh',
        user: {
          email: 'ada@example.test',
          first_name: 'Ada',
          id: 'user_ada',
          last_name: 'Lovelace'
        }
      })
    )
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'UNAUTHORIZED' },
      headers: new Headers(),
      operationId: 'createAccountProfilePictureUpload',
      status: 401
    })
    const createProfilePictureUpload = vi
      .fn<AccountScope['createProfilePictureUpload']>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce({
        expiresAt: '2026-08-01T19:00:00.000Z',
        formFields: {},
        uploadId: 'upload_123',
        uploadUrl: 'https://uploads.example.test/avatar'
      })
    const commitProfilePicture = vi.fn<AccountScope['commitProfilePicture']>(
      () => Promise.resolve(accountFixture)
    )
    const storageFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const service = new AccountService({
      account: {
        ...createAccountScope(() => Promise.resolve(accountFixture)),
        commitProfilePicture,
        createProfilePictureUpload
      },
      fetch: storageFetch,
      repository,
      tokenManager: new TokenManager({
        device: deviceScope(refresh),
        now: () => now,
        repository
      })
    })

    await service.uploadAvatar(
      {
        blob: new Blob([Buffer.from('avatar')], { type: 'image/png' }),
        contentType: 'image/png',
        digest: 'a'.repeat(64),
        fileName: 'avatar.png'
      },
      'avatar-request'
    )

    expect(createProfilePictureUpload).toHaveBeenCalledTimes(2)
    expect(
      createProfilePictureUpload.mock.calls.map(([, options]) =>
        new Headers(options?.headers).get('idempotency-key')
      )
    ).toEqual(['avatar-request:upload', 'avatar-request:upload'])
    expect(refresh).toHaveBeenCalledOnce()
    expect(storageFetch).toHaveBeenCalledOnce()
    expect(commitProfilePicture).toHaveBeenCalledWith(
      {
        body: { uploadId: 'upload_123' },
        headers: { idempotencyKey: 'avatar-request' }
      },
      undefined
    )
  })
})
