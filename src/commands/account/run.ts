import type { CommandRunner } from 'gunshi'
import { accountDetails } from '../../account/presenter.ts'
import { validateAccountChanges } from '../../account/validation.ts'
import { validateFilePath } from '../../core/validation.ts'
import { cancelled, confirmRiskyAction } from '../helpers.ts'
import type { PhotonCommandParams } from '../types.ts'
import type {
  AccountAvatarResetParams,
  AccountAvatarUploadParams,
  AccountEditParams
} from './definition.ts'

type AccountViewParams = PhotonCommandParams

export const runView: CommandRunner<AccountViewParams> = async (context) => {
  const { photon } = context.extensions
  const account = await photon.account.get()
  photon.output.success(account, accountDetails(photon.output, account))
}

export const runEdit: CommandRunner<AccountEditParams> = async (context) => {
  const { photon } = context.extensions
  const changes = validateAccountChanges({
    clearLastName: context.values.clearLastName ?? false,
    ...(context.values.firstName === undefined
      ? {}
      : { firstName: context.values.firstName }),
    ...(context.values.lastName === undefined
      ? {}
      : { lastName: context.values.lastName })
  })
  const { result: account } = await photon.operations.execute(
    { changes, kind: 'account.update' },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.account.update(changes, idempotencyKey)
  )
  photon.output.success(account, [
    photon.output.style('green', 'Updated the account.'),
    ...accountDetails(photon.output, account)
  ])
}

export const runAvatarUpload: CommandRunner<AccountAvatarUploadParams> = async (
  context
) => {
  const { photon } = context.extensions
  const file = validateFilePath(context.values.file, 'Avatar file path')
  const { result: account } =
    await photon.operations.executeAccountAvatarUpload(
      file,
      context.values.idempotencyKey
    )
  photon.output.success(account, [
    photon.output.style('green', 'Uploaded the account avatar.'),
    ...accountDetails(photon.output, account)
  ])
}

export const runAvatarReset: CommandRunner<AccountAvatarResetParams> = async (
  context
) => {
  const { photon } = context.extensions
  const confirmed = await confirmRiskyAction(context, {
    action: 'reset your Photon account avatar'
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result: account } = await photon.operations.execute(
    { kind: 'account-avatar.reset' },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.account.resetAvatar(idempotencyKey)
  )
  photon.output.success(
    account,
    photon.output.style('green', 'Reset the account avatar.')
  )
}
