import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, vi } from 'vitest'
import type { AccountScope } from '../src/account/service.ts'
import type { PhotonPluginOptions } from '../src/app/plugin.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import type { OrganizationScope } from '../src/organization/service.ts'
import type { ProjectRawScope, ProjectScope } from '../src/project/service.ts'

export const TEST_NOW = Date.parse('2026-07-31T18:00:00.000Z')

export const instantPollClock = (): PollClock & { sleeps: number[] } => {
  let elapsed = 0
  const sleeps: number[] = []
  return {
    now: () => elapsed,
    sleep: (durationMs) => {
      elapsed += durationMs
      sleeps.push(durationMs)
      return Promise.resolve()
    },
    sleeps,
    wallNow: () => TEST_NOW + elapsed
  }
}

const temporaryConfigDirectories = new Set<string>()

type DeepPartial<Value> = Value extends (
  ...arguments_: infer Arguments
) => infer Result
  ? (...arguments_: Arguments) => Result
  : Value extends object
    ? { [Key in keyof Value]?: DeepPartial<Value[Key]> }
    : Value

afterEach(async () => {
  await Promise.all(
    [...temporaryConfigDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
  temporaryConfigDirectories.clear()
})

export const collector = (
  isTTY = false
): WritableOutput & { value: () => string } => {
  let contents = ''
  return {
    clearLine: () => undefined,
    cursorTo: () => undefined,
    isTTY,
    moveCursor: () => undefined,
    value: () => contents,
    write: (chunk, callback) => {
      contents += chunk
      callback?.()
    }
  }
}

const WRITE_FAILURES = {
  ENOSPC: 'ENOSPC: no space left on device, write',
  EPIPE: 'write EPIPE'
} as const

/**
 * A stdout that fails the way a full disk (`ENOSPC`) or a closed pipe
 * (`EPIPE`) does: `write` takes the chunk and returns `true`, and the error
 * reaches the write's callback on a later turn of the event loop. Like the
 * CLI's own stdout, it has an `error` listener, so the stream's error event
 * doesn't crash the run.
 */
export const lateFailingStdout = (
  code: keyof typeof WRITE_FAILURES = 'ENOSPC'
): Writable => {
  const stdout = new Writable({
    write: (_chunk, _encoding, callback) => {
      setImmediate(() => {
        callback(
          Object.assign(new Error(WRITE_FAILURES[code]), {
            code,
            syscall: 'write'
          })
        )
      })
    }
  })
  stdout.on('error', () => undefined)
  return stdout
}

/** The JSON error document a `--json` run wrote last on stderr. */
export const stderrError = (stderr: string): Record<string, unknown> =>
  (
    JSON.parse(stderr.trim().split('\n').at(-1) ?? '') as {
      error: Record<string, unknown>
    }
  ).error

export const unusedDeviceScope = (): DeviceAuthScope => ({
  authorize: () => Promise.reject(new Error('authorize should not be called')),
  token: () => Promise.reject(new Error('token should not be called'))
})

export interface CliInvocation {
  exitCodes: number[]
  stderr: string
  stdout: string
}

const invoker =
  (terminal: boolean) =>
  (
    configDirectory: string,
    projectScope: ProjectScope,
    overrides: PhotonPluginOptions = {}
  ): ((args: string[]) => Promise<CliInvocation>) =>
  async (args) => {
    const stderr = collector(terminal)
    const stdout = collector(terminal)
    const exitCodes: number[] = []
    await runCli([...args, terminal ? '--no-color' : '--json'], {
      // A temporary folder, so no .photon/project.json above the repository
      // selects a project.
      cwd: configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope: asOrganizationScope(),
      platform: 'linux',
      ...overrides,
      configDirectory,
      projectScope,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })
    return {
      exitCodes,
      stderr: stderr.value(),
      stdout: stdout.value()
    }
  }

/** Runs the CLI with `--json`, off a terminal. */
export const cliInvoker = invoker(false)

/**
 * Runs the CLI with `--json` like `cliInvoker`, with a stdout whose writes
 * fail late, as on a full disk.
 */
export const lateFailingInvoker =
  (
    configDirectory: string,
    projectScope: ProjectScope,
    overrides: PhotonPluginOptions = {},
    failure: keyof typeof WRITE_FAILURES = 'ENOSPC'
  ): ((args: string[]) => Promise<Omit<CliInvocation, 'stdout'>>) =>
  async (args) => {
    const stderr = collector()
    const exitCodes: number[] = []
    await runCli([...args, '--json'], {
      cwd: configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope: asOrganizationScope(),
      platform: 'linux',
      ...overrides,
      configDirectory,
      projectScope,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout: lateFailingStdout(failure)
    })
    return { exitCodes, stderr: stderr.value() }
  }

/**
 * Runs the CLI as a person at a terminal: standard output and error are
 * terminals and there's no `--json`, so with a terminal `stdin` in the
 * overrides the command may ask its questions.
 */
export const terminalInvoker = invoker(true)

export const createAuthenticatedConfig = async (
  identityId = 'user_ada',
  apiOrigin?: string
): Promise<{ configDirectory: string; remove: () => Promise<void> }> => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'photon-project-'))
  temporaryConfigDirectories.add(configDirectory)
  const repository = new AuthRepository({
    ...(apiOrigin === undefined ? {} : { apiOrigin }),
    configDirectory,
    platform: 'linux'
  })
  const backend = await repository.prepareLoginBackend(true, undefined)
  const metadata = repository.createMetadata(backend, {
    email: `${identityId}@example.test`,
    id: identityId,
    name: 'Ada Lovelace'
  })
  await repository.withLock(async () => {
    await repository.persistSessionLocked(
      repository.createCredential(
        'project-access-token',
        'project-refresh-token',
        new Date(TEST_NOW + 3_600_000)
      ),
      metadata,
      backend.backend
    )
  })
  return {
    configDirectory,
    remove: async () => {
      temporaryConfigDirectories.delete(configDirectory)
      await rm(configDirectory, { force: true, recursive: true })
    }
  }
}

