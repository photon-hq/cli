import type { CommandRunner } from 'gunshi'
import { displayName } from '../../auth/storage/repository.ts'
import { inert } from '../../core/presenter.ts'
import type { WhoamiParams } from './definition.ts'

export const run: CommandRunner<WhoamiParams> = async (context) => {
  const account = await context.extensions.photon.auth.whoami()
  const name = displayName(account.firstName, account.lastName)
  context.extensions.photon.output.success(
    {
      accountId: account.accountId,
      email: account.email,
      name
    },
    [
      `Account: ${account.accountId}`,
      `Name: ${name ?? '—'}`,
      `Email: ${account.email}`
    ].map(inert)
  )
}
