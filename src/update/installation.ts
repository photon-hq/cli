import { type Dirent, existsSync, readdirSync, realpathSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import { CLI_NAME } from '../meta.ts'
import {
  GLOBAL_COMMAND_DIRECTORY,
  PACKAGE_MANAGERS,
  type PackageManager
} from './package-managers.ts'
import { type ProcessRunner, runProcess } from './process.ts'
import { PHOTON_PACKAGE } from './release.ts'

export type Installation =
  | { kind: 'binary'; path: string }
  | { entry: string; kind: 'global'; manager: PackageManager }
  | { kind: 'npx' }
  | { directory: string; kind: 'project'; manager: PackageManager }
  | { kind: 'unknown' }

export interface DetectionOptions {
  binaryPath?: string | undefined
  cwd?: string | undefined
  file: string
  managers?: readonly PackageManager[]
  runProcess?: ProcessRunner
  signal?: AbortSignal | undefined
  startPath?: string | undefined
}

const EPHEMERAL_PATH =
  /\/(?:_npx|\.?bunx-[^/]+|dlx-[^/]+|pnpm(?:-cache)?\/dlx)\//u
const BUN_GLOBAL_FOLDER = /^(.+?) node_modules \(/mu
const PROJECT_MARKER = '/node_modules/'
const QUERY_TIMEOUT_MS = 10_000

const GLOBAL_FOLDER_ARGS: Record<PackageManager, readonly string[]> = {
  bun: ['pm', 'ls', '-g'],
  npm: ['root', '-g'],
  pnpm: ['root', '-g'],
  yarn: ['global', 'dir']
}

// npm and pnpm print the global node_modules folder; Yarn and Bun print the
// folder that holds it.
const GLOBAL_MODULES: Record<PackageManager, readonly string[]> = {
  bun: ['node_modules'],
  npm: [],
  pnpm: [],
  yarn: ['node_modules']
}

export const GLOBAL_INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  bun: ['add', '--global'],
  npm: ['install', '--global'],
  pnpm: ['add', '--global'],
  yarn: ['global', 'add']
}

const PROJECT_INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  bun: ['add'],
  npm: ['install'],
  pnpm: ['add'],
  yarn: ['add']
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm']
]

const LATEST_PACKAGE = `${PHOTON_PACKAGE.name}@${PHOTON_PACKAGE.tag}`
const INSTALLED_PACKAGE = sep + join('node_modules', PHOTON_PACKAGE.name)

export const realPath = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export const runningFile = (binaryPath: string | undefined): string =>
  binaryPath ?? realPath(process.argv[1] ?? '')

export const runsThroughNpx = (file: string): boolean =>
  EPHEMERAL_PATH.test(file.replaceAll('\\', '/'))

