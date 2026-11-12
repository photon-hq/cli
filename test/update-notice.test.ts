import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { resolveTarget } from '../scripts/build-config.mjs'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CLI_NAME } from '../src/meta.ts'
import { prepareUpdateNotice } from '../src/update/notice.ts'
import { PHOTON_PACKAGE } from '../src/update/release.ts'

const PACKAGE = PHOTON_PACKAGE.name
const LATEST = `${PACKAGE}@${PHOTON_PACKAGE.tag}`
const NOTICE = `A new version of ${CLI_NAME} is available: ${packageJson.version} → 99.0.0`
const DAY_MS = 86_400_000
const TERMINAL = join(import.meta.dirname, 'support', 'terminal.py')
const supported =
  process.platform !== 'win32' &&
  (Boolean(process.env.CI) || spawnSync('python3', ['--version']).status === 0)

interface Run {
  exitCode: number
  stderr: string
  stdout: string
}

interface RunOptions {
  args?: string[]
  env?: Record<string, string>
  stderr?: 'pipe' | 'terminal'
  stdout?: 'pipe' | 'terminal'
}

let directory: string
let bundle: string
let registry: string
let server: Server

beforeAll(async () => {
  directory = realpathSync(await mkdtemp(join(tmpdir(), 'photon-notice-')))
  bundle = join(directory, 'bundle.js')
  const { aliases, conditions } = resolveTarget(BUILD_CONFIG)
  await build({
    alias: aliases,
    bundle: true,
    conditions,
    entryPoints: [join(import.meta.dirname, '..', 'src', 'cli.ts')],
    external: ['@napi-rs/keyring'],
    format: 'esm',
    logLevel: 'silent',
    outfile: bundle,
    platform: 'node',
    target: 'node22'
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ 'dist-tags': { [PHOTON_PACKAGE.tag]: '99.0.0' } })
    )
  })
  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', listening)
  })
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
}, 60_000)

afterAll(async () => {
  server?.close()
  await rm(directory, { force: true, recursive: true })
})

const place = async (packageRoot: string): Promise<string> => {
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await cp(bundle, join(packageRoot, 'dist', 'bin.js'))
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      type: 'module',
      version: packageJson.version
    })
  )
  return join(packageRoot, 'dist', 'bin.js')
}

const stateFile = (home: string): string =>
  process.platform === 'darwin'
    ? join(
        home,
        'Library',
        'Caches',
        BUILD_CONFIG.stateNamespace,
        'update-check.json'
      )
    : join(home, '.cache', BUILD_CONFIG.stateNamespace, 'update-check.json')

const terminal = (
  home: string,
  file: string,
  options: RunOptions = {}
): Run => {
  const result = spawnSync(
    'python3',
    [
      TERMINAL,
      JSON.stringify({
        command: [process.execPath, file, ...(options.args ?? ['--version'])],
        env: {
          HOME: home,
          npm_config_registry: registry,
          PATH: process.env.PATH ?? '',
          TERM: 'xterm-256color',
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_CONFIG_HOME: join(home, '.config'),
          ...options.env
        },
        stderr: options.stderr ?? 'terminal',
        stdout: options.stdout ?? 'terminal'
      })
    ],
    { encoding: 'utf8' }
  )
  const run = JSON.parse(result.stdout) as Run
  return {
    exitCode: run.exitCode,
    stderr: stripVTControlCharacters(run.stderr),
    stdout: stripVTControlCharacters(run.stdout)
  }
}

const checked = async (home: string): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polls the background check until it writes.
    const state = await readFile(stateFile(home), 'utf8').catch(() => '{}')
    const parsed = JSON.parse(state) as Record<string, unknown>
    if (parsed.latestVersion !== undefined) {
      return parsed
    }
    await delay(100)
  }
  throw new Error('the background check did not finish')
}

const install = async (layout: string) => {
  const home = join(directory, `home-${layout}`)
  await mkdir(home, { recursive: true })
  return { file: await place(join(home, layout, PACKAGE)), home }
}

const seed = async (
  home: string,
  file: string,
  state: Record<string, unknown> = {}
) => {
  await mkdir(join(stateFile(home), '..'), { recursive: true })
  await writeFile(
    stateFile(home),
    JSON.stringify({
      checkedAt: Date.now(),
      command: null,
      file,
      latestVersion: '99.0.0',
      start: dirname(file),
      ...state
    })
  )
}

