import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { CliError } from '../core/errors.ts'
import { ID_FORMATS } from '../core/photon-id.ts'
import { CLI_NAME } from '../meta.ts'

const FOLDER_DIRECTORY = '.photon'
const FOLDER_FILE = 'project.json'
const SCHEMA_VERSION = 1
const GITIGNORE_ENTRY = '.photon/'
// .gitignore lines that already keep the folder's .photon/ out of Git.
const GITIGNORE_EQUIVALENTS = new Set([
  '.photon',
  '.photon/',
  '/.photon',
  '/.photon/'
])
const LINE_BREAK_PATTERN = /\r?\n/u
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR'])

const folderProjectSchema = z.strictObject({
  apiOrigin: z.url(),
  organizationId: z
    .string()
    .regex(
      ID_FORMATS.organization.pattern,
      'Organization ID must be a canonical pho_org_ identifier.'
    ),
  projectId: z
    .string()
    .regex(
      ID_FORMATS.project.pattern,
      'Project ID must be a canonical pho_prj_ identifier.'
    ),
  schemaVersion: z.literal(SCHEMA_VERSION)
})

// The project a folder and its subfolders act on, from the nearest
// .photon/project.json.
export interface FolderProject {
  organizationId: string
  path: string
  projectId: string
}

type ParsedFile =
  | { kind: 'corrupt'; cause: unknown }
  | { kind: 'other-build' }
  | { kind: 'project'; project: FolderProject }

interface ProjectFolderRepositoryOptions {
  apiOrigin: string
  cwd: string
}

const storageError = (path: string, cause: unknown): CliError =>
  new CliError(
    'PROJECT_CONTEXT_UNAVAILABLE',
    `Photon could not access ${path}.`,
    {
      cause
    }
  )

const corruptFileError = (path: string, cause: unknown): CliError =>
  new CliError(
    'PROJECT_CONTEXT_CORRUPT',
    `${path} is malformed. Run ${CLI_NAME} unlink, then ${CLI_NAME} link --project <project-id>.`,
    { cause }
  )

const invalidProjectError = (cause: unknown): CliError =>
  new CliError(
    'ARGUMENT_VALIDATION',
    'The project to save for this folder contains invalid input.',
    { cause, exitCode: 2 }
  )

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  typeof error.code === 'string' &&
  MISSING_FILE_CODES.has(error.code)

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      return
    }
    throw storageError(path, error)
  }
}

// The folder file is not a secret, so it is an ordinary file a person can
// read and edit, not one of the private credential files.
export class ProjectFolderRepository {
  readonly #apiOrigin: string
  readonly #cwd: string
  #found: Promise<FolderProject | undefined> | undefined

  constructor(options: ProjectFolderRepositoryOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#cwd = resolve(options.cwd)
  }

  // The nearest file this build saved, from the current folder up, read once
  // per command.
  async find(): Promise<FolderProject | undefined> {
    this.#found ??= this.#find()
    try {
      return await this.#found
    } catch (error) {
      this.#found = undefined
      throw error
    }
  }

  async save(project: {
    organizationId: string
    projectId: string
  }): Promise<FolderProject> {
    let serialized: string
    try {
      serialized = `${JSON.stringify(
        folderProjectSchema.parse({
          apiOrigin: this.#apiOrigin,
          organizationId: project.organizationId,
          projectId: project.projectId,
          schemaVersion: SCHEMA_VERSION
        }),
        undefined,
        2
      )}\n`
    } catch (error) {
      throw invalidProjectError(error)
    }
    const directory = join(this.#cwd, FOLDER_DIRECTORY)
    const path = join(directory, FOLDER_FILE)
    const temporary = join(directory, `.${FOLDER_FILE}.${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, serialized)
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw storageError(path, error)
    }
    const saved = { ...project, path }
    this.#found = Promise.resolve(saved)
    return saved
  }

  // Adds .photon/ to the .gitignore beside it, creating the file if needed,
  // as "vercel link" does with .vercel. Reports whether it added the line.
  async ignoreInGit(): Promise<boolean> {
    const path = join(this.#cwd, '.gitignore')
    const existing = await readOptional(path)
    if (
      existing
        ?.split(LINE_BREAK_PATTERN)
        .some((line) => GITIGNORE_EQUIVALENTS.has(line.trim()))
    ) {
      return false
    }
    const separator =
      existing === undefined || existing === '' || existing.endsWith('\n')
        ? ''
        : '\n'
    try {
      await appendFile(path, `${separator}${GITIGNORE_ENTRY}\n`)
    } catch (error) {
      throw storageError(path, error)
    }
    return true
  }

  // Removes the nearest file this build saved, even a malformed one, and
  // returns its path.
  async clear(): Promise<string | undefined> {
    const nearest = await this.#nearest()
    if (nearest === undefined) {
      return
    }
    await this.#remove(nearest.path)
    return nearest.path
  }

  // Removes the nearest file only when it names this project.
  async clearIfNames(projectId: string): Promise<boolean> {
    const found = await this.find()
    if (found?.projectId !== projectId) {
      return false
    }
    await this.#remove(found.path)
    return true
  }

  async #find(): Promise<FolderProject | undefined> {
    const nearest = await this.#nearest()
    if (nearest === undefined) {
      return
    }
    if (nearest.parsed.kind === 'corrupt') {
      throw corruptFileError(nearest.path, nearest.parsed.cause)
    }
    return nearest.parsed.project
  }

  // A file another build saved (another API origin) is not this build's, so
  // the search passes it and goes on to the folder above.
  async #nearest(): Promise<
    | { parsed: Exclude<ParsedFile, { kind: 'other-build' }>; path: string }
    | undefined
  > {
    let directory = this.#cwd
    for (;;) {
      const path = join(directory, FOLDER_DIRECTORY, FOLDER_FILE)
      // biome-ignore lint/performance/noAwaitInLoops: the nearest file wins, so the search reads one folder at a time.
      const serialized = await readOptional(path)
      const parsed =
        serialized === undefined ? undefined : this.#parse(path, serialized)
      if (parsed !== undefined && parsed.kind !== 'other-build') {
        return { parsed, path }
      }
      const parent = dirname(directory)
      if (parent === directory) {
        return
      }
      directory = parent
    }
  }

  #parse(path: string, serialized: string): ParsedFile {
    let value: unknown
    try {
      value = JSON.parse(serialized) as unknown
    } catch (error) {
      return { cause: error, kind: 'corrupt' }
    }
    const result = folderProjectSchema.safeParse(value)
    if (!result.success) {
      return { cause: result.error, kind: 'corrupt' }
    }
    if (result.data.apiOrigin !== this.#apiOrigin) {
      return { kind: 'other-build' }
    }
    return {
      kind: 'project',
      project: {
        organizationId: result.data.organizationId,
        path,
        projectId: result.data.projectId
      }
    }
  }

  async #remove(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissingFile(error)) {
        throw storageError(path, error)
      }
    }
    await rmdir(dirname(path)).catch(() => undefined)
    this.#found = undefined
  }
}
