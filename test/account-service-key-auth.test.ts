import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  ApiError,
  type DeviceAuthorizeOutput,
  type DeviceTokenOutput,
  type GetAccountOutput,
  ResponseValidationError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AccountScope } from '../src/account/service.ts'
import { createPhotonCommandServices } from '../src/app/services.ts'
import {
  AccountServiceKeyInput,
  parseAccountServiceKey
} from '../src/auth/account-service-key.ts'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import { StoredBearerCredentialProvider } from '../src/auth/credential-provider.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { TokenManager } from '../src/auth/token-manager.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CliError } from '../src/core/errors.ts'
import type { ReadableInput } from '../src/core/input.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { photonKey } from './key-support.ts'

const serviceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const replacementServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02t')
const concurrentServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02v')
const serviceKey = `${serviceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`
const replacementServiceKey = `${replacementServiceKeyId}_UmVwbGFjZW1lbnQ`
const concurrentServiceKey = `${concurrentServiceKeyId}_Q29uY3VycmVudA`
const deviceAccessToken = 'device-access-token'

const authorization: DeviceAuthorizeOutput = {
  device_code: 'device-code',
  expires_in: 600,
  interval: 1,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.test/device',
  verification_uri_complete:
    'https://auth.example.test/device?user_code=ABCD-EFGH'
}

const grant: DeviceTokenOutput = {
  access_token: 'device-access-token',
  expires_in: 300,
  refresh_token: 'device-refresh-token',
  user: {
    email: 'ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const account: GetAccountOutput = {
  accountId: 'pho_acc_01h455vb4pex5vsknk084sn02q',
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

const replacementAccount: GetAccountOutput = {
  ...account,
  email: 'replacement@example.test',
  firstName: 'Replacement',
  lastName: 'Session'
}

const temporaryDirectories: string[] = []

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-ask-auth-'))
  temporaryDirectories.push(directory)
  return directory
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

const stdin = (contents: string, isTTY = false): ReadableInput => {
  const stream = Readable.from([contents]) as ReadableInput
  if (isTTY) {
    Object.defineProperty(stream, 'isTTY', { value: true })
  }
  return stream
}

const deviceScope = (): DeviceAuthScope => ({
  authorize: vi.fn(() => Promise.reject(new Error('must not authorize'))),
  token: vi.fn(() => Promise.reject(new Error('must not refresh')))
})

const accountScope = (): AccountScope =>
  ({
    billing: {},
    get: vi.fn(() => Promise.resolve(account))
  }) as unknown as AccountScope

const deferred = <Value>() => {
  let reject = (_error: unknown): void => undefined
  let resolve = (_value: Value | PromiseLike<Value>): void => undefined
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    reject = promiseReject
    resolve = promiseResolve
  })
  return { promise, reject, resolve }
}

const saveAccountServiceKey = async (
  repository: AuthRepository,
  credential: string,
  identity: GetAccountOutput = account
): Promise<void> => {
  const parsed = parseAccountServiceKey(credential)
  if (parsed === undefined) {
    throw new TypeError('The test Account Service Key must be valid.')
  }
  const previous = await repository.loadSession()
  const backend = await repository.prepareAccountServiceKeyBackend(
    true,
    previous?.metadata
  )
  await repository.withLock(async () => {
    const current = await repository.loadSession()
    await repository.persistSessionLocked(
      repository.createAccountServiceKeyCredential(parsed),
      repository.createAccountServiceKeyMetadata(
        backend,
        identity,
        parsed,
        current?.metadata
      ),
      backend.backend,
      current
    )
  })
}

const persistAccountServiceKey = async (
  configDirectory: string,
  credential = serviceKey
): Promise<AuthRepository> => {
  const repository = new AuthRepository({
    configDirectory,
    platform: 'linux'
  })
  await saveAccountServiceKey(repository, credential)
  return repository
}

