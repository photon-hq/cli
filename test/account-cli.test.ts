import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError, type GetAccountOutput, TransportError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import type { AccountScope } from '../src/account/service.ts'
import { runCli } from '../src/main.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const accountFixture: GetAccountOutput = {
  accountId: 'account_123',
  createdAt: '2026-07-01T00:00:00.000Z',
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: '+14155550123',
  phoneVerifiedAt: '2026-07-02T00:00:00.000Z',
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: '2026-07-03T00:00:00.000Z'
}

const ONBOARDED_LINE = /^\s*Onboarded\b/mu

interface AccountMocks {
  commitProfilePicture: ReturnType<
    typeof vi.fn<AccountScope['commitProfilePicture']>
  >
  createProfilePictureUpload: ReturnType<
    typeof vi.fn<AccountScope['createProfilePictureUpload']>
  >
  get: ReturnType<typeof vi.fn<AccountScope['get']>>
  resetProfilePicture: ReturnType<
    typeof vi.fn<AccountScope['resetProfilePicture']>
  >
  scope: AccountScope
  update: ReturnType<typeof vi.fn<AccountScope['update']>>
}

const accountMocks = (): AccountMocks => {
  const get = vi.fn<AccountScope['get']>(() => Promise.resolve(accountFixture))
  const update = vi.fn<AccountScope['update']>(() =>
    Promise.resolve(accountFixture)
  )
  const createProfilePictureUpload = vi.fn<
    AccountScope['createProfilePictureUpload']
  >(() =>
    Promise.resolve({
      expiresAt: '2026-08-01T19:00:00.000Z',
      formFields: { key: 'account/avatar.png', policy: 'signed-policy' },
      uploadId: 'upload_123',
      uploadUrl: 'https://uploads.example.test/'
    })
  )
  const commitProfilePicture = vi.fn<AccountScope['commitProfilePicture']>(() =>
    Promise.resolve({
      ...accountFixture,
      pictureUrl: 'https://images.example.test/new.png'
    })
  )
  const resetProfilePicture = vi.fn<AccountScope['resetProfilePicture']>(() =>
    Promise.resolve({
      ...accountFixture,
      pictureUrl: 'https://images.example.test/default.png'
    })
  )
  return {
    commitProfilePicture,
    createProfilePictureUpload,
    get,
    resetProfilePicture,
    scope: {
      commitProfilePicture,
      createProfilePictureUpload,
      get,
      resetProfilePicture,
      update
    },
    update
  }
}

const jsonError = (stderr: string): { error: Record<string, unknown> } => {
  const line = stderr.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line) as { error: Record<string, unknown> }
}

