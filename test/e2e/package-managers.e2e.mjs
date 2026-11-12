// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared steps assert inside the tests that call them.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { after, before, test } from 'node:test'

import { fixturesDirectory, RELEASED } from './build-fixtures.mjs'
import { startReleaseServer } from './release-server.mjs'

// Installs this branch's @photon-ai/cli 3.0.0 package each way people install
// it, from a local registry that also serves 3.0.1, and runs "photon update".
const PACKAGE = '@photon-ai/cli'
const [FIRST, SECOND] = RELEASED
const fixtures = fixturesDirectory()
const YARN_CLASSIC = /^1\./u
const windows = process.platform === 'win32'
const PATH_KEY = windows
  ? (Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ??
    'Path')
  : 'PATH'

// Where a package manager given this prefix puts the commands it installs.
const binIn = (prefix) => (windows ? prefix : join(prefix, 'bin'))

let server
let sudoTrap

before(async () => {
  server = await startReleaseServer({ packages: join(fixtures, 'packages') })
  sudoTrap = realpathSync.native(await mkdtemp(join(tmpdir(), 'photon-sudo-')))
  const ran = join(sudoTrap, 'ran')
  await writeFile(join(sudoTrap, 'sudo'), `#!/bin/sh\ntouch "${ran}"\nexit 1\n`)
  await chmod(join(sudoTrap, 'sudo'), 0o755)
  await writeFile(
    join(sudoTrap, 'sudo.cmd'),
    `@echo off\r\ntype nul > "${ran}"\r\nexit /b 1\r\n`
  )
})

after(async () => {
  await server.close()
  assert.equal(existsSync(join(sudoTrap, 'ran')), false, 'sudo ran')
})

// On Windows, package managers install .cmd files, which only cmd.exe runs.
const spawnCommand = (command, args, options) =>
  windows
    ? spawn(
        [command, ...args]
          .map((word) => (word.includes(' ') ? `"${word}"` : word))
          .join(' '),
        { ...options, shell: true }
      )
    : spawn(command, args, options)

// The registry runs in this process, so nothing here may block the event loop.
const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      console.log(
        `${command} ${args.join(' ')} exited ${status}\n${stdout}${stderr}`
      )
      resolve({ status, stderr, stdout })
    })
  })

// Each workspace reads only its own user config. setup-node points
// NPM_CONFIG_USERCONFIG at an .npmrc that needs NODE_AUTH_TOKEN, which Yarn 1
// refuses to read without it.
const workspace = async (paths = []) => {
  const home = realpathSync.native(await mkdtemp(join(tmpdir(), 'photon-pm-')))
  const env = {
    ...process.env,
    BUN_CONFIG_REGISTRY: server.url,
    HOME: home,
    NPM_CONFIG_REGISTRY: server.url,
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
    npm_config_registry: server.url,
    npm_config_userconfig: join(home, '.npmrc'),
    [PATH_KEY]: [
      sudoTrap,
      ...paths.map((path) => join(home, path)),
      process.env[PATH_KEY]
    ].join(delimiter),
    PHOTON_NO_UPDATE_NOTIFIER: '1',
    pnpm_config_registry: server.url,
    YARN_REGISTRY: server.url,
    ...(windows
      ? {
          HOMEDRIVE: home.slice(0, 2),
          HOMEPATH: home.slice(2),
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          USERPROFILE: home
        }
      : {})
  }
  env.CI = undefined
  return {
    env,
    home,
    run: async (command, args, cwd = home) =>
      await run(command, args, { cwd, env })
  }
}

const version = async (shell, command, args = []) =>
  (await shell.run(command, [...args, '--version'])).stdout.trim()

const updatesGlobally = async (shell, manager, cwd = shell.home) => {
  assert.equal(await version(shell, 'photon'), FIRST)
  const update = await shell.run('photon', ['update'], cwd)
  assert.equal(update.status, 0)
  assert.ok(
    update.stdout.includes(
      `Updated photon from ${FIRST} to ${SECOND} with ${manager}.`
    )
  )
  assert.equal(await version(shell, 'photon'), SECOND)
}

const changesNothing = async (
  shell,
  command,
  args,
  expected,
  cwd = shell.home
) => {
  assert.equal(await version(shell, command, args), FIRST)
  const update = await shell.run(command, [...args, 'update', '--json'], cwd)
  assert.equal(update.status, 1)
  assert.equal(update.stderr, '')
  const { error } = JSON.parse(update.stdout)
  assert.equal(error.code, 'MANUAL_UPDATE_REQUIRED')
  assert.equal(error.next[0].run, expected)
  assert.equal(await version(shell, command, args), FIRST)
  return error
}

test('updates a global npm install with npm', async () => {
  const shell = await workspace([binIn('npm')])
  shell.env.npm_config_prefix = join(shell.home, 'npm')
  assert.equal(
    (await shell.run('npm', ['install', '--global', `${PACKAGE}@${FIRST}`]))
      .status,
    0
  )
  await updatesGlobally(shell, 'npm')
})

const globalPnpmInstall = async (env = {}) => {
  const shell = await workspace(['pnpm', 'pnpm/bin'])
  Object.assign(shell.env, env)
  shell.env.PNPM_HOME = join(shell.home, 'pnpm')
  await mkdir(join(shell.home, 'pnpm', 'bin'), { recursive: true })
  assert.equal(
    (await shell.run('pnpm', ['add', '--global', `${PACKAGE}@${FIRST}`]))
      .status,
    0
  )
  return shell
}

test('updates a global pnpm install with pnpm', async () => {
  await updatesGlobally(await globalPnpmInstall(), 'pnpm')
})

