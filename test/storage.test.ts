import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LOCK_STALE_MS } from '../src/auth/constants.ts'
import {
  type CredentialBackend,
  FileCredentialBackend
} from '../src/auth/storage/backends.ts'
import { withAuthLock } from '../src/auth/storage/lock.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import type { CredentialBackendKind } from '../src/auth/types.ts'
import { CliError } from '../src/core/errors.ts'

const temporaryDirectories: string[] = []

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-storage-'))
  temporaryDirectories.push(directory)
  return directory
}

const fakeSecureBackend = (
  kind: Exclude<CredentialBackendKind, 'file'>,
  locator: string,
  overrides: Partial<Pick<CredentialBackend, 'delete' | 'probe' | 'write'>> = {}
): CredentialBackend => ({
  delete: () => Promise.resolve(false),
  kind,
  locator,
  probe: () => Promise.resolve(),
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  ...overrides
})

const user = { email: 'lin@example.test', id: 'user_lin', name: 'Lin' }

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('credential storage', () => {
  test('writes private files atomically without secrets in metadata', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux'
    })
    const backend = await repository.prepareLoginBackend(true, undefined)
    const metadata = repository.createMetadata(backend, {
      email: 'lin@example.test',
      id: 'user_lin',
      name: 'Lin'
    })
    const credentials = repository.createCredential(
      'private-access-token',
      'private-refresh-token',
      new Date(Date.now() + 300_000)
    )

    await repository.withLock(async () => {
      await repository.persistSessionLocked(
        credentials,
        metadata,
        backend.backend
      )
    })

    const serializedMetadata = await readFile(repository.paths.metadata, 'utf8')
    expect(serializedMetadata).not.toContain('private-access-token')
    expect(serializedMetadata).not.toContain('private-refresh-token')
    if (process.platform !== 'win32') {
      const credentialStats = await stat(repository.paths.credentials)
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bit masks.
      expect(credentialStats.mode & 0o777).toBe(0o600)
      const metadataStats = await stat(repository.paths.metadata)
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bit masks.
      expect(metadataStats.mode & 0o777).toBe(0o600)
      const directoryStats = await stat(configDirectory)
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bit masks.
      expect(directoryStats.mode & 0o777).toBe(0o700)
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a symlinked credential file',
    async () => {
      const configDirectory = await temporaryDirectory()
      const target = join(configDirectory, 'target.json')
      const credentials = join(configDirectory, 'credentials.json')
      await writeFile(target, '{}', { mode: 0o600 })
      await symlink(target, credentials)
      const backend = new FileCredentialBackend(credentials)

      // biome-ignore lint/suspicious/noMisplacedAssertion: Vitest's test.skipIf wrapper is the test function.
      await expect(backend.read()).rejects.toMatchObject({
        code: 'AUTH_STORAGE_UNSAFE'
      })
    }
  )

  test('rejects malformed metadata URLs', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux'
    })
    const backend = await repository.prepareLoginBackend(true, undefined)
    const metadata = repository.createMetadata(backend, {
      email: 'lin@example.test',
      id: 'user_lin',
      name: 'Lin'
    })
    await writeFile(
      repository.paths.metadata,
      `${JSON.stringify({ ...metadata, apiOrigin: 'not-a-url' })}\n`,
      { mode: 0o600 }
    )

    await expect(repository.loadMetadata()).rejects.toMatchObject({
      code: 'AUTH_STORAGE_CORRUPT'
    })
  })

  test('does not overwrite unsupported metadata schemas and requires forced recovery', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux'
    })
    await mkdir(configDirectory, { recursive: true })
    const unsupported = '{"schemaVersion":999,"accessToken":"must-remain"}\n'
    await writeFile(repository.paths.metadata, unsupported, { mode: 0o600 })

    await expect(repository.loadMetadata()).rejects.toMatchObject({
      code: 'AUTH_STORAGE_CORRUPT'
    })
    await expect(readFile(repository.paths.metadata, 'utf8')).resolves.toBe(
      unsupported
    )

    const result = await repository.withLock(
      async () => await repository.removeSessionLocked(true)
    )
    expect(result).toEqual({
      orphanedCredential: true,
      removed: true
    })
    await expect(lstat(repository.paths.metadata)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  test('recovers a stale owner-checked lock', async () => {
    const configDirectory = await temporaryDirectory()
    const lockDirectory = join(configDirectory, 'auth.lock')
    await mkdir(lockDirectory, { mode: 0o700 })
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ id: 'dead-owner', pid: 1 }),
      { mode: 0o600 }
    )
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1000)
    await utimes(lockDirectory, stale, stale)

    await expect(
      withAuthLock(configDirectory, async () => 'acquired')
    ).resolves.toBe('acquired')
    await expect(lstat(lockDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('uses a file only the user can read when there is no keychain', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'freebsd'
    })

    const prepared = await repository.prepareLoginBackend(false, undefined)

    expect(prepared).toMatchObject({ keychainUnavailable: true, kind: 'file' })
    expect(prepared.backend.path).toBe(repository.paths.credentials)
  })

  test('falls back to a file when the keychain cannot be used', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          probe: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_UNAVAILABLE', 'No keyring is running.')
            )
        })
    })

    await expect(
      repository.prepareLoginBackend(false, undefined)
    ).resolves.toMatchObject({ keychainUnavailable: true, kind: 'file' })
    await expect(
      repository.prepareAccountServiceKeyBackend(false, undefined)
    ).resolves.toMatchObject({ keychainUnavailable: true, kind: 'file' })
  })

  test('uses the keychain when there is one, and a file with --insecure-storage', async () => {
    const configDirectory = await temporaryDirectory()
    const secureBackend = vi.fn(fakeSecureBackend)
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend
    })

    const keychain = await repository.prepareLoginBackend(false, undefined)
    expect(keychain.kind).toBe('secret-service')
    expect(keychain).not.toHaveProperty('keychainUnavailable')
    expect(secureBackend).toHaveBeenCalledTimes(1)

    const file = await repository.prepareLoginBackend(true, undefined)
    expect(file.kind).toBe('file')
    expect(file).not.toHaveProperty('keychainUnavailable')
    expect(secureBackend).toHaveBeenCalledTimes(1)
  })

  test('does not fall back to a file when the keychain fails for another reason', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          probe: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_CORRUPT', 'The keyring is damaged.')
            )
        })
    })

    await expect(
      repository.prepareLoginBackend(false, undefined)
    ).rejects.toMatchObject({ code: 'AUTH_STORAGE_CORRUPT' })
  })

  test('saves a new sign-in to a file when the keychain refuses the write', async () => {
    const configDirectory = await temporaryDirectory()
    const deleteEntry = vi.fn(() => Promise.resolve(false))
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          delete: deleteEntry,
          write: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
            )
        })
    })
    const prepared = await repository.prepareLoginBackend(false, undefined)
    expect(prepared.kind).toBe('secret-service')
    const credentials = repository.createCredential(
      'access-token',
      'refresh-token',
      new Date(Date.now() + 300_000)
    )

    const persisted = await repository.withLock(
      async () =>
        await repository.persistSignInLocked(credentials, prepared, (backend) =>
          repository.createMetadata(backend, user)
        )
    )

    expect(persisted.prepared).toMatchObject({
      keychainUnavailable: true,
      kind: 'file'
    })
    expect(persisted.prepared.backend.path).toBe(repository.paths.credentials)
    expect(deleteEntry).toHaveBeenCalledTimes(1)
    const session = await repository.loadSession()
    expect(session?.metadata.backend).toBe('file')
    expect(session?.credentials).toEqual(credentials)
  })

  test('keeps the error when a refused keychain write cannot be cleaned up', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          delete: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
            ),
          write: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
            )
        })
    })
    const prepared = await repository.prepareLoginBackend(false, undefined)
    const credentials = repository.createCredential(
      'access-token',
      'refresh-token',
      new Date(Date.now() + 300_000)
    )

    await expect(
      repository.withLock(
        async () =>
          await repository.persistSignInLocked(
            credentials,
            prepared,
            (backend) => repository.createMetadata(backend, user)
          )
      )
    ).rejects.toMatchObject({ code: 'AUTH_PERSISTENCE_FAILED' })
    await expect(readFile(repository.paths.credentials)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(repository.loadMetadata()).resolves.toBeUndefined()
  })

  test('keeps the error when a refused keychain write would replace a stored sign-in', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          write: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
            )
        })
    })
    const stored = await repository.prepareLoginBackend(true, undefined)
    const storedCredentials = repository.createCredential(
      'stored-access-token',
      'stored-refresh-token',
      new Date(Date.now() + 300_000)
    )
    await repository.withLock(async () => {
      await repository.persistSessionLocked(
        storedCredentials,
        repository.createMetadata(stored, user),
        stored.backend
      )
    })
    const previous = await repository.loadSession()
    const prepared = await repository.prepareLoginBackend(false, undefined)

    await expect(
      repository.withLock(
        async () =>
          await repository.persistSignInLocked(
            repository.createCredential(
              'access-token',
              'refresh-token',
              new Date(Date.now() + 300_000)
            ),
            prepared,
            (backend) => repository.createMetadata(backend, user),
            previous
          )
      )
    ).rejects.toMatchObject({ code: 'AUTH_PERSISTENCE_FAILED' })
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: storedCredentials
    })
  })

  test('keeps the error when the keychain write fails for another reason', async () => {
    const configDirectory = await temporaryDirectory()
    const fileWrite = vi.spyOn(FileCredentialBackend.prototype, 'write')
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: (kind, locator) =>
        fakeSecureBackend(kind, locator, {
          write: () =>
            Promise.reject(
              new CliError('AUTH_STORAGE_CORRUPT', 'The keyring is damaged.')
            )
        })
    })
    const prepared = await repository.prepareLoginBackend(false, undefined)

    await expect(
      repository.withLock(
        async () =>
          await repository.persistSignInLocked(
            repository.createCredential(
              'access-token',
              'refresh-token',
              new Date(Date.now() + 300_000)
            ),
            prepared,
            (backend) => repository.createMetadata(backend, user)
          )
      )
    ).rejects.toMatchObject({ code: 'AUTH_PERSISTENCE_FAILED' })
    expect(fileWrite).not.toHaveBeenCalled()
    await expect(repository.loadMetadata()).resolves.toBeUndefined()
    fileWrite.mockRestore()
  })

  test('keeps the error when the metadata write fails after the keychain write', async () => {
    const configDirectory = await temporaryDirectory()
    const fileWrite = vi.spyOn(FileCredentialBackend.prototype, 'write')
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux',
      secureBackend: fakeSecureBackend
    })
    const prepared = await repository.prepareLoginBackend(false, undefined)
    await mkdir(join(repository.paths.metadata, 'blocker'), { recursive: true })

    await expect(
      repository.withLock(
        async () =>
          await repository.persistSignInLocked(
            repository.createCredential(
              'access-token',
              'refresh-token',
              new Date(Date.now() + 300_000)
            ),
            prepared,
            (backend) => repository.createMetadata(backend, user)
          )
      )
    ).rejects.toMatchObject({ code: 'AUTH_PERSISTENCE_FAILED' })
    expect(fileWrite).not.toHaveBeenCalled()
    fileWrite.mockRestore()
  })

  test('removes orphaned file credentials and makes logout idempotent', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux'
    })
    await writeFile(repository.paths.credentials, '{"orphan":true}\n', {
      mode: 0o600
    })

    await expect(
      repository.withLock(
        async () => await repository.removeSessionLocked(false)
      )
    ).resolves.toEqual({
      orphanedCredential: false,
      removed: true
    })
    await expect(
      repository.withLock(
        async () => await repository.removeSessionLocked(false)
      )
    ).resolves.toEqual({
      orphanedCredential: false,
      removed: false
    })
  })
})
