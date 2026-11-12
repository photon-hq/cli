import type { CommandRunner } from 'gunshi'
import type { LoginResult } from '../../auth/types.ts'
import { CliError, type NextStep } from '../../core/errors.ts'
import { interruptedExitCode } from '../../core/interrupt.ts'
import { nextStepLines } from '../../core/output.ts'
import { inert } from '../../core/presenter.ts'
import { CLI_NAME } from '../../meta.ts'
import type { LoginParams } from './definition.ts'

export const run: CommandRunner<LoginParams> = async (context) => {
  let result: LoginResult
  try {
    result = await context.extensions.photon.auth.login({
      force: context.values.force ?? false,
      insecureStorage: context.values.insecureStorage ?? false,
      noBrowser: !(context.values.browser ?? true),
      serviceKey: context.values.serviceKey ?? false
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
      throw new CliError('LOGIN_INTERRUPTED', 'Login was interrupted.', {
        cause: error,
        exitCode: interruptedExitCode(error)
      })
    }
    throw error
  }
  let message = `Logged in as ${result.email}.`
  if (result.credentialKind === 'account_service_key') {
    message = `${result.alreadyAuthenticated ? 'Already logged in' : 'Logged in'} with account service key ${result.serviceKeyId ?? 'unknown'}.`
  } else if (result.alreadyAuthenticated) {
    message = `Already logged in as ${result.email}.`
  }
  const next: NextStep[] = result.alreadyAuthenticated
    ? [
        {
          description: 'Sign in as a different account',
          person: true,
          run: `${CLI_NAME} login --force`
        }
      ]
    : []
  context.extensions.photon.output.success(
    {
      ...(result.accountId === undefined
        ? {}
        : { accountId: result.accountId }),
      alreadyAuthenticated: result.alreadyAuthenticated,
      apiOrigin: result.apiOrigin,
      ...(result.credentialKind === undefined
        ? {}
        : { credentialKind: result.credentialKind }),
      email: result.email,
      name: result.name,
      ...(result.serviceKeyId === undefined
        ? {}
        : { serviceKeyId: result.serviceKeyId }),
      storage: result.storage
    },
    inert(message)
  )
  for (const line of nextStepLines(next)) {
    context.extensions.photon.output.progress(inert(line))
  }
}
