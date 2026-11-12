import type { CommandRunner } from 'gunshi'
import { isAccountServiceKeyCreation } from '../../account/service.ts'
import type { PhotonCommandServices } from '../../app/services.ts'
import { CliError } from '../../core/errors.ts'
import { nextStepLines } from '../../core/output.ts'
import { detail, inert, presentList, table } from '../../core/presenter.ts'
import { CLI_NAME } from '../../meta.ts'
import type {
  OperationService,
  OperationView
} from '../../operation/service.ts'
import { OPERATION_DEFINITIONS } from '../../operation/types.ts'
import {
  API_KEY_SECRET_WARNING,
  apiKeyCreationDetails,
  isApiKeyCreationResult,
  isWebhookDestinationCreationResult,
  isWebhookSigningSecretRotationResult,
  WEBHOOK_SIGNING_SECRET_WARNING,
  webhookDestinationCreationDetails,
  webhookSigningSecretRotationDetails
} from '../../project/presenter.ts'
import {
  assertDisplaySafeOutboundPassword,
  VOICE_OUTBOUND_PASSWORD_WARNING,
  VOICE_OUTBOUND_SECRET_UNAVAILABLE_WARNING
} from '../../project/voice-presenter.ts'
import {
  SERVICE_KEY_SECRET_WARNING,
  serviceKeyCreationDetails
} from '../account/service-key/run.ts'
import { cancelled, confirmRiskyAction } from '../helpers.ts'
import type {
  OperationListParams,
  OperationRemoveParams,
  OperationReplayParams,
  OperationViewParams
} from './definition.ts'

const INPUT_LABELS: Record<string, string> = {
  accountId: 'Account',
  activate: 'Activate',
  apiKeyId: 'API key ID',
  apiVersion: 'Webhook API version',
  assignmentId: 'Assignment',
  brandId: 'Brand ID',
  campaignId: 'Campaign ID',
  category: 'Category',
  changes: 'Changes',
  contentType: 'Content type',
  description: 'Description',
  destinationId: 'Webhook destination ID',
  email: 'Email',
  enabledEvents: 'Enabled events',
  expectedVersion: 'Expected profile version',
  expiresAt: 'API key expiration',
  fileName: 'File',
  input: 'Input',
  inputDigest: 'Normalized input SHA-256',
  invitationId: 'Invitation',
  name: 'Name',
  overlapSeconds: 'Secret overlap seconds',
  phase: 'Recovery phase',
  planCode: 'Plan code',
  profileId: 'Voice profile ID',
  profileReference: 'Voice profile reference',
  projectId: 'Project',
  resourceId: 'Resource',
  role: 'Role',
  serviceKeyId: 'Account service key ID',
  status: 'Status',
  tokenStored: 'Token stored',
  url: 'URL'
}

type OperationReplayResult = Awaited<ReturnType<OperationService['replay']>>

const resolvedReplay = (result: OperationReplayResult) => ({
  ...result,
  operation: { ...result.operation, status: 'resolved' as const }
})

const replayedMessage = (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): string =>
  photon.output.style(
    'green',
    `Replayed operation ${result.operation.operationId}.`
  )

const revokedAccountServiceKeyId = (value: object): string | undefined => {
  if ('serviceKeyId' in value && typeof value.serviceKeyId === 'string') {
    return value.serviceKeyId
  }
  if (
    'serviceKey' in value &&
    typeof value.serviceKey === 'object' &&
    value.serviceKey !== null &&
    'serviceKeyId' in value.serviceKey &&
    typeof value.serviceKey.serviceKeyId === 'string'
  ) {
    return value.serviceKey.serviceKeyId
  }
}

/**
 * Prints a replay's one-time output, and acknowledges its record only once
 * stdout has taken it, so a failed write leaves the record to replay again.
 */
const deliverReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult,
  human: string | string[]
): Promise<void> => {
  await photon.operations.deliverOutput(result.operation.operationId, () =>
    photon.output.successAndFlush(resolvedReplay(result), human)
  )
}

const presentAccountServiceKeyCreationReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): Promise<boolean> => {
  if (result.operation.kind !== 'account-service-key.create') {
    return false
  }
  if (!isAccountServiceKeyCreation(result.result)) {
    throw new CliError(
      'ACCOUNT_PROTOCOL_ERROR',
      'Photon returned an invalid account service key response.',
      {
        debugSafe: false,
        detail:
          'The replay result did not contain a safe one-time account service key credential.',
        exitCode: 1,
        next: [
          {
            description:
              'The one-time credential cannot be recovered. Revoke the new key and create another one.'
          }
        ]
      }
    )
  }
  const human = [
    replayedMessage(photon, result),
    ...serviceKeyCreationDetails(photon.output, result.result)
  ]
  photon.output.warning(SERVICE_KEY_SECRET_WARNING)
  await deliverReplay(photon, result, human)
  return true
}

const presentApiKeyCreationReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): Promise<boolean> => {
  if (result.operation.kind !== 'api-key.create') {
    return false
  }
  if (!isApiKeyCreationResult(result.result)) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        debugSafe: false,
        detail:
          'The API key replay result did not contain a safe one-time secret.',
        exitCode: 1,
        next: [
          {
            description:
              'The one-time secret cannot be recovered. Revoke the new API key and create another one.'
          }
        ]
      }
    )
  }
  const human = [
    replayedMessage(photon, result),
    ...apiKeyCreationDetails(photon.output, result.result, 'Recovered API key')
  ]
  photon.output.warning(API_KEY_SECRET_WARNING)
  await deliverReplay(photon, result, human)
  return true
}

const presentWebhookDestinationCreationReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): Promise<boolean> => {
  if (result.operation.kind !== 'webhook-destination.create') {
    return false
  }
  if (!isWebhookDestinationCreationResult(result.result)) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        debugSafe: false,
        detail:
          'The webhook replay result did not contain a safe one-time signing secret.',
        exitCode: 1,
        next: [
          {
            description:
              'The one-time secret cannot be recovered. Delete the destination and create another one.'
          }
        ]
      }
    )
  }
  const human = [
    replayedMessage(photon, result),
    ...webhookDestinationCreationDetails(
      photon.output,
      result.result,
      'Recovered webhook destination'
    )
  ]
  photon.output.warning(WEBHOOK_SIGNING_SECRET_WARNING)
  await deliverReplay(photon, result, human)
  return true
}

const presentWebhookSigningSecretRotationReplay = async (
  photon: PhotonCommandServices,
  operation: OperationView,
  result: OperationReplayResult
): Promise<boolean> => {
  if (result.operation.kind !== 'webhook-signing-secret.rotate') {
    return false
  }
  if (!isWebhookSigningSecretRotationResult(result.result)) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        debugSafe: false,
        detail:
          'The webhook replay result did not contain a safe rotated signing secret.',
        exitCode: 1,
        next: [
          {
            description:
              'The one-time secret cannot be recovered. Rotate the signing secret again.'
          }
        ]
      }
    )
  }
  const { destinationId } = operation.input
  const human = [
    replayedMessage(photon, result),
    ...webhookSigningSecretRotationDetails(
      photon.output,
      typeof destinationId === 'string' ? destinationId : undefined,
      result.result
    )
  ]
  photon.output.warning(WEBHOOK_SIGNING_SECRET_WARNING)
  await deliverReplay(photon, result, human)
  return true
}

const presentAccountServiceKeyRevokeReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): Promise<boolean> => {
  if (
    result.operation.kind !== 'account-service-key.revoke' ||
    result.operation.status !== 'awaiting-output-ack'
  ) {
    return false
  }
  await deliverReplay(photon, result, replayedMessage(photon, result))
  const serviceKeyId = revokedAccountServiceKeyId(result.result)
  if (serviceKeyId === undefined) {
    return true
  }
  try {
    const removed =
      await photon.auth.removeRevokedAccountServiceKey(serviceKeyId)
    if (removed?.removed === true) {
      photon.output.warning(
        'The revoked key was the active CLI credential, so its local session was removed.'
      )
    }
  } catch {
    photon.output.warning(
      `The key was revoked, but its local CLI session could not be removed. Run "${CLI_NAME} logout --force" before another command.`
    )
  }
  return true
}

const presentVoiceOutboundReplay = async (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): Promise<boolean> => {
  if (
    result.operation.kind !== 'voice-profile-outbound.enable' &&
    result.operation.kind !== 'voice-profile-outbound.rotate'
  ) {
    return false
  }
  if (
    !('password' in result.result) ||
    (result.result.password !== null &&
      typeof result.result.password !== 'string')
  ) {
    throw new CliError(
      'VOICE_PROTOCOL_ERROR',
      'Photon returned an invalid Voice response.',
      {
        debugSafe: false,
        detail:
          'The replay result did not contain a safe outbound SIP password result.',
        next: [
          {
            description:
              'The one-time password cannot be recovered. Rotate the outbound credential with a new idempotency key.'
          }
        ]
      }
    )
  }
  const password =
    result.result.password === null
      ? null
      : assertDisplaySafeOutboundPassword(result.result.password)
  const human = [
    replayedMessage(photon, result),
    ...detail(photon.output, 'Outbound SIP credential', [
      {
        label: 'Password',
        value: password ?? 'Unavailable; rotate to issue a new password'
      }
    ])
  ]
  photon.output.warning(
    result.result.password === null
      ? VOICE_OUTBOUND_SECRET_UNAVAILABLE_WARNING
      : VOICE_OUTBOUND_PASSWORD_WARNING
  )
  await deliverReplay(photon, result, human)
  return true
}

