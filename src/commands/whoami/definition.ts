import { defineWithTypes } from 'gunshi'
import type { PhotonCommandParams } from '../types.ts'

export type WhoamiParams = PhotonCommandParams

export const whoamiDefinition = defineWithTypes<WhoamiParams>()({
  description: 'Show the canonical authenticated Photon account',
  name: 'whoami',
  toKebab: true
})
