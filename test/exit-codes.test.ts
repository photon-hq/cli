import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ApiError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import type { ProjectScope } from '../src/project/service.ts'
import { photonKey } from './key-support.ts'
import {
  asOrganizationScope,
  asProjectScope,
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const KEY_ID = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
const timestamp = '2026-07-31T18:00:00.000Z'

const apiKey = {
  apiKeyId: KEY_ID,
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  expiresAt: null,
  name: 'Deploy key',
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: 'pho_prj_00000000000000000000000001',
  revokedAt: null
}

const unavailable = () =>
  new ApiError('request failed', {
    body: {
      code: 'PROJECTS_UNAVAILABLE',
      detail: 'Temporary project service failure.'
    },
    headers: new Headers(),
    operationId: 'listProjectApiKeys',
    requestId: 'req_exit_codes',
    status: 503
  })

const refused = () =>
  new ApiError('request failed', {
    body: {
      code: 'PERMISSION_DENIED',
      detail: 'This key cannot read project API keys.'
    },
    headers: new Headers(),
    operationId: 'listProjectApiKeys',
    requestId: 'req_exit_codes_refused',
    status: 403
  })

const fakeProjects = () => {
  const listProjectApiKeys = vi.fn<ProjectScope['listProjectApiKeys']>(() =>
    Promise.resolve({ apiKeys: [apiKey] })
  )
  const revokeProjectApiKey = vi.fn<ProjectScope['revokeProjectApiKey']>(() =>
    Promise.resolve({ apiKey: { ...apiKey, revokedAt: timestamp } })
  )
  return {
    listProjectApiKeys,
    revokeProjectApiKey,
    scope: asProjectScope({ listProjectApiKeys, revokeProjectApiKey })
  }
}

interface RunOptions {
  /** What a person types at the terminal; without it nothing is a terminal. */
  answer?: string
  projects?: ReturnType<typeof fakeProjects>
  signal?: AbortSignal
  signedIn?: boolean
}

const run = async (args: string[], options: RunOptions = {}) => {
  const config =
    options.signedIn === false
      ? await mkdtemp(join(tmpdir(), 'photon-exit-codes-'))
      : await createAuthenticatedConfig()
  const configDirectory =
    typeof config === 'string' ? config : config.configDirectory
  const terminal = options.answer !== undefined
  const stdin = Readable.from(terminal ? [options.answer] : []) as Readable &
    ReadableInput
  stdin.isTTY = terminal
  const stdout = collector(terminal)
  const stderr = collector(terminal)
  const exitCodes: number[] = []
  await runCli([...args, '--no-color'], {
    configDirectory,
    deviceScope: unusedDeviceScope(),
    env: {},
    now: () => TEST_NOW,
    organizationScope: asOrganizationScope(),
    platform: 'linux',
    projectScope: (options.projects ?? fakeProjects()).scope,
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stderr,
    stdin,
    stdout
  })
  await (typeof config === 'string'
    ? rm(config, { force: true, recursive: true })
    : config.remove())
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const LIST = [
  'project',
  'api-key',
  'list',
  '--project',
  'pho_prj_00000000000000000000000001'
]
const REVOKE = [
  'project',
  'api-key',
  'revoke',
  KEY_ID,
  '--project',
  'pho_prj_00000000000000000000000001'
]

describe('exit codes', () => {
  test('0 for a success and for an empty list', async () => {
    const empty = fakeProjects()
    empty.listProjectApiKeys.mockResolvedValueOnce({ apiKeys: [] })

    const listed = await run(LIST)
    const listedEmpty = await run(LIST, { projects: empty })
    const revoked = await run([...REVOKE, '--yes'])

    expect(listed.stdout).toContain(KEY_ID)
    expect(listed.exitCodes).toEqual([])
    expect(listedEmpty.exitCodes).toEqual([])
    expect(revoked.exitCodes).toEqual([])
  })

  test('1 for a failure, a key the API refuses and a declined confirmation', async () => {
    const failing = fakeProjects()
    failing.listProjectApiKeys.mockRejectedValueOnce(unavailable())
    const refusing = fakeProjects()
    refusing.listProjectApiKeys.mockRejectedValueOnce(refused())
    const declining = fakeProjects()

    const failed = await run(LIST, { projects: failing })
    const wrongKey = await run(LIST, { projects: refusing })
    const declined = await run(REVOKE, { answer: 'n\n', projects: declining })

    expect(failed.stderr).toContain('PROJECTS_UNAVAILABLE')
    expect(failed.exitCodes).toEqual([1])
    expect(wrongKey.stderr).toContain('PERMISSION_DENIED')
    expect(wrongKey.exitCodes).toEqual([1])
    expect(declined.stderr).toContain('Cancelled.')
    expect(declined.exitCodes).toEqual([1])
    expect(declining.revokeProjectApiKey).not.toHaveBeenCalled()
  })

  test('2 for invalid usage, CONFIRMATION_REQUIRED, PROJECT_NOT_SELECTED and a 1.0 command', async () => {
    const unconfirmed = fakeProjects()

    const results = {
      confirmationRequired: await run(REVOKE, { projects: unconfirmed }),
      invalidUsage: await run([...LIST, '--no-such-option']),
      legacyCommand: await run(['spectrum', 'lines', 'list']),
      projectNotSelected: await run(['project', 'api-key', 'list'])
    }

    expect(results.confirmationRequired.stderr).toContain(
      'CONFIRMATION_REQUIRED'
    )
    expect(unconfirmed.revokeProjectApiKey).not.toHaveBeenCalled()
    expect(results.invalidUsage.stderr).toContain('--no-such-option')
    expect(results.legacyCommand.stderr).toContain('LEGACY_COMMAND')
    expect(results.projectNotSelected.stderr).toContain('PROJECT_NOT_SELECTED')
    for (const result of Object.values(results)) {
      expect(result.exitCodes).toEqual([2])
    }
  })

  test('4 when no one is signed in', async () => {
    const projects = fakeProjects()

    const result = await run(LIST, { projects, signedIn: false })

    expect(result.stderr).toContain('NOT_AUTHENTICATED')
    expect(result.stderr).toContain(`${CLI_NAME} login`)
    expect(result.exitCodes).toEqual([4])
    expect(projects.listProjectApiKeys).not.toHaveBeenCalled()
  })

  test('130 for Ctrl-C', async () => {
    const controller = new AbortController()
    const projects = fakeProjects()
    projects.listProjectApiKeys.mockImplementationOnce(() => {
      const reason = new DOMException('interrupted', 'AbortError')
      controller.abort(reason)
      return Promise.reject(reason)
    })

    const result = await run(LIST, { projects, signal: controller.signal })

    expect(result.exitCodes).toEqual([130])
  })
})