// In a project whose packageManager field names another pnpm, pnpm switches
// to that version, which keeps its global packages somewhere else.
test('updates a global pnpm install with pnpm from a project that pins another pnpm', async () => {
  const shell = await globalPnpmInstall()
  const pinned = (await version(shell, 'pnpm')).startsWith('10.')
    ? '11.0.9'
    : '10.33.0'
  const project = join(shell.home, 'project')
  await mkdir(project)
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'app',
      packageManager: `pnpm@${pinned}`,
      private: true
    })
  )
  await updatesGlobally(shell, 'pnpm', project)
})

test('updates a global Yarn install with Yarn', async () => {
  const shell = await workspace([
    binIn('yarn1'),
    windows ? join('AppData', 'Local', 'Yarn', 'bin') : join('.yarn', 'bin')
  ])
  shell.env.npm_config_prefix = join(shell.home, 'yarn1')
  assert.equal(
    (await shell.run('npm', ['install', '--global', 'yarn@1.22.22'])).status,
    0
  )
  shell.env.npm_config_prefix = undefined
  assert.match(await version(shell, 'yarn'), YARN_CLASSIC)
  assert.equal(
    (await shell.run('yarn', ['global', 'add', `${PACKAGE}@${FIRST}`])).status,
    0
  )
  await updatesGlobally(shell, 'yarn')
})

test('updates a global Bun install with Bun', async () => {
  const shell = await workspace(['bun/bin'])
  shell.env.BUN_INSTALL = join(shell.home, 'bun')
  assert.equal(
    (await shell.run('bun', ['add', '--global', `${PACKAGE}@${FIRST}`])).status,
    0
  )
  await updatesGlobally(shell, 'bun')
})

test('prints the command and changes nothing under npx', async () => {
  const shell = await workspace()
  await changesNothing(
    shell,
    'npx',
    ['--yes', `${PACKAGE}@${FIRST}`],
    `npx ${PACKAGE}@latest`
  )
})

test('prints the command and changes nothing for a project dependency', async () => {
  const shell = await workspace()
  const project = join(shell.home, 'project')
  await mkdir(project)
  await writeFile(
    join(project, 'package.json'),
    '{"name":"app","private":true}'
  )
  assert.equal(
    (await shell.run('npm', ['install', `${PACKAGE}@${FIRST}`], project))
      .status,
    0
  )
  await changesNothing(
    shell,
    join(project, 'node_modules', '.bin', 'photon'),
    [],
    `npm install ${PACKAGE}@latest`
  )
  const installed = JSON.parse(
    await readFile(
      join(project, 'node_modules', PACKAGE, 'package.json'),
      'utf8'
    )
  )
  assert.equal(installed.version, FIRST)
})

// With pnpm's global virtual store on, a project links its dependencies from
// the store, outside the project. pnpm 10 turns the store off when it finds
// CI, unless CI is false.
const virtualStoreProject = async (shell) => {
  const project = join(shell.home, 'project')
  await mkdir(project)
  await writeFile(
    join(project, 'package.json'),
    '{"name":"app","private":true}'
  )
  await writeFile(
    join(project, 'pnpm-workspace.yaml'),
    'enableGlobalVirtualStore: true\n'
  )
  assert.equal(
    (await shell.run('pnpm', ['add', `${PACKAGE}@${FIRST}`], project)).status,
    0
  )
  const installed = realpathSync.native(join(project, 'node_modules', PACKAGE))
  assert.ok(
    !installed.startsWith(project + sep),
    `${installed} is inside the project`
  )
  return project
}

const projectVersion = async (project) =>
  JSON.parse(
    await readFile(
      join(
        realpathSync.native(join(project, 'node_modules', PACKAGE)),
        'package.json'
      ),
      'utf8'
    )
  ).version

test('prints the command and changes nothing for a pnpm project dependency in the global virtual store', async () => {
  const shell = await workspace()
  shell.env.CI = 'false'
  const project = await virtualStoreProject(shell)
  const error = await changesNothing(
    shell,
    join(project, 'node_modules', '.bin', 'photon'),
    [],
    `pnpm add ${PACKAGE}@latest`,
    project
  )
  assert.equal(error.next[0].description, `Update the dependency in ${project}`)
  assert.equal(await projectVersion(project), FIRST)
})

// pnpm 11 and later keep a global install in the store's global virtual
// store too, so a project's dependency of the same version is the same copy.
test('tells a pnpm project dependency from a global pnpm install of the same version', async () => {
  const shell = await globalPnpmInstall({ CI: 'false' })
  const project = await virtualStoreProject(shell)
  await changesNothing(
    shell,
    join(project, 'node_modules', '.bin', 'photon'),
    [],
    `pnpm add ${PACKAGE}@latest`,
    project
  )
  assert.equal(await version(shell, 'photon'), FIRST)
  await updatesGlobally(shell, 'pnpm', project)
  assert.equal(await projectVersion(project), FIRST)
})

test('prints the command and changes nothing for an install it cannot identify', async () => {
  const shell = await workspace()
  const unpacked = join(shell.home, 'unpacked')
  await mkdir(unpacked)
  const unpack = await shell.run(
    windows
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar',
    [
      '-xzf',
      join(fixtures, 'packages', `photon-ai-cli-${FIRST}.tgz`),
      '-C',
      unpacked
    ]
  )
  assert.equal(unpack.status, 0)
  await changesNothing(
    shell,
    process.execPath,
    [join(unpacked, 'package', 'dist', 'bin.js')],
    `npm install --global ${PACKAGE}@latest`
  )
})
