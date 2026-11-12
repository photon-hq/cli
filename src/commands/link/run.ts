import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../app/services.ts'
import { CliError } from '../../core/errors.ts'
import { inert, type TypedCommand, typedCommand } from '../../core/presenter.ts'
import type { SavedProjectContext } from '../../project/context-service.ts'
import type { LinkParams } from './definition.ts'

// What link and project create --link say after saving the folder's file.
export const savedProjectLines = (
  photon: PhotonCommandServices,
  saved: SavedProjectContext
): string[] => {
  if (saved.gitignore === 'failed') {
    photon.output.warning('Photon could not add .photon/ to .gitignore.')
  }
  return [
    `Saved to ${saved.path}.`,
    ...(saved.gitignore === 'added' ? ['Added .photon/ to .gitignore.'] : [])
  ]
}

export const savedProjectJson = (saved: SavedProjectContext) => ({
  gitignore: saved.gitignore,
  path: saved.path,
  source: 'folder' as const
})

// The file saves the project's own organization, so an --org that names
// another one would be dropped without a word: link refuses it instead, as
// Neon's link refuses a mismatched --org-id. PHOTON_ORGANIZATION_ID and
// "org use" are defaults rather than a choice for this project, so only --org
// is checked.
const organizationMismatch = (
  project: { name: string; organizationId: string; projectId: string },
  requestedOrganizationId: string,
  typed: TypedCommand
): CliError =>
  new CliError(
    'ORGANIZATION_MISMATCH',
    `Project ${project.name} (${project.projectId}) belongs to organization ${project.organizationId}, not ${requestedOrganizationId}.`,
    {
      exitCode: 2,
      next: [
        {
          description: 'Run it without --org',
          run: typedCommand(typed, { without: ['org'] })
        },
        {
          description: "Run it with the project's organization",
          run: typedCommand(typed, {
            add: `--org ${project.organizationId}`,
            without: ['org']
          })
        }
      ]
    }
  )

export const linkProject = async (
  photon: PhotonCommandServices,
  projectId: string,
  typed: TypedCommand
): Promise<void> => {
  const project = await photon.projects.get(projectId)
  const requested = photon.organizationContext.fromFlag()?.organizationId
  if (requested !== undefined && requested !== project.organizationId) {
    throw organizationMismatch(project, requested, typed)
  }
  const saved = await photon.projectContext.activate(project)
  photon.output.success({ project, ...savedProjectJson(saved) }, [
    photon.output.style(
      'green',
      inert(
        `Linked this folder to project ${project.name} (${project.projectId}).`
      )
    ),
    ...savedProjectLines(photon, saved)
  ])
}

export const run: CommandRunner<LinkParams> = async (context) => {
  await linkProject(context.extensions.photon, context.values.project, context)
}