describe('account CLI contract', () => {
  test('prints the account Photon returns, with a field the SDK does not declare yet', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const returned = { ...accountFixture, addedByNewerApi: 'from-a-newer-api' }
    mocks.get.mockResolvedValueOnce(returned)
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const result = await invoke(['account', 'view'])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(returned)
  })

  test('leaves onboarded out of the JSON when Photon does not send it, and text has no Onboarded line', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const { onboarded: _onboarded, ...withoutOnboarded } = accountFixture
    mocks.get.mockResolvedValue(withoutOnboarded)
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })
    const stdout = collector()

    const result = await invoke(['account', 'view'])
    await runCli(['account', 'view'], {
      accountScope: mocks.scope,
      configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      stderr: collector(),
      stdout
    })

    expect(JSON.parse(result.stdout)).toEqual(withoutOnboarded)
    expect(stdout.value()).not.toMatch(ONBOARDED_LINE)
  })

  test('renders a labeled human account view', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const stdout = collector()

    await runCli(['account', 'view'], {
      accountScope: mocks.scope,
      configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      stderr: collector(),
      stdout
    })

    expect(stdout.value()).toContain('Account')
    expect(stdout.value()).toContain('account_123')
    expect(stdout.value()).toContain('ada@example.test')
    expect(stdout.value()).toContain('Phone verified')
  })

  test('renders every account field in the text view except Onboarded', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const stdout = collector()

    await runCli(['account', 'view'], {
      accountScope: mocks.scope,
      configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      stderr: collector(),
      stdout
    })

    expect(stdout.value()).toBe(
      [
        'Account',
        'ID              account_123',
        'First name      Ada',
        'Last name       Lovelace',
        'Email           ada@example.test',
        'Phone           +14155550123',
        'Phone verified  2026-07-02T00:00:00.000Z',
        'Avatar          https://images.example.test/ada.png',
        'Created         2026-07-01T00:00:00.000Z',
        'Updated         2026-07-03T00:00:00.000Z',
        'Deleted         —',
        ''
      ].join('\n')
    )
  })

  test('edits profile names with a journaled idempotency key', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    mocks.update.mockResolvedValueOnce({
      ...accountFixture,
      firstName: 'Augusta',
      lastName: null
    })
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const result = await invoke([
      'account',
      'edit',
      '--first-name',
      ' Augusta ',
      '--clear-last-name',
      '--idempotency-key',
      'account-edit-1'
    ])

    expect(JSON.parse(result.stdout)).toEqual({
      ...accountFixture,
      firstName: 'Augusta',
      lastName: null
    })
    expect(mocks.update).toHaveBeenCalledWith(
      {
        body: { firstName: 'Augusta', lastName: null },
        headers: { idempotencyKey: 'account-edit-1' }
      },
      undefined
    )
    const metadata = JSON.parse(
      await readFile(join(configDirectory, 'auth.json'), 'utf8')
    ) as { cachedUser: { name: string | null } }
    expect(metadata.cachedUser.name).toBe('Augusta')
    const operations = await invoke(['operation', 'list'])
    expect(JSON.parse(operations.stdout)).toEqual({ operations: [] })
  })

  test('rejects an empty edit before sending or journaling a mutation', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const result = await invoke(['account', 'edit'])

    expect(jsonError(result.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(result.exitCodes).toEqual([2])
    expect(mocks.update).not.toHaveBeenCalled()
    const operations = await invoke(['operation', 'list'])
    expect(JSON.parse(operations.stdout)).toEqual({ operations: [] })
  })

  test('uploads and commits an account avatar without an authorization header', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const avatarPath = join(configDirectory, 'avatar.png')
    await writeFile(
      avatarPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const mocks = accountMocks()
    const storageFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      fetch: storageFetch
    })

    const result = await invoke([
      'account',
      'avatar',
      'upload',
      avatarPath,
      '--idempotency-key',
      'avatar-upload-1'
    ])

    expect(JSON.parse(result.stdout)).toEqual({
      ...accountFixture,
      pictureUrl: 'https://images.example.test/new.png'
    })
    expect(storageFetch).toHaveBeenCalledTimes(1)
    const storageOptions = storageFetch.mock.calls[0]?.[1]
    expect(storageOptions?.method).toBe('POST')
    expect(new Headers(storageOptions?.headers).has('authorization')).toBe(
      false
    )
    expect(mocks.commitProfilePicture).toHaveBeenCalledWith(
      {
        body: { uploadId: 'upload_123' },
        headers: { idempotencyKey: 'avatar-upload-1' }
      },
      undefined
    )
  })

  test('requires confirmation before resetting the account avatar', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      confirm: () => Promise.resolve(false)
    })

    const cancelled = await invoke(['account', 'avatar', 'reset'])

    expect(cancelled.stdout).toBe('')
    expect(mocks.resetProfilePicture).not.toHaveBeenCalled()

    const forced = await invoke([
      'account',
      'avatar',
      'reset',
      '--yes',
      '--idempotency-key',
      'avatar-reset-1'
    ])
    expect(JSON.parse(forced.stdout)).toEqual({
      ...accountFixture,
      pictureUrl: 'https://images.example.test/default.png'
    })
    expect(mocks.resetProfilePicture).toHaveBeenCalledWith(
      { headers: { idempotencyKey: 'avatar-reset-1' } },
      undefined
    )
  })

  test('resumes an account avatar at commit without uploading the file again', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const avatarPath = join(configDirectory, 'commit-replay.png')
    await writeFile(
      avatarPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const mocks = accountMocks()
    mocks.commitProfilePicture
      .mockRejectedValueOnce(new TransportError('offline'))
      .mockResolvedValueOnce({
        ...accountFixture,
        pictureUrl: 'https://images.example.test/replayed.png'
      })
    const storageFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      fetch: storageFetch
    })

    const failed = await invoke([
      'account',
      'avatar',
      'upload',
      avatarPath,
      '--idempotency-key',
      'account-avatar-replay-1'
    ])
    const failure = jsonError(failed.stdout)
    expect(failure).toMatchObject({
      error: { code: 'API_CONNECTION_ERROR', replayable: true }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      String(failure.error.operationId),
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout).result).toEqual({
      ...accountFixture,
      pictureUrl: 'https://images.example.test/replayed.png'
    })
    expect(mocks.createProfilePictureUpload).toHaveBeenCalledTimes(1)
    expect(storageFetch).toHaveBeenCalledTimes(1)
    expect(mocks.commitProfilePicture).toHaveBeenCalledTimes(2)
  })

  test('rejects insecure account avatar upload URLs before storage access', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const avatarPath = join(configDirectory, 'insecure-upload.png')
    await writeFile(
      avatarPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const mocks = accountMocks()
    mocks.createProfilePictureUpload.mockResolvedValueOnce({
      expiresAt: '2026-08-01T19:00:00.000Z',
      formFields: { policy: 'secret-policy' },
      uploadId: 'upload_insecure',
      uploadUrl: 'http://uploads.example.test/private-target'
    })
    const storageFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope,
      fetch: storageFetch
    })

    const result = await invoke(['account', 'avatar', 'upload', avatarPath])

    expect(jsonError(result.stdout)).toMatchObject({
      error: { code: 'ACCOUNT_PROTOCOL_ERROR' }
    })
    expect(result.stderr).not.toContain('private-target')
    expect(result.stdout).not.toContain('private-target')
    expect(result.stderr).not.toContain('secret-policy')
    expect(result.stdout).not.toContain('secret-policy')
    expect(storageFetch).not.toHaveBeenCalled()
    expect(mocks.commitProfilePicture).not.toHaveBeenCalled()
  })

  test('replays a failed account edit with the original payload and key', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    mocks.update
      .mockRejectedValueOnce(new TransportError('offline'))
      .mockResolvedValueOnce({ ...accountFixture, firstName: 'Grace' })
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const failed = await invoke([
      'account',
      'edit',
      '--first-name',
      'Grace',
      '--idempotency-key',
      'account-replay-1'
    ])
    const failure = jsonError(failed.stdout)
    expect(failure).toMatchObject({
      error: {
        code: 'API_CONNECTION_ERROR',
        idempotencyKey: 'account-replay-1',
        replayable: true
      }
    })
    const operationId = String(failure.error.operationId)

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'account.update',
        operationId,
        status: 'resolved'
      },
      result: { ...accountFixture, firstName: 'Grace' }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual({
      ...accountFixture,
      firstName: 'Grace'
    })
    expect(mocks.update).toHaveBeenLastCalledWith(
      {
        body: { firstName: 'Grace' },
        headers: { idempotencyKey: 'account-replay-1' }
      },
      undefined
    )
  })

  test('keeps deterministic upstream failures replayable for account edits', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const mocks = accountMocks()
    mocks.update.mockRejectedValueOnce(
      new ApiError('upstream unavailable', {
        body: {
          code: 'UPSTREAM_UNAVAILABLE',
          detail: 'The account dependency is unavailable.'
        },
        headers: new Headers(),
        operationId: 'updateAccount',
        requestId: 'request_account_upstream',
        status: 503
      })
    )
    const invoke = cliInvoker(configDirectory, asProjectScope({}), {
      accountScope: mocks.scope
    })

    const failed = await invoke([
      'account',
      'edit',
      '--first-name',
      'Grace',
      '--idempotency-key',
      'account-upstream-1'
    ])

    expect(jsonError(failed.stdout)).toMatchObject({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        replayable: true,
        retryable: false
      }
    })
  })
})
