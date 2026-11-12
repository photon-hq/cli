import { defineWithTypes } from 'gunshi'
import type { PhotonCommandParams } from '../types.ts'

export type UnlinkParams = PhotonCommandParams

export const unlinkDefinition = defineWithTypes<UnlinkParams>()({
  description: 'Remove the nearest .photon/project.json',
  name: 'unlink'
})
