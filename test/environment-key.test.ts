import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { resolveTarget } from '../scripts/build-config.mjs'
import type { PhotonPluginOptions } from '../src/app/plugin.ts'
import { API_TOKEN_VARIABLE } from '../src/auth/constants.ts'
import {
  environmentKey,
  environmentKeyIdentity
} from '../src/auth/environment-key.ts'
import { environmentKeyRefused } from '../src/auth/errors.ts'
import type { CredentialBackend } from '../src/auth/storage/backends.ts'
import type { SecureBackendFactory } from '../src/auth/storage/repository.ts'
import { CliError } from '../src/core/errors.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  lateFailingStdout,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT_KEY = photonKey(
  'sk',
  '01h455vb4pex5vsknk084sn02q_project-secret-never-print'
)
const ACCOUNT_KEY = photonKey(
  'ask',
  '01h455vb4pex5vsknk084sn02q_account-secret-never-print'
)
const IDENTITY_KEY =
  'pho_scred_01h455vb4pex5vsknk084sn02q_identity-secret-never-print'
const UNKNOWN_KEY = 'custom-token-unknown-secret-never-print'
const ACCOUNT_ID = 'pho_acc_01h455vb4pex5vsknk084sn02q'
const ACCOUNT = {
  accountId: ACCOUNT_ID,
  createdAt: '2026-07-01T00:00:00.000Z',
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: '2026-07-01T00:00:00.000Z'
}

interface Exchange {
  authorization: string | undefined
  idempotencyKey: string | undefined
  method: string | undefined
  url: string | undefined
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((done) => {
          server.close(() => done())
        })
    )
  )
})

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200
): void => {
  response.writeHead(status, {
    'content-type':
      status >= 400 ? 'application/problem+json' : 'application/json'
  })
  response.end(JSON.stringify(body))
}

/** A fake Photon API that records each request it gets. */
const fakeApi = async (
  handler: Handler
): Promise<{ exchanges: Exchange[]; origin: string }> => {
  const exchanges: Exchange[] = []
  const server = createServer((request, response) => {
    exchanges.push({
      authorization: request.headers.authorization,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
      method: request.method,
      url: request.url
    })
    request.resume()
    request.on('end', () => handler(request, response))
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return { exchanges, origin: `http://127.0.0.1:${port.toString()}` }
}

const emptyWebhookList: Handler = (_request, response) =>
  writeJson(response, { destinations: [] })

const problem =
  (status: number, title: string): Handler =>
  (_request, response) =>
    writeJson(response, { status, title, type: 'about:blank' }, status)

/** A keychain that fails the test if anything touches it. */
const untouchedKeychain = (): {
  calls: string[]
  factory: SecureBackendFactory
} => {
  const calls: string[] = []
  const record = (name: string) => (): Promise<never> => {
    calls.push(name)
    return Promise.reject(new Error(`keychain ${name} must not run`))
  }
  return {
    calls,
    factory: (kind, locator): CredentialBackend => ({
      delete: record('delete'),
      kind,
      locator,
      probe: record('probe'),
      read: record('read'),
      write: record('write')
    })
  }
}

/** Every file under the directory, with a digest of its bytes. */
const snapshot = async (directory: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        files[`${relative(directory, path)}/`] = 'directory'
        // biome-ignore lint/performance/noAwaitInLoops: the walk is small and ordered.
        await walk(path)
      } else {
        files[relative(directory, path)] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      }
    }
  }
  await walk(directory)
  return files
}

const emptyConfig = async (): Promise<string> =>
  await mkdtemp(join(tmpdir(), 'photon-environment-key-'))

interface Result {
  exitCodes: number[]
  stderr: string
  stdout: string
}

