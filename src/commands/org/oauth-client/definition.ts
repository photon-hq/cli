import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { beta } from '../../beta.ts'
import { runs, skip, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'
import { oauthSecretCommand } from './secret/definition.ts'

type OauthClientListParams = PhotonCommandParams

const clientIdArg = {
  description: 'OAuth client ID',
  parse: idArgument('oauthClient', 'OAuth client ID'),
  type: 'positional'
} as const

const viewArgs = { 'client-id': clientIdArg } as const
const authorizeArgs = {
  'client-id': clientIdArg,
  noBrowser: {
    default: false,
    description: 'Print the authorization URL instead of opening a browser',
    toKebab: true,
    type: 'boolean'
  },
  redirectUri: {
    description: 'Registered redirect URI (defaults to the client default)',
    toKebab: true,
    type: 'string'
  },
  scope: {
    description: 'OAuth scope to request (repeatable)',
    multiple: true,
    type: 'string'
  }
} as const
const createArgs = {
  defaultRedirectUri: {
    description: 'Redirect URI to mark as the default',
    required: true,
    toKebab: true,
    type: 'string'
  },
  description: {
    description: 'OAuth client description',
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'OAuth client name',
    required: true,
    type: 'string'
  },
  redirectUri: {
    description: 'Allowed redirect URI (repeatable)',
    multiple: true,
    required: true,
    toKebab: true,
    type: 'string'
  },
  scope: {
    description: 'Delegated OAuth scope (repeatable)',
    multiple: true,
    type: 'string'
  }
} as const
const updateArgs = {
  clearDescription: {
    conflicts: 'description',
    default: false,
    description: 'Remove the OAuth client description',
    toKebab: true,
    type: 'boolean'
  },
  clearScopes: {
    conflicts: 'scope',
    default: false,
    description: 'Remove every delegated OAuth scope',
    toKebab: true,
    type: 'boolean'
  },
  'client-id': clientIdArg,
  defaultRedirectUri: {
    description: 'Redirect URI to mark as the default',
    toKebab: true,
    type: 'string'
  },
  description: {
    conflicts: 'clearDescription',
    description: 'New OAuth client description',
    type: 'string'
  },
  name: {
    description: 'New OAuth client name',
    type: 'string'
  },
  redirectUri: {
    description: 'Replacement redirect URI (repeatable)',
    multiple: true,
    toKebab: true,
    type: 'string'
  },
  scope: {
    conflicts: 'clearScopes',
    description: 'Replacement delegated OAuth scope (repeatable)',
    multiple: true,
    type: 'string'
  }
} as const
const deleteArgs = {
  'client-id': clientIdArg,
  yes: yesArg
} as const

export type OauthClientViewParams = PhotonCommandParams<typeof viewArgs>
export type OauthClientAuthorizeParams = PhotonCommandParams<
  typeof authorizeArgs
>
export type OauthClientCreateParams = PhotonCommandParams<typeof createArgs>
export type OauthClientUpdateParams = PhotonCommandParams<typeof updateArgs>
export type OauthClientDeleteParams = PhotonCommandParams<typeof deleteArgs>

const listDefinition = defineWithTypes<OauthClientListParams>()({
  description: 'List organization OAuth clients',
  name: 'list'
})
const viewDefinition = defineWithTypes<OauthClientViewParams>()({
  args: viewArgs,
  description: 'View an OAuth client',
  name: 'view'
})
const authorizeDefinition = defineWithTypes<OauthClientAuthorizeParams>()({
  args: authorizeArgs,
  description: 'Open an OAuth authorization request for a client',
  name: 'authorize',
  toKebab: true
})
const createDefinition = defineWithTypes<OauthClientCreateParams>()({
  args: createArgs,
  description: 'Create an OAuth client',
  name: 'create',
  toKebab: true
})
const updateDefinition = defineWithTypes<OauthClientUpdateParams>()({
  args: updateArgs,
  description: 'Update an OAuth client',
  name: 'update',
  toKebab: true
})
const deleteDefinition = defineWithTypes<OauthClientDeleteParams>()({
  args: deleteArgs,
  description: 'Delete an OAuth client',
  name: 'delete'
})

export const oauthClientCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Manage organization OAuth clients',
  name: 'oauth-client',
  subCommands: {
    authorize: tested(
      skip('needs a person to approve the authorization in a browser'),
      beta(
        lazyWithTypes<OauthClientAuthorizeParams>()(
          async () => (await import('./run.ts')).runAuthorize,
          authorizeDefinition
        )
      )
    ),
    create: tested(
      runs,
      lazyWithTypes<OauthClientCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    delete: tested(
      runs,
      lazyWithTypes<OauthClientDeleteParams>()(
        async () => (await import('./run.ts')).runDelete,
        deleteDefinition
      )
    ),
    list: tested(
      runs,
      beta(
        lazyWithTypes<OauthClientListParams>()(
          async () => (await import('./run.ts')).runList,
          listDefinition
        )
      )
    ),
    secret: oauthSecretCommand,
    update: tested(
      runs,
      beta(
        lazyWithTypes<OauthClientUpdateParams>()(
          async () => (await import('./run.ts')).runUpdate,
          updateDefinition
        )
      )
    ),
    view: tested(
      runs,
      beta(
        lazyWithTypes<OauthClientViewParams>()(
          async () => (await import('./run.ts')).runView,
          viewDefinition
        )
      )
    )
  },
  toKebab: true
})
