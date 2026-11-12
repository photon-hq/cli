import type { CommandRunner } from 'gunshi'
import { nextStepLines } from '../../../core/output.ts'
import { inert } from '../../../core/presenter.ts'
import type { AuthStatusParams } from './definition.ts'

export const run: CommandRunner<AuthStatusParams> = async (context) => {
  const { output } = context.extensions.photon
  const { next, ...status } = await context.extensions.photon.auth.status()
  const human = [
    `Status: ${status.state}`,
    `API: ${status.apiOrigin}`,
    ...(status.source === undefined
      ? []
      : [
          `Source: ${status.variable === undefined ? status.source : `${status.source} (${status.variable})`}`
        ]),
    ...(status.storage === undefined ? [] : [`Storage: ${status.storage}`]),
    ...(status.credentialKind === undefined
      ? []
      : [`Credential: ${status.credentialKind}`]),
    ...(status.keyId === undefined ? [] : [`Key: ${status.keyId}`]),
    ...(status.serviceKeyId === undefined
      ? []
      : [`Service key: ${status.serviceKeyId}`]),
    ...(status.accountId === undefined ? [] : [`Account: ${status.accountId}`]),
    ...(status.name === undefined ? [] : [`Name: ${status.name ?? '—'}`]),
    ...(status.email === undefined ? [] : [`Email: ${status.email}`]),
    ...(status.expiresAt === undefined
      ? []
      : [`Access token expires: ${status.expiresAt}`]),
    ...(status.reason === undefined ? [] : [`Reason: ${status.reason}`])
  ]
  const steps = nextStepLines(next ?? [])
  if (output.json) {
    for (const line of steps) {
      output.progress(inert(line))
    }
  }
  output.success(status, [...human, ...steps].map(inert))
  if (status.state === 'not_authenticated' || status.state === 'unavailable') {
    context.extensions.photon.setExitCode(1)
  }
}