const run = async (
  args: string[],
  options: PhotonPluginOptions & { configDirectory: string }
): Promise<Result> => {
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    cwd: options.configDirectory,
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    platform: 'linux',
    ...options,
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const errorOf = (result: Result): Record<string, unknown> =>
  (JSON.parse(result.stdout) as { error: Record<string, unknown> }).error

describe('the API token variable', () => {
  test('runs a command with only the key, and leaves the config directory and keychain alone', async () => {
    const configDirectory = await emptyConfig()
    const keychain = untouchedKeychain()
    const api = await fakeApi(emptyWebhookList)
    const before = await snapshot(configDirectory)

    const result = await run(
      [
        'project',
        'webhook',
        'list',
        '--project',
        PROJECT_ID,
        '--json',
        '--debug'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY },
        secureBackend: keychain.factory
      }
    )

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({ destinations: [] })
    expect(api.exchanges).toMatchObject([
      {
        authorization: `Bearer ${PROJECT_KEY}`,
        method: 'GET',
        url: expect.stringContaining(
          `/v1/projects/${PROJECT_ID}/webhooks/destinations`
        )
      }
    ])
    expect(result.stderr).toContain('GET')
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'project-secret-never-print'
    )
    expect(await snapshot(configDirectory)).toEqual(before)
    expect(keychain.calls).toEqual([])
  })

  test('outranks a stored sign-in without touching it', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const keychain = untouchedKeychain()
    const api = await fakeApi(emptyWebhookList)
    const before = await snapshot(configDirectory)

    const result = await run(
      ['project', 'webhook', 'list', '--project', PROJECT_ID, '--json'],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY },
        secureBackend: keychain.factory
      }
    )

    expect(result.exitCodes).toEqual([])
    expect(api.exchanges.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${PROJECT_KEY}`
    ])
    expect(await snapshot(configDirectory)).toEqual(before)
    expect(keychain.calls).toEqual([])
  })

  test('exits 4 after a 401, with a step to replace the key and the key nowhere in the output', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi(problem(401, 'The credential is invalid.'))
    const before = await snapshot(configDirectory)

    const result = await run(
      [
        'project',
        'webhook',
        'list',
        '--project',
        PROJECT_ID,
        '--json',
        '--debug'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
      }
    )

    expect(result.exitCodes).toEqual([4])
    const error = errorOf(result)
    expect(error).toMatchObject({
      message: `Photon refused the key in ${API_TOKEN_VARIABLE}.`,
      next: [
        {
          description: `Replace the key in ${API_TOKEN_VARIABLE} with a valid one`,
          person: true
        }
      ]
    })
    expect(JSON.stringify(error.next)).not.toContain(`${CLI_NAME} login`)
    expect(api.exchanges).toHaveLength(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'project-secret-never-print'
    )
    expect(await snapshot(configDirectory)).toEqual(before)
  })

  test.each([
    ['a Project API key', PROJECT_KEY, 'project-secret-never-print'],
    ['a service identity key', IDENTITY_KEY, 'identity-secret-never-print'],
    ['a key of no known shape', UNKNOWN_KEY, 'unknown-secret-never-print']
  ])(
    'keeps %s out of the output when the API echoes it',
    async (_name, key, secret) => {
      const configDirectory = await emptyConfig()
      const echo =
        (status: number): Handler =>
        (request, response) =>
          writeJson(
            response,
            {
              detail: `Rejected ${request.headers.authorization ?? ''}`,
              status,
              title: `Key ${key} refused`,
              type: 'about:blank'
            },
            status
          )
      const results = await Promise.all(
        [401, 403].map(async (status) => {
          const api = await fakeApi(echo(status))
          return await run(
            [
              'project',
              'webhook',
              'list',
              '--project',
              PROJECT_ID,
              '--json',
              '--debug'
            ],
            {
              baseUrl: api.origin,
              configDirectory,
              env: { [API_TOKEN_VARIABLE]: key }
            }
          )
        })
      )

      expect(results.map(({ exitCodes }) => exitCodes)).toEqual([[4], [1]])
      for (const result of results) {
        expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
      }
    }
  )

  test('keeps the API wording out of a 401 for a sensitive command', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi((_request, response) =>
      writeJson(
        response,
        {
          detail: 'Distinctive server wording for this key.',
          status: 401,
          title: 'Unauthorized',
          type: 'about:blank'
        },
        401
      )
    )

    const result = await run(
      [
        'account',
        'service-key',
        'create',
        '--name',
        'ci',
        '--no-expiry',
        '--json'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: ACCOUNT_KEY }
      }
    )

    expect(result.exitCodes).toEqual([4])
    expect(errorOf(result)).toMatchObject({
      message: `Photon refused the key in ${API_TOKEN_VARIABLE}.`
    })
    expect(result.stderr).not.toContain('Distinctive server wording')
    expect(result.stdout).not.toContain('Distinctive server wording')
    expect(result.stderr).not.toContain('account-secret-never-print')
    expect(result.stdout).not.toContain('account-secret-never-print')
  })

  test.each([
    ['a Project API key', PROJECT_KEY, 'project API key'],
    ['an Account Service Key', ACCOUNT_KEY, 'account service key'],
    ['a service identity key', IDENTITY_KEY, 'service identity API key'],
    ['a key of no known shape', UNKNOWN_KEY, 'key']
  ])(
    'exits 1 when the API refuses %s with a 403, and names its kind, the variable and what the API said',
    async (_name, key, kind) => {
      const configDirectory = await emptyConfig()
      const api = await fakeApi(
        problem(403, 'This operation needs an Account Service Key.')
      )
      const options = {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: key }
      }
      const args = ['project', 'webhook', 'list', '--project', PROJECT_ID]

      const json = await run([...args, '--json'], options)
      const text = await run(args, options)

      expect([json.exitCodes, text.exitCodes]).toEqual([[1], [1]])
      expect(errorOf(json)).toMatchObject({
        detail: 'This operation needs an Account Service Key.',
        message: `The ${kind} in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
      })
      expect(text.stderr).toContain(
        `Error: The ${kind} in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
      )
      expect(text.stderr).toContain(
        'Detail: This operation needs an Account Service Key.'
      )
      expect(`${json.stderr}${text.stderr}`).not.toContain('never-print')
    }
  )

  test('keeps the API wording out of a 403 for a sensitive command, and still names the key', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi((_request, response) =>
      writeJson(
        response,
        {
          detail: 'Distinctive server wording for this key.',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank'
        },
        403
      )
    )

    const result = await run(
      [
        'account',
        'service-key',
        'create',
        '--name',
        'ci',
        '--no-expiry',
        '--json'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
      }
    )

    expect(result.exitCodes).toEqual([1])
    expect(errorOf(result)).toMatchObject({
      detail: "Photon's API answered HTTP 403.",
      message: `The project API key in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
    })
    expect(result.stderr).not.toContain('Distinctive server wording')
    expect(result.stdout).not.toContain('Distinctive server wording')
    expect(result.stderr).not.toContain('never-print')
    expect(result.stdout).not.toContain('never-print')
  })

  test('leaves a 403 from somewhere other than Photon as it is', async () => {
    const configDirectory = await emptyConfig()
    const avatarPath = join(configDirectory, 'avatar.png')
    await writeFile(
      avatarPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const api = await fakeApi((request, response) => {
      if (request.url === '/v1/account/profile-picture/uploads') {
        writeJson(
          response,
          {
            expiresAt: '2026-08-01T19:00:00.000Z',
            formFields: { key: 'account/avatar.png' },
            uploadId: 'pho_upl_00000000000000000000000000',
            uploadUrl: 'https://uploads.example.test/account-avatar'
          },
          201
        )
        return
      }
      writeJson(response, ACCOUNT)
    })
    const storage: string[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith('https://uploads.example.test/')) {
        storage.push(url)
        return new Response(null, { status: 403 })
      }
      return await globalThis.fetch(input, init)
    }

    const result = await run(
      ['account', 'avatar', 'upload', avatarPath, '--json'],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: ACCOUNT_KEY },
        fetch
      }
    )

    expect(storage).toHaveLength(1)
    expect(result.exitCodes).toEqual([1])
    expect(errorOf(result)).toMatchObject({
      code: 'AVATAR_UPLOAD_FAILED',
      detail: 'The storage provider returned HTTP 403.',
      message: 'The avatar file could not be uploaded.'
    })
  })

  test.each([
    [
      'project platform voice assignment view',
      [
        'project',
        'platform',
        'voice',
        'assignment',
        'view',
        'pho_res_01h455vb4pex5vsknk084sn02q',
        '--project',
        PROJECT_ID
      ]
    ],
    ...(stagingTarget
      ? [
          [
            'project telemetry trace view',
            [
              'project',
              'telemetry',
              'trace',
              'view',
              '0123456789abcdef0123456789abcdef',
              '--project',
              PROJECT_ID
            ]
          ]
        ]
      : [])
  ])(
    'names the key in a 403 and asks to replace it after a 401 for %s',
    async (_name, args) => {
      const configDirectory = await emptyConfig()
      const refused = await fakeApi(
        problem(403, 'This operation needs an Account Service Key.')
      )
      const rejected = await fakeApi(problem(401, 'The credential is invalid.'))
      const env = { [API_TOKEN_VARIABLE]: PROJECT_KEY }

      const forbidden = await run([...args, '--json'], {
        baseUrl: refused.origin,
        configDirectory,
        env
      })
      const unauthorized = await run([...args, '--json'], {
        baseUrl: rejected.origin,
        configDirectory,
        env
      })

      expect(
        refused.exchanges.map(({ authorization }) => authorization)
      ).toEqual([`Bearer ${PROJECT_KEY}`])
      expect(forbidden.exitCodes).toEqual([1])
      expect(errorOf(forbidden)).toMatchObject({
        detail: 'This operation needs an Account Service Key.',
        message: `The project API key in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
      })
      expect(unauthorized.exitCodes).toEqual([4])
      expect(errorOf(unauthorized)).toMatchObject({
        message: `Photon refused the key in ${API_TOKEN_VARIABLE}.`,
        next: [
          {
            description: `Replace the key in ${API_TOKEN_VARIABLE} with a valid one`,
            person: true
          }
        ]
      })
      expect(rejected.exchanges).toHaveLength(1)
    }
  )

  test('leaves a 403 alone when the request carried no key', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi(
      problem(403, 'The scope catalog is not available.')
    )

    const result = await run(['account', 'oauth', 'scope', 'list', '--json'], {
      baseUrl: api.origin,
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
    })

    expect(api.exchanges.map(({ authorization }) => authorization)).toEqual([
      undefined
    ])
    expect(result.exitCodes).toEqual([1])
    const error = errorOf(result)
    expect(error).toMatchObject({
      message: 'The scope catalog is not available.'
    })
    expect(error).not.toHaveProperty('detail')
  })

  test('leaves the message of a 403 alone for a stored sign-in', async () => {
    const api = await fakeApi(
      problem(403, 'This operation needs an Account Service Key.')
    )
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.origin
    )

    const result = await run(
      ['project', 'webhook', 'list', '--project', PROJECT_ID, '--json'],
      { baseUrl: api.origin, configDirectory, env: {} }
    )

    expect(api.exchanges.map(({ authorization }) => authorization)).toEqual([
      'Bearer project-access-token'
    ])
    expect(result.exitCodes).toEqual([1])
    const error = errorOf(result)
    expect(error).toMatchObject({
      message: 'This operation needs an Account Service Key.'
    })
    expect(error).not.toHaveProperty('detail')
  })

  test.each([['account view'], ['whoami']])(
    'says nothing about stored credentials when the API refuses the key on photon %s',
    async (command) => {
      const configDirectory = await emptyConfig()
      const api = await fakeApi(problem(403, 'Forbidden'))
      const options = {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
      }

      const json = await run([...command.split(' '), '--json'], options)
      const text = await run(command.split(' '), options)

      expect([json.exitCodes, text.exitCodes]).toEqual([[1], [1]])
      expect(errorOf(json)).toMatchObject({
        detail: 'Forbidden',
        message: `The project API key in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
      })
      expect(text.stderr).toContain('Detail: Forbidden\n')
      expect(`${json.stdout}${json.stderr}${text.stderr}`).not.toContain(
        'preserved'
      )
    }
  )

  test('says the stored credentials were kept, as its own sentence, when the API refuses a stored sign-in on photon account view', async () => {
    const api = await fakeApi(problem(403, 'Forbidden'))
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      api.origin
    )
    const options = { baseUrl: api.origin, configDirectory, env: {} }

    const json = await run(['account', 'view', '--json'], options)
    const text = await run(['account', 'view'], options)

    expect(api.exchanges.map(({ authorization }) => authorization)).toEqual([
      'Bearer project-access-token',
      'Bearer project-access-token'
    ])
    expect([json.exitCodes, text.exitCodes]).toEqual([[1], [1]])
    expect(errorOf(json)).toMatchObject({
      message: 'Forbidden. Your credentials were preserved.'
    })
    expect(errorOf(json)).not.toHaveProperty('detail')
    expect(text.stderr).toContain(
      'Error: Forbidden. Your credentials were preserved.'
    )
  })

  test('repeats a keyed write with its idempotency key after a retryable failure, and keeps no journal', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi(problem(503, 'Photon is unavailable.'))
    const before = await snapshot(configDirectory)

    const result = await run(
      [
        'project',
        'webhook',
        'create',
        '--project',
        PROJECT_ID,
        '--name',
        'Production hook',
        '--url',
        'https://hooks.example.test/deliver',
        '--api-version',
        '2026-07-01',
        '--all-events',
        '--json'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
      }
    )

    const writes = api.exchanges.filter(({ method }) => method === 'POST')
    expect(writes.length).toBeGreaterThan(0)
    const [{ idempotencyKey }] = writes as [Exchange]
    expect(idempotencyKey).toEqual(expect.any(String))
    expect(result.exitCodes).toEqual([1])
    const error = errorOf(result)
    expect(error).toMatchObject({
      idempotencyKey,
      next: expect.arrayContaining([
        {
          description: `Retry the same command with --idempotency-key ${idempotencyKey ?? ''}`
        }
      ])
    })
    expect(error).not.toHaveProperty('operationId')
    expect(JSON.stringify(error.next)).not.toContain('operation replay')
    expect(await snapshot(configDirectory)).toEqual(before)
  })

  test('names the retry with its idempotency key when stdout fails after a rotated signing secret, and keeps no journal', async () => {
    const configDirectory = await emptyConfig()
    const signingSecret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
    const api = await fakeApi((_request, response) =>
      writeJson(response, {
        previousSecretExpiresAt: '2026-01-02T00:00:00.000Z',
        signingSecret
      })
    )
    const before = await snapshot(configDirectory)
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'webhook',
        'rotate-secret',
        'pho_whd_01h455vb4pex5vsknk084sn02q',
        '--project',
        PROJECT_ID,
        '--yes',
        '--json'
      ],
      {
        baseUrl: api.origin,
        configDirectory,
        cwd: configDirectory,
        deviceScope: unusedDeviceScope(),
        env: { [API_TOKEN_VARIABLE]: PROJECT_KEY },
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout: lateFailingStdout()
      }
    )

    const [{ idempotencyKey }] = api.exchanges.filter(
      ({ method }) => method === 'POST'
    ) as [Exchange]
    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain(signingSecret)
    const { error } = JSON.parse(
      stderr.value().trim().split('\n').at(-1) ?? ''
    ) as { error: Record<string, unknown> }
    expect(error).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      idempotencyKey,
      next: [
        {
          description: `Retry the same command with --idempotency-key ${idempotencyKey ?? ''}`
        }
      ]
    })
    expect(error).not.toHaveProperty('operationId')
    expect(error).not.toHaveProperty('replayable')
    expect(await snapshot(configDirectory)).toEqual(before)
  })

  test('without a project exits 2 with PROJECT_NOT_SELECTED, and with no credential exits 4', async () => {
    const configDirectory = await emptyConfig()

    const withKey = await run(['project', 'webhook', 'list', '--json'], {
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
    })
    const withNothing = await run(['project', 'webhook', 'list', '--json'], {
      configDirectory,
      env: {}
    })
    const withEmptyKey = await run(['project', 'webhook', 'list', '--json'], {
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: '' }
    })

    expect(withKey.exitCodes).toEqual([2])
    expect(errorOf(withKey)).toMatchObject({ code: 'PROJECT_NOT_SELECTED' })
    for (const signedOut of [withNothing, withEmptyKey]) {
      expect(signedOut.exitCodes).toEqual([4])
      expect(errorOf(signedOut)).toMatchObject({
        code: 'NOT_AUTHENTICATED',
        next: [{ run: `${CLI_NAME} login` }]
      })
    }
  })

  test('ignores the variable of the other build', async () => {
    const configDirectory = await emptyConfig()
    const otherVariable =
      API_TOKEN_VARIABLE === 'PHOTON_API_TOKEN'
        ? 'PHOTON_STAGING_API_TOKEN'
        : 'PHOTON_API_TOKEN'

    const result = await run(['project', 'webhook', 'list', '--json'], {
      configDirectory,
      env: { [otherVariable]: PROJECT_KEY, PHOTON_PROJECT_ID: PROJECT_ID }
    })

    expect(result.exitCodes).toEqual([4])
    expect(errorOf(result)).toMatchObject({ code: 'NOT_AUTHENTICATED' })
  })

  test.each([
    ['login', ['login', '--no-browser', '--json']],
    ['login --service-key', ['login', '--service-key', '--json']]
  ])('makes %s refuse', async (_name, args) => {
    const configDirectory = await emptyConfig()
    const before = await snapshot(configDirectory)

    const result = await run(args, {
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
    })

    expect(result.exitCodes).toEqual([2])
    expect(errorOf(result)).toMatchObject({
      code: 'AUTH_ENVIRONMENT_KEY_SET',
      message: `${API_TOKEN_VARIABLE} is set, so ${CLI_NAME} uses its key and does not save a sign-in.`
    })
    expect(await snapshot(configDirectory)).toEqual(before)
  })

  test('lets logout remove the stored sign-in and says the key is still in use', async () => {
    const { configDirectory } = await createAuthenticatedConfig()

    const result = await run(['logout', '--json'], {
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: PROJECT_KEY }
    })

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({ removed: true })
    expect(result.stderr).toContain(
      `${API_TOKEN_VARIABLE} is still set, so ${CLI_NAME} keeps using its key. Unset ${API_TOKEN_VARIABLE} to stop using it.`
    )
    expect(await readdir(configDirectory)).not.toContain('auth.json')
  })
})