const saveDeviceSession = async (repository: AuthRepository): Promise<void> => {
  const previous = await repository.loadSession()
  const backend =
    previous === undefined
      ? await repository.prepareLoginBackend(true, undefined)
      : await repository.createReplacementBackend(previous.metadata)
  const metadata = repository.createMetadata(backend, {
    email: grant.user.email,
    id: grant.user.id,
    name: 'Ada Lovelace'
  })
  const credentials = repository.createCredential(
    deviceAccessToken,
    grant.refresh_token,
    new Date(Date.now() + 300_000)
  )
  await repository.withLock(async () => {
    const current = await repository.loadSession()
    await repository.persistSessionLocked(
      credentials,
      metadata,
      backend.backend,
      current
    )
  })
}

afterEach(async () => {
  process.exitCode = undefined
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('Account Service Key input', () => {
  test.each([serviceKey, `${serviceKey}\n`, `${serviceKey}\r\n`])(
    'accepts one exact credential with an optional terminal line ending',
    async (value) => {
      await expect(
        new AccountServiceKeyInput({ stdin: stdin(value) }).read()
      ).resolves.toEqual({ credential: serviceKey, serviceKeyId })
    }
  )

  test.each([
    [` ${serviceKey}\n`, 'surrounding whitespace'],
    [`${serviceKey}\n\n`, 'multiple lines'],
    [`${serviceKey}\r`, 'a bare carriage return'],
    [`${serviceKey}${'A'.repeat(512)}`, 'an oversized credential']
  ])('rejects %s (%s)', async (value) => {
    await expect(
      new AccountServiceKeyInput({ stdin: stdin(value) }).read()
    ).rejects.toMatchObject({ code: 'ARGUMENT_VALIDATION' })
  })

  test('rejects terminal input instead of echoing or prompting for a key', async () => {
    await expect(
      new AccountServiceKeyInput({ stdin: stdin(serviceKey, true) }).read()
    ).rejects.toMatchObject({ code: 'ARGUMENT_VALIDATION' })
  })
})

describe('Account Service Key login and storage', () => {
  test('verifies an isolated candidate and persists a v2 session without public output leakage', async () => {
    const configDirectory = await temporaryDirectory()
    const stdout = collector()
    const stderr = collector()
    const verifier = vi.fn(() => Promise.resolve(account))
    const device = deviceScope()

    await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: verifier,
      configDirectory,
      deviceScope: device,
      platform: 'linux',
      stderr,
      stdin: stdin(`${serviceKey}\n`),
      stdout
    })

    expect(verifier).toHaveBeenCalledOnce()
    expect(verifier).toHaveBeenCalledWith(serviceKey)
    expect(device.authorize).not.toHaveBeenCalled()
    expect(device.token).not.toHaveBeenCalled()
    expect(JSON.parse(stdout.value())).toEqual({
      accountId: account.accountId,
      alreadyAuthenticated: false,
      apiOrigin: BUILD_CONFIG.apiOrigin,
      credentialKind: 'account_service_key',
      email: account.email,
      name: 'Ada Lovelace',
      serviceKeyId,
      storage: 'file'
    })
    expect(`${stdout.value()}${stderr.value()}`).not.toContain(serviceKey)

    const metadata = JSON.parse(
      await readFile(join(configDirectory, 'auth.json'), 'utf8')
    ) as Record<string, unknown>
    expect(metadata).toMatchObject({
      accountId: account.accountId,
      credentialKind: 'account_service_key',
      schemaVersion: 2,
      serviceKeyId
    })
    expect(JSON.stringify(metadata)).not.toContain(serviceKey)
    await expect(
      readFile(join(configDirectory, 'credentials.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const entries = await readdir(join(configDirectory, 'credential-entries'))
    expect(entries).toHaveLength(1)
    await expect(
      readFile(
        join(configDirectory, 'credential-entries', entries[0] ?? ''),
        'utf8'
      )
    ).resolves.toContain(serviceKey)
  })

  test('saves the key to a file and says where when the keychain cannot be used', async () => {
    const configDirectory = await temporaryDirectory()
    const stdout = collector()
    const stderr = collector()

    await runCli(['login', '--service-key', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => Promise.resolve(account),
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      secureBackend: (kind, locator) => ({
        delete: () => Promise.resolve(false),
        kind,
        locator,
        probe: () =>
          Promise.reject(
            new CliError('AUTH_STORAGE_UNAVAILABLE', 'No keyring is running.')
          ),
        read: () => Promise.resolve(undefined),
        write: () => Promise.reject(new Error('not used'))
      }),
      stderr,
      stdin: stdin(serviceKey),
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      credentialKind: 'account_service_key',
      storage: 'file'
    })
    const entries = await readdir(join(configDirectory, 'credential-entries'))
    expect(entries).toHaveLength(1)
    const file = join(configDirectory, 'credential-entries', entries[0] ?? '')
    await expect(readFile(file, 'utf8')).resolves.toContain(serviceKey)
    expect(stderr.value()).toContain(
      `The system keychain could not be used, so the sign-in was saved in plain text to ${file}.`
    )
    expect(`${stdout.value()}${stderr.value()}`).not.toContain(serviceKey)
  })

  test('saves the key to a file and says where when the keychain refuses the write', async () => {
    const configDirectory = await temporaryDirectory()
    const stdout = collector()
    const stderr = collector()

    await runCli(['login', '--service-key', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => Promise.resolve(account),
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      secureBackend: (kind, locator) => ({
        delete: () => Promise.resolve(false),
        kind,
        locator,
        probe: () => Promise.resolve(),
        read: () => Promise.resolve(undefined),
        write: () =>
          Promise.reject(
            new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
          )
      }),
      stderr,
      stdin: stdin(serviceKey),
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      credentialKind: 'account_service_key',
      storage: 'file'
    })
    const entries = await readdir(join(configDirectory, 'credential-entries'))
    expect(entries).toHaveLength(1)
    const file = join(configDirectory, 'credential-entries', entries[0] ?? '')
    await expect(readFile(file, 'utf8')).resolves.toContain(serviceKey)
    expect(stderr.value()).toContain(
      `The system keychain could not be used, so the sign-in was saved in plain text to ${file}.`
    )
  })

  test('rejects a candidate whose Account response has a non-canonical account ID', async () => {
    const configDirectory = await temporaryDirectory()
    const stdout = collector()

    await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: () =>
        Promise.resolve({ ...account, accountId: 'account_not_canonical' }),
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      stderr: collector(),
      stdin: stdin(serviceKey),
      stdout
    })

    expect(stdout.value()).toContain('AUTH_PROTOCOL_ERROR')
    await expect(
      new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
    ).resolves.toBeUndefined()
  })

  test('answers a candidate whose Account response has an invalid email address as a protocol error', async () => {
    const configDirectory = await temporaryDirectory()
    const invalidEmail = 'ada.example.test'
    const login = async (jsonOutput: boolean) => {
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(
        [
          'login',
          '--service-key',
          '--insecure-storage',
          ...(jsonOutput ? ['--json'] : [])
        ],
        {
          accountScope: accountScope(),
          accountServiceKeyVerifier: () =>
            Promise.resolve({ ...account, email: invalidEmail }),
          configDirectory,
          deviceScope: deviceScope(),
          platform: 'linux',
          setExitCode: (exitCode) => exitCodes.push(exitCode),
          stderr,
          stdin: stdin(serviceKey),
          stdout
        }
      )
      return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
    }

    const json = await login(true)
    const text = await login(false)

    expect(json.exitCodes).toEqual([1])
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: {
        code: 'AUTH_PROTOCOL_ERROR',
        detail: 'The Account response did not contain a valid email address.',
        message:
          'Photon returned an invalid Account response. Your current credentials were preserved.'
      }
    })
    expect(text.exitCodes).toEqual([1])
    expect(text.stdout).toBe('')
    expect(text.stderr).toContain(
      'Error: Photon returned an invalid Account response. Your current credentials were preserved. (AUTH_PROTOCOL_ERROR)'
    )
    expect(text.stderr).toContain(
      'The Account response did not contain a valid email address.'
    )
    for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
      expect(output).not.toContain(invalidEmail)
    }
    await expect(
      new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
    ).resolves.toBeUndefined()
  })

  test('keeps the current session when a forced replacement returns an invalid email address', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const before = await repository.loadSession()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--service-key', '--force', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: () =>
        Promise.resolve({
          ...replacementAccount,
          email: 'replacement.example.test'
        }),
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdin: stdin(replacementServiceKey),
      stdout
    })

    expect(exitCodes).toEqual([1])
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'AUTH_PROTOCOL_ERROR' }
    })
    expect(before).toMatchObject({
      credentials: { credential: serviceKey },
      metadata: { email: account.email, serviceKeyId }
    })
    await expect(
      new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
    ).resolves.toEqual(before)
  })

  test.each(['ops=eu@example.com', 'a%b@example.com', 'ops#eu@example.com'])(
    'saves a session whose Account email is %s',
    async (email) => {
      const configDirectory = await temporaryDirectory()
      const stdout = collector()
      const exitCodes: number[] = []

      await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
        accountScope: accountScope(),
        accountServiceKeyVerifier: () => Promise.resolve({ ...account, email }),
        configDirectory,
        deviceScope: deviceScope(),
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr: collector(),
        stdin: stdin(serviceKey),
        stdout
      })

      expect(exitCodes).toEqual([])
      expect(JSON.parse(stdout.value())).toMatchObject({
        credentialKind: 'account_service_key',
        email
      })
      await expect(
        new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
      ).resolves.toMatchObject({ metadata: { email, serviceKeyId } })
    }
  )

  test.each(['ada.example.test', '', 'ada lovelace@example.test'])(
    'refuses an Account email of %j and saves nothing',
    async (email) => {
      const configDirectory = await temporaryDirectory()
      const stdout = collector()
      const exitCodes: number[] = []

      await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
        accountScope: accountScope(),
        accountServiceKeyVerifier: () => Promise.resolve({ ...account, email }),
        configDirectory,
        deviceScope: deviceScope(),
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr: collector(),
        stdin: stdin(serviceKey),
        stdout
      })

      expect(exitCodes).toEqual([1])
      expect(JSON.parse(stdout.value())).toMatchObject({
        error: {
          code: 'AUTH_PROTOCOL_ERROR',
          detail: 'The Account response did not contain a valid email address.'
        }
      })
      await expect(
        new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
      ).resolves.toBeUndefined()
    }
  )

  test('force logout removes isolated ASK files even when metadata is corrupt', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    await writeFile(repository.paths.metadata, '{not-json}\n', { mode: 0o600 })

    await expect(
      repository.withLock(
        async () => await repository.removeSessionLocked(true)
      )
    ).resolves.toMatchObject({
      orphanedCredential: true,
      removed: true
    })
    await expect(readdir(repository.paths.credentialEntries)).resolves.toEqual(
      []
    )
  })

  test('requires --yes before reading stdin and preserves the existing session when verification fails', async () => {
    const configDirectory = await temporaryDirectory()
    const verifier = vi.fn(() => Promise.resolve(account))
    await runCli(['login', '--service-key', '--insecure-storage', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: verifier,
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      stderr: collector(),
      stdin: stdin(serviceKey),
      stdout: collector()
    })

    const read = vi.spyOn(AccountServiceKeyInput.prototype, 'read')
    const replacementVerifier = vi.fn(() => Promise.resolve(account))
    const missingForceError = collector()
    await runCli(['login', '--service-key', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: replacementVerifier,
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      stderr: collector(),
      stdin: stdin(replacementServiceKey),
      stdout: missingForceError
    })
    expect(read).not.toHaveBeenCalled()
    expect(replacementVerifier).not.toHaveBeenCalled()
    expect(missingForceError.value()).toContain(
      'AUTH_SESSION_REPLACEMENT_REQUIRED'
    )
    read.mockRestore()

    const rejected = new ApiError('candidate rejected', {
      body: { code: 'INVALID_ACCOUNT_SERVICE_KEY' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 401
    })
    const rejectedVerifier = vi.fn(() => Promise.reject(rejected))
    const stderr = collector()
    const stdout = collector()
    await runCli(['login', '--service-key', '--force', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: rejectedVerifier,
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      stderr,
      stdin: stdin(replacementServiceKey),
      stdout
    })

    expect(stdout.value()).toContain('AUTH_SERVICE_KEY_REJECTED')
    expect(stdout.value()).not.toContain(replacementServiceKey)
    expect(stderr.value()).not.toContain(replacementServiceKey)
    const session = await new AuthRepository({
      configDirectory,
      platform: 'linux'
    }).loadSession()
    expect(session).toMatchObject({
      credentials: { credential: serviceKey },
      kind: 'account_service_key',
      metadata: { serviceKeyId }
    })

    const timedOut = new ApiError('candidate timed out', {
      body: { code: 'REQUEST_TIMEOUT' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 408
    })
    const timeoutError = collector()
    await runCli(['login', '--service-key', '--force', '--json'], {
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => Promise.reject(timedOut),
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      stderr: collector(),
      stdin: stdin(replacementServiceKey),
      stdout: timeoutError
    })
    expect(timeoutError.value()).toContain('AUTH_TEMPORARILY_UNAVAILABLE')
    await expect(
      new AuthRepository({ configDirectory, platform: 'linux' }).loadSession()
    ).resolves.toMatchObject({
      credentials: { credential: serviceKey },
      metadata: { serviceKeyId }
    })
  })

  test('removes a self-revoked key only if its ID is still the active local identity', async () => {
    const configDirectory = await temporaryDirectory()
    const first = createPhotonCommandServices({
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => Promise.resolve(account),
      color: false,
      configDirectory,
      deviceScope: deviceScope(),
      json: true,
      platform: 'linux',
      stdin: stdin(serviceKey)
    })
    await first.auth.login({
      force: false,
      insecureStorage: true,
      noBrowser: true,
      serviceKey: true
    })
    const second = createPhotonCommandServices({
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => Promise.resolve(account),
      color: false,
      configDirectory,
      deviceScope: deviceScope(),
      json: true,
      platform: 'linux',
      stdin: stdin(replacementServiceKey)
    })
    await second.auth.login({
      force: true,
      insecureStorage: true,
      noBrowser: true,
      serviceKey: true
    })

    await expect(
      first.auth.removeRevokedAccountServiceKey(serviceKeyId)
    ).resolves.toBeUndefined()
    await expect(
      first.auth.removeRevokedAccountServiceKey(replacementServiceKeyId)
    ).resolves.toMatchObject({
      credentialKind: 'account_service_key',
      orphanedCredential: false,
      removed: true
    })
  })

  test('does not resurrect an ASK session after a concurrent logout', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const verification = deferred<GetAccountOutput>()
    const started = deferred<void>()
    const services = createPhotonCommandServices({
      accountScope: accountScope(),
      accountServiceKeyVerifier: (credential) => {
        expect(credential).toBe(replacementServiceKey)
        started.resolve(undefined)
        return verification.promise
      },
      color: false,
      configDirectory,
      deviceScope: deviceScope(),
      json: true,
      platform: 'linux',
      stdin: stdin(replacementServiceKey)
    })

    const login = services.auth.login({
      force: true,
      insecureStorage: true,
      noBrowser: true,
      serviceKey: true
    })
    await started.promise
    await repository.withLock(
      async () => await repository.removeSessionLocked(false)
    )
    verification.resolve(account)

    await expect(login).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
    await expect(repository.loadSession()).resolves.toBeUndefined()
  })

  test('does not overwrite an ASK session replaced during candidate verification', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const verification = deferred<GetAccountOutput>()
    const started = deferred<void>()
    const services = createPhotonCommandServices({
      accountScope: accountScope(),
      accountServiceKeyVerifier: () => {
        started.resolve(undefined)
        return verification.promise
      },
      color: false,
      configDirectory,
      deviceScope: deviceScope(),
      json: true,
      platform: 'linux',
      stdin: stdin(replacementServiceKey)
    })

    const login = services.auth.login({
      force: true,
      insecureStorage: true,
      noBrowser: true,
      serviceKey: true
    })
    await started.promise
    await saveAccountServiceKey(
      repository,
      concurrentServiceKey,
      replacementAccount
    )
    verification.resolve(account)

    await expect(login).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { credential: concurrentServiceKey },
      metadata: {
        email: replacementAccount.email,
        serviceKeyId: concurrentServiceKeyId
      }
    })
  })

  test('starts Device Flow after the active ASK receives a definitive 401', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const unauthorized = new ApiError('unauthorized', {
      body: { code: 'INVALID_ACCOUNT_SERVICE_KEY' },
      headers: new Headers(),
      operationId: 'getAccount',
      status: 401
    })
    const scope = accountScope()
    scope.get = vi.fn(() => Promise.reject(unauthorized))
    const device: DeviceAuthScope = {
      authorize: vi.fn(() => Promise.resolve(authorization)),
      token: vi.fn(() => Promise.resolve(grant))
    }
    let monotonicNow = 0
    const stdout = collector()

    await runCli(['login', '--no-browser', '--json'], {
      accountScope: scope,
      clock: {
        now: () => monotonicNow,
        sleep: (durationMs) => {
          monotonicNow += durationMs
          return Promise.resolve()
        },
        wallNow: () => Date.now()
      },
      configDirectory,
      deviceScope: device,
      platform: 'linux',
      stderr: collector(),
      stdout
    })

    expect(device.authorize).toHaveBeenCalledOnce()
    expect(device.token).toHaveBeenCalledOnce()
    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      email: account.email
    })
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: {
        accessToken: grant.access_token,
        refreshToken: grant.refresh_token,
        version: 1
      },
      kind: 'device',
      metadata: { schemaVersion: 1 }
    })
    await expect(
      readFile(join(configDirectory, 'credentials.json'), 'utf8')
    ).resolves.toContain(grant.refresh_token)
    await expect(
      readdir(join(configDirectory, 'credential-entries'))
    ).resolves.toEqual([])
  })

  test('does not replace an ASK session after a 503 or invalid account response', async () => {
    const failures = [
      new ApiError('unavailable', {
        body: { code: 'SERVICE_UNAVAILABLE' },
        headers: new Headers(),
        operationId: 'getAccount',
        status: 503
      }),
      new ResponseValidationError('getAccount', [], { status: 200 })
    ]

    await Promise.all(
      failures.map(async (failure) => {
        const configDirectory = await temporaryDirectory()
        const repository = await persistAccountServiceKey(configDirectory)
        const scope = accountScope()
        scope.get = vi.fn(() => Promise.reject(failure))
        const device = deviceScope()

        await runCli(['login', '--no-browser', '--json'], {
          accountScope: scope,
          configDirectory,
          deviceScope: device,
          platform: 'linux',
          setExitCode: () => undefined,
          stderr: collector(),
          stdout: collector()
        })

        expect(device.authorize).not.toHaveBeenCalled()
        expect(device.token).not.toHaveBeenCalled()
        await expect(repository.loadSession()).resolves.toMatchObject({
          credentials: { credential: serviceKey },
          kind: 'account_service_key',
          metadata: { serviceKeyId }
        })
      })
    )
  })

  test('says it is already logged in with the stored key and names photon login --force', async () => {
    const configDirectory = await temporaryDirectory()
    await persistAccountServiceKey(configDirectory)
    const device = deviceScope()
    const stdout = collector()
    const stderr = collector()

    await runCli(['login', '--no-browser'], {
      accountScope: accountScope(),
      configDirectory,
      deviceScope: device,
      platform: 'linux',
      stderr,
      stdout
    })

    expect(device.authorize).not.toHaveBeenCalled()
    expect(stdout.value()).toBe(
      `Already logged in with account service key ${serviceKeyId}.\n`
    )
    expect(stderr.value()).toContain(
      `Next: Sign in as a different account (you do this): ${CLI_NAME} login --force\n`
    )
  })
})

