import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ApiError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import type { ProjectScope } from '../src/project/service.ts'
import { printed } from './help-support.ts'
import { photonKey } from './key-support.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  lateFailingInvoker,
  lateFailingStdout,
  stderrError,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const expiresAt = '2026-09-01T01:00:00.000Z'
const secret = 'photon_api_key_private_value'
const revocableApiKeyId = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
const revocationSecret = 'private-revocation-material'
const revocableApiKeyCredential = `${revocableApiKeyId}_${revocationSecret}`
const OPERATION_ID_LINE = /^Operation ID: (op_\S+)$/mu
const STACK_FRAME_LINE = /^\s+at /mu

const apiKeyFixture = (
  apiKeyId: string,
  name: string,
  overrides: Partial<{
    expiresAt: null | string
    revokedAt: null | string
  }> = {}
) => ({
  apiKeyId,
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  expiresAt:
    overrides.expiresAt === undefined ? expiresAt : overrides.expiresAt,
  futureField: 'from-a-newer-api',
  name,
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: 'pho_prj_00000000000000000000000001',
  revokedAt: overrides.revokedAt ?? null
})

const apiKeyScope = (revokedApiKeyId = 'api_key_3') => {
  const listProjectApiKeys = vi.fn<ProjectScope['listProjectApiKeys']>(() =>
    Promise.resolve({
      apiKeys: [
        apiKeyFixture('api_key_2', 'Newest'),
        apiKeyFixture('api_key_1', 'Older', { expiresAt: null })
      ]
    })
  )
  const createProjectApiKey = vi.fn<ProjectScope['createProjectApiKey']>(
    (input) =>
      Promise.resolve({
        apiKey: apiKeyFixture('api_key_3', 'Deploy key', {
          expiresAt: input.body.expiresAt ?? null
        }),
        secret
      })
  )
  const revokeProjectApiKey = vi.fn<ProjectScope['revokeProjectApiKey']>(() =>
    Promise.resolve({
      apiKey: apiKeyFixture(revokedApiKeyId, 'Deploy key', {
        revokedAt: timestamp
      })
    })
  )
  return {
    scope: asProjectScope({
      createProjectApiKey,
      listProjectApiKeys,
      revokeProjectApiKey
    }),
    spies: { createProjectApiKey, listProjectApiKeys, revokeProjectApiKey }
  }
}

const unavailable = (): ApiError =>
  new ApiError(`request failed with secret=${secret}`, {
    body: {
      code: 'PROJECTS_UNAVAILABLE',
      detail: `Temporary failure echoed ${secret}`
    },
    headers: new Headers(),
    operationId: 'createProjectApiKey',
    requestId: 'req_api_key',
    status: 503
  })