const isInside = (file: string, folder: string): boolean => {
  const path = relative(realPath(folder), file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

const globalFolder = async (
  manager: PackageManager,
  run: ProcessRunner,
  signal: AbortSignal | undefined
): Promise<string | undefined> => {
  const result = await run(manager, GLOBAL_FOLDER_ARGS[manager], {
    cwd: GLOBAL_COMMAND_DIRECTORY,
    signal,
    timeoutMs: QUERY_TIMEOUT_MS
  })
  if (result.exitCode !== 0) {
    return
  }
  const folder =
    manager === 'bun'
      ? BUN_GLOBAL_FOLDER.exec(result.stdout)?.[1]
      : result.stdout.split('\n')[0]
  return folder?.trim() || undefined
}

const entries = (folder: string): Dirent[] => {
  try {
    return readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
}

// Where a manager's global folder links the package. pnpm 11 and later give
// each global install a folder of its own, replaced on every update, and link
// it from the folder `pnpm root -g` prints by a name that stays the same.
const globalLinks = (manager: PackageManager, folder: string): string[] => {
  const links = [join(folder, ...GLOBAL_MODULES[manager], PHOTON_PACKAGE.name)]
  if (manager === 'pnpm') {
    for (const entry of entries(folder)) {
      if (entry.isSymbolicLink()) {
        links.push(
          join(folder, entry.name, 'node_modules', PHOTON_PACKAGE.name)
        )
      }
    }
  }
  return links
}

// The entry point to run after the manager updates the package: the running
// file, reached through the link the manager keeps for it, since pnpm starts
// the CLI from a copy that an update leaves behind or removes. A package the
// manager installed always sits in a node_modules folder; a checkout linked
// in with `npm link` and the like does not, and is not an install.
const globalEntry = (
  manager: PackageManager,
  folder: string,
  file: string
): string | undefined => {
  for (const link of globalLinks(manager, folder)) {
    const target = realPath(link)
    if (isInside(file, target) && target.endsWith(INSTALLED_PACKAGE)) {
      return join(link, relative(target, file))
    }
  }
}

const folderAndParents = (folder: string): string[] => {
  const folders = [folder]
  let parent = dirname(folder)
  while (parent !== folders.at(-1)) {
    folders.push(parent)
    parent = dirname(parent)
  }
  return folders
}

// Whether a path runs through a folder, itself or a link to it, wherever the
// links below that folder lead.
const runsThrough = (path: string, folder: string): boolean => {
  const target = realPath(folder)
  return folderAndParents(dirname(path)).some(
    (parent) => realPath(parent) === target
  )
}

// A package in a workspace has its lockfile at the workspace's root.
const projectManager = (directory: string): PackageManager => {
  for (const folder of folderAndParents(directory)) {
    const found = LOCKFILES.find(([lockfile]) =>
      existsSync(join(folder, lockfile))
    )
    if (found !== undefined) {
      return found[1]
    }
  }
  return 'npm'
}

// The project the CLI runs in, when the copy running is the one that project
// resolves: the nearest node_modules folder holding the package, as Node
// finds it. pnpm's global virtual store keeps a project's dependencies
// outside the project, so the running file alone does not name it.
const workingProject = (
  file: string,
  cwd: string | undefined
): string | undefined => {
  let start: string
  try {
    start = resolve(cwd ?? process.cwd())
  } catch {
    return
  }
  for (const folder of folderAndParents(start)) {
    const link = join(folder, 'node_modules', PHOTON_PACKAGE.name)
    if (existsSync(link)) {
      const target = realPath(link)
      return isInside(file, target) && target.endsWith(INSTALLED_PACKAGE)
        ? folder
        : undefined
    }
  }
}

export const detectInstallation = async (
  options: DetectionOptions
): Promise<Installation> => {
  if (options.binaryPath !== undefined) {
    return { kind: 'binary', path: options.binaryPath }
  }
  if (runsThroughNpx(options.file)) {
    return { kind: 'npx' }
  }
  const run = options.runProcess ?? runProcess
  const folders = await Promise.all(
    (options.managers ?? PACKAGE_MANAGERS).map(async (manager) => ({
      folder: await globalFolder(manager, run, options.signal),
      manager
    }))
  )
  const project = workingProject(options.file, options.cwd)
  const started = options.startPath ?? process.argv[1] ?? ''
  // pnpm 11 and later keep a global install in the store's global virtual
  // store, where a project's dependency of the same version is the very same
  // copy. The path the CLI was started from tells the two apart: the global
  // command starts it through the global folder, the project's from the store.
  // pnpm 10 keeps the package in .pnpm beside the node_modules folder
  // `pnpm root -g` prints, so there the folder that holds both counts.
  const startedGlobally = (manager: PackageManager, folder: string): boolean =>
    project === undefined ||
    isInside(options.file, folder) ||
    runsThrough(
      started,
      manager === 'pnpm' && basename(folder) === 'node_modules'
        ? dirname(folder)
        : folder
    )
  for (const { folder, manager } of folders) {
    if (folder === undefined) {
      continue
    }
    const entry = globalEntry(manager, folder, options.file)
    if (entry !== undefined && startedGlobally(manager, folder)) {
      return { entry, kind: 'global', manager }
    }
  }
  if (
    folders.some(
      ({ folder }) => folder !== undefined && isInside(options.file, folder)
    )
  ) {
    return { kind: 'unknown' }
  }
  if (project !== undefined) {
    return {
      directory: project,
      kind: 'project',
      manager: projectManager(project)
    }
  }
  // A project keeps its dependencies in the node_modules folder beside its
  // package.json. A copy in a package manager's own store, such as pnpm's
  // global virtual store, belongs to no project the file names.
  const marker = options.file.replaceAll('\\', '/').indexOf(PROJECT_MARKER)
  if (marker === -1) {
    return { kind: 'unknown' }
  }
  const directory = resolve(options.file.slice(0, marker + 1))
  if (!existsSync(join(directory, 'package.json'))) {
    return { kind: 'unknown' }
  }
  return { directory, kind: 'project', manager: projectManager(directory) }
}

export const noticeCommand = (
  installation: Installation
): string | undefined => {
  if (installation.kind === 'binary') {
    return `${CLI_NAME} update`
  }
  if (installation.kind === 'global') {
    return [
      installation.manager,
      ...GLOBAL_INSTALL_ARGS[installation.manager],
      LATEST_PACKAGE
    ].join(' ')
  }
}

export const manualUpdateSteps = (
  installation: Installation
): { description: string; run: string }[] => {
  if (installation.kind === 'npx') {
    return [
      { description: 'Run the newest version', run: `npx ${LATEST_PACKAGE}` }
    ]
  }
  if (installation.kind === 'project') {
    return [
      {
        description: `Update the dependency in ${installation.directory}`,
        run: [
          installation.manager,
          ...PROJECT_INSTALL_ARGS[installation.manager],
          LATEST_PACKAGE
        ].join(' ')
      }
    ]
  }
  return [
    {
      description:
        'If you installed it globally, update it with the package manager you used, for example npm',
      run: `npm install --global ${LATEST_PACKAGE}`
    },
    {
      description:
        'If a project depends on it, update it in that project, for example with npm',
      run: `npm install ${LATEST_PACKAGE}`
    }
  ]
}
