import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import type { Commandable } from 'gunshi'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { resolveTarget } from '../scripts/build-config.mjs'
import { photonCommands } from '../src/commands/registry.ts'
import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from '../src/meta.ts'
import { allCommands, groupPaths, printed } from './help-support.ts'
import { collector } from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TIMEOUT_MS = 60_000

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(
      async (directory) => await rm(directory, { force: true, recursive: true })
    )
  )
})

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

// The help of every group as the given build prints it, signed out.
const builtHelp = async (
  environment: 'production' | 'staging'
): Promise<string> => {
  const directory = await temporaryDirectory(`photon-help-${environment}-`)
  const outfile = join(directory, 'help.js')
  const { aliases, conditions } = resolveTarget({ environment })
  await build({
    alias: aliases,
    bundle: true,
    conditions,
    external: ['@napi-rs/keyring'],
    format: 'esm',
    logLevel: 'silent',
    outfile,
    platform: 'node',
    stdin: {
      contents:
        "import { helpDump } from './test/help-support.ts'\nprocess.stdout.write(await helpDump())\n",
      loader: 'ts',
      resolveDir: root
    },
    target: 'node22'
  })
  const { stdout } = await promisify(execFile)(process.execPath, [outfile], {
    env: {
      HOME: directory,
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: directory
    },
    maxBuffer: 16 * 1024 * 1024
  })
  return stdout
}

interface Run {
  exitCodes: number[]
  printed: string
  requests: number
}

// Runs the CLI signed out, with a fetch that fails the test if it is called.
const runSignedOut = async (args: string[]): Promise<Run> => {
  const configDirectory = await temporaryDirectory('photon-signed-out-')
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected request'))
  )
  const exitCodes: number[] = []
  const help = await printed(args, {
    configDirectory,
    fetch,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr: collector()
  })
  return {
    exitCodes,
    printed: help,
    requests: fetch.mock.calls.length
  }
}

const commandRows = (help: string): string[] => {
  const lines = help.split('\n')
  const start = lines.indexOf('COMMANDS:') + 1
  const end = lines.indexOf('', start)
  return lines.slice(start, end)
}

const rowName = (row: string): string => row.trim().split(' ')[0] ?? ''

