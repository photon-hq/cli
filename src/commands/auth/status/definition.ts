import { defineWithTypes } from 'gunshi'
import type { PhotonCommandParams } from '../../types.ts'

export type AuthStatusParams = PhotonCommandParams

export const authStatusDefinition = defineWithTypes<AuthStatusParams>()({
  description: 'Verify local storage and the remote Photon session',
  name: 'status',
  toKebab: true
})
