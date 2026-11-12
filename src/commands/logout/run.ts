import type { CommandRunner } from 'gunshi'
import { CLI_NAME } from '../../meta.ts'
import type { LogoutParams } from './definition.ts'

export const run: CommandRunner<LogoutParams> = async (context) => {
  const result = await context.extensions.photon.auth.logout(
    context.values.force ?? false
  )
  if (result.orphanedCredential) {
    context.extensions.photon.output.warning(
      'Local metadata was removed, but an orphaned keychain item may remain.'
    )
  }
  if (result.environmentVariable !== undefined) {
    context.extensions.photon.output.warning(
      `${result.environmentVariable} is still set, so ${CLI_NAME} keeps using its key. Unset ${result.environmentVariable} to stop using it.`
    )
  }
  context.extensions.photon.output.warning(
    result.credentialKind === 'account_service_key'
      ? 'Logout is local only; the account service key remains active until it is explicitly revoked.'
      : 'Logout is local only and does not revoke the remote WorkOS session.'
  )
  context.extensions.photon.output.success(
    {
      orphanedCredential: result.orphanedCredential,
      remoteSessionRevoked: false,
      removed: result.removed
    },
    result.removed ? 'Logged out of Photon.' : 'No Photon login was found.'
  )
}