const presentWhatsappBusinessNumberDeleteReplay = (
  photon: PhotonCommandServices,
  result: OperationReplayResult
): boolean => {
  if (result.operation.kind !== 'whatsapp-business-number.delete') {
    return false
  }
  let released: unknown = result.result
  if ('operation' in result.result) {
    released = result.result.operation
  } else if ('resource' in result.result) {
    released = result.result.resource
  }
  const resourceId =
    typeof released === 'object' &&
    released !== null &&
    'resourceId' in released &&
    typeof released.resourceId === 'string'
      ? released.resourceId
      : undefined
  photon.output.success(result, [
    replayedMessage(photon, result),
    ...(resourceId === undefined
      ? []
      : [
          photon.output.style(
            'green',
            inert(`Deleted WhatsApp Business number resource ${resourceId}.`)
          )
        ])
  ])
  return true
}

const presentSpecialReplay = async (
  photon: PhotonCommandServices,
  operation: OperationView,
  result: OperationReplayResult
): Promise<boolean> => {
  if (await presentAccountServiceKeyCreationReplay(photon, result)) {
    return true
  }
  if (await presentApiKeyCreationReplay(photon, result)) {
    return true
  }
  if (await presentWebhookDestinationCreationReplay(photon, result)) {
    return true
  }
  if (
    await presentWebhookSigningSecretRotationReplay(photon, operation, result)
  ) {
    return true
  }
  if (await presentVoiceOutboundReplay(photon, result)) {
    return true
  }
  if (presentWhatsappBusinessNumberDeleteReplay(photon, result)) {
    return true
  }
  return await presentAccountServiceKeyRevokeReplay(photon, result)
}

export const runList: CommandRunner<OperationListParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.operations.list({
    limit: context.values.limit,
    ...(context.values.pageToken === undefined
      ? {}
      : { pageToken: context.values.pageToken }),
    ...(context.values.status === undefined
      ? {}
      : { statuses: context.values.status })
  })
  presentList(photon.output, {
    document: { operations: result.operations },
    emptyMessage: 'No unresolved operations found.',
    items: result.operations,
    lines: table(
      photon.output,
      ['OPERATION ID', 'COMMAND', 'STATUS', 'REPLAYABLE', 'UPDATED'],
      result.operations.map((operation) => [
        { style: 'cyan', text: operation.operationId },
        OPERATION_DEFINITIONS[operation.kind].command,
        operation.status,
        operation.replayable ? 'yes' : 'no',
        { style: 'dim', text: operation.updatedAt }
      ])
    ),
    page: { command: context, token: result.nextCursor }
  })
}

export const runView: CommandRunner<OperationViewParams> = async (context) => {
  const { photon } = context.extensions
  const operation = await photon.operations.view(context.values['operation-id'])
  photon.output.success(
    { operation },
    detail(photon.output, 'Local operation', [
      { label: 'ID', value: operation.operationId },
      { label: 'Command', value: operation.command },
      { label: 'Status', value: operation.status },
      ...Object.entries(operation.input).map(([label, value]) => ({
        label: INPUT_LABELS[label] ?? label,
        value
      })),
      { label: 'Error', value: operation.failure?.code },
      { label: 'Replayable', value: operation.replayable ? 'yes' : 'no' },
      { label: 'Remote operation', value: operation.remoteOperationId },
      { label: 'Idempotency key', value: operation.idempotencyKey },
      { label: 'Created', value: operation.createdAt },
      { label: 'Updated', value: operation.updatedAt },
      { label: 'Expires', value: operation.expiresAt },
      ...(operation.replayExpiresAt === undefined
        ? []
        : [{ label: 'Replay expires', value: operation.replayExpiresAt }])
    ])
  )
}

export const runReplay: CommandRunner<OperationReplayParams> = async (
  context
) => {
  const { photon } = context.extensions
  const localOperationId = context.values['operation-id']
  const operation = await photon.operations.view(localOperationId)
  photon.operations.assertReplayable(operation)
  const confirmed = await confirmRiskyAction(context, {
    action: `replay ${operation.command}`
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = await photon.output.withLoading(
    `Replaying operation ${localOperationId}`,
    async () => await photon.operations.replay(localOperationId),
    { nonInteractive: 'silent' }
  )
  if (await presentSpecialReplay(photon, operation, result)) {
    return
  }
  const { next = [], ...replayed } = result
  const steps = nextStepLines(next).map(inert)
  if (photon.output.json) {
    for (const line of steps) {
      photon.output.progress(line)
    }
  }
  photon.output.success(replayed, [replayedMessage(photon, result), ...steps])
}

export const runRemove: CommandRunner<OperationRemoveParams> = async (
  context
) => {
  const { photon } = context.extensions
  const localOperationId = context.values['operation-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `remove local operation ${localOperationId}`,
    consequence: 'This will not cancel or reverse any server-side resource.'
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const removed = await photon.operations.remove(localOperationId)
  photon.output.success(
    { operationId: localOperationId, removed },
    photon.output.style('green', `Removed local operation ${localOperationId}.`)
  )
}
