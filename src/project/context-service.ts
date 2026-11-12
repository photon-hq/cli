import type { EnvironmentKey } from '../auth/environment-key.ts'
import { notSignedInError } from '../auth/errors.ts'
import type { AuthRepository } from '../auth/storage/repository.ts'
import { CliError } from '../core/errors.ts'
import { validateId } from '../core/photon-id.ts'
import { CLI_NAME } from '../meta.ts'
import type {
  FolderProject,
  ProjectFolderRepository
} from './folder-repository.ts'

// "folder" is the nearest .photon/project.json, which "link" saves.
export type ResolvedProjectContext =
  | { path: string; projectId: string; source: 'folder' }
  | { projectId: string; source: 'environment' | 'flag' }

export type ProjectContextSource = ResolvedProjectContext['source']

export interface SavedProjectContext extends FolderProject {
  // Whether .photon/ was added to the .gitignore beside it, was already
  // there, or could not be added.
  gitignore: 'added' | 'failed' | 'listed'
}

interface ProjectContextServiceOptions {
  authRepository: AuthRepository
  env?: NodeJS.ProcessEnv
  /** The run's key from the environment, which counts as signed in. */
  environmentKey?: EnvironmentKey
  explicitProjectId?: string
  folder: ProjectFolderRepository
}

const projectNotSelected = (): CliError =>
  new CliError(
    'PROJECT_NOT_SELECTED',
    `No project is selected. Pass --project <project-id>, set PHOTON_PROJECT_ID, or run ${CLI_NAME} link --project <project-id> to save one for this folder.`,
    { exitCode: 2 }
  )

const normalizeEnvironmentProject = (
  value: string | undefined
): string | undefined => {
  if (value === undefined) {
    return
  }
  const normalized = value.trim()
  return normalized.length === 0
    ? undefined
    : validateId('project', normalized, 'PHOTON_PROJECT_ID')
}

export class ProjectContextService {
  readonly #authRepository: AuthRepository
  readonly #environmentKey: EnvironmentKey | undefined
  readonly #env: NodeJS.ProcessEnv
  readonly #explicitProjectId: string | undefined
  readonly #folder: ProjectFolderRepository
  #selection: ResolvedProjectContext | undefined

  constructor(options: ProjectContextServiceOptions) {
    this.#authRepository = options.authRepository
    this.#environmentKey = options.environmentKey
    this.#env = options.env ?? process.env
    this.#explicitProjectId = options.explicitProjectId
    this.#folder = options.folder
  }

  // Saves the project for the current folder and below.
  async activate(project: {
    organizationId: string
    projectId: string
  }): Promise<SavedProjectContext> {
    const saved = await this.#folder.save({
      organizationId: validateId(
        'organization',
        project.organizationId,
        'Organization ID'
      ),
      projectId: validateId('project', project.projectId, 'Project ID')
    })
    try {
      return {
        ...saved,
        gitignore: (await this.#folder.ignoreInGit()) ? 'added' : 'listed'
      }
    } catch {
      return { ...saved, gitignore: 'failed' }
    }
  }

  // Removes the folder's file and returns its path.
  async clear(): Promise<string | undefined> {
    return await this.#folder.clear()
  }

  async clearIfActive(projectId: string): Promise<boolean> {
    return await this.#folder.clearIfNames(projectId)
  }

  // The project this command resolved, and where it came from, without
  // resolving it again.
  get selection(): ResolvedProjectContext | undefined {
    return this.#selection
  }

  async resolve(): Promise<ResolvedProjectContext> {
    const context = await this.resolveOptional()
    if (context !== undefined) {
      return context
    }
    if (
      this.#environmentKey === undefined &&
      (await this.#authRepository.loadMetadata()) === undefined
    ) {
      throw notSignedInError()
    }
    throw projectNotSelected()
  }

  async resolveOptional(): Promise<ResolvedProjectContext | undefined> {
    const context = await this.#resolveOptional()
    if (context !== undefined) {
      this.#selection = context
    }
    return context
  }

  async #resolveOptional(): Promise<ResolvedProjectContext | undefined> {
    if (this.#explicitProjectId !== undefined) {
      return {
        projectId: validateId('project', this.#explicitProjectId, 'Project ID'),
        source: 'flag'
      }
    }
    const fromEnvironment = normalizeEnvironmentProject(
      this.#env.PHOTON_PROJECT_ID
    )
    if (fromEnvironment !== undefined) {
      return { projectId: fromEnvironment, source: 'environment' }
    }
    const folder = await this.#folder.find()
    return folder === undefined
      ? undefined
      : { path: folder.path, projectId: folder.projectId, source: 'folder' }
  }
}
