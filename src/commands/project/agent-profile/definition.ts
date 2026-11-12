import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { runs, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

type AgentProfileParams = PhotonCommandParams
type AgentProfileViewParams = PhotonCommandParams

const editArgs = {
  clearLastName: {
    conflicts: 'lastName',
    default: false,
    description: 'Remove the agent last name',
    toKebab: true,
    type: 'boolean'
  },
  firstName: {
    description: 'Set the agent first name',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  lastName: {
    conflicts: 'clearLastName',
    description: 'Set the agent last name',
    toKebab: true,
    type: 'string'
  }
} as const

const uploadArgs = {
  file: {
    description: 'JPEG, PNG, or WebP avatar file',
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg
} as const

const resetArgs = {
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const

export type AgentProfileEditParams = PhotonCommandParams<typeof editArgs>
export type AvatarUploadParams = PhotonCommandParams<typeof uploadArgs>
export type AvatarResetParams = PhotonCommandParams<typeof resetArgs>

const viewDefinition = defineWithTypes<AgentProfileViewParams>()({
  description: 'View the current project agent profile',
  name: 'view'
})

const editDefinition = defineWithTypes<AgentProfileEditParams>()({
  args: editArgs,
  description: 'Edit the current project agent profile',
  name: 'edit',
  toKebab: true
})

const uploadDefinition = defineWithTypes<AvatarUploadParams>()({
  args: uploadArgs,
  description: 'Upload a new agent avatar',
  name: 'upload'
})

const resetDefinition = defineWithTypes<AvatarResetParams>()({
  args: resetArgs,
  description: 'Reset the agent avatar',
  name: 'reset'
})

const viewCommand = tested(
  runs,
  lazyWithTypes<AgentProfileViewParams>()(
    async () => (await import('./run.ts')).runView,
    viewDefinition
  )
)
const editCommand = tested(
  runs,
  lazyWithTypes<AgentProfileEditParams>()(
    async () => (await import('./run.ts')).runEdit,
    editDefinition
  )
)
const uploadCommand = tested(
  runs,
  lazyWithTypes<AvatarUploadParams>()(
    async () => (await import('./run.ts')).runAvatarUpload,
    uploadDefinition
  )
)
const resetCommand = tested(
  runs,
  lazyWithTypes<AvatarResetParams>()(
    async () => (await import('./run.ts')).runAvatarReset,
    resetDefinition
  )
)

const avatarCommand = defineWithTypes<AgentProfileParams>()({
  description: 'Manage the current project agent avatar',
  name: 'avatar',
  subCommands: {
    reset: resetCommand,
    upload: uploadCommand
  }
})

export const agentProfileCommand = defineWithTypes<AgentProfileParams>()({
  description: 'Manage the current project agent profile',
  name: 'agent-profile',
  subCommands: {
    avatar: avatarCommand,
    edit: editCommand,
    view: viewCommand
  },
  toKebab: true
})
