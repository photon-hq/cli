import type { CommandRunner } from 'gunshi'
import {
  type AccountServiceKey,
  type AccountServiceKeyCreation,
  validateAccountServiceKeyCreateInput
} from '../../../account/service.ts'
import type { CliOutput } from '../../../core/output.ts'
import { detail, inert, presentList, table } from '../../../core/presenter.ts'
import { CLI_NAME } from '../../../meta.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type {
  ServiceKeyCreateParams,
  ServiceKeyListParams,
  ServiceKeyRevokeParams
} from './definition.ts'

export const SERVICE_KEY_SECRET_WARNING =
  'Save this account service key now. List and revoke never return it.'

const serviceKeyDetails = (
  output: CliOutput,
  serviceKey: AccountServiceKey,
  heading = 'Account service key'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: serviceKey.name },
    { label: 'ID', value: serviceKey.serviceKeyId },
    { label: 'Account', value: serviceKey.accountId },
    { label: 'Created', value: serviceKey.createdAt },
    { label: 'Expires', value: serviceKey.expiresAt },
    { label: 'Revoked', value: serviceKey.revokedAt }
  ])

export const serviceKeyCreationDetails = (
  output: CliOutput,
  result: AccountServiceKeyCreation
): string[] => [
  ...serviceKeyDetails(
    output,
    result.serviceKey,
    'Created account service key'
  ),
  ...detail(output, 'Create credential', [
    { label: 'Service key', value: result.secret }
  ])
]

export const runList: CommandRunner<ServiceKeyListParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.account.listServiceKeys()
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No unrevoked account service keys found.',
    items: result.serviceKeys,
    lines: table(
      photon.output,
      ['NAME', 'SERVICE KEY ID', 'EXPIRES', 'CREATED'],
      result.serviceKeys.map((serviceKey) => [
        serviceKey.name,
        { style: 'cyan', text: serviceKey.serviceKeyId },
        serviceKey.expiresAt ?? 'never',
        { style: 'dim', text: serviceKey.createdAt }
      ])
    )
  })
}

export const runCreate: CommandRunner<ServiceKeyCreateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const input = validateAccountServiceKeyCreateInput({
    ...(context.values.expiresAt === undefined
      ? {}
      : { expiresAt: context.values.expiresAt }),
    name: context.values.name,
    noExpiry: context.values.noExpiry ?? false
  })
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    {
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      kind: 'account-service-key.create',
      name: input.name
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.account.createServiceKey(input, idempotencyKey)
  )
  const human = serviceKeyCreationDetails(photon.output, result)
  photon.output.warning(SERVICE_KEY_SECRET_WARNING)
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(result, human)
  )
}

const serviceKeyRevocationDetails = (
  output: CliOutput,
  serviceKey: AccountServiceKey
): string[] => [
  output.style(
    'green',
    inert(`Revoked account service key ${serviceKey.serviceKeyId}.`)
  ),
  ...serviceKeyDetails(output, serviceKey, 'Revoked account service key')
]

export const runRevoke: CommandRunner<ServiceKeyRevokeParams> = async (
  context
) => {
  const { photon } = context.extensions
  const serviceKeyId = context.values['service-key-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke account service key ${serviceKeyId}`
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const intent = { kind: 'account-service-key.revoke' as const, serviceKeyId }
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.account.revokeServiceKey(serviceKeyId, idempotencyKey)
  )
  const human = serviceKeyRevocationDetails(photon.output, result.serviceKey)
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(result, human)
  )

  try {
    const removed =
      await photon.auth.removeRevokedAccountServiceKey(serviceKeyId)
    if (removed !== undefined) {
      photon.output.warning(
        removed.removed
          ? 'The revoked key was the active CLI credential, so its local session was removed.'
          : 'The active CLI session changed while the key was being revoked; no newer local credential was removed.'
      )
    }
  } catch {
    photon.output.warning(
      `The key was revoked, but its local CLI session could not be checked or removed. If it was active, run "${CLI_NAME} logout --force" before another command.`
    )
  }
}
