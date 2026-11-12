import {
  type EnvironmentKey,
  environmentKeyIdentity
} from '../auth/environment-key.ts'
import { notSignedInError } from '../auth/errors.ts'
import type { AuthRepository } from '../auth/storage/repository.ts'
import { authIdentityDescriptor } from '../auth/types.ts'
import { CliError } from '../core/errors.ts'
import { validateId } from '../core/photon-id.ts'
import { CLI_NAME } from '../meta.ts'
import type { ProjectFolderRepository } from '../project/folder-repository.ts'
import type { OrganizationContextRepository } from './context-repository.ts'

// "folder" is the organization of the project in the nearest
// .photon/project.json, and "stored" the one "org use" saved for the account.
// "default" is the account's only organization. An account credential cannot
// read Photon's "current organization" (that route accepts organization
// credentials only), so the default comes from the organizations the account
// can list, and only when there is exactly one.
export type ResolvedOrganizationContext =
  | { organizationId: string; path: string; source: 'folder' }
  | {
      organizationId: string
      source: 'default' | 'environment' | 'flag' | 'stored'
    }

export type OrganizationContextSource = ResolvedOrganizationContext['source']

interface OrganizationContextServiceOptions {
  authRepository: AuthRepository
  env?: NodeJS.ProcessEnv
  /**
   * The run's key from the environment. It outranks the stored sign-in, and
   * `org use` saves its choice under the key's public ID.
   */
  environmentKey?: EnvironmentKey
  explicitOrganizationId?: string
  folder: ProjectFolderRepository
  listOrganizationIds: () => Promise<string[]>
  now?: () => number
  repository: OrganizationContextRepository
}

const organizationNotSelected = (count: number): CliError =>
  new CliError(
    'ORGANIZATION_NOT_SELECTED',
    count === 0
      ? 'Your account does not belong to any organization.'
      : 'Your account belongs to several organizations, and none is selected.',
    {
      exitCode: 2,
      next:
        count === 0
          ? [
              {
                description: 'Accept an organization invitation',
                run: `${CLI_NAME} org invitation accept`
              }
            ]
          : [
              {
                description: 'List your organizations',
                run: `${CLI_NAME} org list`
              },
              {
                description: `Select one with "${CLI_NAME} org use <organization-id>", or pass --org <organization-id>.`
              }
            ]
    }
  )

export class OrganizationContextService {
  readonly #authRepository: AuthRepository
  readonly #environmentKey: EnvironmentKey | undefined
  readonly #env: NodeJS.ProcessEnv
  readonly #explicitOrganizationId: string | undefined
  readonly #folder: ProjectFolderRepository
  readonly #listOrganizationIds: () => Promise<string[]>
  readonly #now: () => number
  readonly #repository: OrganizationContextRepository
  #resolved: Promise<ResolvedOrganizationContext> | undefined
  #selection: ResolvedOrganizationContext | undefined

  constructor(options: OrganizationContextServiceOptions) {
    this.#authRepository = options.authRepository
    this.#environmentKey = options.environmentKey
    this.#env = options.env ?? process.env
    this.#explicitOrganizationId = options.explicitOrganizationId
    this.#folder = options.folder
    this.#listOrganizationIds = options.listOrganizationIds
    this.#now = options.now ?? Date.now
    this.#repository = options.repository
  }

  async activate(organizationId: string): Promise<void> {
    this.#resolved = undefined
    await this.#repository.save(
      await this.#identityId(),
      validateId('organization', organizationId, 'Organization ID'),
      new Date(this.#now()).toISOString()
    )
  }

  async clear(): Promise<boolean> {
    this.#resolved = undefined
    return await this.#repository.clear(await this.#identityId())
  }

  async clearIfActive(organizationId: string): Promise<boolean> {
    const identityId = await this.#optionalIdentityId()
    if (identityId === undefined) {
      return false
    }
    const stored = await this.#repository.load(identityId)
    if (stored?.organizationId !== organizationId) {
      return false
    }
    this.#resolved = undefined
    return await this.#repository.clear(identityId)
  }

  // One command resolves the organization once, even when several requests
  // need it.
  async resolve(): Promise<ResolvedOrganizationContext> {
    this.#resolved ??= this.#resolve()
    try {
      this.#selection = await this.#resolved
      return this.#selection
    } catch (error) {
      this.#resolved = undefined
      throw error
    }
  }

  // The organization this command resolved, and where it came from, without
  // resolving it again (which can cost a request for the default).
  get selection(): ResolvedOrganizationContext | undefined {
    return this.#selection
  }

  // For "org list": the listed organizations supply the default, and a
  // selection that cannot be resolved (none, several, or a corrupt stored
  // context) leaves nothing marked active instead of failing the listing.
  async resolveAmong(
    organizationIds: readonly string[]
  ): Promise<ResolvedOrganizationContext | undefined> {
    try {
      return await this.#resolve(() => Promise.resolve([...organizationIds]))
    } catch {
      // No organization can be marked active; the listing still succeeds.
    }
  }

  async #resolve(
    listOrganizationIds: () => Promise<string[]> = this.#listOrganizationIds
  ): Promise<ResolvedOrganizationContext> {
    const fromFlag = this.fromFlag()
    if (fromFlag !== undefined) {
      return fromFlag
    }
    const outranking = await this.outranking()
    if (outranking !== undefined) {
      return outranking
    }
    const stored = await this.#repository.load(await this.#identityId())
    if (stored !== undefined) {
      return { organizationId: stored.organizationId, source: 'stored' }
    }
    const organizationIds = await listOrganizationIds()
    const [onlyOrganizationId] = organizationIds
    if (organizationIds.length !== 1 || onlyOrganizationId === undefined) {
      throw organizationNotSelected(organizationIds.length)
    }
    return { organizationId: onlyOrganizationId, source: 'default' }
  }

  // The organization --org names, and nothing below it, so it never costs a
  // request. "link" checks it against the project it saves.
  fromFlag(): ResolvedOrganizationContext | undefined {
    return this.#explicitOrganizationId === undefined
      ? undefined
      : {
          organizationId: validateId(
            'organization',
            this.#explicitOrganizationId,
            'Organization ID'
          ),
          source: 'flag'
        }
  }

  // The selection that outranks "org use": PHOTON_ORGANIZATION_ID, then the
  // organization of the folder's project.
  async outranking(): Promise<ResolvedOrganizationContext | undefined> {
    const fromEnvironment = this.#env.PHOTON_ORGANIZATION_ID?.trim()
    if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
      return {
        organizationId: validateId(
          'organization',
          fromEnvironment,
          'PHOTON_ORGANIZATION_ID'
        ),
        source: 'environment'
      }
    }
    const folder = await this.#folder.find()
    return folder === undefined
      ? undefined
      : {
          organizationId: folder.organizationId,
          path: folder.path,
          source: 'folder'
        }
  }

  async #identityId(): Promise<string> {
    const identityId = await this.#optionalIdentityId()
    if (identityId === undefined) {
      throw notSignedInError()
    }
    return identityId
  }

  async #optionalIdentityId(): Promise<string | undefined> {
    if (this.#environmentKey !== undefined) {
      return environmentKeyIdentity(this.#environmentKey)
    }
    const metadata = await this.#authRepository.loadMetadata()
    return metadata === undefined
      ? undefined
      : authIdentityDescriptor(metadata).publicId
  }
}
