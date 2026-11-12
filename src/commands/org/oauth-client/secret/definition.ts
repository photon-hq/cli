import { defineWithTypes, lazyWithTypes } from 'gunshi'
import {
  argumentValidationError,
  type CliError
} from '../../../../core/errors.ts'
import { idArgument } from '../../../../core/photon-id.ts'
import { CLI_NAME } from '../../../../meta.ts'
import { idempotencyKeyArg, yesArg } from '../../../args.ts'
import { runs, tested } from '../../../production-test.ts'
import type { PhotonCommandParams } from '../../../types.ts'

const clientIdArg = {
  description: 'OAuth client ID',
  parse: idArgument('oauthClient', 'OAuth client ID'),
  type: 'positional'
} as const

const viewArgs = { 'client-id': clientIdArg } as const
const createArgs = {
  'client-id': clientIdArg,
  idempotencyKey: idempotencyKeyArg
} as const
const rotateArgs = {
  'client-id': clientIdArg,
  emergency: {
    description: 'Stop the current secret now instead of in one hour',
    type: 'boolean'
  },
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const
// One error for every secret ID given, so several are reported as one is.
export const ONE_SECRET_ERROR: CliError = argumentValidationError(
  'An OAuth client has one secret, so secret revoke takes only the client ID, not a secret ID.',
  {
    next: [
      {
        description: 'See the secret',
        run: `${CLI_NAME} org oauth-client secret view <client-id>`
      },
      {
        description: 'Revoke it',
        run: `${CLI_NAME} org oauth-client secret revoke <client-id>`
      }
    ]
  }
)

const revokeArgs = {
  'client-id': clientIdArg,
  'secret-id': {
    description: 'Not taken: an OAuth client has one secret',
    hidden: true,
    multiple: true,
    parse: (): never => {
      throw ONE_SECRET_ERROR
    },
    required: false,
    type: 'positional'
  },
  yes: yesArg
} as const

export type OauthSecretViewParams = PhotonCommandParams<typeof viewArgs>
export type OauthSecretCreateParams = PhotonCommandParams<typeof createArgs>
export type OauthSecretRotateParams = PhotonCommandParams<typeof rotateArgs>
export type OauthSecretRevokeParams = PhotonCommandParams<typeof revokeArgs>

const viewDefinition = defineWithTypes<OauthSecretViewParams>()({
  args: viewArgs,
  description: "View the OAuth client's secret metadata",
  name: 'view'
})
const createDefinition = defineWithTypes<OauthSecretCreateParams>()({
  args: createArgs,
  description: "Create the OAuth client's first secret",
  name: 'create'
})
const rotateDefinition = defineWithTypes<OauthSecretRotateParams>()({
  args: rotateArgs,
  description: "Replace the OAuth client's secret with a new one",
  name: 'rotate'
})
const revokeDefinition = defineWithTypes<OauthSecretRevokeParams>()({
  args: revokeArgs,
  description: "Revoke the OAuth client's secret",
  name: 'revoke'
})

export const oauthSecretCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Manage the OAuth client secret',
  name: 'secret',
  subCommands: {
    create: tested(
      runs,
      lazyWithTypes<OauthSecretCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    revoke: tested(
      runs,
      lazyWithTypes<OauthSecretRevokeParams>()(
        async () => (await import('./run.ts')).runRevoke,
        revokeDefinition
      )
    ),
    rotate: tested(
      runs,
      lazyWithTypes<OauthSecretRotateParams>()(
        async () => (await import('./run.ts')).runRotate,
        rotateDefinition
      )
    ),
    view: tested(
      runs,
      lazyWithTypes<OauthSecretViewParams>()(
        async () => (await import('./run.ts')).runView,
        viewDefinition
      )
    )
  },
  toKebab: true
})