describe('the error for a key Photon refuses with a 403', () => {
  test("keeps a command's own detail after its message", () => {
    const key = environmentKey({ [API_TOKEN_VARIABLE]: ACCOUNT_KEY })
    if (key === undefined) {
      throw new Error('The test key must be read.')
    }
    const error = environmentKeyRefused(
      new CliError('AUTH_REQUEST_FAILED', 'Photon could not start.', {
        detail: 'This operation needs a sign-in.',
        httpStatus: 403
      }),
      key
    )

    expect(error).toMatchObject({
      code: 'AUTH_REQUEST_FAILED',
      detail: 'Photon could not start. This operation needs a sign-in.',
      exitCode: 1,
      httpStatus: 403,
      message: `The account service key in ${API_TOKEN_VARIABLE} isn't allowed to do this.`
    })
  })

  test('closes a message that ends no sentence before the detail after it', () => {
    const key = environmentKey({ [API_TOKEN_VARIABLE]: ACCOUNT_KEY })
    if (key === undefined) {
      throw new Error('The test key must be read.')
    }
    const error = environmentKeyRefused(
      new CliError('API_ERROR', 'Forbidden', {
        detail: 'This operation needs a sign-in.',
        httpStatus: 403
      }),
      key
    )

    expect(error.detail).toBe('Forbidden. This operation needs a sign-in.')
  })
})