describe('Account Service Key request policy', () => {
  test('uses the ASK directly and performs zero refresh or replay after a 401', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const device = deviceScope()
    const tokenManager = new TokenManager({ device, repository })
    const provider = new StoredBearerCredentialProvider({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      repository,
      tokenManager
    })
    await expect(provider.getBearer()).resolves.toBe(serviceKey)

    const unauthorized = new ApiError('unauthorized', {
      body: undefined,
      headers: new Headers(),
      operationId: 'listProjects',
      status: 401
    })
    const invoke = vi.fn(() => Promise.reject(unauthorized))
    const request = new AuthenticatedRequest({ credentialProvider: provider })
    await expect(request.run(invoke)).rejects.toBe(unauthorized)
    expect(invoke).toHaveBeenCalledOnce()
    expect(device.authorize).not.toHaveBeenCalled()
    expect(device.token).not.toHaveBeenCalled()
  })

  test('rejects a Device request when the session changes to an ASK before its 401', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = new AuthRepository({
      configDirectory,
      platform: 'linux'
    })
    await saveDeviceSession(repository)
    const device = deviceScope()
    const provider = new StoredBearerCredentialProvider({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      repository,
      tokenManager: new TokenManager({ device, repository })
    })
    const refresh = vi.spyOn(provider, 'refreshAfterUnauthorized')
    const started = deferred<void>()
    const release = deferred<void>()
    const bearers: string[] = []
    const unauthorized = new ApiError('unauthorized', {
      body: undefined,
      headers: new Headers(),
      operationId: 'listProjects',
      status: 401
    })
    const invoke = vi.fn(async () => {
      bearers.push(await provider.getBearer())
      started.resolve(undefined)
      await release.promise
      bearers.push(await provider.getBearer())
      throw unauthorized
    })
    const pending = new AuthenticatedRequest({
      credentialProvider: provider
    }).run(invoke)

    await started.promise
    await saveAccountServiceKey(repository, serviceKey)
    release.resolve(undefined)

    await expect(pending).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED'
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(bearers).toEqual([deviceAccessToken, deviceAccessToken])
    expect(refresh).not.toHaveBeenCalled()
    expect(device.authorize).not.toHaveBeenCalled()
    expect(device.token).not.toHaveBeenCalled()
    await expect(repository.loadSession()).resolves.toMatchObject({
      kind: 'account_service_key',
      metadata: { serviceKeyId }
    })
  })

  test('rejects an ASK request when the session changes to Device before its 401', async () => {
    const configDirectory = await temporaryDirectory()
    const repository = await persistAccountServiceKey(configDirectory)
    const device = deviceScope()
    const provider = new StoredBearerCredentialProvider({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      repository,
      tokenManager: new TokenManager({ device, repository })
    })
    const refresh = vi.spyOn(provider, 'refreshAfterUnauthorized')
    const started = deferred<void>()
    const release = deferred<void>()
    const bearers: string[] = []
    const unauthorized = new ApiError('unauthorized', {
      body: undefined,
      headers: new Headers(),
      operationId: 'listProjects',
      status: 401
    })
    const invoke = vi.fn(async () => {
      bearers.push(await provider.getBearer())
      started.resolve(undefined)
      await release.promise
      bearers.push(await provider.getBearer())
      throw unauthorized
    })
    const pending = new AuthenticatedRequest({
      credentialProvider: provider
    }).run(invoke)

    await started.promise
    await saveDeviceSession(repository)
    release.resolve(undefined)

    await expect(pending).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED'
    })
    expect(invoke).toHaveBeenCalledOnce()
    expect(bearers).toEqual([serviceKey, serviceKey])
    expect(refresh).not.toHaveBeenCalled()
    expect(device.authorize).not.toHaveBeenCalled()
    expect(device.token).not.toHaveBeenCalled()
    await expect(repository.loadSession()).resolves.toMatchObject({
      credentials: { accessToken: deviceAccessToken },
      kind: 'device'
    })
  })
})
