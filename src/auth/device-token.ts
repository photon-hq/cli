import type { ApiError, DeviceTokenOutput } from '@photon-ai/api'
import { CliError } from '../core/errors.ts'
import { accountEmailSchema } from './types.ts'

export const validateDeviceToken = (grant: DeviceTokenOutput): void => {
  const validLifetime =
    Number.isFinite(grant.expires_in) && grant.expires_in > 0
  const completeTokens =
    grant.access_token.length > 0 && grant.refresh_token.length > 0
  const completeUser = grant.user.id.length > 0 && grant.user.email.length > 0
  if (!(validLifetime && completeTokens && completeUser)) {
    throw new CliError(
      'AUTH_PROTOCOL_ERROR',
      'The authentication server returned an incomplete token response.'
    )
  }
  if (!accountEmailSchema.safeParse(grant.user.email).success) {
    throw new CliError(
      'AUTH_PROTOCOL_ERROR',
      'The authentication server returned an invalid email address.'
    )
  }
}

export const oauthErrorCode = (error: ApiError): string | undefined => {
  const { body } = error
  return typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : undefined
}