describe('the identity a saved selection is keyed by', () => {
  const identity = (value: string): string => {
    const key = environmentKey({ [API_TOKEN_VARIABLE]: value })
    if (key === undefined) {
      throw new Error('The variable holds no key.')
    }
    return environmentKeyIdentity(key)
  }

  test('is the public ID of a known key', () => {
    expect(identity(PROJECT_KEY)).toBe(
      photonKey('sk', '01h455vb4pex5vsknk084sn02q')
    )
  })

  test('tells values of no known shape apart without holding them', () => {
    const other = 'another-custom-token-never-print'

    expect(identity(UNKNOWN_KEY)).toBe(identity(UNKNOWN_KEY))
    expect(identity(UNKNOWN_KEY)).not.toBe(identity(other))
    expect(identity(UNKNOWN_KEY)).not.toContain('never-print')
    expect(identity(other)).not.toContain('never-print')
  })
})

describe('auth status', () => {
  test.each([
    ['a Project API key', PROJECT_KEY, 'project_api_key'],
    ['a service identity key', IDENTITY_KEY, 'service_identity_key']
  ])(
    'names the source and kind of %s without a request',
    async (_name, key, kind) => {
      const configDirectory = await emptyConfig()
      const api = await fakeApi(problem(500, 'No request expected.'))

      const result = await run(['auth', 'status', '--json'], {
        baseUrl: api.origin,
        configDirectory,
        env: { [API_TOKEN_VARIABLE]: key }
      })

      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toMatchObject({
        credentialKind: kind,
        keyId: key.slice(0, key.indexOf('_', key.indexOf('_', 4) + 1)),
        source: 'environment',
        state: 'unverified',
        variable: API_TOKEN_VARIABLE
      })
      expect(api.exchanges).toEqual([])
      expect(result.stdout).not.toContain('secret-never-print')
    }
  )

  test('checks an Account Service Key with the API and names its source and kind', async () => {
    const configDirectory = await emptyConfig()
    const api = await fakeApi((_request, response) =>
      writeJson(response, ACCOUNT)
    )

    const result = await run(['auth', 'status', '--json'], {
      baseUrl: api.origin,
      configDirectory,
      env: { [API_TOKEN_VARIABLE]: ACCOUNT_KEY }
    })

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      accountId: ACCOUNT_ID,
      credentialKind: 'account_service_key',
      keyId: photonKey('ask', '01h455vb4pex5vsknk084sn02q'),
      source: 'environment',
      state: 'authenticated',
      variable: API_TOKEN_VARIABLE
    })
    expect(api.exchanges).toMatchObject([
      { authorization: `Bearer ${ACCOUNT_KEY}`, method: 'GET' }
    ])
  })

  test('names the source and kind of a stored sign-in', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const getAccount = vi.fn(() => Promise.resolve(ACCOUNT))

    const result = await run(['auth', 'status', '--json'], {
      accountScope: { get: getAccount } as never,
      configDirectory,
      env: {}
    })

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      credentialKind: 'device',
      source: 'stored',
      state: 'authenticated'
    })
  })
})

