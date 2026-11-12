import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { commandMetadata } from '../scripts/export-docs.ts'
import type { AccountScope } from '../src/account/service.ts'
import type { PhotonPluginOptions } from '../src/app/plugin.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const HUMAN_ERROR_PATTERN = /^Error: /u
const STACK_FRAME_LINE_PATTERN = /^ {6}at /mu
const STACK_FRAME_PATTERN = /\n {4}at /u
const CLEAR_SCREEN = '\u001b[2J'

interface Invocation {
  exitCodes: number[]
  stderr: string
  stdout: string
}

const commands = await commandMetadata(photonCommands)

// `complete` is the shell-completion handler: it completes the words it is
// given, so `complete --json=false` asks for completions of that word.
const COMPLETION_COMMAND = 'complete'

const booleanOptions = commands
  .filter(({ path }) => path[1] !== COMPLETION_COMMAND)
  .flatMap(({ options, path }) =>
    options
      .filter((option) => option.type === 'boolean')
      .map(
        (option) =>
          [
            `${path.join(' ')} --${option.name}`,
            {
              command: path.slice(1),
              defaultsToTrue: option.default === true,
              name: option.name
            }
          ] as const
      )
  )

const valueOptions = commands.flatMap(({ options, path }) =>
  options
    .filter(
      (option) => option.type !== 'boolean' && option.type !== 'positional'
    )
    .map(
      (option) =>
        [
          `${path.join(' ')} --${option.name}`,
          { command: path.slice(1), name: option.name }
        ] as const
    )
)

let signedOutDirectory = ''

beforeAll(async () => {
  signedOutDirectory = await mkdtemp(join(tmpdir(), 'photon-arguments-'))
})

afterAll(async () => {
  await rm(signedOutDirectory, { force: true, recursive: true })
})

const invoke = async (
  args: string[],
  options: PhotonPluginOptions = {}
): Promise<Invocation> => {
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((message) => {
    stdout.write(`${String(message)}\n`)
  })
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    await runCli(args, {
      configDirectory: signedOutDirectory,
      deviceScope: unusedDeviceScope(),
      env: {},
      fetch: () => Promise.reject(new Error('No request is expected.')),
      now: () => TEST_NOW,
      platform: 'linux',
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      ...options,
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })
  } finally {
    clock.mockRestore()
    log.mockRestore()
  }
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

// One call site for every run, so the stack traces --debug prints match.
const invokeEach = async <ArgumentLists extends string[][]>(
  ...argumentLists: ArgumentLists
): Promise<{ [Index in keyof ArgumentLists]: Invocation }> => {
  const invocations: Invocation[] = []
  for (const args of argumentLists) {
    // biome-ignore lint/performance/noAwaitInLoops: the runs share one call site so their stack traces match.
    invocations.push(await invoke(args))
  }
  return invocations as { [Index in keyof ArgumentLists]: Invocation }
}

const jsonError = (stderr: string): { error: Record<string, unknown> } =>
  JSON.parse(stderr.trim().split('\n').at(-1) ?? '') as {
    error: Record<string, unknown>
  }

