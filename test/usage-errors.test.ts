import { stripVTControlCharacters } from 'node:util'
import { kebabnize } from 'gunshi/utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { allCommands } from './help-support.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

// What `photon project lst --json` printed before suggestions existed.
const UNKNOWN_COMMAND_DOCUMENT =
  '{"error":{"code":"ARGUMENT_VALIDATION","message":"The command contains invalid input.","retryable":false,"docsUrl":"https://photon.codes/docs/cli/output#errors","detail":"Command not found: lst","issues":[{"message":"Command not found: lst"}],"next":[{"description":"Run the command with --help for valid options."}]}}\n'

const API_KEY_ID = photonKey('sk', '01h455vb4pex5vsknk084sn02q')

afterEach(() => {
  vi.restoreAllMocks()
})

// Runs the CLI signed in, with a fetch that records every request and fails it.
const run = async (args: string[], isTTY = false, env?: NodeJS.ProcessEnv) => {
  const { configDirectory } = await createAuthenticatedConfig()
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected request'))
  )
  const stderr = collector(isTTY)
  const stdout = collector(isTTY)
  const exitCodes: number[] = []
  await runCli(args, {
    configDirectory,
    deviceScope: unusedDeviceScope(),
    ...(env === undefined ? {} : { env }),
    fetch,
    now: () => TEST_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return {
    exitCodes,
    requests: fetch.mock.calls.length,
    stderr: stderr.value(),
    stdout: stdout.value()
  }
}

const occurrences = (text: string, part: string): number =>
  text.split(part).length - 1

const INVALID_LIMIT = ['project', 'list', '--limit', 'abc']
const NO_SUCH_COMMAND = ['nosuchcommand']
const DOCS_LINE = 'Docs: https://photon.codes/docs/cli/output#errors'

describe('usage errors', () => {
  test('writes an error document instead of rejecting when an argument is not text', async () => {
    const result = await run([
      'project',
      undefined as unknown as string,
      '--json'
    ])

    expect(result.exitCodes).toHaveLength(1)
    expect(result.exitCodes[0]).not.toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toHaveProperty('error.code')
  })

  test('makes a request for a valid command, so the checks below can see one', async () => {
    const result = await run(['project', 'list', '--json'])

    expect(result.requests).toBeGreaterThan(0)
  })

  test.each([
    [['project', 'list', 'extra', '--json']],
    [['project', 'api-key', 'revoke', API_KEY_ID, 'extra', '--yes', '--json']],
    [['project', 'list', '--json', '--', 'extra']],
    ...(stagingTarget
      ? [[['auth', 'mfa', 'disable', '--yes', '--json', '--', 'extra']]]
      : [])
  ])(
    'refuses the undeclared argument in %j before any request',
    async (args) => {
      const result = await run(args)

      expect(result.exitCodes).toEqual([2])
      expect(result.requests).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'ARGUMENT_VALIDATION',
          detail: 'Unexpected argument: extra',
          issues: [{ message: 'Unexpected argument: extra' }]
        }
      })
    }
  )

  test.each([
    [['completion', 'bash'], 'bash completion'],
    [['complete', '--', 'project', 'li'], 'list']
  ])(
    'leaves the arguments of %j to the completion command',
    async (args, printed) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

      const result = await run(args)

      expect(result.exitCodes).toEqual([])
      expect(result.stderr).toBe('')
      expect(log.mock.calls.flat().join('\n')).toContain(printed)
    }
  )

  test('says which argument is unexpected in text', async () => {
    const result = await run(['project', 'list', 'extra', '--no-color'])

    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toBe(
      [
        'Error: The command contains invalid input. (ARGUMENT_VALIDATION)',
        'Detail: Unexpected argument: extra',
        `Next: See the valid options: ${CLI_NAME} project list --help`,
        'Docs: https://photon.codes/docs/cli/output#errors',
        ''
      ].join('\n')
    )
  })

  test.each([false, true])(
    'shows the unknown command once and one suggestion, with a terminal: %s',
    async (isTTY) => {
      const result = await run(['project', 'lst'], isTTY)
      const lines = result.stderr.split('\n')

      expect(result.exitCodes).toEqual([2])
      expect(result.requests).toBe(0)
      expect(result.stdout).toBe('')
      expect(occurrences(result.stderr, 'Command not found: lst')).toBe(1)
      expect(lines.filter((line) => line.startsWith('Did you mean'))).toEqual([
        'Did you mean list?'
      ])
      expect(lines[lines.indexOf('Detail: Command not found: lst') + 1]).toBe(
        'Did you mean list?'
      )
    }
  )

  test.each([
    [['projct'], 'Did you mean project?'],
    [['project', 'list', '--jsno'], 'Did you mean --json?']
  ])('suggests the closest name for %j', async (args, suggestion) => {
    const result = await run(args)

    expect(result.exitCodes).toEqual([2])
    expect(result.requests).toBe(0)
    expect(
      result.stderr
        .split('\n')
        .filter((line) => line.startsWith('Did you mean'))
    ).toEqual([suggestion])
  })

  test('suggests nothing when no name is close', async () => {
    const result = await run(['project', 'zzzzzz'])

    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toContain('Command not found: zzzzzz')
    expect(result.stderr).not.toContain('Did you mean')
  })

  test('keeps the JSON error for an unknown command as it was, without a suggestion', async () => {
    const result = await run(['project', 'lst', '--json'])

    expect(result.exitCodes).toEqual([2])
    expect(result.requests).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(UNKNOWN_COMMAND_DOCUMENT)
  })

  test('refuses every option that has a default when it is given no value, as its help says', async () => {
    const options = allCommands().flatMap(([path, command]) =>
      Object.entries(command.args ?? {}).flatMap(([name, schema]) =>
        schema.type === 'boolean' ||
        schema.type === 'positional' ||
        schema.default === undefined
          ? []
          : [
              [
                ...path,
                `--${command.toKebab || schema.toKebab ? kebabnize(name) : name}`
              ]
            ]
      )
    )
    expect(options).toContainEqual(['project', 'list', '--limit'])
    for (const args of options) {
      // biome-ignore lint/performance/noAwaitInLoops: runs share console.log, so they go one at a time.
      const result = await run(args)

      expect(result.stderr).toContain(
        `Option '${args.at(-1)}' requires a value`
      )
      expect(result.exitCodes).toEqual([2])
      expect(result.requests).toBe(0)
    }
  })
})