describe('photon login --help', () => {
  test('tells agents to pass on the link and code, and to use the variable when no one can approve', async () => {
    const lines: string[] = []
    lines.push(await printed(['login', '--help']))
    vi.restoreAllMocks()

    const help = lines.join('\n')
    expect(help).toContain(`$ ${CLI_NAME} login\n`)
    expect(help).toContain('passes the printed link and code to a person')
    expect(help).toContain('Where no one can approve a sign-in')
    expect(help).toContain(`$ export ${API_TOKEN_VARIABLE}=<key>`)
  })
})

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TIMEOUT_MS = 60_000
const builtDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    builtDirectories.map(
      async (directory) => await rm(directory, { force: true, recursive: true })
    )
  )
})

const buildBundle = async (
  environment: 'production' | 'staging'
): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), `photon-${environment}-build-`)
  )
  builtDirectories.push(directory)
  const outfile = join(directory, 'bin.js')
  const { aliases, conditions } = resolveTarget({ environment })
  await build({
    alias: aliases,
    bundle: true,
    conditions,
    entryPoints: [join(root, 'src', 'cli.ts')],
    external: ['@napi-rs/keyring'],
    format: 'esm',
    logLevel: 'silent',
    outfile,
    platform: 'node',
    target: 'node22'
  })
  return outfile
}

