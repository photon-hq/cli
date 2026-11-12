import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../../core/photon-id.ts'
import { yesArg } from '../../../args.ts'
import { runs, skip, tested } from '../../../production-test.ts'
import { paginationArgs } from '../../../project/args.ts'
import type { PhotonCommandParams } from '../../../types.ts'

const listArgs = {
  after: {
    conflicts: 'before',
    description: 'Old name of --page-token',
    hidden: true,
    type: 'string'
  },
  before: {
    conflicts: 'pageToken',
    description: 'List the page before this pagination token',
    type: 'string'
  },
  limit: paginationArgs.limit,
  order: {
    choices: ['normal', 'desc', 'asc'],
    description: 'Connection sort order',
    type: 'enum'
  },
  pageToken: { ...paginationArgs.pageToken, conflicts: 'after' }
} as const

const revokeArgs = {
  'application-id': {
    description: 'Connected OAuth application ID',
    parse: idArgument('oauthApplication', 'OAuth application ID'),
    type: 'positional'
  },
  yes: yesArg
} as const

export type OauthConnectionListParams = PhotonCommandParams<typeof listArgs>
export type OauthConnectionRevokeParams = PhotonCommandParams<typeof revokeArgs>

const listDefinition = defineWithTypes<OauthConnectionListParams>()({
  args: listArgs,
  description: 'List OAuth applications connected to this account',
  name: 'list'
})

const revokeDefinition = defineWithTypes<OauthConnectionRevokeParams>()({
  args: revokeArgs,
  description: 'Revoke a connected OAuth application',
  name: 'revoke'
})

export const oauthConnectionCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Manage applications connected to this account',
  name: 'connection',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<OauthConnectionListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    revoke: tested(
      skip('needs an OAuth connection, which a person authorizes in a browser'),
      lazyWithTypes<OauthConnectionRevokeParams>()(
        async () => (await import('./run.ts')).runRevoke,
        revokeDefinition
      )
    )
  },
  toKebab: true
})
