import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, type PathLike, realpathSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CliError } from '../src/core/errors.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  detectInstallation,
  noticeCommand
} from '../src/update/installation.ts'
import type { ProcessOptions, ProcessResult } from '../src/update/process.ts'
import { isNewerRelease, PHOTON_PACKAGE } from '../src/update/release.ts'
import {
  renameRetrying,
  swapRunningBinary,
  UpdateService
} from '../src/update/service.ts'

const PACKAGE = PHOTON_PACKAGE.name
const LATEST = `${PACKAGE}@${PHOTON_PACKAGE.tag}`
const REGISTRY = 'https://registry.example.test'
const GITHUB = 'https://github.example.test'
const RELEASES = `${GITHUB}/${BUILD_CONFIG.releaseRepository}/releases`
const ASSET = `${CLI_NAME}-linux-x64.tar.gz`

interface Call {
  args: readonly string[]
  command: string
  options: ProcessOptions | undefined
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'photon-update-'))
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

const env = {
  npm_config_registry: REGISTRY,
  PHOTON_INSTALLER_GITHUB_BASE_URL: GITHUB
}

const registry =
  (latest: string): typeof fetch =>
  (input) =>
    Promise.resolve(
      String(input) === `${REGISTRY}/${PACKAGE.replace('/', '%2f')}`
        ? Response.json({
            'dist-tags': { latest: '9.9.9', [PHOTON_PACKAGE.tag]: latest }
          })
        : new Response('Not Found', { status: 404 })
    )

const done = (stdout = ''): ProcessResult => ({
  exitCode: 0,
  stderr: '',
  stdout
})

const missing: ProcessResult = { exitCode: null, stderr: 'ENOENT', stdout: '' }

const managers = (
  calls: Call[],
  owner: string,
  folder: string,
  installed: string
) => {
  let updated = false
  const respond = (command: string, args: readonly string[]): ProcessResult => {
    if (args.at(-1) === '--version') {
      return done(updated ? `${installed}\n` : '0.3.0\n')
    }
    if (args[0] === 'global' && args[1] === 'dir') {
      return command === owner ? done(`${folder}\n`) : missing
    }
    if (args.includes('--global') || args[0] === 'global') {
      updated = true
      return done()
    }
    if (command !== owner) {
      return missing
    }
    return done(
      command === 'bun'
        ? `${folder} node_modules (2)\n└── ${PACKAGE}@0.3.0\n`
        : `${folder}\n`
    )
  }
  return (
    command: string,
    args: readonly string[],
    options?: ProcessOptions
  ): Promise<ProcessResult> => {
    calls.push({ args, command, options })
    return Promise.resolve(respond(command, args))
  }
}

const service = (
  options: Partial<ConstructorParameters<typeof UpdateService>[0]>
): UpdateService =>
  new UpdateService({
    binary: undefined,
    currentVersion: '0.3.0',
    env,
    fetch: registry('3.1.0'),
    progress: () => undefined,
    showOutput: false,
    ...options
  })

const rejection = async (promise: Promise<unknown>): Promise<CliError> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof CliError) {
      return error
    }
    throw error
  }
  throw new Error('expected a CliError')
}

describe('version check', () => {
  test('reads the dist-tag of this build from the registry', async () => {
    await expect(service({}).check()).resolves.toEqual({
      currentVersion: '0.3.0',
      installer: null,
      latestVersion: '3.1.0',
      status: 'update-available'
    })
    await expect(
      service({ fetch: registry('0.3.0') }).check()
    ).resolves.toMatchObject({ status: 'up-to-date' })
  })

  test('reads the latest GitHub release for a standalone binary', async () => {
    const result = await service({
      binary: { asset: ASSET, path: join(directory, CLI_NAME) },
      fetch: (input, init) =>
        Promise.resolve(
          String(input) === `${RELEASES}/latest` && init?.redirect === 'manual'
            ? new Response(null, {
                headers: { location: `${RELEASES}/tag/v3.2.0` },
                status: 302
              })
            : new Response('Not Found', { status: 404 })
        )
    }).check()
    expect(result).toMatchObject({
      latestVersion: '3.2.0',
      status: 'update-available'
    })
  })

  test('never offers a release older than the first 3.x release', () => {
    expect(isNewerRelease('3.0.1', '3.0.0', '3.0.0')).toBe(true)
    expect(isNewerRelease('2.2.0', '0.3.0', '3.0.0')).toBe(false)
    expect(isNewerRelease('3.0.0', '3.0.0', '3.0.0')).toBe(false)
    expect(isNewerRelease('3.1.0-beta.1', '3.0.0', '3.0.0')).toBe(false)
  })
})