/** `auth status --json` from a built bundle, with only the given variables set. */
const bundleStatus = async (
  bundle: string,
  variables: Record<string, string>
): Promise<Record<string, unknown>> => {
  const home = await mkdtemp(join(tmpdir(), 'photon-bundle-home-'))
  builtDirectories.push(home)
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? '',
    PHOTON_NO_UPDATE_NOTIFIER: '1',
    XDG_CONFIG_HOME: join(home, '.config'),
    ...variables
  }
  const result = await promisify(execFile)(
    process.execPath,
    [bundle, 'auth', 'status', '--json'],
    { env }
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }))
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe.runIf(stagingTarget)('each build', () => {
  test(
    'reads its own variable and ignores the other one',
    async () => {
      const [production, staging] = await Promise.all([
        buildBundle('production'),
        buildBundle('staging')
      ])

      const results = await Promise.all([
        bundleStatus(production, { PHOTON_API_TOKEN: PROJECT_KEY }),
        bundleStatus(production, { PHOTON_STAGING_API_TOKEN: PROJECT_KEY }),
        bundleStatus(staging, { PHOTON_STAGING_API_TOKEN: PROJECT_KEY }),
        bundleStatus(staging, { PHOTON_API_TOKEN: PROJECT_KEY })
      ])

      expect(results).toMatchObject([
        {
          credentialKind: 'project_api_key',
          source: 'environment',
          variable: 'PHOTON_API_TOKEN'
        },
        { state: 'not_authenticated' },
        {
          credentialKind: 'project_api_key',
          source: 'environment',
          variable: 'PHOTON_STAGING_API_TOKEN'
        },
        { state: 'not_authenticated' }
      ])
      expect(JSON.stringify(results)).not.toContain('secret-never-print')
    },
    BUILD_TIMEOUT_MS
  )
})
