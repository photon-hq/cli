import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../core/photon-id.ts'
import { yesArg } from '../args.ts'
import { runs, skip, tested } from '../production-test.ts'
import type { PhotonCommandParams } from '../types.ts'

type OperationParams = PhotonCommandParams

const operationIdArg = {
  description: 'Local operation ID',
  parse: idArgument('localOperation', 'Operation ID'),
  type: 'positional'
} as const

const listArgs = {
  limit: {
    default: 30,
    description: 'Maximum number of operations to return',
    type: 'number'
  },
  pageToken: {
    description: 'Start listing after this pagination token',
    toKebab: true,
    type: 'string'
  },
  status: {
    choices: ['awaiting-output-ack', 'failed', 'outcome-unknown'],
    description: 'Only include this status (repeatable)',
    multiple: true,
    type: 'enum'
  }
} as const

const viewArgs = { 'operation-id': operationIdArg } as const
const replayArgs = {
  'operation-id': operationIdArg,
  yes: yesArg
} as const
const removeArgs = {
  'operation-id': operationIdArg,
  yes: yesArg
} as const

export type OperationListParams = PhotonCommandParams<typeof listArgs>
export type OperationViewParams = PhotonCommandParams<typeof viewArgs>
export type OperationReplayParams = PhotonCommandParams<typeof replayArgs>
export type OperationRemoveParams = PhotonCommandParams<typeof removeArgs>

const listDefinition = defineWithTypes<OperationListParams>()({
  args: listArgs,
  description: 'List unresolved local operations',
  name: 'list',
  toKebab: true
})

const viewDefinition = defineWithTypes<OperationViewParams>()({
  args: viewArgs,
  description: 'Inspect a local operation',
  name: 'view'
})

const replayDefinition = defineWithTypes<OperationReplayParams>()({
  args: replayArgs,
  description: 'Safely replay an unresolved operation',
  name: 'replay',
  toKebab: true
})

const removeDefinition = defineWithTypes<OperationRemoveParams>()({
  args: removeArgs,
  description: 'Remove a local operation record',
  name: 'remove'
})

export const operationCommand = defineWithTypes<OperationParams>()({
  description: 'Inspect and recover local operations',
  name: 'operation',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<OperationListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    remove: tested(
      skip(
        'needs an unresolved operation, which only an interrupted write leaves (ENG-3927)'
      ),
      lazyWithTypes<OperationRemoveParams>()(
        async () => (await import('./run.ts')).runRemove,
        removeDefinition
      )
    ),
    replay: tested(
      skip(
        'needs an unresolved operation, which only an interrupted write leaves (ENG-3927)'
      ),
      lazyWithTypes<OperationReplayParams>()(
        async () => (await import('./run.ts')).runReplay,
        replayDefinition
      )
    ),
    view: tested(
      skip(
        'needs an unresolved operation, which only an interrupted write leaves (ENG-3927)'
      ),
      lazyWithTypes<OperationViewParams>()(
        async () => (await import('./run.ts')).runView,
        viewDefinition
      )
    )
  }
})
