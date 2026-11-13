import { afterEach, describe, expect, test, vi } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const SHELLS = ['bash', 'fish', 'powershell', 'zsh'] as const
const SHELL_NAMES = 'bash, fish, powershell or zsh'
const UNSUPPORTED_SHELLS = ['tcsh', 'zhs'] as const
// How each script calls back into the CLI at a Tab press: PowerShell quotes
// the --.
const CALLBACK = / complete '?--'? /u

afterEach(() => {
  vi.restoreAllMocks()
})

// Runs the CLI signed in, and returns what the completion plugin printed with
// console.log beside what the CLI wrote.
const run = async (args: string[]) => {
  const { configDirectory } = await createAuthenticatedConfig()
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    configDirectory,
    deviceScope: unusedDeviceScope(),
    fetch: vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error('unexpected request'))
    ),
    now: () => TEST_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  const printed = log.mock.calls.flat().join('\n')
  log.mockRestore()
  return { exitCodes, printed, stderr: stderr.value(), stdout: stdout.value() }
}

const argumentError = (detail: string) =>
  [
    'Error: The command contains invalid input. (ARGUMENT_VALIDATION)',
    `Detail: ${detail}`,
    'Next: Run the command with --help for valid options.',
    'Docs: https://photon.codes/docs/cli/output#errors',
    ''
  ].join('\n')

describe('completion', () => {
  test.each(SHELLS)(
    'prints the %s script that complete prints',
    async (shell) => {
      const completion = await run(['completion', shell])
      const complete = await run(['complete', shell, '--no-color'])

      expect(completion.exitCodes).toEqual([])
      expect(completion.stderr).toBe('')
      expect(completion.printed).toMatch(CALLBACK)
      expect(complete.exitCodes).toEqual([])
      expect(complete.printed).toBe(completion.printed)
    }
  )

  test('prints the script when a global option comes before the command', async () => {
    const plain = await run(['completion', 'zsh'])
    const withOption = await run(['--no-color', 'completion', 'zsh'])

    expect(withOption.exitCodes).toEqual([])
    expect(withOption.printed).toBe(plain.printed)
  })

  test('warns that complete <shell> is now completion <shell>', async () => {
    const result = await run(['complete', 'zsh', '--no-color'])

    expect(result.stderr).toBe(
      `Warning: "${CLI_NAME} complete zsh" is now "${CLI_NAME} completion zsh".\n`
    )
  })

  test('answers the call back from the scripts without a warning', async () => {
    const result = await run(['complete', '--', 'project', 'li'])

    expect(result.exitCodes).toEqual([])
    expect(result.stderr).toBe('')
    expect(result.printed).toBe(
      'list\tList projects in the current organization\n:4'
    )
  })

  test('names the shells when the shell is missing', async () => {
    const text = await run(['completion', '--no-color'])
    const json = await run(['completion', '--json'])
    const detail = `Name the shell to print the completion script for: ${SHELL_NAMES}.`

    expect(text.exitCodes).toEqual([2])
    expect(text.printed).toBe('')
    expect(text.stderr).toBe(argumentError(detail))
    expect(json.exitCodes).toEqual([2])
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION', detail }
    })
  })

  test.each(
    UNSUPPORTED_SHELLS.flatMap((shell) => [
      ['completion', shell],
      ['complete', shell]
    ])
  )('names the shells for %s %s', async (command, shell) => {
    const text = await run([command, shell, '--no-color'])
    const json = await run([command, shell, '--json'])
    const detail = `Unsupported shell: ${shell}. Use ${SHELL_NAMES}.`

    expect(text.exitCodes).toEqual([2])
    expect(text.printed).toBe('')
    expect(text.stderr).toBe(argumentError(detail))
    expect(json.exitCodes).toEqual([2])
    expect(json.printed).toBe('')
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION', detail }
    })
  })
})