export const asProjectScope = (
  scope: DeepPartial<ProjectScope>
): ProjectScope => scope as ProjectScope

export const asProjectRawScope = (
  scope: DeepPartial<ProjectRawScope>
): ProjectRawScope => scope as ProjectRawScope

export const TEST_ORGANIZATION_ID = 'pho_org_00000000000000000000000001'

// What an organization command prints on stderr before it asks or writes,
// when asOrganizationScope's only organization supplied the organization.
export const ONLY_ORGANIZATION_LINE = `Organization: ${TEST_ORGANIZATION_ID}, from your only organization\n`

// What a project command prints on stderr before it asks or writes, when the
// project came from the .photon/project.json "link" saved in folder.
// The project is its ID, or its name, ID and organization once the command
// has read it.
export const folderProjectLine = (project: string, folder: string): string =>
  `Project: ${project}, from ${join(folder, '.photon', 'project.json')}\n`

export const organizationFixture = (
  organizationId = TEST_ORGANIZATION_ID,
  name = 'Acme'
) => ({
  avatarUrl: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  name,
  organizationId,
  updatedAt: '2026-07-02T00:00:00.000Z',
  version: '1'
})

export const singleOrganizationList = () =>
  Promise.resolve({
    acquisitionQuestionnaireExempt: false,
    organizations: [organizationFixture()],
    ownedOrganizationIds: [TEST_ORGANIZATION_ID]
  })

// An organization scope whose account belongs only to TEST_ORGANIZATION_ID,
// so organization-scoped commands resolve without a stored selection.
export const asOrganizationScope = (
  scope: DeepPartial<OrganizationScope> = {}
): OrganizationScope =>
  ({
    listOrganizations: singleOrganizationList,
    ...scope
  }) as OrganizationScope

export const asAccountScope = (
  scope: DeepPartial<AccountScope>
): AccountScope => scope as AccountScope

/**
 * Every call the fake API received, in the order it received them: the name
 * of each `vi.fn` under `spies` and the arguments it was called with.
 */
export const apiCalls = (spies: object): unknown[][] => {
  const calls: { call: unknown[]; order: number }[] = []
  const visit = (value: unknown, name: string): void => {
    if (vi.isMockFunction(value)) {
      for (const [index, args] of value.mock.calls.entries()) {
        calls.push({
          call: [name, ...args],
          order: value.mock.invocationCallOrder[index] ?? 0
        })
      }
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, name === '' ? key : `${name}.${key}`)
      }
    }
  }
  visit(spies, '')
  return calls
    .sort((left, right) => left.order - right.order)
    .map(({ call }) => call)
}