describe('boolean option values, signed out', () => {
  test('--yes=false asks for confirmation, and --json=false prints text', async () => {
    const [reset, unforced] = await invokeEach(
      ['account', 'avatar', 'reset', '--yes=false'],
      ['account', 'avatar', 'reset']
    )
    expect(reset.exitCodes).toEqual([2])
    expect(reset.stderr).toContain('(CONFIRMATION_REQUIRED)')
    expect(reset).toEqual(unforced)

    const [forced, bareForce] = await invokeEach(
      ['account', 'avatar', 'reset', '--yes=true'],
      ['account', 'avatar', 'reset', '--yes']
    )
    expect(forced.stderr).toContain('(NOT_AUTHENTICATED)')
    expect(forced).toEqual(bareForce)

    const [text, unset] = await invokeEach(
      ['whoami', '--json=false'],
      ['whoami']
    )
    expect(text.stderr).toMatch(HUMAN_ERROR_PATTERN)
    expect(text).toEqual(unset)

    const [json, bareJson] = await invokeEach(
      ['whoami', '--json=true'],
      ['whoami', '--json']
    )
    expect(jsonError(json.stdout).error.code).toBe('NOT_AUTHENTICATED')
    expect(json).toEqual(bareJson)
  })

  test.for(booleanOptions)(
    '%s reads =true and =false, and rejects other values',
    async ([, { command, defaultsToTrue, name }]) => {
      const [explicitTrue, bare, explicitFalse, unset, zero, no] =
        await invokeEach(
          [...command, `--${name}=true`],
          [...command, `--${name}`],
          [...command, `--${name}=false`],
          [...command, ...(defaultsToTrue ? [`--no-${name}`] : [])],
          [...command, `--${name}=0`],
          [...command, `--${name}=no`]
        )
      expect(explicitTrue).toEqual(bare)
      expect(explicitFalse).toEqual(unset)
      for (const rejected of [zero, no]) {
        expect(rejected.exitCodes).toEqual([2])
        expect(rejected.stderr).toContain('(ARGUMENT_VALIDATION)')
        expect(rejected.stderr).toContain(`'--${name}'`)
      }
    }
  )
})

describe('options that take a value, signed out', () => {
  test.for(valueOptions)(
    '%s with no value is a usage error',
    async ([, { command, name }]) => {
      const [text, json] = await invokeEach(
        [...command, `--${name}`],
        [...command, `--${name}`, '--json']
      )
      expect(text.exitCodes).toEqual([2])
      expect(text.stderr).toContain('(ARGUMENT_VALIDATION)')
      expect(text.stderr).toContain(`'--${name}'`)
      expect(text.stderr).not.toContain('UNEXPECTED_ERROR')

      expect(json.exitCodes).toEqual([2])
      expect(jsonError(json.stdout).error).toMatchObject({
        code: 'ARGUMENT_VALIDATION',
        issues: expect.arrayContaining([
          { message: expect.stringContaining(`'--${name}'`) }
        ])
      })
    }
  )
})

const clearOptionCases = [
  {
    args: ['--first-name', 'Ann', '--last-name='],
    clearOption: '--clear-last-name',
    command: ['account', 'edit']
  },
  {
    args: ['--last-name='],
    clearOption: '--clear-last-name',
    command: ['project', 'agent-profile', 'edit']
  },
  {
    args: ['client_123', '--description='],
    clearOption: '--clear-description',
    command: ['org', 'oauth-client', 'update']
  },
  {
    args: ['client_123', '--scope='],
    clearOption: '--clear-scopes',
    command: ['org', 'oauth-client', 'update']
  },
  {
    args: ['pho_whd_01h455vb4pex5vsknk084sn02q', '--description='],
    clearOption: '--clear-description',
    command: ['project', 'webhook', 'edit']
  },
  {
    args: ['default', '--sip-uri', 'sip:agent@example.test', '--sip-username='],
    clearOption: '--clear-sip-credentials',
    command: ['project', 'platform', 'voice', 'profile', 'inbound', 'set']
  },
  {
    args: ['default', '--sip-username='],
    clearOption: '--clear-sip-credentials',
    command: ['project', 'platform', 'voice', 'profile', 'inbound', 'edit']
  }
]

