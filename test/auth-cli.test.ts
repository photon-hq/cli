import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApiError,
  type DeviceAuthorizeOutput,
  type DeviceTokenOutput,
  type GetAccountOutput,
  TransportError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AccountScope } from '../src/account/service.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import type { SecureBackendFactory } from '../src/auth/storage/repository.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CliError } from '../src/core/errors.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { createAuthenticatedConfig } from './project-test-support.ts'

const temporaryDirectories: string[] = []
const wallClock = Date.parse('2026-07-30T20:00:00.000Z')

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

const authorizationFixture: DeviceAuthorizeOutput = {
  device_code: 'device-secret-never-print',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.test/device',
  verification_uri_complete:
    'https://auth.example.test/device?user_code=ABCD-EFGH'
}

const tokenFixture: DeviceTokenOutput = {
  access_token: 'access-secret-never-print',
  expires_in: 300,
  refresh_token: 'refresh-secret-never-print',
  user: {
    email: 'ada@example.test',
    first_name: 'Ada',
    id: 'user_ada',
    last_name: 'Lovelace'
  }
}

const identityFixture: GetAccountOutput = {
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

const deviceScope = (): DeviceAuthScope => ({
  authorize: vi.fn(() => Promise.resolve(authorizationFixture)),
  token: vi.fn(() => Promise.resolve(tokenFixture))
})

const accountScope = (): AccountScope => ({
  commitProfilePicture: () => Promise.reject(new Error('not used')),
  createProfilePictureUpload: () => Promise.reject(new Error('not used')),
  get: vi.fn(() => Promise.resolve(identityFixture)),
  resetProfilePicture: () => Promise.reject(new Error('not used')),
  update: () => Promise.reject(new Error('not used'))
})

const unavailableKeychain: SecureBackendFactory = (kind, locator) => ({
  delete: () => Promise.resolve(false),
  kind,
  locator,
  probe: () =>
    Promise.reject(
      new CliError('AUTH_STORAGE_UNAVAILABLE', 'No keyring is running.')
    ),
  read: () => Promise.resolve(undefined),
  write: () => Promise.reject(new Error('not used'))
})

const refusingKeychain: SecureBackendFactory = (kind, locator) => ({
  delete: () => Promise.resolve(false),
  kind,
  locator,
  probe: () => Promise.resolve(),
  read: () => Promise.resolve(undefined),
  write: () =>
    Promise.reject(
      new CliError('AUTH_STORAGE_UNAVAILABLE', 'The keyring is locked.')
    )
})

afterEach(async () => {
  process.exitCode = undefined
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('authentication CLI contract', () => {
  test('supports the complete login, identity, status, and logout lifecycle', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-auth-'))
    temporaryDirectories.push(configDirectory)
    const device = deviceScope()
    const account = accountScope()
    const browserLauncher = vi.fn(async () => undefined)
    const loginStdout = collector()
    const loginStderr = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      accountScope: account,
      browserLauncher,
      clock: clock(),
      configDirectory,
      deviceScope: device,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: loginStderr,
      stdout: loginStdout
    })

    expect(JSON.parse(loginStdout.value())).toEqual({
      alreadyAuthenticated: false,
      apiOrigin: BUILD_CONFIG.apiOrigin,
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      storage: 'file'
    })
    expect(loginStderr.value()).toContain('ABCD-EFGH')
    expect(loginStderr.value()).toContain('confirm code')
    expect(loginStderr.value()).not.toContain('enter code')
    expect(browserLauncher).not.toHaveBeenCalled()
    const combinedLoginOutput = `${loginStdout.value()}${loginStderr.value()}`
    expect(combinedLoginOutput).not.toContain('device-secret-never-print')
    expect(combinedLoginOutput).not.toContain('access-secret-never-print')
    expect(combinedLoginOutput).not.toContain('refresh-secret-never-print')
    expect(loginStderr.value()).toContain(
      'Or open https://auth.example.test/device?user_code=ABCD-EFGH, which has the code filled in.'
    )
    expect(loginStderr.value()).toContain(
      'No browser was opened because --no-browser is set.'
    )

    const metadata = await readFile(join(configDirectory, 'auth.json'), 'utf8')
    expect(metadata).not.toContain('access-secret-never-print')
    expect(metadata).not.toContain('refresh-secret-never-print')

    const repeatLoginStdout = collector()
    await runCli(['login', '--no-browser', '--json'], {
      accountScope: account,
      configDirectory,
      deviceScope: device,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: repeatLoginStdout
    })
    expect(JSON.parse(repeatLoginStdout.value())).toMatchObject({
      accountId: 'account_123',
      alreadyAuthenticated: true
    })
    expect(device.authorize).toHaveBeenCalledTimes(1)

    const whoamiStdout = collector()
    await runCli(['whoami', '--json'], {
      accountScope: account,
      configDirectory,
      deviceScope: device,
      now: () => wallClock,
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

    const statusStdout = collector()
    await runCli(['auth', 'status', '--json'], {
      accountScope: account,
      configDirectory,
      deviceScope: device,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: statusStdout
    })
    expect(JSON.parse(statusStdout.value())).toMatchObject({
      accountId: 'account_123',
      state: 'authenticated',
      storage: 'file'
    })

    const logoutStdout = collector()
    const logoutStderr = collector()
    await runCli(['logout', '--json'], {
      configDirectory,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: logoutStderr,
      stdout: logoutStdout
    })
    expect(JSON.parse(logoutStdout.value())).toEqual({
      orphanedCredential: false,
      remoteSessionRevoked: false,
      removed: true
    })
    expect(logoutStderr.value()).toContain('does not revoke')

    const missingStdout = collector()
    await runCli(['auth', 'status', '--json'], {
      configDirectory,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout: missingStdout
    })
    expect(JSON.parse(missingStdout.value())).toEqual({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      state: 'not_authenticated'
    })
    expect(exitCodes).toEqual([1])
  })

  test.each(['ops=eu@example.com', 'a%b@example.com', 'ops#eu@example.com'])(
    'signs in with the Account email %s and keeps the session usable',
    async (email) => {
      const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-email-'))
      temporaryDirectories.push(configDirectory)
      const device: DeviceAuthScope = {
        authorize: vi.fn(() => Promise.resolve(authorizationFixture)),
        token: vi.fn(() =>
          Promise.resolve({
            ...tokenFixture,
            user: { ...tokenFixture.user, email }
          })
        )
      }
      const account: AccountScope = {
        ...accountScope(),
        get: vi.fn(() => Promise.resolve({ ...identityFixture, email }))
      }
      const run = async (args: string[]) => {
        const stdout = collector()
        const exitCodes: number[] = []
        await runCli(args, {
          accountScope: account,
          clock: clock(),
          configDirectory,
          deviceScope: device,
          now: () => wallClock,
          platform: 'linux',
          setExitCode: (exitCode) => exitCodes.push(exitCode),
          stderr: collector(),
          stdout
        })
        return { exitCodes, stdout: stdout.value() }
      }

      const login = await run([
        'login',
        '--insecure-storage',
        '--no-browser',
        '--json'
      ])
      const whoami = await run(['whoami', '--json'])
      const status = await run(['auth', 'status', '--json'])

      expect(login.exitCodes).toEqual([])
      expect(JSON.parse(login.stdout)).toMatchObject({
        alreadyAuthenticated: false,
        email
      })
      expect(whoami.exitCodes).toEqual([])
      expect(JSON.parse(whoami.stdout)).toEqual({
        accountId: 'account_123',
        email,
        name: 'Ada Lovelace'
      })
      expect(status.exitCodes).toEqual([])
      expect(JSON.parse(status.stdout)).toMatchObject({
        accountId: 'account_123',
        email,
        state: 'authenticated',
        storage: 'file'
      })
    }
  )

  test.each(['ada.example.test', '', 'ada lovelace@example.test'])(
    'refuses a device sign-in whose email is %j and saves nothing',
    async (email) => {
      const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-email-'))
      temporaryDirectories.push(configDirectory)
      const stdout = collector()
      const exitCodes: number[] = []

      await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
        accountScope: accountScope(),
        clock: clock(),
        configDirectory,
        deviceScope: {
          authorize: vi.fn(() => Promise.resolve(authorizationFixture)),
          token: vi.fn(() =>
            Promise.resolve({
              ...tokenFixture,
              user: { ...tokenFixture.user, email }
            })
          )
        },
        now: () => wallClock,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr: collector(),
        stdout
      })

      expect(JSON.parse(stdout.value())).toMatchObject({
        error: { code: 'AUTH_PROTOCOL_ERROR' }
      })
      expect(exitCodes).toEqual([1])
      await expect(
        readFile(join(configDirectory, 'auth.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readFile(join(configDirectory, 'credentials.json'), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  test('renders argument failures as the JSON document on stdout with exit code 2', async () => {
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--unknown', '--json'], {
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(stderr.value()).toBe('')
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION'
      }
    })
    expect(exitCodes).toEqual([2])
  })

  test('aborts login without persisting credentials and exits 130', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-abort-'))
    temporaryDirectories.push(configDirectory)
    const controller = new AbortController()
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      clock: {
        now: () => 0,
        sleep: () => {
          const reason = new DOMException('interrupted', 'AbortError')
          controller.abort(reason)
          return Promise.reject(reason)
        },
        wallNow: () => wallClock
      },
      configDirectory,
      deviceScope: deviceScope(),
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      signal: controller.signal,
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'LOGIN_INTERRUPTED'
      }
    })
    expect(exitCodes).toEqual([130])
    await expect(
      readFile(join(configDirectory, 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(configDirectory, 'credentials.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('maps cancellation of the authorization request to exit 130', async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'photon-cli-authorize-abort-')
    )
    temporaryDirectories.push(configDirectory)
    const controller = new AbortController()
    const reason = new DOMException('interrupted', 'AbortError')
    const device = deviceScope()
    device.authorize = vi.fn(() => {
      controller.abort(reason)
      return Promise.reject(reason)
    })
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      configDirectory,
      deviceScope: device,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      signal: controller.signal,
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'LOGIN_INTERRUPTED' }
    })
    expect(exitCodes).toEqual([130])
    await expect(
      readFile(join(configDirectory, 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('reports a cancelled authorization request as interrupted, not as a connection failure', async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'photon-cli-authorize-transport-abort-')
    )
    temporaryDirectories.push(configDirectory)
    const controller = new AbortController()
    const device = deviceScope()
    device.authorize = vi.fn(() => {
      controller.abort(new DOMException('interrupted', 'AbortError'))
      return Promise.reject(new TransportError('request aborted'))
    })
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      configDirectory,
      deviceScope: device,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      signal: controller.signal,
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'LOGIN_INTERRUPTED' }
    })
    expect(exitCodes).toEqual([130])
  })

  test('treats browser launch failure as a warning and continues login', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-browser-'))
    temporaryDirectories.push(configDirectory)
    const stdout = collector()
    const stderr = collector()

    await runCli(['login', '--insecure-storage', '--json'], {
      browserLauncher: () => Promise.reject(new Error('no browser')),
      clock: clock(),
      configDirectory,
      deviceScope: deviceScope(),
      now: () => wallClock,
      platform: 'linux',
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      email: 'ada@example.test'
    })
    expect(stderr.value()).toContain('browser could not be opened')
  })

  test('prints both links before it waits and, with no keychain, saves to a 0600 file and says where', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-file-'))
    temporaryDirectories.push(configDirectory)
    const stdout = collector()
    const stderr = collector()
    const browserLauncher = vi.fn(() => Promise.reject(new Error('no browser')))
    const pollClock = clock()
    const { sleep } = pollClock
    let stderrBeforeWait: string | undefined
    pollClock.sleep = (durationMs) => {
      stderrBeforeWait ??= stderr.value()
      return sleep(durationMs)
    }
    const exitCodes: number[] = []

    await runCli(['login', '--json'], {
      accountScope: accountScope(),
      browserLauncher,
      clock: pollClock,
      configDirectory,
      deviceScope: deviceScope(),
      now: () => wallClock,
      platform: 'linux',
      secureBackend: unavailableKeychain,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(exitCodes).toEqual([])
    expect(stderrBeforeWait).toContain(
      'Open https://auth.example.test/device and confirm code ABCD-EFGH.'
    )
    expect(stderrBeforeWait).toContain(
      'Or open https://auth.example.test/device?user_code=ABCD-EFGH, which has the code filled in.'
    )
    expect(browserLauncher).toHaveBeenCalledWith(
      authorizationFixture.verification_uri_complete
    )
    expect(stderrBeforeWait).toContain(
      'The browser could not be opened. Continue with the printed URL and code.'
    )
    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      storage: 'file'
    })
    const credentials = join(configDirectory, 'credentials.json')
    if (process.platform !== 'win32') {
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bit masks.
      expect((await stat(credentials)).mode & 0o777).toBe(0o600)
    }
    expect(stderr.value()).toContain(
      `The system keychain could not be used, so the sign-in was saved in plain text to ${credentials}.`
    )
    expect(stderr.value()).not.toContain('access-secret-never-print')
  })

  test('saves to a file and says where when the keychain refuses the write', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-refused-'))
    temporaryDirectories.push(configDirectory)
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--no-browser', '--json'], {
      accountScope: accountScope(),
      clock: clock(),
      configDirectory,
      deviceScope: deviceScope(),
      now: () => wallClock,
      platform: 'linux',
      secureBackend: refusingKeychain,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(exitCodes).toEqual([])
    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      storage: 'file'
    })
    const credentials = join(configDirectory, 'credentials.json')
    await expect(readFile(credentials, 'utf8')).resolves.toContain(
      'access-secret-never-print'
    )
    expect(stderr.value()).toContain(
      `The system keychain could not be used, so the sign-in was saved in plain text to ${credentials}.`
    )
  })

  test('opens no browser when CI is set, and says so', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-ci-'))
    temporaryDirectories.push(configDirectory)
    const stdout = collector()
    const stderr = collector()
    const browserLauncher = vi.fn(async () => undefined)

    await runCli(['login', '--insecure-storage', '--json'], {
      accountScope: accountScope(),
      browserLauncher,
      clock: clock(),
      configDirectory,
      deviceScope: deviceScope(),
      env: { CI: '1' },
      now: () => wallClock,
      platform: 'linux',
      stderr,
      stdout
    })

    expect(browserLauncher).not.toHaveBeenCalled()
    expect(stderr.value()).toContain(
      'No browser was opened because CI is set. Continue with the printed URL and code.'
    )
    expect(stderr.value()).toContain(
      `The sign-in was saved in plain text to ${join(configDirectory, 'credentials.json')}.`
    )
    expect(JSON.parse(stdout.value())).toMatchObject({
      alreadyAuthenticated: false,
      storage: 'file'
    })
  })

  test('exits 4 with photon login as the next step when the code expires', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-expired-'))
    temporaryDirectories.push(configDirectory)
    const device = deviceScope()
    device.token = vi.fn(() =>
      Promise.reject(
        new ApiError('expired', {
          body: { error: 'expired_token' },
          headers: new Headers(),
          operationId: 'deviceToken',
          status: 400
        })
      )
    )
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      clock: clock(),
      configDirectory,
      deviceScope: device,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'AUTH_DEVICE_CODE_EXPIRED',
        message: 'The login code expired.',
        next: [
          {
            description: 'Sign in again',
            person: true,
            run: `${CLI_NAME} login`
          }
        ]
      }
    })
    expect(exitCodes).toEqual([4])
    await expect(
      readFile(join(configDirectory, 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('preserves the old session when a forced device flow is denied', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-force-'))
    temporaryDirectories.push(configDirectory)

    await runCli(['login', '--insecure-storage', '--no-browser', '--json'], {
      clock: clock(),
      configDirectory,
      deviceScope: deviceScope(),
      now: () => wallClock,
      platform: 'linux',
      stderr: collector(),
      stdout: collector()
    })

    const denied = new ApiError('denied', {
      body: {
        error: 'access_denied',
        error_description: 'access-secret-never-print'
      },
      headers: new Headers(),
      operationId: 'deviceToken',
      status: 400
    })
    const deniedDevice = deviceScope()
    deniedDevice.token = vi.fn(() => Promise.reject(denied))
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['login', '--force', '--no-browser', '--json'], {
      clock: clock(),
      configDirectory,
      deviceScope: deniedDevice,
      now: () => wallClock,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'AUTH_ACCESS_DENIED' }
    })
    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain('access-secret-never-print')
    expect(stdout.value()).not.toContain('access-secret-never-print')
    await expect(
      readFile(join(configDirectory, 'credentials.json'), 'utf8')
    ).resolves.toContain('access-secret-never-print')
  })

  test('reports corrupt metadata as unavailable without overwriting it', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-status-'))
    temporaryDirectories.push(configDirectory)
    const corruptMetadata = '{"schemaVersion":999}\n'
    await writeFile(join(configDirectory, 'auth.json'), corruptMetadata, {
      mode: 0o600
    })
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['auth', 'status', '--json'], {
      configDirectory,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      state: 'unavailable'
    })
    expect(exitCodes).toEqual([1])
    await expect(
      readFile(join(configDirectory, 'auth.json'), 'utf8')
    ).resolves.toBe(corruptMetadata)
  })

  test('reports credentials from another API origin as unavailable', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'photon-cli-origin-'))
    temporaryDirectories.push(configDirectory)
    const timestamp = '2026-07-30T20:00:00.000Z'
    await writeFile(
      join(configDirectory, 'auth.json'),
      `${JSON.stringify({
        apiOrigin: 'https://api.example.test',
        backend: 'file',
        cachedUser: {
          email: 'cached@example.test',
          id: 'user_cached',
          name: 'Cached User'
        },
        createdAt: timestamp,
        schemaVersion: 1,
        updatedAt: timestamp
      })}\n`,
      { mode: 0o600 }
    )
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['auth', 'status', '--json'], {
      configDirectory,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      reason: expect.stringContaining(`${CLI_NAME} login`),
      state: 'unavailable'
    })
    expect(exitCodes).toEqual([1])
  })

  test('reports cached identity and backend when credentials are unavailable', async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), 'photon-cli-storage-status-')
    )
    temporaryDirectories.push(configDirectory)
    const timestamp = '2026-07-30T20:00:00.000Z'
    await writeFile(
      join(configDirectory, 'auth.json'),
      `${JSON.stringify({
        apiOrigin: BUILD_CONFIG.apiOrigin,
        backend: 'file',
        cachedUser: {
          email: 'cached@example.test',
          id: 'user_cached',
          name: 'Cached User'
        },
        createdAt: timestamp,
        schemaVersion: 1,
        updatedAt: timestamp
      })}\n`,
      { mode: 0o600 }
    )
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(['auth', 'status', '--json'], {
      configDirectory,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr: collector(),
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({
      email: 'cached@example.test',
      name: 'Cached User',
      state: 'unavailable',
      storage: 'file'
    })
    expect(exitCodes).toEqual([1])
  })
})

describe('photon login while already signed in', () => {
  test('names photon login --force on stderr in both modes, never in the JSON document', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const account = {
      get: vi.fn(() => Promise.resolve(identityFixture))
    } as unknown as AccountScope
    const login = async (args: string[]) => {
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(['login', ...args], {
        accountScope: account,
        configDirectory,
        deviceScope: {
          authorize: vi.fn(() => Promise.reject(new Error('no device flow'))),
          token: vi.fn(() => Promise.reject(new Error('no device flow')))
        },
        env: {},
        now: () => wallClock,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })
      return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
    }

    const text = await login([])
    const machine = await login(['--json'])

    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toBe('Already logged in as ada@example.test.\n')
    expect(text.stderr).toContain(
      `Next: Sign in as a different account (you do this): ${CLI_NAME} login --force\n`
    )
    expect(machine.exitCodes).toEqual([])
    const document = JSON.parse(machine.stdout)
    expect(document).toMatchObject({ alreadyAuthenticated: true })
    expect(document).not.toHaveProperty('next')
    expect(machine.stderr).toContain(
      `Next: Sign in as a different account (you do this): ${CLI_NAME} login --force\n`
    )
  })
})
