import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { internalCommands } from '#internal'
import { idArgument } from '../../core/photon-id.ts'
import { CLI_NAME } from '../../meta.ts'
import { idempotencyKeyArg, yesArg } from '../args.ts'
import { runs, tested } from '../production-test.ts'
import type { PhotonCommandParams } from '../types.ts'
import { agentProfileCommand } from './agent-profile/definition.ts'
import { apiKeyCommand } from './api-key/definition.ts'
import { paginationArgs, projectFilterArgs } from './args.ts'
import { billingCommand } from './billing/definition.ts'
import { platformCommand } from './platform/definition.ts'
import { webhookCommand } from './webhook/definition.ts'

type ProjectParams = PhotonCommandParams
type ProjectViewParams = PhotonCommandParams
type ProjectCurrentParams = PhotonCommandParams
type ProjectClearParams = PhotonCommandParams

const listArgs = { ...projectFilterArgs, ...paginationArgs } as const
const countArgs = { ...projectFilterArgs } as const
const createArgs = {
  idempotencyKey: idempotencyKeyArg,
  link: {
    default: false,
    description: 'Save the new project for this folder',
    type: 'boolean'
  },
  name: {
    description: 'Project name',
    required: true,
    type: 'string'
  },
  slug: {
    description:
      'Unique project slug (3–63 lowercase letters, digits, and hyphens)',
    required: true,
    type: 'string'
  },
  use: {
    default: false,
    description: 'Old name of --link',
    hidden: true,
    type: 'boolean'
  }
} as const
const editArgs = {
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'New project name',
    required: true,
    type: 'string'
  }
} as const
const deleteArgs = {
  'project-id': {
    description: 'Project ID to delete',
    parse: idArgument('project', 'Project ID'),
    type: 'positional'
  },
  yes: yesArg
} as const
const useArgs = {
  'project-id': {
    description: 'Project ID to save for this folder',
    parse: idArgument('project', 'Project ID'),
    type: 'positional'
  }
} as const

export type ProjectListParams = PhotonCommandParams<typeof listArgs>
export type ProjectCountParams = PhotonCommandParams<typeof countArgs>
export type ProjectCreateParams = PhotonCommandParams<typeof createArgs>
export type ProjectEditParams = PhotonCommandParams<typeof editArgs>
export type ProjectDeleteParams = PhotonCommandParams<typeof deleteArgs>
export type ProjectUseParams = PhotonCommandParams<typeof useArgs>

const listDefinition = defineWithTypes<ProjectListParams>()({
  args: listArgs,
  description: 'List projects in the current organization',
  name: 'list',
  toKebab: true
})
const countDefinition = defineWithTypes<ProjectCountParams>()({
  args: countArgs,
  description: 'Count projects in the current organization',
  name: 'count',
  toKebab: true
})
const createDefinition = defineWithTypes<ProjectCreateParams>()({
  args: createArgs,
  description: 'Create a project in the current organization',
  name: 'create'
})
const viewDefinition = defineWithTypes<ProjectViewParams>()({
  description: 'View the current project',
  name: 'view'
})
const editDefinition = defineWithTypes<ProjectEditParams>()({
  args: editArgs,
  description: 'Edit the current project',
  name: 'edit'
})
const deleteDefinition = defineWithTypes<ProjectDeleteParams>()({
  args: deleteArgs,
  description: 'Delete a project',
  name: 'delete'
})
const currentDefinition = defineWithTypes<ProjectCurrentParams>()({
  description: 'Show the effective project and selection source',
  name: 'current'
})
const useDefinition = defineWithTypes<ProjectUseParams>()({
  args: useArgs,
  description: `Old name of "${CLI_NAME} link"`,
  internal: true,
  name: 'use'
})
const clearDefinition = defineWithTypes<ProjectClearParams>()({
  description: `Old name of "${CLI_NAME} unlink"`,
  internal: true,
  name: 'clear'
})

export const projectCommand = defineWithTypes<ProjectParams>()({
  description: 'Manage Photon projects',
  name: 'project',
  subCommands: {
    ...internalCommands.project,
    'agent-profile': agentProfileCommand,
    'api-key': apiKeyCommand,
    billing: billingCommand,
    clear: tested(
      runs,
      lazyWithTypes<ProjectClearParams>()(
        async () => (await import('./run.ts')).runClear,
        clearDefinition
      )
    ),
    count: tested(
      runs,
      lazyWithTypes<ProjectCountParams>()(
        async () => (await import('./run.ts')).runCount,
        countDefinition
      )
    ),
    create: tested(
      runs,
      lazyWithTypes<ProjectCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    current: tested(
      runs,
      lazyWithTypes<ProjectCurrentParams>()(
        async () => (await import('./run.ts')).runCurrent,
        currentDefinition
      )
    ),
    delete: tested(
      runs,
      lazyWithTypes<ProjectDeleteParams>()(
        async () => (await import('./run.ts')).runDelete,
        deleteDefinition
      )
    ),
    edit: tested(
      runs,
      lazyWithTypes<ProjectEditParams>()(
        async () => (await import('./run.ts')).runEdit,
        editDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<ProjectListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    platform: platformCommand,
    use: tested(
      runs,
      lazyWithTypes<ProjectUseParams>()(
        async () => (await import('./run.ts')).runUse,
        useDefinition
      )
    ),
    view: tested(
      runs,
      lazyWithTypes<ProjectViewParams>()(
        async () => (await import('./run.ts')).runView,
        viewDefinition
      )
    ),
    webhook: webhookCommand
  },
  toKebab: true
})
