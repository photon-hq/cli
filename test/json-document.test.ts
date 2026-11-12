import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Commandable } from 'gunshi'
import { getCommandSubCommands } from 'gunshi/utils'
import { afterEach, describe, expect, test } from 'vitest'
import { photonCommands } from '../src/commands/registry.ts'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  instantPollClock,
  unusedDeviceScope
} from './project-test-support.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

// Every command that runs, under the path that runs it.
const leafPaths = (
  commands: ReadonlyMap<string, Commandable> | undefined,
  path: string[] = []
): string[][] =>
  [...(commands ?? [])].flatMap(([name, command]) => {
    const children = getCommandSubCommands(command)
    return children === undefined || children.size === 0
      ? [[...path, name]]
      : leafPaths(children, [...path, name])
  })

const COMMANDS = leafPaths(
  getCommandSubCommands({ subCommands: photonCommands })
)

// Runs a command with --json and nothing set up: no sign-in, no project, no
// terminal, and no network.
const runJson = async (args: string[]) => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-json-document-'))
  temporaryDirectories.push(directory)
  const stdin = Readable.from([]) as Readable & ReadableInput
  stdin.isTTY = false
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli([...args, '--json'], {
    browserLauncher: () => Promise.reject(new Error('no browser')),
    clock: instantPollClock(),
    configDirectory: directory,
    cwd: directory,
    deviceScope: unusedDeviceScope(),
    env: {},
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdin,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const jsonLines = (text: string): string[] =>
  text.split('\n').filter((line) => line.startsWith('{'))

// The commands that answer with a result when nothing is set up. Every other
// command fails there.
const ANSWERS_SIGNED_OUT = new Set([
  'auth status',
  'logout',
  'project clear',
  'unlink'
])

describe('one JSON document on stdout', () => {
  test('the registry has commands to check', () => {
    expect(COMMANDS.length).toBeGreaterThan(100)
  })

  test.each(COMMANDS.map((path) => [path.join(' ')]))(
    '%s writes its usage error as the one document on stdout',
    async (command) => {
      const result = await runJson([...command.split(' '), '--no-such-option'])

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
      expect(result.stderr).toBe('')
      expect(result.exitCodes).toEqual([2])
    }
  )

  test.each(COMMANDS.map((path) => [path.join(' ')]))(
    '%s writes one document on stdout and no JSON on stderr when nothing is set up',
    async (command) => {
      const result = await runJson(command.split(' '))
      const document = JSON.parse(result.stdout) as Record<string, unknown>

      expect(jsonLines(result.stdout)).toHaveLength(1)
      expect(jsonLines(result.stderr)).toEqual([])
      if (ANSWERS_SIGNED_OUT.has(command)) {
        expect(document).not.toHaveProperty('error')
        expect(document).not.toHaveProperty('next')
      } else {
        expect(document).toHaveProperty('error.code')
        expect(result.exitCodes).toHaveLength(1)
        expect(result.exitCodes[0]).toBeGreaterThan(0)
      }
    }
  )
})
