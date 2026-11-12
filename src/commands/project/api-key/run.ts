import type { CommandRunner } from 'gunshi'
import { inert, presentList, table } from '../../../core/presenter.ts'
import { resolveProjectId } from '../../../project/command-helpers.ts'
import {
  API_KEY_SECRET_WARNING,
  apiKeyCreationDetails,
  apiKeyDetails,
  withSafeApiKeySecret
} from '../../../project/presenter.ts'
import {
  validateApiKeyCreateInput,
  validateApiKeyId
} from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type {
  ApiKeyCreateParams,
  ApiKeyListParams,
  ApiKeyRevokeParams
} from './definition.ts'

export const runList: CommandRunner<ApiKeyListParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.projects.listApiKeys(
    await resolveProjectId(photon)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No live project API keys found.',
    items: result.apiKeys,
    lines: table(
      photon.output,
      ['NAME', 'API KEY ID', 'PERMISSIONS', 'EXPIRES', 'CREATED BY', 'CREATED'],
      result.apiKeys.map((apiKey) => [
        apiKey.name,
        { style: 'cyan', text: apiKey.apiKeyId },
        apiKey.permissions.join(', '),
        apiKey.expiresAt ?? 'never',
        apiKey.createdByAccountId,
        { style: 'dim', text: apiKey.createdAt }
      ])
    )
  })
}

export const runCreate: CommandRunner<ApiKeyCreateParams> = async (context) => {
  const { photon } = context.extensions
  const input = validateApiKeyCreateInput({
    ...(context.values.expiresAt === undefined
      ? {}
      : { expiresAt: context.values.expiresAt }),
    name: context.values.name,
    noExpiry: context.values.noExpiry ?? false,
    permissions: context.values.permission
  })
  const projectId = await resolveProjectId(photon)
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    {
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      kind: 'api-key.create',
      name: input.name,
      permissions: input.permissions,
      projectId
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      withSafeApiKeySecret(
        await photon.projects.createApiKey(projectId, input, idempotencyKey)
      )
  )
  const human = apiKeyCreationDetails(photon.output, result)
  photon.output.warning(API_KEY_SECRET_WARNING)
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(result, human)
  )
}

export const runRevoke: CommandRunner<ApiKeyRevokeParams> = async (context) => {
  const { photon } = context.extensions
  const apiKeyId = validateApiKeyId(context.values['api-key-id'], context._)
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke API key ${apiKeyId} from project ${projectId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result } = await photon.operations.execute(
    { apiKeyId, kind: 'api-key.revoke', projectId },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.projects.revokeApiKey(projectId, apiKeyId, idempotencyKey)
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(`Revoked API key ${result.apiKey.apiKeyId}.`)
    ),
    ...apiKeyDetails(photon.output, result.apiKey, 'Revoked API key')
  ])
}