describe('an explicit empty value, signed in', () => {
  test('every --clear- option has a case', () => {
    const registered = commands.flatMap(({ options, path }) =>
      options
        .filter((option) => option.name.startsWith('clear-'))
        .map((option) => `${path.slice(1).join(' ')} ${option.name}`)
    )
    const covered = clearOptionCases.map(
      ({ clearOption, command }) =>
        `${command.join(' ')} ${clearOption.slice(2)}`
    )
    const byText = (left: string, right: string): number =>
      left.localeCompare(right, 'en')
    expect(covered.toSorted(byText)).toEqual(registered.toSorted(byText))
  })

  test.for(
    clearOptionCases.map(
      (testCase) => [testCase.command.join(' '), testCase] as const
    )
  )(
    '%s names its --clear- option before any request',
    async ([, { args, clearOption, command }]) => {
      const { configDirectory } = await createAuthenticatedConfig()
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error('No request is expected.'))
      )

      const result = await invoke(
        [
          ...command,
          ...args,
          '--project',
          'pho_prj_00000000000000000000000001',
          '--org',
          'pho_org_00000000000000000000000001'
        ],
        { configDirectory, fetch }
      )

      expect(result.exitCodes).toEqual([2])
      expect(result.stderr).toContain('(ARGUMENT_VALIDATION)')
      expect(result.stderr).toContain(`, pass ${clearOption}.`)
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})

describe('an unexpected error', () => {
  const secret = 'planted-secret-value'
  const failingAccountScope = (): AccountScope =>
    ({
      get: () =>
        Promise.reject(
          new TypeError(
            `Cannot read the session: access_token=${secret} Bearer ${secret}`,
            {
              cause: new Error(
                `Keychain answered api_key: ${secret} from https://uploads.example.test/${secret}.png ${CLEAR_SCREEN}`
              )
            }
          )
        )
    }) as unknown as AccountScope

  test('prints its name, message and stack under --debug, with secrets hidden', async () => {
    const { configDirectory } = await createAuthenticatedConfig()
    const options = { accountScope: failingAccountScope(), configDirectory }

    const text = await invoke(['account', 'view', '--debug'], options)
    expect(text.exitCodes).toEqual([1])
    expect(text.stderr).toContain(
      'Error: Photon encountered an unexpected error. (UNEXPECTED_ERROR)'
    )
    expect(text.stderr).toContain(
      'TypeError: Cannot read the session: access_token=[REDACTED] Bearer [REDACTED]'
    )
    expect(text.stderr).toContain(
      'Error: Keychain answered api_key: [REDACTED] from https://uploads.example.test/[REDACTED]'
    )
    expect(text.stderr).not.toContain(CLEAR_SCREEN)
    expect(text.stderr).toContain('[REDACTED] ^[[2J')
    expect(text.stderr).toMatch(STACK_FRAME_LINE_PATTERN)
    expect(text.stderr).not.toContain(secret)

    const json = await invoke(['account', 'view', '--debug', '--json'], options)
    expect(jsonError(json.stdout).error).toMatchObject({
      code: 'UNEXPECTED_ERROR',
      debug: {
        causes: expect.arrayContaining([
          {
            message:
              'Cannot read the session: access_token=[REDACTED] Bearer [REDACTED]',
            name: 'TypeError',
            stack: expect.stringMatching(STACK_FRAME_PATTERN)
          }
        ])
      }
    })
    expect(json.stderr).not.toContain(secret)
    expect(json.stdout).not.toContain(secret)
    expect(json.stderr).not.toContain(CLEAR_SCREEN)
    expect(json.stdout).not.toContain(CLEAR_SCREEN)
    expect(jsonError(json.stdout).error).toMatchObject({
      debug: {
        causes: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining(`[REDACTED] ${CLEAR_SCREEN}`)
          })
        ])
      }
    })
  })

  test('prints what it printed before without --debug', async () => {
    const { configDirectory } = await createAuthenticatedConfig()

    const result = await invoke(['account', 'view'], {
      accountScope: failingAccountScope(),
      configDirectory
    })

    expect(result.exitCodes).toEqual([1])
    expect(result.stderr).toBe(
      [
        'Error: Photon encountered an unexpected error. (UNEXPECTED_ERROR)',
        'Next: Retry with --debug for diagnostic information.',
        'Docs: https://photon.codes/docs/cli/output#errors',
        ''
      ].join('\n')
    )
  })
})
