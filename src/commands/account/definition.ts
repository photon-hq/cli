import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { internalCommands } from '#internal'
import { idempotencyKeyArg, yesArg } from '../args.ts'
import { runs, skip, tested } from '../production-test.ts'
import type { PhotonCommandParams } from '../types.ts'
import { oauthCommand } from './oauth/definition.ts'
import { serviceKeyCommand } from './service-key/definition.ts'

type AccountParams = PhotonCommandParams
type AccountViewParams = PhotonCommandParams

const editArgs = {
  clearLastName: {
    conflicts: 'lastName',
    default: false,
    description: 'Remove the account last name',
    toKebab: true,
    type: 'boolean'
  },
  firstName: {
    description: 'Set the account first name',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  lastName: {
    conflicts: 'clearLastName',
    description: 'Set the account last name',
    toKebab: true,
    type: 'string'
  }
} as const

const avatarUploadArgs = {
  file: {
    description: 'JPEG, PNG, or WebP avatar file',
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg
} as const

const avatarResetArgs = {
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const

export type AccountEditParams = PhotonCommandParams<typeof editArgs>
export type AccountAvatarUploadParams = PhotonCommandParams<
  typeof avatarUploadArgs
>
export type AccountAvatarResetParams = PhotonCommandParams<
  typeof avatarResetArgs
>

const viewDefinition = defineWithTypes<AccountViewParams>()({
  description: 'View the authenticated Photon account',
  name: 'view'
})

const editDefinition = defineWithTypes<AccountEditParams>()({
  args: editArgs,
  description: 'Edit the authenticated Photon account',
  name: 'edit',
  toKebab: true
})

const avatarUploadDefinition = defineWithTypes<AccountAvatarUploadParams>()({
  args: avatarUploadArgs,
  description: 'Upload a new account avatar',
  name: 'upload'
})

const avatarResetDefinition = defineWithTypes<AccountAvatarResetParams>()({
  args: avatarResetArgs,
  description: 'Reset the account avatar',
  name: 'reset'
})

const avatarCommand = defineWithTypes<AccountParams>()({
  description: 'Manage the account avatar',
  name: 'avatar',
  subCommands: {
    reset: tested(
      skip(
        "resets the signed-in account's own picture, which the test can't put back"
      ),
      lazyWithTypes<AccountAvatarResetParams>()(
        async () => (await import('./run.ts')).runAvatarReset,
        avatarResetDefinition
      )
    ),
    upload: tested(
      skip(
        "replaces the signed-in account's own picture, which the test can't put back"
      ),
      lazyWithTypes<AccountAvatarUploadParams>()(
        async () => (await import('./run.ts')).runAvatarUpload,
        avatarUploadDefinition
      )
    )
  }
})

export const accountCommand = defineWithTypes<AccountParams>()({
  description: 'Inspect and manage the Photon account',
  name: 'account',
  subCommands: {
    ...internalCommands.account,
    avatar: avatarCommand,
    edit: tested(
      runs,
      lazyWithTypes<AccountEditParams>()(
        async () => (await import('./run.ts')).runEdit,
        editDefinition
      )
    ),
    oauth: oauthCommand,
    'service-key': serviceKeyCommand,
    view: tested(
      runs,
      lazyWithTypes<AccountViewParams>()(
        async () => (await import('./run.ts')).runView,
        viewDefinition
      )
    )
  },
  toKebab: true
})
