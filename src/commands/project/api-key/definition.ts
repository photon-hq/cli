import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { apiKeyIdArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { runs, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

export type ApiKeyListParams = PhotonCommandParams

const createArgs = {
  expiresAt: {
    conflicts: 'noExpiry',
    description: 'RFC 3339 expiration timestamp',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'Descriptive API key name',
    required: true,
    type: 'string'
  },
  noExpiry: {
    conflicts: 'expiresAt',
    default: false,
    description: 'Create a key that does not expire',
    toKebab: true,
    type: 'boolean'
  },
  permission: {
    description: 'Permission to grant (repeatable)',
    multiple: true,
    required: true,
    type: 'string'
  }
} as const

const revokeArgs = {
  'api-key-id': {
    description: 'API key ID to revoke',
    parse: apiKeyIdArgument,
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const

export type ApiKeyCreateParams = PhotonCommandParams<typeof createArgs>
export type ApiKeyRevokeParams = PhotonCommandParams<typeof revokeArgs>

const listDefinition = defineWithTypes<ApiKeyListParams>()({
  description: 'List live project API keys',
  name: 'list'
})

const createDefinition = defineWithTypes<ApiKeyCreateParams>()({
  args: createArgs,
  description: 'Create a project API key',
  name: 'create',
  toKebab: true
})

const revokeDefinition = defineWithTypes<ApiKeyRevokeParams>()({
  args: revokeArgs,
  description: 'Revoke a project API key',
  name: 'revoke',
  toKebab: true
})

export const apiKeyCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Manage project API keys',
  name: 'api-key',
  subCommands: {
    create: tested(
      runs,
      lazyWithTypes<ApiKeyCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<ApiKeyListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    revoke: tested(
      runs,
      lazyWithTypes<ApiKeyRevokeParams>()(
        async () => (await import('./run.ts')).runRevoke,
        revokeDefinition
      )
    )
  },
  toKebab: true
})
