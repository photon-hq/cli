import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { runs, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

export type ServiceKeyListParams = PhotonCommandParams

const createArgs = {
  expiresAt: {
    conflicts: 'noExpiry',
    description: 'RFC 3339 expiration timestamp',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'Descriptive account service key name',
    required: true,
    type: 'string'
  },
  noExpiry: {
    conflicts: 'expiresAt',
    default: false,
    description: 'Create a key that does not expire',
    toKebab: true,
    type: 'boolean'
  }
} as const

const revokeArgs = {
  idempotencyKey: idempotencyKeyArg,
  'service-key-id': {
    description: 'Canonical account service key ID to revoke',
    parse: idArgument('accountServiceKey', 'Service key ID'),
    type: 'positional'
  },
  yes: yesArg
} as const

export type ServiceKeyCreateParams = PhotonCommandParams<typeof createArgs>
export type ServiceKeyRevokeParams = PhotonCommandParams<typeof revokeArgs>

const listDefinition = defineWithTypes<ServiceKeyListParams>()({
  description: 'List unrevoked account service keys',
  name: 'list'
})

const createDefinition = defineWithTypes<ServiceKeyCreateParams>()({
  args: createArgs,
  description: 'Create an account service key',
  name: 'create',
  toKebab: true
})

const revokeDefinition = defineWithTypes<ServiceKeyRevokeParams>()({
  args: revokeArgs,
  description: 'Revoke an account service key',
  name: 'revoke',
  toKebab: true
})

export const serviceKeyCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Manage account service keys',
  name: 'service-key',
  subCommands: {
    create: tested(
      runs,
      lazyWithTypes<ServiceKeyCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<ServiceKeyListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    revoke: tested(
      runs,
      lazyWithTypes<ServiceKeyRevokeParams>()(
        async () => (await import('./run.ts')).runRevoke,
        revokeDefinition
      )
    )
  },
  toKebab: true
})
