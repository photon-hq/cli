import { defineWithTypes } from 'gunshi'
import { PACKAGE_MANAGERS } from '../../update/package-managers.ts'
import type { PhotonCommandParams } from '../types.ts'

export const updateArgs = {
  check: {
    default: false,
    description: 'Check for a newer version without installing it',
    type: 'boolean'
  },
  installer: {
    choices: PACKAGE_MANAGERS,
    description:
      'Update with this package manager, when it installed this copy globally',
    type: 'enum'
  }
} as const

export type UpdateParams = PhotonCommandParams<typeof updateArgs>

export const updateDefinition = defineWithTypes<UpdateParams>()({
  args: updateArgs,
  description: 'Update the Photon CLI to the newest version',
  name: 'update',
  toKebab: true
})
