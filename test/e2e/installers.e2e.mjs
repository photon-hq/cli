import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import {
  CORRUPTED,
  fixturesDirectory,
  LEGACY,
  RELEASED
} from './build-fixtures.mjs'
import { startReleaseServer } from './release-server.mjs'

// Runs scripts/install.sh (macOS, Linux) or scripts/install.ps1 (Windows)
// against this branch's own builds, served as photon-hq/cli releases, then
// "photon update" on the installed binary.
const root = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const fixtures = fixturesDirectory()
const releases = join(fixtures, 'releases')
const [FIRST, SECOND] = RELEASED
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const zsh = !windows && spawnSync('zsh', ['--version']).status === 0
const python = !windows && spawnSync('python3', ['--version']).status === 0
const CHECKSUM_FAILED = /failed its checksum check/u
const NO_RELEASE = /No Photon CLI release 3\.0\.0 or newer was found/u
const PROFILE_UNWRITABLE = /Could not add .+ to PATH in: .+\/\.profile/u

let server
let sudoTrap

before(async () => {
  server = await startReleaseServer({ releases })
  sudoTrap = realpathSync(await mkdtemp(join(tmpdir(), 'photon-sudo-')))
  await writeFile(
    join(sudoTrap, 'sudo'),
    `#!/bin/sh\ntouch "${join(sudoTrap, 'ran')}"\nexit 1\n`
  )
  await chmod(join(sudoTrap, 'sudo'), 0o755)
})

after(async () => {
  await server.close()
  // biome-ignore lint/suspicious/noMisplacedAssertion: the suite fails when any of its tests ran sudo.
  assert.equal(existsSync(join(sudoTrap, 'ran')), false, 'sudo ran')
})

// The release server runs in this process, so commands that download from it
// must not block the event loop. On macOS and Linux each command runs in its
// own session, with no terminal to prompt on: an interactive zsh otherwise asks
// on the terminal itself (compinit's "insecure directories") and waits forever.
const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: !windows,
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
      resolve({ status, stderr, stdout })
    })
  })

const latest = async (version) => {
  await writeFile(join(releases, 'latest'), `v${version}`)
}

const freshHome = async () => {
  const home = realpathSync.native(
    await mkdtemp(join(tmpdir(), 'photon-home-'))
  )
  return {
    binary: join(home, '.local', 'bin', windows ? 'photon.exe' : 'photon'),
    home
  }
}

const baseEnv = (home) => {
  const env = {
    ...process.env,
    HOME: home,
    PHOTON_INSTALLER_GITHUB_BASE_URL: server.url,
    PHOTON_NO_UPDATE_NOTIFIER: '1',
    SHELL: zsh ? '/bin/zsh' : '/bin/sh',
    ...(windows
      ? {
          HOMEDRIVE: home.slice(0, 2),
          HOMEPATH: home.slice(2),
          USERPROFILE: home
        }
      : {})
  }
  for (const name of [
    'PHOTON_BIN_DIR',
    'PHOTON_NO_MODIFY_PATH',
    'PHOTON_VERSION',
    'XDG_BIN_HOME',
    'ZDOTDIR'
  ]) {
    delete env[name]
  }
  // A Windows PowerShell started by a process that PowerShell 7 started
  // inherits PowerShell 7's module paths and can't load Get-FileHash. Without
  // PSModulePath it builds its own, as a new Windows PowerShell does
  // (about_PSModulePath, "Starting Windows PowerShell from PowerShell 7").
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'PSMODULEPATH') {
      delete env[name]
    }
  }
  return env
}

const install = async (home, extra = {}) => {
  const env = { ...baseEnv(home), ...extra }
  const result = windows
    ? await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Get-Content -Raw -LiteralPath '${join(root, 'scripts', 'install.ps1')}' | Invoke-Expression`
        ],
        { env }
      )
    : await run('sh', [join(root, 'scripts', 'install.sh')], { env })
  console.log(
    `install ${JSON.stringify(extra)} exited ${result.status}\n${result.stdout}${result.stderr}`
  )
  return result
}

const userPath = () =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User')"
    ],
    { encoding: 'utf8' }
  ).stdout.trim()

// A shell started the way a new terminal starts one: PATH comes only from the
// system and the profiles (Windows: the registry), never from this process.
const newShells = () => {
  if (windows) {
    return [
      [
        'powershell',
        (command) => [
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine'); ${command}`
          ]
        ]
      ]
    ]
  }
  const shells = [
    ['sh', (command) => ['sh', ['-lc', command]]],
    ['bash', (command) => ['bash', ['-lc', command]]]
  ]
  return zsh
    ? [...shells, ['zsh', (command) => ['zsh', ['-ilc', command]]]]
    : shells
}

const inNewShell = async (home, command, shell = newShells()[0]) => {
  const [name, line] = shell
  const [program, args] = line(command)
  const env = windows
    ? baseEnv(home)
    : {
        HOME: home,
        PATH: `${sudoTrap}:${SYSTEM_PATH}`,
        PHOTON_INSTALLER_GITHUB_BASE_URL: server.url,
        PHOTON_NO_UPDATE_NOTIFIER: '1',
        SHELL: zsh ? '/bin/zsh' : '/bin/sh',
        TERM: 'dumb'
      }
  const result = await run(program, args, { env })
  console.log(
    `${name}: ${command} exited ${result.status}\n${result.stdout}${result.stderr}`
  )
  return result
}