describe.skipIf(!supported)('update notice under a pseudo-terminal', () => {
  test('checks in the background and shows the notice on the next run, once a day', async () => {
    const { file, home } = await install('global/lib/node_modules')
    const env = { npm_config_prefix: join(home, 'global') }
    const first = terminal(home, file, { env })
    expect(first.stdout).toBe(`${packageJson.version}\n`)
    expect(first.stderr).toBe('')
    await expect(checked(home)).resolves.toMatchObject({
      command: `npm install --global ${LATEST}`,
      latestVersion: '99.0.0'
    })
    const second = terminal(home, file, { env })
    expect(second.stdout).toBe(`${packageJson.version}\n`)
    expect(second.stderr).toContain(NOTICE)
    expect(second.stderr).toContain(
      `To update, run: npm install --global ${LATEST}`
    )
    expect(terminal(home, file, { env }).stderr).toBe('')
  })

  test('names no command for a project dependency', async () => {
    const { file, home } = await install('project/node_modules')
    await writeFile(join(home, 'project', 'package.json'), '{}')
    terminal(home, file)
    await expect(checked(home)).resolves.toMatchObject({ command: null })
    const run = terminal(home, file)
    expect(run.stderr).toContain(NOTICE)
    expect(run.stderr).not.toContain('To update')
  })

  // A global pnpm install and a project's dependency of the same version can
  // run the same copy; what the check found for one is not the other's.
  test('keeps what one install found from another that runs the same copy', async () => {
    const { file, home } = await install('project/node_modules')
    await writeFile(join(home, 'project', 'package.json'), '{}')
    await seed(home, file, {
      command: `pnpm add --global ${LATEST}`,
      start: join(home, 'pnpm', 'global', 'v11', '93c5e4', 'dist')
    })
    expect(terminal(home, file).stderr).not.toContain('To update')
    await expect(checked(home)).resolves.toMatchObject({
      command: null,
      start: dirname(file)
    })
  })

  test('keeps one record for an install started by either of its commands', async () => {
    const { file, home } = await install('plain')
    const alias = join(dirname(file), 'pho.js')
    await symlink(file, alias)
    const checkedAt = Date.now() - 1000
    await seed(home, file, { checkedAt, notifiedAt: checkedAt })
    expect(terminal(home, alias).stderr).toBe('')
    await expect(
      readFile(stateFile(home), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({ checkedAt, notifiedAt: checkedAt })
  })

  test('stays quiet under npx and does not check', async () => {
    const { file, home } = await install('.npm/_npx/0a1b2c3d/node_modules')
    await seed(home, file)
    expect(terminal(home, file).stderr).toBe('')
    await rm(stateFile(home))
    expect(terminal(home, file).stderr).toBe('')
    await delay(1000)
    await expect(readFile(stateFile(home), 'utf8')).rejects.toThrow()
  })

  test('shows again a day after the last notice', async () => {
    const { file, home } = await install('plain')
    await seed(home, file, { notifiedAt: Date.now() - DAY_MS / 2 })
    expect(terminal(home, file).stderr).toBe('')
    await seed(home, file, { notifiedAt: Date.now() - DAY_MS - 1000 })
    expect(terminal(home, file).stderr).toContain(NOTICE)
  })

  // Everything after the first "--" is an operand, so a --json there leaves the
  // command in text mode, where the notice shows.
  test('reads --json only up to --', async () => {
    const { file, home } = await install('plain')
    await seed(home, file)
    const quiet = terminal(home, file, {
      args: ['--version', '--json', '--', 'x']
    })
    expect(quiet.stderr).not.toContain('A new version')
    expect(quiet.stdout).not.toContain('A new version')
    const shown = terminal(home, file, { args: ['--version', '--', '--json'] })
    expect(shown.stdout).toBe(`${packageJson.version}\n`)
    expect(shown.stderr).toContain(NOTICE)
  })

  test.each([
    ['standard output is not a terminal', { stdout: 'pipe' }],
    ['standard error is not a terminal', { stderr: 'pipe' }],
    ['--json is given', { args: ['--version', '--json'] }],
    ['--json=true is given', { args: ['--version', '--json=true'] }],
    ['TERM is dumb', { env: { TERM: 'dumb' } }],
    ['CI is on', { env: { CI: 'true' } }],
    [
      'PHOTON_NO_UPDATE_NOTIFIER is on',
      { env: { PHOTON_NO_UPDATE_NOTIFIER: '1' } }
    ]
  ] satisfies [string, RunOptions][])(
    'never shows when %s',
    async (_case, options) => {
      const { file, home } = await install('plain')
      await seed(home, file)
      const quiet = terminal(home, file, options)
      expect(quiet.stderr).not.toContain('A new version')
      expect(quiet.stdout).not.toContain('A new version')
      expect(terminal(home, file).stderr).toContain(NOTICE)
    }
  )
})

describe('the update notice after an interrupt', () => {
  const terminalStream = () => {
    const written: string[] = []
    return {
      stream: {
        isTTY: true,
        write: (chunk: string) => written.push(chunk)
      },
      written
    }
  }

  test('shows nothing once Ctrl-C, SIGTERM or SIGHUP ended the command', async () => {
    const home = await mkdtemp(join(directory, 'interrupted-'))
    const file = join(home, 'node_modules', PACKAGE, 'dist', 'bin.js')
    const path = join(home, 'update-check.json')
    const now = Date.now()
    const shown = async (signal?: AbortSignal): Promise<string> => {
      await writeFile(
        path,
        JSON.stringify({
          checkedAt: now,
          file,
          latestVersion: '99.0.0',
          start: dirname(process.argv[1] ?? '')
        })
      )
      const stderr = terminalStream()
      const show = await prepareUpdateNotice({
        args: ['--version'],
        env: { TERM: 'xterm-256color' },
        file,
        now: () => now,
        signal,
        startCheck: () => undefined,
        stateFile: path,
        stderr: stderr.stream,
        stdout: terminalStream().stream
      })
      await show()
      return stripVTControlCharacters(stderr.written.join(''))
    }
    expect(await shown()).toContain('A new version of')
    const interrupt = new AbortController()
    interrupt.abort()
    expect(await shown(interrupt.signal)).toBe('')
    await expect(
      readFile(path, 'utf8').then(JSON.parse)
    ).resolves.not.toHaveProperty('notifiedAt')
  })
})