describe('package manager installs', () => {
  test.each([
    ['npm', ['install', '--global'], ['lib', 'node_modules'], []],
    ['pnpm', ['add', '--global'], ['global', '5', 'node_modules'], []],
    ['yarn', ['global', 'add'], ['global'], ['node_modules']],
    ['bun', ['add', '--global'], ['install', 'global'], ['node_modules']]
  ] as const)(
    'updates a global %s install with %s',
    async (manager, install, root, modules) => {
      const folder = join(directory, ...root)
      const file = join(folder, ...modules, PACKAGE, 'dist', 'bin.js')
      await mkdir(join(folder, ...modules, PACKAGE, 'dist'), {
        recursive: true
      })
      await writeFile(file, '')
      const calls: Call[] = []
      const result = await service({
        file,
        runProcess: managers(calls, manager, folder, '3.1.0')
      }).update()
      expect(result).toEqual({
        currentVersion: '0.3.0',
        installer: manager,
        latestVersion: '3.1.0',
        status: 'updated'
      })
      expect(calls).toContainEqual(
        expect.objectContaining({
          args: [...install, `${PACKAGE}@3.1.0`],
          command: manager
        })
      )
      expect(calls.map(({ command }) => command)).not.toContain('sudo')
    }
  )

  test('asks and runs the package managers outside any project', async () => {
    const folder = join(directory, 'lib', 'node_modules')
    const file = join(folder, PACKAGE, 'dist', 'bin.js')
    await mkdir(join(folder, PACKAGE, 'dist'), { recursive: true })
    await writeFile(file, '')
    const calls: Call[] = []
    await service({
      file,
      runProcess: managers(calls, 'npm', folder, '3.1.0')
    }).update()
    const asked = calls.filter(({ command }) => command !== process.execPath)
    expect(asked.map(({ command }) => command)).toEqual([
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'npm'
    ])
    expect(asked.map(({ options }) => options?.cwd)).toEqual(
      asked.map(() => parse(process.execPath).root)
    )
  })

  test('updates a pnpm 10 global install and checks the copy it links to', async () => {
    const global = join(realpathSync(directory), 'global', '5')
    const folder = join(global, 'node_modules')
    const stored = join(global, '.pnpm', 'pkg@0.3.0', 'node_modules', PACKAGE)
    await mkdir(join(stored, 'dist'), { recursive: true })
    await writeFile(join(stored, 'dist', 'bin.js'), '')
    await mkdir(join(folder, PACKAGE, '..'), { recursive: true })
    await symlink(stored, join(folder, PACKAGE), 'junction')
    const calls: Call[] = []
    const result = await service({
      file: join(stored, 'dist', 'bin.js'),
      runProcess: managers(calls, 'pnpm', folder, '3.1.0')
    }).update()
    expect(result).toMatchObject({ installer: 'pnpm', status: 'updated' })
    expect(calls.at(-1)?.args).toEqual([
      join(folder, PACKAGE, 'dist', 'bin.js'),
      '--version'
    ])
  })

  // pnpm 11 and later install each global package in a folder of its own,
  // replaced on every update and linked from `pnpm root -g` by a name that
  // stays the same. The package itself sits in that folder's .pnpm, or in the
  // store's global virtual store (the default since pnpm 11).
  test.each([
    [
      'in its own folder',
      false,
      (own: string) => join(own, 'node_modules', '.pnpm')
    ],
    [
      'in the global virtual store',
      false,
      (own: string) => join(own, '..', '..', 'store', 'v11', 'links')
    ],
    [
      'with PNPM_HOME reached through a link',
      true,
      (own: string) => join(own, '..', '..', 'store', 'v11', 'links')
    ]
  ] as const)(
    'updates a pnpm 11 global install %s and checks it through the link that stays',
    async (_layout, linkedHome, storeOf) => {
      const home = join(realpathSync(directory), 'pnpm')
      const own = join(home, 'v11', '1773b6-1a1bdb5788b')
      const stored = join(storeOf(own), 'pkg@0.3.0', 'node_modules', PACKAGE)
      await mkdir(join(stored, 'dist'), { recursive: true })
      await writeFile(join(stored, 'dist', 'bin.js'), '')
      await mkdir(join(own, 'node_modules', PACKAGE, '..'), { recursive: true })
      await symlink(stored, join(own, 'node_modules', PACKAGE), 'junction')
      await symlink(own, join(home, 'v11', '93c5e4'), 'junction')
      if (linkedHome) {
        await symlink(home, join(directory, 'home'), 'junction')
      }
      const folder = join(linkedHome ? join(directory, 'home') : home, 'v11')
      const calls: Call[] = []
      const result = await service({
        file: join(stored, 'dist', 'bin.js'),
        runProcess: managers(calls, 'pnpm', folder, '3.1.0')
      }).update()
      expect(result).toMatchObject({ installer: 'pnpm', status: 'updated' })
      expect(calls.at(-1)?.args).toEqual([
        join(folder, '93c5e4', 'node_modules', PACKAGE, 'dist', 'bin.js'),
        '--version'
      ])
    }
  )

  test('changes nothing for a copy another global package depends on', async () => {
    const folder = join(realpathSync(directory), 'lib', 'node_modules')
    const file = join(
      folder,
      'other-tool',
      'node_modules',
      PACKAGE,
      'dist',
      'bin.js'
    )
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '')
    const calls: Call[] = []
    const error = await rejection(
      service({
        file,
        runProcess: managers(calls, 'npm', folder, '3.1.0')
      }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(error.next[0]?.run).toBe(`npm install --global ${LATEST}`)
    expect(calls.map(({ args }) => args)).not.toContainEqual(
      expect.arrayContaining(['--global'])
    )
  })

  // pnpm keeps a copy another package depends on outside the folder
  // `pnpm root -g` prints: pnpm 10 in .pnpm beside it, pnpm 11 and later in
  // the store's global virtual store, where `pnpm dlx` runs it from too.
  test.each([
    [
      'pnpm 10',
      ['global', '5', 'node_modules'],
      ['global', '5', '.pnpm', 'pkg@0.3.0']
    ],
    [
      'pnpm 11',
      ['global', 'v11'],
      ['store', 'v11', 'links', ...PACKAGE.split('/'), '0.3.0', 'c9a624']
    ]
  ] as const)(
    'changes nothing for a %s copy that no global install links to',
    async (_version, root, store) => {
      const home = realpathSync(directory)
      const folder = join(home, ...root)
      const file = join(
        home,
        ...store,
        'node_modules',
        PACKAGE,
        'dist',
        'bin.js'
      )
      await mkdir(folder, { recursive: true })
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, '')
      const calls: Call[] = []
      const error = await rejection(
        service({
          file,
          runProcess: managers(calls, 'pnpm', folder, '3.1.0')
        }).update()
      )
      expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
      expect(error.next[0]?.run).toBe(`npm install --global ${LATEST}`)
      expect(calls.map(({ args }) => args)).not.toContainEqual(
        expect.arrayContaining(['--global'])
      )
    }
  )

  test('reads a global folder it cannot list as holding nothing', async () => {
    const folder = join(directory, 'global')
    await writeFile(folder, '')
    const error = await rejection(
      service({
        file: join(directory, 'checkout', 'dist', 'bin.js'),
        runProcess: managers([], 'pnpm', folder, '3.1.0')
      }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
  })

  test('changes nothing for a checkout linked in with npm link', async () => {
    const folder = join(realpathSync(directory), 'lib', 'node_modules')
    const checkout = join(realpathSync(directory), 'cli')
    await mkdir(join(checkout, 'dist'), { recursive: true })
    await writeFile(join(checkout, 'dist', 'bin.js'), '')
    await mkdir(join(folder, PACKAGE, '..'), { recursive: true })
    await symlink(checkout, join(folder, PACKAGE), 'junction')
    const calls: Call[] = []
    const error = await rejection(
      service({
        file: join(checkout, 'dist', 'bin.js'),
        runProcess: managers(calls, 'npm', folder, '3.1.0')
      }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(calls.map(({ args }) => args)).not.toContainEqual(
      expect.arrayContaining(['--global'])
    )
  })

  test('fails when the manager leaves the old version in place', async () => {
    const folder = join(directory, 'lib', 'node_modules')
    const file = join(folder, PACKAGE, 'dist', 'bin.js')
    await mkdir(join(folder, PACKAGE, 'dist'), { recursive: true })
    await writeFile(file, '')
    const error = await rejection(
      service({
        file,
        runProcess: managers([], 'npm', folder, '0.3.0')
      }).update()
    )
    expect(error.code).toBe('UPDATE_FAILED')
    expect(error.detail).toContain('reports 0.3.0 instead of 3.1.0')
  })

  test('says so when the package manager runs past its time', async () => {
    const folder = join(directory, 'lib', 'node_modules')
    const file = join(folder, PACKAGE, 'dist', 'bin.js')
    await mkdir(join(folder, PACKAGE, 'dist'), { recursive: true })
    await writeFile(file, '')
    const run = managers([], 'npm', folder, '3.1.0')
    const error = await rejection(
      service({
        file,
        runProcess: async (command, args, options) =>
          args.includes('--global')
            ? { exitCode: null, stderr: '', stdout: '', timedOut: true }
            : await run(command, args, options)
      }).update()
    )
    expect(error.code).toBe('UPDATE_FAILED')
    expect(error.detail).toBe(
      `npm install --global ${PACKAGE}@3.1.0 did not finish within 10 minutes, so Photon stopped it.`
    )
  })

  test('refuses --installer for a copy that manager did not install', async () => {
    const file = join(directory, 'photon', 'dist', 'bin.js')
    const calls: Call[] = []
    const error = await rejection(
      service({
        file,
        runProcess: managers(calls, 'npm', join(directory, 'global'), '3.1.0')
      }).update('pnpm')
    )
    expect(error.code).toBe('INSTALLER_MISMATCH')
    expect(error.exitCode).toBe(2)
    expect(calls.map(({ command }) => command)).toEqual(['pnpm'])
  })
})

describe('installs it does not change', () => {
  const nothingRuns = async (): Promise<ProcessResult> => missing

  test('prints the npx command and changes nothing', async () => {
    const file = join(
      directory,
      '.npm/_npx/0a1b2c/node_modules',
      PACKAGE,
      'dist/bin.js'
    )
    const error = await rejection(
      service({ file, runProcess: nothingRuns }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(error.next).toEqual([
      {
        description: 'Run the newest version',
        run: `npx ${LATEST}`
      }
    ])
  })

  test('names the project manager for a project dependency', async () => {
    const project = join(directory, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'package.json'), '{}')
    await writeFile(join(project, 'pnpm-lock.yaml'), '')
    const error = await rejection(
      service({
        file: join(project, 'node_modules', PACKAGE, 'dist/bin.js'),
        runProcess: nothingRuns
      }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(error.next).toEqual([
      {
        description: `Update the dependency in ${project}`,
        run: `pnpm add ${LATEST}`
      }
    ])
  })

  // With pnpm's global virtual store on, a project links its dependencies
  // from the store, so the copy that runs sits outside the project.
  const storeCopy = async (home: string): Promise<string> => {
    const copy = join(
      home,
      'store',
      'v11',
      'links',
      ...PACKAGE.split('/'),
      '0.3.0',
      'c9a624',
      'node_modules',
      PACKAGE
    )
    await mkdir(join(copy, 'dist'), { recursive: true })
    await writeFile(join(copy, 'dist', 'bin.js'), '')
    return copy
  }

  const linkDependency = async (project: string, target: string) => {
    await mkdir(join(project, 'node_modules', PACKAGE, '..'), {
      recursive: true
    })
    await symlink(target, join(project, 'node_modules', PACKAGE), 'junction')
  }

  test('finds a project dependency kept in the pnpm global virtual store from the folder it runs in', async () => {
    const home = realpathSync(directory)
    const copy = await storeCopy(home)
    const project = join(home, 'project')
    await mkdir(join(project, 'src'), { recursive: true })
    await writeFile(join(project, 'package.json'), '{}')
    await writeFile(join(project, 'pnpm-lock.yaml'), '')
    await linkDependency(project, copy)
    await expect(
      detectInstallation({
        cwd: join(project, 'src'),
        file: join(copy, 'dist', 'bin.js'),
        managers: []
      })
    ).resolves.toEqual({ directory: project, kind: 'project', manager: 'pnpm' })
  })

  test('names no project when the folder it runs in resolves another copy', async () => {
    const home = realpathSync(directory)
    const copy = await storeCopy(home)
    const other = join(home, 'other')
    await mkdir(join(other, 'node_modules', PACKAGE), { recursive: true })
    const checkout = join(home, 'cli')
    await mkdir(join(checkout, 'dist'), { recursive: true })
    await writeFile(join(checkout, 'dist', 'bin.js'), '')
    const linked = join(home, 'linked')
    await linkDependency(linked, checkout)
    const runs = [
      { cwd: home, file: join(copy, 'dist', 'bin.js') },
      { cwd: other, file: join(copy, 'dist', 'bin.js') },
      { cwd: linked, file: join(checkout, 'dist', 'bin.js') }
    ]
    expect(
      await Promise.all(
        runs.map((run) => detectInstallation({ ...run, managers: [] }))
      )
    ).toEqual(runs.map(() => ({ kind: 'unknown' })))
  })

  // pnpm 11 and later keep a global install in the store too, so a project
  // dependency of the same version is the same copy. pnpm prints the global
  // folder the way PNPM_HOME names it, which may be through a link.
  test.each([
    ['the global folder', 'global', [], 'global'],
    ['a link to PNPM_HOME', 'linked', [], 'global'],
    ['the store', 'store', [], 'project'],
    ['a store kept in PNPM_HOME/global', 'store', ['pnpm', 'global'], 'project']
  ] as const)(
    'tells a project dependency from a global pnpm install of the same copy, started from %s',
    async (_from, from, storeIn, kind) => {
      const home = realpathSync(directory)
      const copy = await storeCopy(join(home, ...storeIn))
      const folder = join(home, 'pnpm', 'global', 'v11')
      const own = join(folder, '1773b6-1a1bdb5788b')
      await mkdir(join(own, 'node_modules', PACKAGE, '..'), { recursive: true })
      await symlink(copy, join(own, 'node_modules', PACKAGE), 'junction')
      await symlink(own, join(folder, '93c5e4'), 'junction')
      await symlink(join(home, 'pnpm'), join(home, 'linked'), 'junction')
      const project = join(home, 'project')
      await mkdir(project)
      await writeFile(join(project, 'package.json'), '{}')
      await writeFile(join(project, 'pnpm-lock.yaml'), '')
      await linkDependency(project, copy)
      const printed =
        from === 'linked' ? join(home, 'linked', 'global', 'v11') : folder
      const entry = join(
        printed,
        '93c5e4',
        'node_modules',
        PACKAGE,
        'dist',
        'bin.js'
      )
      const result = await detectInstallation({
        cwd: project,
        file: join(copy, 'dist', 'bin.js'),
        managers: ['pnpm'],
        runProcess: managers([], 'pnpm', printed, '3.1.0'),
        startPath: from === 'store' ? join(copy, 'dist', 'bin.js') : entry
      })
      expect(result).toEqual(
        kind === 'global'
          ? { entry, kind: 'global', manager: 'pnpm' }
          : { directory: project, kind: 'project', manager: 'pnpm' }
      )
    }
  )

  test('tells a project inside the npm prefix from the global install it links', async () => {
    const home = realpathSync(directory)
    const folder = join(home, 'lib', 'node_modules')
    const copy = join(home, 'packed', 'node_modules', PACKAGE)
    await mkdir(join(copy, 'dist'), { recursive: true })
    await writeFile(join(copy, 'dist', 'bin.js'), '')
    await mkdir(join(folder, PACKAGE, '..'), { recursive: true })
    await symlink(copy, join(folder, PACKAGE), 'junction')
    const project = join(home, 'lib', 'app')
    await mkdir(project)
    await writeFile(join(project, 'package.json'), '{}')
    await writeFile(join(project, 'package-lock.json'), '{}')
    await linkDependency(project, copy)
    await expect(
      detectInstallation({
        cwd: project,
        file: join(copy, 'dist', 'bin.js'),
        managers: ['npm'],
        runProcess: managers([], 'npm', folder, '3.1.0'),
        startPath: join(project, 'node_modules', PACKAGE, 'dist', 'bin.js')
      })
    ).resolves.toEqual({ directory: project, kind: 'project', manager: 'npm' })
  })

  test('tells a global pnpm 10 install from a project that links it', async () => {
    const home = realpathSync(directory)
    const global = join(home, 'global', '5')
    const folder = join(global, 'node_modules')
    const stored = join(global, '.pnpm', 'pkg@0.3.0', 'node_modules', PACKAGE)
    await mkdir(join(stored, 'dist'), { recursive: true })
    await writeFile(join(stored, 'dist', 'bin.js'), '')
    await mkdir(join(folder, PACKAGE, '..'), { recursive: true })
    await symlink(stored, join(folder, PACKAGE), 'junction')
    const project = join(home, 'project')
    await mkdir(project)
    await writeFile(join(project, 'package.json'), '{}')
    await linkDependency(project, join(folder, PACKAGE))
    await expect(
      detectInstallation({
        cwd: project,
        file: join(stored, 'dist', 'bin.js'),
        managers: ['pnpm'],
        runProcess: managers([], 'pnpm', folder, '3.1.0'),
        startPath: join(stored, 'dist', 'bin.js')
      })
    ).resolves.toEqual({
      entry: join(folder, PACKAGE, 'dist', 'bin.js'),
      kind: 'global',
      manager: 'pnpm'
    })
  })

  test('names the package manager of the workspace a package belongs to', async () => {
    const workspace = realpathSync(directory)
    const copy = join(
      workspace,
      'node_modules',
      '.pnpm',
      `${PACKAGE.replace('/', '+')}@0.3.0`,
      'node_modules',
      PACKAGE
    )
    const app = join(workspace, 'apps', 'web')
    await mkdir(join(copy, 'dist'), { recursive: true })
    await writeFile(join(copy, 'dist', 'bin.js'), '')
    await mkdir(app, { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{}')
    await writeFile(join(workspace, 'pnpm-lock.yaml'), '')
    await writeFile(join(workspace, 'package-lock.json'), '{}')
    await writeFile(join(app, 'package.json'), '{}')
    await linkDependency(app, copy)
    await expect(
      detectInstallation({
        cwd: app,
        file: join(copy, 'dist', 'bin.js'),
        managers: []
      })
    ).resolves.toEqual({ directory: app, kind: 'project', manager: 'pnpm' })
  })

  test('names npm for an npm project inside a repository that uses another manager', async () => {
    const repository = realpathSync(directory)
    const project = join(repository, 'tools', 'app')
    const file = join(project, 'node_modules', PACKAGE, 'dist', 'bin.js')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '')
    await writeFile(join(repository, 'pnpm-lock.yaml'), '')
    await writeFile(join(project, 'package.json'), '{}')
    await writeFile(join(project, 'package-lock.json'), '{}')
    await expect(
      detectInstallation({ cwd: repository, file, managers: [] })
    ).resolves.toEqual({ directory: project, kind: 'project', manager: 'npm' })
  })

  // A node_modules folder at the root of the disk belongs to a project there,
  // never to the folder the CLI happens to run in.
  const { root } = parse(tmpdir())
  describe.skipIf(existsSync(join(root, 'package.json')))(
    'with a node_modules folder at the root of the disk',
    () => {
      test('reads it from the root, not from the folder it runs in', async () => {
        const elsewhere = join(directory, 'project')
        await mkdir(elsewhere)
        await writeFile(join(elsewhere, 'package.json'), '{}')
        const cwd = process.cwd()
        process.chdir(elsewhere)
        try {
          await expect(
            detectInstallation({
              cwd: directory,
              file: join(root, 'node_modules', PACKAGE, 'dist', 'bin.js'),
              managers: []
            })
          ).resolves.toEqual({ kind: 'unknown' })
        } finally {
          process.chdir(cwd)
        }
      })
    }
  )

  test('prints a command for an install it cannot identify', async () => {
    const error = await rejection(
      service({
        file: join(directory, 'checkout', 'dist', 'bin.js'),
        runProcess: nothingRuns
      }).update()
    )
    expect(error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(error.next).toEqual([
      {
        description:
          'If you installed it globally, update it with the package manager you used, for example npm',
        run: `npm install --global ${LATEST}`
      },
      {
        description:
          'If a project depends on it, update it in that project, for example with npm',
        run: `npm install ${LATEST}`
      }
    ])
  })
})

describe('renaming on Windows', () => {
  const failing = (codes: string[]) => {
    const calls: string[] = []
    const renameFile = (): Promise<void> => {
      const code = codes[calls.length]
      calls.push(code ?? 'done')
      return code === undefined
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error(code), { code }))
    }
    return { calls, renameFile }
  }

  test.each(['EACCES', 'EBUSY', 'EPERM'])(
    'tries again while another process holds the file (%s)',
    async (code) => {
      const { calls, renameFile } = failing([code, code])
      await renameRetrying(
        join(directory, 'fresh'),
        join(directory, 'photon.exe'),
        { renameFile }
      )
      expect(calls).toEqual([code, code, 'done'])
    }
  )

  test('gives up at once on another error, or when the destination exists', async () => {
    const other = failing(['ENOENT'])
    await expect(
      renameRetrying(join(directory, 'fresh'), join(directory, 'photon.exe'), {
        renameFile: other.renameFile
      })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(other.calls).toEqual(['ENOENT'])
    await writeFile(join(directory, 'taken.exe'), '')
    const taken = failing(['EPERM'])
    await expect(
      renameRetrying(join(directory, 'fresh'), join(directory, 'taken.exe'), {
        renameFile: taken.renameFile
      })
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(taken.calls).toEqual(['EPERM'])
  })

  test('stops trying once the update is interrupted', async () => {
    const controller = new AbortController()
    const interruption = new DOMException('Command interrupted.', 'AbortError')
    const calls: string[] = []
    const renameFile = (): Promise<void> => {
      calls.push('EBUSY')
      if (calls.length === 2) {
        controller.abort(interruption)
      }
      return Promise.reject(
        Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      )
    }
    await expect(
      renameRetrying(join(directory, 'fresh'), join(directory, 'photon.exe'), {
        renameFile,
        signal: controller.signal
      })
    ).rejects.toBe(interruption)
    expect(calls).toEqual(['EBUSY', 'EBUSY'])
  })
})

describe('swapping the running binary on Windows', () => {
  const binaries = async () => {
    const target = join(directory, 'photon.exe')
    const fresh = join(directory, 'fresh.exe')
    await writeFile(target, 'previous')
    await writeFile(fresh, 'new')
    return { fresh, target }
  }
  const failure = (code: string) =>
    Promise.reject(Object.assign(new Error(code), { code }))

  test('moves the running binary aside and puts the new one in its place', async () => {
    const { fresh, target } = await binaries()
    await swapRunningBinary(fresh, target)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readFile(`${target}.old`, 'utf8')).toBe('previous')
  })

  test('puts the previous binary back when the new one cannot take its place', async () => {
    const { fresh, target } = await binaries()
    const renameFile = (from: PathLike, to: PathLike): Promise<void> =>
      from === fresh ? failure('ENOENT') : rename(from, to)
    await expect(
      swapRunningBinary(fresh, target, { renameFile })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(target, 'utf8')).toBe('previous')
  })

  test('puts the previous binary back when the update is interrupted', async () => {
    const { fresh, target } = await binaries()
    const controller = new AbortController()
    const interruption = new DOMException('Command interrupted.', 'AbortError')
    const renameFile = (from: PathLike, to: PathLike): Promise<void> => {
      if (from !== fresh) {
        return rename(from, to)
      }
      controller.abort(interruption)
      return failure('EBUSY')
    }
    await expect(
      swapRunningBinary(fresh, target, {
        renameFile,
        signal: controller.signal
      })
    ).rejects.toBe(interruption)
    expect(await readFile(target, 'utf8')).toBe('previous')
  })

  test('says where the previous binary is when it cannot go back either', async () => {
    const { fresh, target } = await binaries()
    const renameFile = (from: PathLike, to: PathLike): Promise<void> =>
      from === target ? rename(from, to) : failure('ENOENT')
    const error: unknown = await swapRunningBinary(fresh, target, {
      renameFile
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({
      cause: { code: 'ENOENT' },
      code: 'UPDATE_FAILED',
      detail: `Photon could not replace ${target} (ENOENT), nor put the previous version back. It is at ${target}.old.`,
      next: [
        {
          description: `Rename ${target}.old to photon.exe to use the previous version again`
        }
      ]
    })
    expect(await readFile(`${target}.old`, 'utf8')).toBe('previous')
  })
})

describe('notice commands', () => {
  test('name the command for how the CLI was installed', () => {
    expect(noticeCommand({ kind: 'binary', path: '/bin/photon' })).toBe(
      `${CLI_NAME} update`
    )
    expect(
      noticeCommand({ entry: '/bin.js', kind: 'global', manager: 'yarn' })
    ).toBe(`yarn global add ${LATEST}`)
    expect(noticeCommand({ kind: 'npx' })).toBeUndefined()
    expect(
      noticeCommand({ directory: '/app', kind: 'project', manager: 'npm' })
    ).toBeUndefined()
    expect(noticeCommand({ kind: 'unknown' })).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('standalone binary', () => {
  const release = async (version: string, corrupt = false) => {
    const staging = join(directory, `release-${version}`)
    await mkdir(staging, { recursive: true })
    const binary = join(staging, CLI_NAME)
    await writeFile(binary, `#!/bin/sh\necho ${version}\n`)
    await chmod(binary, 0o755)
    execFileSync('tar', ['-czf', join(staging, ASSET), '-C', staging, CLI_NAME])
    const archive = await readFile(join(staging, ASSET))
    const checksum = createHash('sha256').update(archive).digest('hex')
    const served = corrupt
      ? Buffer.concat([archive, Buffer.from('x')])
      : archive
    const responses = new Map([
      [
        `${RELEASES}/latest`,
        () =>
          new Response(null, {
            headers: { location: `${RELEASES}/tag/v${version}` },
            status: 302
          })
      ],
      [`${RELEASES}/download/v${version}/${ASSET}`, () => new Response(served)],
      [
        `${RELEASES}/download/v${version}/checksums.txt`,
        () => new Response(`${checksum}  ${ASSET}\n`)
      ]
    ])
    const fetchRelease: typeof fetch = (input) =>
      Promise.resolve(
        responses.get(String(input))?.() ??
          new Response('Not Found', { status: 404 })
      )
    return fetchRelease
  }

  const installed = async (): Promise<string> => {
    const path = join(directory, 'bin', CLI_NAME)
    await mkdir(join(directory, 'bin'), { recursive: true })
    await writeFile(path, '#!/bin/sh\necho 0.3.0\n')
    await chmod(path, 0o755)
    return path
  }

  test('downloads, checks and replaces the binary', async () => {
    const path = await installed()
    const result = await service({
      binary: { asset: ASSET, path },
      fetch: await release('3.1.0')
    }).update()
    expect(result).toMatchObject({ installer: 'standalone', status: 'updated' })
    expect(execFileSync(path, ['--version'], { encoding: 'utf8' })).toBe(
      '3.1.0\n'
    )
  })

  test('refuses a download that fails its checksum and keeps the binary', async () => {
    const path = await installed()
    const error = await rejection(
      service({
        binary: { asset: ASSET, path },
        fetch: await release('3.1.0', true)
      }).update()
    )
    expect(error.code).toBe('UPDATE_CHECKSUM_MISMATCH')
    expect(execFileSync(path, ['--version'], { encoding: 'utf8' })).toBe(
      '0.3.0\n'
    )
  })
})
