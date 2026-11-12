import type { CommandRunner } from 'gunshi'
import { detail } from '../../../../core/presenter.ts'
import { CLI_NAME } from '../../../../meta.ts'
import {
  OAUTH_SECRET_WARNING,
  oauthClientSecretDetails,
  withDeliveredOauthClientSecret
} from '../../../../oauth/presenter.ts'
import { validateOauthIdempotencyKey } from '../../../../oauth/validation.ts'
import { resolveOrganizationId } from '../../../../organization/command-helpers.ts'
import { cancelled, confirmRiskyAction } from '../../../helpers.ts'
import type {
  OauthSecretCreateParams,
  OauthSecretRevokeParams,
  OauthSecretRotateParams,
  OauthSecretViewParams
} from './definition.ts'
import { ONE_SECRET_ERROR } from './definition.ts'

export const runView: CommandRunner<OauthSecretViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const clientSecret = await photon.oauth.getClientSecret(
    await resolveOrganizationId(photon),
    clientId
  )
  photon.output.success(
    clientSecret,
    clientSecret.current === null
      ? `OAuth client ${clientId} has no secret. Run "${CLI_NAME} org oauth-client secret create ${clientId}" to set one up.`
      : oauthClientSecretDetails(photon.output, clientSecret)
  )
}

export const runCreate: CommandRunner<OauthSecretCreateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const result = withDeliveredOauthClientSecret(
    await photon.oauth.setUpClientSecret(
      await resolveOrganizationId(photon),
      clientId,
      validateOauthIdempotencyKey(context.values.idempotencyKey)
    ),
    clientId
  )
  photon.output.warning(OAUTH_SECRET_WARNING)
  photon.output.success(
    result,
    detail(photon.output, 'Created secret', [
      { label: 'Secret', value: result.value }
    ])
  )
}

export const runRotate: CommandRunner<OauthSecretRotateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const emergency = context.values.emergency ?? false
  const organizationId = await resolveOrganizationId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `rotate the secret of OAuth client ${clientId}`,
    consequence: emergency
      ? 'The current secret stops working now.'
      : 'The current secret keeps working for one hour.',
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = withDeliveredOauthClientSecret(
    await photon.oauth.rotateClientSecret(
      organizationId,
      clientId,
      emergency ? 'emergency' : 'normal',
      validateOauthIdempotencyKey(context.values.idempotencyKey)
    ),
    clientId
  )
  photon.output.warning(OAUTH_SECRET_WARNING)
  photon.output.success(
    result,
    detail(photon.output, 'Rotated secret', [
      { label: 'Secret', value: result.value },
      {
        label: 'Previous secret works until',
        value: result.previousSecretValidUntil ?? 'stopped now'
      }
    ])
  )
}

export const runRevoke: CommandRunner<OauthSecretRevokeParams> = async (
  context
) => {
  const { photon } = context.extensions
  if (context.rest.length > 0) {
    throw ONE_SECRET_ERROR
  }
  const clientId = context.values['client-id']
  const organizationId = await resolveOrganizationId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke the secret of OAuth client ${clientId}`,
    consequence:
      'It stops working now, and so does a previous secret in its grace period.',
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  await photon.oauth.revokeClientSecret(organizationId, clientId)
  photon.output.success(
    { clientId, revoked: true },
    photon.output.style(
      'green',
      `Revoked the secret of OAuth client ${clientId}.`
    )
  )
}