// Everything after the first "--" is an operand, even when it starts with a
// dash, so an output flag there is an operand too. The parser reads it that
// way, and so must the output mode of an error found before the parser hands
// over its values: a bad option value or an unknown command.
describe('output flags after --', () => {
  test.each([
    [
      [...INVALID_LIMIT, '--', '--json'],
      [
        'Detail: One or more command arguments are invalid.',
        'Issues:',
        "  - Invalid value for '--limit': expected number",
        'Next: Run the command with --help for valid options.'
      ]
    ],
    [
      [...NO_SUCH_COMMAND, '--', '--json'],
      [
        'Detail: Command not found: nosuchcommand',
        'Next: Run the command with --help for valid options.'
      ]
    ],
    [
      ['project', 'list', '--org', '--', '--json'],
      [
        'Detail: One or more command arguments are invalid.',
        'Issues:',
        "  - Option '--org' requires a value",
        'Next: Run the command with --help for valid options.'
      ]
    ],
    [
      ['whoami', '--', '--json'],
      [
        'Detail: Unexpected argument: --json',
        `Next: See the valid options: ${CLI_NAME} whoami --help`
      ]
    ]
  ])('prints the error for %j as text', async (args, lines) => {
    const result = await run(args, false, {})

    expect(result.exitCodes).toEqual([2])
    expect(result.requests).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      [
        'Error: The command contains invalid input. (ARGUMENT_VALIDATION)',
        ...lines,
        DOCS_LINE,
        ''
      ].join('\n')
    )
  })

  // With standard error not a terminal, --color shows only where FORCE_COLOR
  // is on. Those runs put --no-color first, so color shows only if a --color
  // after "--" overrode it.
  test.each([
    [[...INVALID_LIMIT, '--', '--debug', '--color'], {}],
    [[...NO_SUCH_COMMAND, '--', '--debug', '--color'], {}],
    [[...INVALID_LIMIT, '--no-color', '--', '--color'], { FORCE_COLOR: '1' }],
    [[...NO_SUCH_COMMAND, '--no-color', '--', '--color'], { FORCE_COLOR: '1' }]
  ])(
    'turns on neither debug output nor color for %j with %j',
    async (args, env) => {
      const result = await run(args, false, env)

      expect(result.exitCodes).toEqual([2])
      expect(result.stdout).toBe('')
      expect(stripVTControlCharacters(result.stderr)).toBe(result.stderr)
      expect(result.stderr).not.toContain('Debug:')
      expect(result.stderr).toContain(
        'Error: The command contains invalid input. (ARGUMENT_VALIDATION)'
      )
    }
  )

  test.each([[INVALID_LIMIT], [NO_SUCH_COMMAND]])(
    'prints the JSON error for %j when --json comes before --',
    async (command) => {
      const result = await run([...command, '--json', '--', 'x'], false, {})

      expect(result.exitCodes).toEqual([2])
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
    }
  )

  test.each([[INVALID_LIMIT], [NO_SUCH_COMMAND]])(
    'shows debug output and color for %j when --debug and --color come before --',
    async (command) => {
      const result = await run(
        [...command, '--no-color', '--debug', '--color', '--', 'x'],
        false,
        { FORCE_COLOR: '1' }
      )

      expect(result.exitCodes).toEqual([2])
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('\nDebug:\n')
      expect(stripVTControlCharacters(result.stderr)).not.toBe(result.stderr)
    }
  )
})
