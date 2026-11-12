import type { CliOutput } from '../core/output.ts'
import { inert } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import type { OperationIntent } from '../operation/types.ts'
import type {
  OrganizationContextService,
  ResolvedOrganizationContext
} from '../organization/context-service.ts'
import type {
  ProjectContextService,
  ResolvedProjectContext
} from '../project/context-service.ts'
import type { ProjectService } from '../project/service.ts'

type ContextSelection =
  | ({ kind: 'organization' } & ResolvedOrganizationContext)
  | ({ kind: 'project' } & ResolvedProjectContext)

// Where a command's project or organization came from, as the "Project: …"
// and "Organization: …" lines name it: a folder's selection is the path of
// its .photon/project.json.
export const contextSourceLabel = (selection: ContextSelection): string => {
  switch (selection.source) {
    case 'default':
      return 'your only organization'
    case 'environment':
      return selection.kind === 'project'
        ? 'PHOTON_PROJECT_ID'
        : 'PHOTON_ORGANIZATION_ID'
    case 'flag':
      return selection.kind === 'project' ? '--project' : '--org'
    case 'folder':
      return selection.path
    case 'stored':
      return `the organization saved with ${CLI_NAME} org use`
    default:
      return selection satisfies never
  }
}

interface TargetNoticeOptions {
  organizationContext: OrganizationContextService
  output: CliOutput
  projectContext: ProjectContextService
  projects: ProjectService
}

// Names the project and organization a command acts on, and where each came
// from, on stderr: once per target, before a confirmation question or the
// first write request, whichever comes first.
export class TargetNotice {
  readonly #announced = new Set<string>()
  readonly #organizationContext: OrganizationContextService
  readonly #output: CliOutput
  readonly #projectContext: ProjectContextService
  readonly #projects: ProjectService

  constructor(options: TargetNoticeOptions) {
    this.#organizationContext = options.organizationContext
    this.#output = options.output
    this.#projectContext = options.projectContext
    this.#projects = options.projects
  }

  // A question names its target whatever the source, --project and --org
  // included.
  beforeQuestion(): void {
    const project = this.#projectContext.selection
    if (project !== undefined) {
      this.#announceProject(project)
    }
    const organization = this.#organizationContext.selection
    if (organization !== undefined) {
      this.#announceOrganization(organization)
    }
  }

  // A write names its target unless --project or --org already did.
  beforeWrite(intent: OperationIntent): void {
    const project = this.#projectContext.selection
    if (
      project !== undefined &&
      project.source !== 'flag' &&
      'projectId' in intent &&
      intent.projectId === project.projectId
    ) {
      this.#announceProject(project)
    }
    const organization = this.#organizationContext.selection
    if (
      organization !== undefined &&
      organization.source !== 'flag' &&
      'organizationId' in intent &&
      intent.organizationId === organization.organizationId
    ) {
      this.#announceOrganization(organization)
    }
  }

  #announceProject(selection: ResolvedProjectContext): void {
    if (!this.#firstTime(`project:${selection.projectId}`)) {
      return
    }
    const loaded = this.#projects.loaded(selection.projectId)
    const from = contextSourceLabel({ kind: 'project', ...selection })
    this.#output.progress(
      inert(
        loaded === undefined
          ? `Project: ${selection.projectId}, from ${from}`
          : `Project: ${loaded.name} (${selection.projectId}), organization ${loaded.organizationId}, from ${from}`
      )
    )
  }

  #announceOrganization(selection: ResolvedOrganizationContext): void {
    if (!this.#firstTime(`organization:${selection.organizationId}`)) {
      return
    }
    const from = contextSourceLabel({ kind: 'organization', ...selection })
    this.#output.progress(
      inert(`Organization: ${selection.organizationId}, from ${from}`)
    )
  }

  #firstTime(key: string): boolean {
    if (this.#announced.has(key)) {
      return false
    }
    this.#announced.add(key)
    return true
  }
}