const versionIn = async (home, shell) =>
  (await inNewShell(home, 'photon --version', shell)).stdout.trim()

const stateFile = (home) =>
  process.platform === 'darwin'
    ? join(
        home,
        'Library',
        'Caches',
        'photon-v3-production',
        'update-check.json'
      )
    : join(home, '.cache', 'photon-v3-production', 'update-check.json')

const underTerminal = async (home, binary) => {
  const result = await run(
    'python3',
    [
      join(root, 'test', 'support', 'terminal.py'),
      JSON.stringify({
        command: [binary, '--version'],
        env: {
          HOME: home,
          PATH: SYSTEM_PATH,
          PHOTON_INSTALLER_GITHUB_BASE_URL: server.url,
          TERM: 'xterm-256color'
        }
      })
    ],
    {}
  )
  const output = JSON.parse(result.stdout)
  return {
    stderr: stripVTControlCharacters(output.stderr),
    stdout: output.stdout
  }
}

let installed

test('installs the newest 3.x release, verified, and puts it on PATH for a new shell', async () => {
  await latest(FIRST)
  installed = await freshHome()
  const result = await install(installed.home)
  assert.equal(result.status, 0)
  assert.match(
    result.stdout,
    new RegExp(`Installed Photon CLI ${FIRST.replaceAll('.', '\\.')} at`)
  )
  assert.ok(result.stdout.includes(installed.binary), 'prints the full path')
  const versions = await Promise.all(
    newShells().map(async (shell) => [
      shell[0],
      await versionIn(installed.home, shell)
    ])
  )
  assert.deepEqual(
    Object.fromEntries(versions),
    Object.fromEntries(newShells().map(([name]) => [name, FIRST]))
  )
})

test('the installed binary shows the update notice with photon update', {
  skip: !python
}, async () => {
  await latest(SECOND)
  const first = await underTerminal(installed.home, installed.binary)
  assert.equal(first.stderr, '')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polls until the background check has written its result.
    const state = await readFile(stateFile(installed.home), 'utf8').catch(
      () => '{}'
    )
    if (JSON.parse(state).latestVersion !== undefined) {
      break
    }
    await delay(100)
  }
  const second = await underTerminal(installed.home, installed.binary)
  console.log(`notice:${second.stderr}`)
  assert.ok(
    second.stderr.includes(
      `A new version of photon is available: ${FIRST} → ${SECOND}`
    )
  )
  assert.ok(second.stderr.includes('To update, run: photon update'))
})

test('photon update downloads, checks and replaces the installer binary', async () => {
  await latest(SECOND)
  assert.equal(await versionIn(installed.home), FIRST)
  const update = await inNewShell(installed.home, 'photon update --debug')
  assert.equal(update.status, 0)
  assert.ok(
    update.stdout.includes(`Updated photon from ${FIRST} to ${SECOND}.`)
  )
  assert.equal(await versionIn(installed.home), SECOND)
})

test('installs the version in PHOTON_VERSION', async () => {
  await latest(SECOND)
  const { binary, home } = await freshHome()
  const result = await install(home, { PHOTON_VERSION: FIRST })
  assert.equal(result.status, 0)
  assert.equal(await versionIn(home), FIRST)
  assert.ok(result.stdout.includes(binary))
})

test('refuses a download that fails its checksum and installs nothing', async () => {
  const { binary, home } = await freshHome()
  const userPathBefore = windows ? userPath() : ''
  const result = await install(home, { PHOTON_VERSION: CORRUPTED })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, CHECKSUM_FAILED)
  assert.equal(existsSync(binary), false)
  assert.equal(existsSync(join(home, '.profile')), false)
  if (windows) {
    assert.equal(userPath(), userPathBefore)
  }
})

test('never installs a 1.0 release', async () => {
  const { binary, home } = await freshHome()
  await latest(LEGACY)
  const fromLatest = await install(home)
  assert.notEqual(fromLatest.status, 0)
  assert.match(fromLatest.stdout + fromLatest.stderr, NO_RELEASE)
  const pinned = await install(home, { PHOTON_VERSION: LEGACY })
  assert.notEqual(pinned.status, 0)
  assert.equal(existsSync(binary), false)
  await latest(SECOND)
})

test('succeeds and says so when a shell profile cannot be written', {
  skip: windows
}, async () => {
  await latest(SECOND)
  const { binary, home } = await freshHome()
  await writeFile(join(home, '.profile'), '')
  await chmod(join(home, '.profile'), 0o444)
  const result = await install(home)
  assert.equal(result.status, 0)
  assert.equal(existsSync(binary), true)
  assert.match(result.stderr, PROFILE_UNWRITABLE)
})

test('leaves PATH alone when PHOTON_NO_MODIFY_PATH is set', async () => {
  await latest(SECOND)
  const { binary, home } = await freshHome()
  const userPathBefore = windows ? userPath() : ''
  const result = await install(home, { PHOTON_NO_MODIFY_PATH: '1' })
  assert.equal(result.status, 0)
  assert.equal(existsSync(binary), true)
  if (windows) {
    assert.equal(userPath(), userPathBefore)
  } else {
    for (const profile of ['.profile', '.bashrc', '.zshrc']) {
      assert.equal(existsSync(join(home, profile)), false, profile)
    }
  }
})