const ROW_WITH_SYMBOLS = /^ {2}\S+ [<[]/mu

const LIMIT_ROW =
  /^ {2}--limit <limit> +Maximum number of records to return \(default: 30\)$/mu

const COMPLETION_SHELL_ROW =
  /^ {2}shell +Shell to print the completion script for: bash, fish, powershell or zsh\. Setup: https:\/\/photon\.codes\/docs\/cli\/shell-completion$/mu

const OPTION_WITH_BRACKETED_VALUE = /^ +(?:-\S, )?--\S+ \[/u

const NAMED_OPTION = /(?:^| )--\S+/gu

const LINK_PROJECT_ROW =
  /^ {2}--project <project> +Project ID to save for this folder$/mu

const usageLine = (help: string): string => {
  const lines = help.split('\n')
  return lines[lines.indexOf('USAGE:') + 1]?.trim() ?? ''
}

const requiredOptionCount = (command: Commandable | undefined): number =>
  Object.values(command?.args ?? {}).filter(
    (schema) =>
      schema.required === true &&
      schema.type !== 'positional' &&
      schema.hidden !== true
  ).length

describe('help', () => {
  test(
    'shows every group with its full path and its sub-commands by name, in the production build',
    async () => {
      await expect(await builtHelp('production')).toMatchFileSnapshot(
        '__snapshots__/help.production.txt'
      )
    },
    BUILD_TIMEOUT_MS
  )

  test(
    'shows every group with its full path and its sub-commands by name, in the staging build',
    async ({ skip }) => {
      skip(!stagingTarget)
      await expect(await builtHelp('staging')).toMatchFileSnapshot(
        'internal/__snapshots__/help.staging.txt'
      )
    },
    BUILD_TIMEOUT_MS
  )

  test('prints the help of every group without an action, signed out', async () => {
    const paths = groupPaths()
    expect(paths).toContainEqual(['org'])
    expect(paths).toContainEqual(['project'])
    expect(paths).toContainEqual(['project', 'webhook'])
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is checked on its own.
      const bare = await runSignedOut(path)
      const help = await runSignedOut([...path, '--help'])
      const bareJson = await runSignedOut([...path, '--json'])
      const helpJson = await runSignedOut([...path, '--help', '--json'])

      expect(bare.printed).toContain(
        `USAGE:\n  ${[CLI_NAME, ...path].join(' ')} <COMMAND> [OPTIONS]`
      )
      expect(bare.printed).toBe(help.printed)
      expect(JSON.parse(bareJson.printed)).toEqual(JSON.parse(helpJson.printed))
      expect(bareJson.printed).toBe(helpJson.printed)
      for (const run of [bare, bareJson]) {
        expect(run.exitCodes).toEqual([])
        expect(run.requests).toBe(0)
      }
    }
  })

  test('prints the root help for a bare photon, and the name and version with --json', async () => {
    const bare = await runSignedOut([])
    const help = await runSignedOut(['--help'])
    const json = await runSignedOut(['--json'])

    expect(bare.printed).toBe(help.printed)
    expect(bare.printed).toContain(`USAGE:\n  ${CLI_NAME} <COMMAND> [OPTIONS]`)
    expect(bare.exitCodes).toEqual([])
    expect(JSON.parse(json.printed)).toEqual({
      name: CLI_NAME,
      version: CLI_VERSION
    })
    expect(json.exitCodes).toEqual([])
  })

  test('prints the same help for "help <command>" as for "<command> --help", signed out', async () => {
    const help = await runSignedOut(['help', 'project', 'list'])
    const flag = await runSignedOut(['project', 'list', '--help'])
    const rootHelp = await runSignedOut(['help'])
    const rootFlag = await runSignedOut(['--help'])

    expect(help.printed).toContain(
      `USAGE:\n  ${CLI_NAME} project list [OPTIONS]`
    )
    expect(help.printed).toBe(flag.printed)
    expect(rootHelp.printed).toBe(rootFlag.printed)
    for (const run of [help, rootHelp]) {
      expect(run.exitCodes).toEqual([])
      expect(run.requests).toBe(0)
    }
  })

  test.each([
    [['--debug=true']],
    [['--org', '--project', 'pho_prj_00000000000000000000000001']]
  ])(
    'finds "help <command>" after %j as the parser reads it',
    async (options) => {
      const help = await runSignedOut([...options, 'help', 'project', 'list'])
      const flag = await runSignedOut([...options, 'project', 'list', '--help'])

      expect(help.printed).toContain(
        `USAGE:\n  ${CLI_NAME} project list [OPTIONS]`
      )
      expect(help.printed).toBe(flag.printed)
      expect(help.exitCodes).toEqual([])
      expect(help.requests).toBe(0)
    }
  )

  test('lists each top-level command once in the root help, and no entry row', async () => {
    const help = (await runSignedOut(['--help'])).printed
    const names = commandRows(help).map(rowName)

    expect(names).toEqual(
      [...Object.keys(photonCommands), 'completion'].sort((left, right) =>
        left.localeCompare(right, 'en')
      )
    )
    expect(help).not.toContain('For more info')
    expect(help).not.toContain(CLI_DESCRIPTION)
    expect(help).not.toContain('(anonymous)')
  })

  test("lists a group's sub-commands by name only, without the group itself", async () => {
    for (const path of groupPaths()) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is checked on its own.
      const help = await runSignedOut([...path, '--help'])
      const rows = commandRows(help.printed)

      expect(rows.length).toBeGreaterThan(0)
      expect(rows.map(rowName)).not.toContain(path.at(-1))
      expect(rows.join('\n')).not.toMatch(ROW_WITH_SYMBOLS)
    }
  })

  test('shows the shell argument of completion, with the setup guide', async () => {
    const help = await runSignedOut(['completion', '--help'])

    expect(help.printed).toContain(
      `USAGE:\n  ${CLI_NAME} completion [OPTIONS] <shell>`
    )
    expect(help.printed).toMatch(COMPLETION_SHELL_ROW)
    expect(help.exitCodes).toEqual([])
  })

  test('shows the value of an option with a default as <name>, and the default', async () => {
    const help = await runSignedOut(['project', 'list', '--help'])

    expect(help.printed).toMatch(LIMIT_ROW)
    expect(help.exitCodes).toEqual([])
  })

  test('shows no option value in square brackets in the help of any command', async () => {
    const paths = allCommands().map(([path]) => path)
    expect(paths).toContainEqual(['project', 'list'])
    const bracketed: string[] = []
    for (const path of [[], ...paths]) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is checked on its own.
      const help = await runSignedOut([...path, '--help'])
      bracketed.push(
        ...help.printed
          .split('\n')
          .filter((line) => OPTION_WITH_BRACKETED_VALUE.test(line))
          .map((line) => `${[CLI_NAME, ...path].join(' ')}: ${line.trim()}`)
      )
    }

    expect(bracketed).toEqual([])
  })

  test('shows the options of a command in square brackets when none is required', async () => {
    const help = await runSignedOut(['project', 'list', '--help'])

    expect(usageLine(help.printed)).toBe(`${CLI_NAME} project list [OPTIONS]`)
    expect(help.exitCodes).toEqual([])
  })

  test('names a required option on the usage line, and still lists it under OPTIONS', async () => {
    const link = (await runSignedOut(['link', '--help'])).printed
    const create = (
      await runSignedOut(['project', 'api-key', 'create', '--help'])
    ).printed
    const edit = (await runSignedOut(['org', 'member', 'edit', '--help']))
      .printed
    const webhook = (
      await runSignedOut(['project', 'webhook', 'create', '--help'])
    ).printed

    expect(usageLine(link)).toBe(
      `${CLI_NAME} link --project <project> [OPTIONS]`
    )
    expect(link).toMatch(LINK_PROJECT_ROW)
    expect(usageLine(create)).toBe(
      `${CLI_NAME} project api-key create --name <name> --permission <permission> [OPTIONS]`
    )
    expect(usageLine(edit)).toBe(
      `${CLI_NAME} org member edit --role <role> [OPTIONS] <account-id>`
    )
    expect(usageLine(webhook)).toBe(
      `${CLI_NAME} project webhook create --api-version <api-version> --name <name> --url <url> [OPTIONS]`
    )
  })

  test('writes [OPTIONS], never <OPTIONS>, on the usage line of every command, and names only its required options', async () => {
    const commands = allCommands()
    expect(commands.map(([path]) => path)).toContainEqual(['project', 'list'])
    const wrong: string[] = []
    for (const [path, command] of [[[], undefined] as const, ...commands]) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is checked on its own.
      const usage = usageLine((await runSignedOut([...path, '--help'])).printed)
      const named = usage.match(NAMED_OPTION)?.length ?? 0
      if (
        usage.includes('<OPTIONS>') ||
        !usage.includes('[OPTIONS]') ||
        named !== requiredOptionCount(command)
      ) {
        wrong.push(usage)
      }
    }

    expect(wrong).toEqual([])
  })
})