const revokeUnavailable = (): ApiError =>
  new ApiError('request failed', {
    body: {
      code: 'PROJECTS_UNAVAILABLE',
      detail: 'Temporary project service failure.'
    },
    headers: new Headers(),
    operationId: 'revokeProjectApiKey',
    requestId: 'req_api_key_revoke',
    status: 503
  })

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('project API key CLI', () => {
  test('lists live keys in server order as the API sends them', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const result = await invoke([
      'project',
      'api-key',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      apiKeys: [
        {
          apiKeyId: 'api_key_2',
          createdAt: timestamp,
          createdByAccountId: 'account_owner',
          expiresAt,
          futureField: 'from-a-newer-api',
          name: 'Newest',
          permissions: ['project:read'],
          permissionsUpdatedAt: null,
          projectId: 'pho_prj_00000000000000000000000001',
          revokedAt: null
        },
        {
          apiKeyId: 'api_key_1',
          createdAt: timestamp,
          createdByAccountId: 'account_owner',
          expiresAt: null,
          futureField: 'from-a-newer-api',
          name: 'Older',
          permissions: ['project:read'],
          permissionsUpdatedAt: null,
          projectId: 'pho_prj_00000000000000000000000001',
          revokedAt: null
        }
      ]
    })
    expect(result.stdout).not.toContain(secret)
    expect(spies.listProjectApiKeys).toHaveBeenCalledWith(
      { path: { projectId: 'pho_prj_00000000000000000000000001' } },
      undefined
    )
  })

  test('renders the documented human list columns without secrets', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope } = apiKeyScope()
    const stdout = collector()
    const stderr = collector()

    await runCli(
      [
        'project',
        'api-key',
        'list',
        '--project',
        'pho_prj_00000000000000000000000001'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        stderr,
        stdout
      }
    )

    expect(stderr.value()).toBe('')
    expect(stdout.value()).toContain('NAME')
    expect(stdout.value()).toContain('API KEY ID')
    expect(stdout.value()).toContain('EXPIRES')
    expect(stdout.value()).toContain('CREATED BY')
    expect(stdout.value()).toContain('CREATED')
    expect(stdout.value().indexOf('Newest')).toBeLessThan(
      stdout.value().indexOf('Older')
    )
    expect(stdout.value()).not.toContain(secret)
  })

  test('creates an expiring key and emits its secret only on stdout', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const result = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      ' Deploy key ',
      '--expires-at',
      '2026-08-31T18:00:00-07:00',
      '--idempotency-key',
      'deploy-key-create'
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      apiKey: {
        apiKeyId: 'api_key_3',
        createdAt: timestamp,
        createdByAccountId: 'account_owner',
        expiresAt,
        futureField: 'from-a-newer-api',
        name: 'Deploy key',
        permissions: ['project:read'],
        permissionsUpdatedAt: null,
        projectId: 'pho_prj_00000000000000000000000001',
        revokedAt: null
      },
      secret
    })
    expect(result.stderr).toContain('cannot be retrieved again')
    expect(result.stderr).not.toContain(secret)
    expect(spies.createProjectApiKey).toHaveBeenCalledWith(
      {
        body: { expiresAt, name: 'Deploy key', permissions: ['project:read'] },
        headers: { idempotencyKey: 'deploy-key-create' },
        path: { projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('rejects a secret with control characters before anything prints', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createProjectApiKey = vi.fn<ProjectScope['createProjectApiKey']>(() =>
      Promise.resolve({
        apiKey: apiKeyFixture('api_key_3', 'Deploy key'),
        secret: `${secret}\u001b[31m`
      })
    )
    const scope = asProjectScope({ createProjectApiKey })
    const args = [
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--name',
      'Deploy key',
      '--no-expiry',
      '--project',
      'pho_prj_00000000000000000000000001'
    ]

    const json = await cliInvoker(authenticated.configDirectory, scope)(args)
    const text = await terminalInvoker(
      authenticated.configDirectory,
      scope
    )(args)

    expect(json.exitCodes).toEqual([1])
    expect(JSON.parse(json.stdout)).toEqual({
      error: expect.objectContaining({
        code: 'PROJECT_PROTOCOL_ERROR',
        detail: 'The API key secret was not safe to display.'
      })
    })
    expect(json.stdout).not.toContain(secret)
    expect(json.stderr).not.toContain(secret)
    expect(text.exitCodes).toEqual([1])
    expect(text.stdout).toBe('')
    expect(text.stderr).toContain('PROJECT_PROTOCOL_ERROR')
    expect(text.stderr).not.toContain(secret)
    expect(text.stderr).not.toContain('cannot be retrieved again')
    expect(createProjectApiKey).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('requires an explicit expiry choice and omits expiry when requested', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const missing = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Missing expiry'
    ])
    expect(JSON.parse(missing.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(missing.exitCodes).toEqual([2])

    const conflicting = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Conflicting expiry',
      '--expires-at',
      expiresAt,
      '--no-expiry'
    ])
    expect(JSON.parse(conflicting.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(conflicting.exitCodes).toEqual([2])
    expect(spies.createProjectApiKey).not.toHaveBeenCalled()

    const created = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Deploy key',
      '--no-expiry'
    ])
    expect(JSON.parse(created.stdout)).toHaveProperty('secret', secret)
    expect(spies.createProjectApiKey.mock.calls[0]?.[0].body).toEqual({
      name: 'Deploy key',
      permissions: ['project:read']
    })
  })

  test('rejects invalid names and timestamps before creating an operation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    for (const args of [
      ['--name', 'x'.repeat(129), '--no-expiry'],
      ['--name', 'Deploy key', '--expires-at', 'next Tuesday']
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case verifies a separate CLI invocation.
      const result = await invoke([
        'project',
        'api-key',
        'create',
        '--permission',
        'project:read',
        '--project',
        'pho_prj_00000000000000000000000001',
        ...args
      ])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
      expect(result.exitCodes).toEqual([2])
    }
    expect(spies.createProjectApiKey).not.toHaveBeenCalled()
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('cancels or force-revokes without ever returning a secret', async () => {
    const authenticated = await createAuthenticatedConfig()
    const prompts: string[] = []
    const { scope, spies } = apiKeyScope(revocableApiKeyId)
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      confirm: (message) => {
        prompts.push(message)
        return Promise.resolve(false)
      }
    })

    const cancelled = await invoke([
      'project',
      'api-key',
      'revoke',
      revocableApiKeyId,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(cancelled.stdout).toBe('')
    expect(cancelled.stderr).toBe(
      'Project: pho_prj_00000000000000000000000001, from --project\n'
    )
    expect(prompts).toEqual([
      `Revoke API key ${revocableApiKeyId} from project pho_prj_00000000000000000000000001?`
    ])
    expect(spies.revokeProjectApiKey).not.toHaveBeenCalled()

    const revoked = await invoke([
      'project',
      'api-key',
      'revoke',
      revocableApiKeyId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes',
      '--idempotency-key',
      'deploy-key-revoke'
    ])
    expect(JSON.parse(revoked.stdout)).toEqual({
      apiKey: {
        apiKeyId: revocableApiKeyId,
        createdAt: timestamp,
        createdByAccountId: 'account_owner',
        expiresAt,
        futureField: 'from-a-newer-api',
        name: 'Deploy key',
        permissions: ['project:read'],
        permissionsUpdatedAt: null,
        projectId: 'pho_prj_00000000000000000000000001',
        revokedAt: timestamp
      }
    })
    expect(cancelled.stdout).not.toContain(revocationSecret)
    expect(cancelled.stderr).not.toContain(revocationSecret)
    expect(revoked.stdout).not.toContain(secret)
    expect(revoked.stdout).not.toContain(revocationSecret)
    expect(revoked.stderr).not.toContain(revocationSecret)
    expect(spies.revokeProjectApiKey).toHaveBeenCalledWith(
      {
        headers: { idempotencyKey: 'deploy-key-revoke' },
        path: {
          apiKeyId: revocableApiKeyId,
          projectId: 'pho_prj_00000000000000000000000001'
        }
      },
      undefined
    )
  })

  test('says Cancelled. on stderr, leaves stdout empty and exits 1 when revoke is answered n at a terminal', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope(revocableApiKeyId)
    const stdin = Readable.from(['n\n']) as ReadableInput
    stdin.isTTY = true
    const stdout = collector(true)
    const stderr = collector(true)
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'api-key',
        'revoke',
        revocableApiKeyId,
        '--project',
        'pho_prj_00000000000000000000000001'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdin,
        stdout
      }
    )

    expect(stdout.value()).toBe('')
    expect(stderr.value()).toBe(
      `Project: pho_prj_00000000000000000000000001, from --project\nRevoke API key ${revocableApiKeyId} from project pho_prj_00000000000000000000000001? [y/N] Cancelled.\n`
    )
    expect(exitCodes).toEqual([1])
    expect(spies.revokeProjectApiKey).not.toHaveBeenCalled()
  })

  test('writes the project into the rerun when it came from PHOTON_PROJECT_ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope(revocableApiKeyId)
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      ['project', 'api-key', 'revoke', revocableApiKeyId, '--json'],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        env: { PHOTON_PROJECT_ID: 'pho_prj_00000000000000000000000001' },
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      }
    )

    expect(exitCodes).toEqual([2])
    expect(stderr.value()).toBe('')
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: `This would revoke API key ${revocableApiKeyId} from project pho_prj_00000000000000000000000001. Confirm it with --yes.`,
        next: [
          {
            description: 'Run it again with --yes',
            run: `${CLI_NAME} project api-key revoke ${revocableApiKeyId} --json --project pho_prj_00000000000000000000000001 --yes`
          }
        ]
      }
    })
    expect(spies.revokeProjectApiKey).not.toHaveBeenCalled()
  })

  test('refuses a full API key before the question and any request', async () => {
    const authenticated = await createAuthenticatedConfig()
    const prompts: string[] = []
    const { scope, spies } = apiKeyScope(revocableApiKeyId)
    const fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      confirm: (message) => {
        prompts.push(message)
        return Promise.resolve(true)
      },
      fetch
    })

    const result = await invoke([
      'project',
      'api-key',
      'revoke',
      revocableApiKeyCredential,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail: 'The value is a full API key. Only its ID is accepted.',
        next: [
          {
            description: 'Revoke the key by its ID',
            run: `${CLI_NAME} project api-key revoke ${revocableApiKeyId} --project pho_prj_00000000000000000000000001 --json`
          },
          {
            description: 'List the API key IDs',
            run: `${CLI_NAME} project api-key list`
          }
        ]
      }
    })
    expect(prompts).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(spies.listProjectApiKeys).not.toHaveBeenCalled()
    expect(spies.revokeProjectApiKey).not.toHaveBeenCalled()
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test("keeps a pasted key's secret out of output and the journal", async () => {
    const authenticated = await createAuthenticatedConfig()
    const prompts: string[] = []
    const revokeProjectApiKey = vi
      .fn<ProjectScope['revokeProjectApiKey']>()
      .mockRejectedValueOnce(revokeUnavailable())
    const scope = asProjectScope({ revokeProjectApiKey })
    const uncertain = await cliInvoker(
      authenticated.configDirectory,
      scope
    )([
      'project',
      'api-key',
      'revoke',
      revocableApiKeyId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    expect(JSON.parse(uncertain.stdout)).toMatchObject({
      error: { replayable: true }
    })

    for (const env of [
      {},
      { PHOTON_TOKEN: 'legacy-token' },
      { DASHBOARD_TOKEN: 'legacy-token' }
    ]) {
      for (const mode of [[], ['--json'], ['--debug']]) {
        const stdout = collector()
        const stderr = collector()
        const exitCodes: number[] = []
        // biome-ignore lint/performance/noAwaitInLoops: each case verifies a separate CLI invocation.
        await runCli(
          [
            'project',
            'api-key',
            'revoke',
            revocableApiKeyCredential,
            '--project',
            'pho_prj_00000000000000000000000001',
            ...mode
          ],
          {
            configDirectory: authenticated.configDirectory,
            confirm: (message) => {
              prompts.push(message)
              return Promise.resolve(true)
            },
            deviceScope: unusedDeviceScope(),
            env,
            now: () => TEST_NOW,
            platform: 'linux',
            projectScope: scope,
            setExitCode: (exitCode) => exitCodes.push(exitCode),
            stderr,
            stdout
          }
        )
        expect(exitCodes).toEqual([2])
        const error = (mode.includes('--json') ? stdout : stderr).value()
        expect(error).toContain(
          Object.keys(env).length === 0 ? 'ARGUMENT_VALIDATION' : 'LEGACY_TOKEN'
        )
        expect(error).toContain(revocableApiKeyId)
        expect(stdout.value()).not.toContain(revocationSecret)
        expect(stderr.value()).not.toContain(revocationSecret)
      }
    }

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const journalFiles = await readdir(operationsRoot, { recursive: true })
    expect(journalFiles.filter((file) => file.endsWith('.json'))).toHaveLength(
      1
    )
    const files = await readdir(authenticated.configDirectory, {
      recursive: true,
      withFileTypes: true
    })
    const contents = await Promise.all(
      files
        .filter((file) => file.isFile())
        .map(
          async (file) =>
            await readFile(join(file.parentPath, file.name), 'utf8')
        )
    )
    for (const content of contents) {
      expect(content).not.toContain(revocationSecret)
    }
    expect(prompts).toEqual([])
    expect(revokeProjectApiKey).toHaveBeenCalledTimes(1)
  })

  test('describes the revoke argument as an API key ID', async () => {
    const lines: string[] = []
    lines.push(await printed(['project', 'api-key', 'revoke', '--help']))

    const help = lines.join('\n')
    expect(help).toContain('API key ID to revoke')
    expect(help).not.toContain('credential')
  })

  test('replays an uncertain create without storing or logging the secret', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createProjectApiKey = vi
      .fn<ProjectScope['createProjectApiKey']>()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({
        apiKey: apiKeyFixture('api_key_replayed', 'Replay key'),
        secret
      })
    const scope = asProjectScope({ createProjectApiKey })
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const failed = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Replay key',
      '--expires-at',
      expiresAt,
      '--idempotency-key',
      'replay-api-key',
      '--debug'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failed.stderr).toBe('')
    expect(failed.stderr).not.toContain(secret)
    expect(failed.stdout).not.toContain(secret)
    expect(failure.error).toMatchObject({ replayable: true })

    const viewed = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project api-key create',
        input: {
          expiresAt,
          name: 'Replay key',
          projectId: 'pho_prj_00000000000000000000000001'
        }
      }
    })
    expect(viewed.stdout).not.toContain(secret)

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    expect(scopeName).toBeDefined()
    const record = await readFile(
      join(
        operationsRoot,
        scopeName ?? '',
        `${failure.error.operationId}.json`
      ),
      'utf8'
    )
    expect(record).not.toContain(secret)

    const stdout = collector()
    const stderr = collector()
    await runCli(['operation', 'replay', failure.error.operationId, '--yes'], {
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      projectScope: scope,
      stderr,
      stdout
    })
    expect(stdout.value()).toContain('Recovered API key')
    expect(stdout.value()).toContain(secret)
    expect(stderr.value()).toContain('cannot be retrieved again')
    expect(stderr.value()).not.toContain(secret)
    expect(createProjectApiKey).toHaveBeenCalledTimes(2)
    expect(createProjectApiKey.mock.calls[1]?.[0]).toEqual(
      createProjectApiKey.mock.calls[0]?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('keeps the record and names the replay when stdout fails after taking the secret, and again when the replay output fails', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'api-key',
        'create',
        '--permission',
        'project:read',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--name',
        'Deploy key',
        '--no-expiry',
        '--idempotency-key',
        'api-key-output-failure'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: lateFailingStdout()
      }
    )

    expect(exitCodes).toEqual([1])
    const operationId = OPERATION_ID_LINE.exec(stderr.value())?.[1]
    expect(operationId).toBeDefined()
    expect(stderr.value()).toContain(
      'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)'
    )
    expect(stderr.value()).toContain(
      `Next: Replay the operation: ${CLI_NAME} operation replay ${operationId}`
    )
    expect(stderr.value()).not.toMatch(STACK_FRAME_LINE)
    expect(stderr.value()).not.toContain(secret)

    const invoke = cliInvoker(authenticated.configDirectory, scope)
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [
        { kind: 'api-key.create', operationId, status: 'awaiting-output-ack' }
      ]
    })
    const failedReplay = await lateFailingInvoker(
      authenticated.configDirectory,
      scope
    )(['operation', 'replay', operationId ?? '', '--yes'])
    expect(failedReplay.exitCodes).toEqual([1])
    expect(failedReplay.stderr).not.toContain(secret)
    expect(stderrError(failedReplay.stderr)).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${operationId}`
        }
      ],
      operationId,
      replayable: true
    })
    const replayed = await invoke([
      'operation',
      'replay',
      operationId ?? '',
      '--yes'
    ])
    expect(replayed.stdout.split(secret)).toHaveLength(2)
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'api-key.create', operationId, status: 'resolved' },
      result: { secret }
    })
    expect(replayed.stderr).not.toContain(secret)
    expect(spies.createProjectApiKey).toHaveBeenCalledTimes(3)
    expect(spies.createProjectApiKey.mock.calls[1]?.[0]).toEqual(
      spies.createProjectApiKey.mock.calls[0]?.[0]
    )
    expect(spies.createProjectApiKey.mock.calls[2]?.[0]).toEqual(
      spies.createProjectApiKey.mock.calls[0]?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('still names the replay when the reader closed the pipe, because running create again would make a second key', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = apiKeyScope()

    const failed = await lateFailingInvoker(
      authenticated.configDirectory,
      scope,
      {},
      'EPIPE'
    )([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Deploy key',
      '--no-expiry'
    ])

    expect(failed.exitCodes).toEqual([1])
    expect(failed.stderr).not.toContain(secret)
    const error = stderrError(failed.stderr)
    expect(error).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${String(error.operationId)}`
        }
      ],
      replayable: true
    })
    expect(spies.createProjectApiKey).toHaveBeenCalledOnce()
  })

  test('replays an uncertain revocation with only the ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const revokeProjectApiKey = vi
      .fn<ProjectScope['revokeProjectApiKey']>()
      .mockRejectedValueOnce(revokeUnavailable())
      .mockResolvedValueOnce({
        apiKey: apiKeyFixture(revocableApiKeyId, 'Revoke replay', {
          revokedAt: timestamp
        })
      })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ revokeProjectApiKey })
    )
    const failed = await invoke([
      'project',
      'api-key',
      'revoke',
      revocableApiKeyId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes',
      '--idempotency-key',
      'replay-api-key-revoke'
    ])
    const {
      error: { operationId }
    } = JSON.parse(failed.stdout) as { error: { operationId: string } }
    expect(failed.stderr).toBe('')
    expect(failed.stderr).not.toContain(revocationSecret)
    expect(failed.stdout).not.toContain(revocationSecret)

    const viewed = await invoke(['operation', 'view', operationId])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        input: {
          apiKeyId: revocableApiKeyId,
          projectId: 'pho_prj_00000000000000000000000001'
        }
      }
    })
    expect(viewed.stdout).not.toContain(revocationSecret)

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    const record = await readFile(
      join(operationsRoot, scopeName ?? '', `${operationId}.json`),
      'utf8'
    )
    expect(record).not.toContain(revocationSecret)
    expect(JSON.parse(record)).toMatchObject({
      intent: {
        apiKeyId: revocableApiKeyId,
        projectId: 'pho_prj_00000000000000000000000001'
      }
    })

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'api-key.revoke', status: 'resolved' }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual({
      apiKey: apiKeyFixture(revocableApiKeyId, 'Revoke replay', {
        revokedAt: timestamp
      })
    })
    expect(replayed.stdout).not.toContain(secret)
    expect(replayed.stdout).not.toContain(revocationSecret)
    expect(revokeProjectApiKey).toHaveBeenCalledTimes(2)
    expect(revokeProjectApiKey.mock.calls[1]?.[0]).toEqual(
      revokeProjectApiKey.mock.calls[0]?.[0]
    )
  })

  test('keeps the one-time secret in the JSON replay result envelope', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createProjectApiKey = vi
      .fn<ProjectScope['createProjectApiKey']>()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({
        apiKey: apiKeyFixture('api_key_json_replay', 'JSON replay'),
        secret
      })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ createProjectApiKey })
    )
    const failed = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'JSON replay',
      '--no-expiry'
    ])
    const {
      error: { operationId }
    } = JSON.parse(failed.stdout) as { error: { operationId: string } }

    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'api-key.create', operationId, status: 'resolved' },
      result: { apiKey: { apiKeyId: 'api_key_json_replay' }, secret }
    })
    expect(replayed.stderr).not.toContain(secret)
    expect(replayed.stderr).toContain('cannot be retrieved again')
  })

  test('fails closed on an unsafe returned secret without exposing it', async () => {
    const authenticated = await createAuthenticatedConfig()
    const unsafeSecret = 'private-secret\nsecond-line'
    const createProjectApiKey = vi.fn<ProjectScope['createProjectApiKey']>(() =>
      Promise.resolve({
        apiKey: apiKeyFixture('api_key_unsafe', 'Unsafe key'),
        secret: unsafeSecret
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ createProjectApiKey })
    )

    const failed = await invoke([
      'project',
      'api-key',
      'create',
      '--permission',
      'project:read',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Unsafe key',
      '--no-expiry',
      '--debug'
    ])

    expect(failed.stderr).toBe('')
    expect(failed.stderr).not.toContain('private-secret')
    expect(failed.stdout).not.toContain('private-secret')
    expect(JSON.parse(failed.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_PROTOCOL_ERROR',
        replayable: true,
        retryable: true
      }
    })
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [{ kind: 'api-key.create', status: 'outcome-unknown' }]
    })
  })
})
