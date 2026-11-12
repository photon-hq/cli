import type { CommandRunner } from 'gunshi'
import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { internalCommands } from '#internal'
import { runs, tested } from '../production-test.ts'
import type { PhotonCommandParams } from '../types.ts'
import type { AuthStatusParams } from './status/definition.ts'
import { authStatusDefinition } from './status/definition.ts'

type AuthParams = PhotonCommandParams

const loadStatus = async (): Promise<CommandRunner<AuthStatusParams>> => {
  const { run } = await import('./status/run.ts')
  return run
}

const statusCommand = tested(
  runs,
  lazyWithTypes<AuthStatusParams>()(loadStatus, authStatusDefinition)
)

export const authCommand = defineWithTypes<AuthParams>()({
  description: 'Inspect and manage Photon authentication',
  name: 'auth',
  subCommands: {
    ...internalCommands.auth,
    status: statusCommand
  },
  toKebab: true
})
