import type { GetProjectOutput } from '@photon-ai/api'
import type { CommandRunner } from 'gunshi'
import { detail, inert, presentList, table } from '../../core/presenter.ts'
import { resolveOrganizationId } from '../../organization/command-helpers.ts'
import { validateProjectSlug } from '../../project/api-contract.ts'
import type { SavedProjectContext } from '../../project/context-service.ts'
import {
  validatePagination,
  validateProjectFilters,
  validateProjectName
} from '../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../helpers.ts'
import {
  linkProject,
  savedProjectJson,
  savedProjectLines
} from '../link/run.ts'
import { renamedWarning } from '../moved.ts'
import type { PhotonCommandParams } from '../types.ts'
import { unlinkProject } from '../unlink/run.ts'
import type {
  ProjectCountParams,
  ProjectCreateParams,
  ProjectDeleteParams,
  ProjectEditParams,
  ProjectListParams,
  ProjectUseParams
} from './definition.ts'

type ProjectViewParams = PhotonCommandParams
type ProjectCurrentParams = PhotonCommandParams
type ProjectClearParams = PhotonCommandParams

const projectDetails = (
  output: ProjectViewParams['extensions']['photon']['output'],
  project: GetProjectOutput,
  heading = 'Project'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: project.name },
    { label: 'ID', value: project.projectId },
    { label: 'Slug', value: project.slug },
    { label: 'Organization', value: project.organizationId },
    { label: 'Created', value: project.createdAt },
    { label: 'Updated', value: project.updatedAt },
    { label: 'Deleted', value: project.deletedAt }
  ])

const filterValues = (values: {
  createdAfter?: string
  createdBefore?: string
  search?: string
}) =>
  validateProjectFilters({
    ...(values.createdAfter === undefined
      ? {}
      : { createdAfter: values.createdAfter }),
    ...(values.createdBefore === undefined
      ? {}
      : { createdBefore: values.createdBefore }),
    ...(values.search === undefined ? {} : { search: values.search })
  })

export const runList: CommandRunner<ProjectListParams> = async (context) => {
  const { photon } = context.extensions
  const pagination = validatePagination(
    context.values.limit,
    context.values.pageToken
  )
  const organizationId = await resolveOrganizationId(photon)
  const result = await photon.projects.list(
    organizationId,
    filterValues(context.values),
    pagination
  )
  const active = await photon.projectContext.resolveOptional()
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No projects found.',
    items: result.projects,
    lines: table(
      photon.output,
      ['NAME', 'ID', 'SLUG', 'ACTIVE', 'UPDATED'],
      result.projects.map((project) => [
        project.name,
        { style: 'cyan', text: project.projectId },
        project.slug,
        active?.projectId === project.projectId
          ? { style: 'yellow', text: '*' }
          : '',
        { style: 'dim', text: project.updatedAt }
      ])
    ),
    page: {
      command: context,
      inDocument: true,
      scope: { org: organizationId },
      token: result.nextPageToken
    }
  })
}

export const runCount: CommandRunner<ProjectCountParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.projects.count(
    await resolveOrganizationId(photon),
    filterValues(context.values)
  )
  photon.output.success(
    result,
    `${result.count.toString()} project${result.count === 1 ? '' : 's'}`
  )
}

export const runCreate: CommandRunner<ProjectCreateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const usedOldFlag = context.values.use ?? false
  if (usedOldFlag) {
    photon.output.warning(
      renamedWarning(
        ['project', 'create', '--use'],
        ['project', 'create', '--link']
      )
    )
  }
  const link = (context.values.link ?? false) || usedOldFlag
  const name = validateProjectName(context.values.name)
  const slug = validateProjectSlug(context.values.slug)
  const organizationId = await resolveOrganizationId(photon)
  const { result } = await photon.operations.execute(
    {
      activate: link,
      kind: 'project.create',
      name,
      organizationId,
      slug
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.create(organizationId, name, slug, idempotencyKey)
  )
  let saved: SavedProjectContext | undefined
  if (link) {
    try {
      saved = await photon.projectContext.activate(result)
    } catch {
      photon.output.warning(
        'The project was created, but Photon could not save it for this folder.'
      )
    }
  }
  photon.output.success(
    link
      ? {
          project: result,
          ...(saved === undefined ? {} : savedProjectJson(saved))
        }
      : result,
    [
      photon.output.style('green', inert(`Created project ${result.name}.`)),
      ...projectDetails(photon.output, result),
      ...(saved === undefined ? [] : savedProjectLines(photon, saved))
    ]
  )
}

export const runView: CommandRunner<ProjectViewParams> = async (context) => {
  const { photon } = context.extensions
  const selected = await photon.projectContext.resolve()
  const project = await photon.projects.get(selected.projectId)
  photon.output.success(project, projectDetails(photon.output, project))
}

export const runEdit: CommandRunner<ProjectEditParams> = async (context) => {
  const { photon } = context.extensions
  const selected = await photon.projectContext.resolve()
  const name = validateProjectName(context.values.name)
  const { result: project } = await photon.operations.execute(
    { kind: 'project.update', name, projectId: selected.projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.update(selected.projectId, name, idempotencyKey)
  )
  photon.output.success(project, [
    photon.output.style('green', inert(`Updated project ${project.name}.`)),
    ...projectDetails(photon.output, project)
  ])
}

export const runDelete: CommandRunner<ProjectDeleteParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = context.values['project-id']
  const projectBeforeDelete = await photon.projects.get(projectId)
  const confirmed = await confirmRiskyAction(context, {
    action: `delete project "${projectBeforeDelete.name}" (${projectId})`,
    typed: projectBeforeDelete.name
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result: project } = await photon.operations.execute(
    { kind: 'project.delete', projectId },
    undefined,
    async () => await photon.projects.delete(projectId)
  )
  try {
    await photon.projectContext.clearIfActive(projectId)
  } catch {
    photon.output.warning(
      'The project was deleted, but Photon could not remove the .photon/project.json that names it.'
    )
  }
  photon.output.success(
    project,
    photon.output.style('green', inert(`Deleted project ${project.name}.`))
  )
}

export const runCurrent: CommandRunner<ProjectCurrentParams> = async (
  context
) => {
  const { photon } = context.extensions
  const selected = await photon.projectContext.resolve()
  const project = await photon.projects.get(selected.projectId)
  photon.output.success(
    {
      project,
      source: selected.source,
      ...(selected.source === 'folder' ? { path: selected.path } : {})
    },
    [
      ...projectDetails(photon.output, project, 'Current project'),
      ...detail(photon.output, 'Selection', [
        { label: 'Source', value: selected.source },
        ...(selected.source === 'folder'
          ? [{ label: 'File', value: selected.path }]
          : [])
      ]).slice(1)
    ]
  )
}

export const runUse: CommandRunner<ProjectUseParams> = async (context) => {
  const { photon } = context.extensions
  const projectId = context.values['project-id']
  photon.output.warning(
    renamedWarning(['project', 'use'], ['link', '--project', projectId])
  )
  await linkProject(photon, projectId, context)
}

export const runClear: CommandRunner<ProjectClearParams> = async (context) => {
  const { photon } = context.extensions
  photon.output.warning(renamedWarning(['project', 'clear'], ['unlink']))
  await unlinkProject(photon)
}
