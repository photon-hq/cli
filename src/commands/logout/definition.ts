import { defineWithTypes } from 'gunshi'
import type { PhotonCommandParams } from '../types.ts'

export const logoutArgs = {
  force: {
    default: false,
    description: 'Forget corrupt metadata even if secure cleanup fails',
    type: 'boolean'
  }
} as const

export type LogoutParams = PhotonCommandParams<typeof logoutArgs>

export const logoutDefinition = defineWithTypes<LogoutParams>()({
  args: logoutArgs,
  description: 'Remove the local Photon session',
  name: 'logout',
  toKebab: true
})
