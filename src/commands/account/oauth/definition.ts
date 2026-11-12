import { defineWithTypes } from 'gunshi'
import type { PhotonCommandParams } from '../../types.ts'
import { oauthConnectionCommand } from './connection/definition.ts'
import { oauthScopeCommand } from './scope/definition.ts'

export const oauthCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Inspect OAuth scopes and connected applications',
  name: 'oauth',
  subCommands: {
    connection: oauthConnectionCommand,
    scope: oauthScopeCommand
  },
  toKebab: true
})
