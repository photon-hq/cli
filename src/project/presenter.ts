import type {
  CreateProjectApiKeyOutput,
  CreateWebhookDestinationOutput,
  DeleteWebhookDestinationOutput,
  GetWebhookDestinationOutput,
  ListProjectApiKeysOutput,
  ListWebhookDestinationsOutput,
  RevokeProjectApiKeyOutput,
  RotateWebhookSigningSecretOutput,
  UpdateWebhookDestinationOutput
} from '@photon-ai/api'
import { CliError } from '../core/errors.ts'
import type { CliOutput } from '../core/output.ts'
import { detail } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import { selectImessageHealthStatus } from './imessage.ts'
import type { PlatformResource } from './service.ts'
import { selectTelegramBotDetail } from './telegram.ts'

type ApiKeyResource =
  | CreateProjectApiKeyOutput['apiKey']
  | ListProjectApiKeysOutput['apiKeys'][number]
  | RevokeProjectApiKeyOutput['apiKey']
type WebhookDestinationResource =
  | CreateWebhookDestinationOutput['destination']
  | DeleteWebhookDestinationOutput
  | GetWebhookDestinationOutput
  | ListWebhookDestinationsOutput['destinations'][number]
  | UpdateWebhookDestinationOutput

const MAXIMUM_API_KEY_SECRET_LENGTH = 4096
const API_KEY_SECRET_PATTERN = /^[\x21-\x7e]+$/u
const MAXIMUM_WEBHOOK_SIGNING_SECRET_LENGTH = 256
const WEBHOOK_SIGNING_SECRET_PREFIX = 'whsec_'
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const BASE64_PADDING_PATTERN = /[=]+$/u
const MINIMUM_WEBHOOK_SECRET_BYTES = 24
const MAXIMUM_WEBHOOK_SECRET_BYTES = 64

export const API_KEY_SECRET_WARNING =
  'Save this API key secret now. It cannot be retrieved again.'

const isSafeApiKeySecret = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAXIMUM_API_KEY_SECRET_LENGTH &&
  API_KEY_SECRET_PATTERN.test(value)

// Checks the one-time secret before anything prints it, and returns the
// response unchanged.
export const withSafeApiKeySecret = (
  result: CreateProjectApiKeyOutput
): CreateProjectApiKeyOutput => {
  if (!isSafeApiKeySecret(result.secret)) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        debugSafe: false,
        detail: 'The API key secret was not safe to display.',
        next: [
          {
            description: `Use the operation ID from this error with ${CLI_NAME} operation replay <operation-id>.`
          }
        ],
        retryable: true
      }
    )
  }
  return result
}

const nullableString = (value: unknown): value is null | string =>
  value === null || typeof value === 'string'

const isApiKey = (value: unknown): value is ApiKeyResource =>
  typeof value === 'object' &&
  value !== null &&
  'apiKeyId' in value &&
  typeof value.apiKeyId === 'string' &&
  'createdAt' in value &&
  typeof value.createdAt === 'string' &&
  'createdByAccountId' in value &&
  typeof value.createdByAccountId === 'string' &&
  'expiresAt' in value &&
  nullableString(value.expiresAt) &&
  'name' in value &&
  typeof value.name === 'string' &&
  'permissions' in value &&
  Array.isArray(value.permissions) &&
  value.permissions.every(
    (permission: unknown) => typeof permission === 'string'
  ) &&
  'permissionsUpdatedAt' in value &&
  nullableString(value.permissionsUpdatedAt) &&
  'projectId' in value &&
  typeof value.projectId === 'string' &&
  'revokedAt' in value &&
  nullableString(value.revokedAt)

export const isApiKeyCreationResult = (
  value: unknown
): value is CreateProjectApiKeyOutput =>
  typeof value === 'object' &&
  value !== null &&
  'apiKey' in value &&
  isApiKey(value.apiKey) &&
  'secret' in value &&
  isSafeApiKeySecret(value.secret)

export const apiKeyDetails = (
  output: CliOutput,
  apiKey: ApiKeyResource,
  heading = 'API key'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: apiKey.name },
    { label: 'ID', value: apiKey.apiKeyId },
    { label: 'Project', value: apiKey.projectId },
    {
      label: 'Permissions',
      value: apiKey.permissions.join(', ')
    },
    { label: 'Created by', value: apiKey.createdByAccountId },
    { label: 'Created', value: apiKey.createdAt },
    { label: 'Expires', value: apiKey.expiresAt },
    { label: 'Revoked', value: apiKey.revokedAt }
  ])

export const apiKeyCreationDetails = (
  output: CliOutput,
  result: CreateProjectApiKeyOutput,
  heading = 'Created API key'
): string[] => [
  ...apiKeyDetails(output, result.apiKey, heading),
  ...detail(output, 'One-time secret', [
    { label: 'Secret', value: result.secret }
  ])
]

const isSafeWebhookSigningSecret = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_WEBHOOK_SIGNING_SECRET_LENGTH ||
    !value.startsWith(WEBHOOK_SIGNING_SECRET_PREFIX)
  ) {
    return false
  }
  const encodedSecret = value.slice(WEBHOOK_SIGNING_SECRET_PREFIX.length)
  if (!BASE64_PATTERN.test(encodedSecret)) {
    return false
  }
  const decodedSecret = Buffer.from(encodedSecret, 'base64')
  const canonicalInput = encodedSecret.replace(BASE64_PADDING_PATTERN, '')
  const canonicalDecoded = decodedSecret
    .toString('base64')
    .replace(BASE64_PADDING_PATTERN, '')
  return (
    canonicalInput === canonicalDecoded &&
    decodedSecret.length >= MINIMUM_WEBHOOK_SECRET_BYTES &&
    decodedSecret.length <= MAXIMUM_WEBHOOK_SECRET_BYTES
  )
}

/**
 * A create or rotate response as Photon sent it, once its signing secret is
 * safe to show.
 */
export const withSafeWebhookSigningSecret = <
  Result extends { signingSecret: string }
>(
  result: Result
): Result => {
  if (isSafeWebhookSigningSecret(result.signingSecret)) {
    return result
  }
  throw new CliError(
    'PROJECT_PROTOCOL_ERROR',
    'Photon returned an invalid project response.',
    {
      debugSafe: false,
      detail: 'The webhook signing secret was not safe to display.',
      next: [
        {
          description: `Use the operation ID from this error with ${CLI_NAME} operation replay <operation-id>.`
        }
      ],
      retryable: true
    }
  )
}

export const WEBHOOK_SIGNING_SECRET_WARNING =
  'Save this webhook signing secret now. It cannot be retrieved again.'

const isWebhookDestination = (
  value: unknown
): value is GetWebhookDestinationOutput =>
  typeof value === 'object' &&
  value !== null &&
  'apiVersion' in value &&
  typeof value.apiVersion === 'string' &&
  'createdAt' in value &&
  typeof value.createdAt === 'string' &&
  'deletedAt' in value &&
  nullableString(value.deletedAt) &&
  'description' in value &&
  nullableString(value.description) &&
  'destinationId' in value &&
  typeof value.destinationId === 'string' &&
  'enabledEvents' in value &&
  Array.isArray(value.enabledEvents) &&
  value.enabledEvents.every((event) => typeof event === 'string') &&
  'name' in value &&
  typeof value.name === 'string' &&
  'projectId' in value &&
  typeof value.projectId === 'string' &&
  'status' in value &&
  typeof value.status === 'string' &&
  'updatedAt' in value &&
  typeof value.updatedAt === 'string' &&
  'url' in value &&
  typeof value.url === 'string'

export const isWebhookDestinationCreationResult = (
  value: unknown
): value is CreateWebhookDestinationOutput =>
  typeof value === 'object' &&
  value !== null &&
  'destination' in value &&
  isWebhookDestination(value.destination) &&
  'signingSecret' in value &&
  isSafeWebhookSigningSecret(value.signingSecret)

export const isWebhookSigningSecretRotationResult = (
  value: unknown
): value is RotateWebhookSigningSecretOutput =>
  typeof value === 'object' &&
  value !== null &&
  'previousSecretExpiresAt' in value &&
  nullableString(value.previousSecretExpiresAt) &&
  'signingSecret' in value &&
  isSafeWebhookSigningSecret(value.signingSecret)

export const webhookDestinationDetails = (
  output: CliOutput,
  destination: WebhookDestinationResource,
  heading = 'Webhook destination'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: destination.name },
    { label: 'ID', value: destination.destinationId },
    { label: 'Project', value: destination.projectId },
    { label: 'Status', value: destination.status },
    { label: 'URL', value: destination.url },
    { label: 'API version', value: destination.apiVersion },
    { label: 'Events', value: destination.enabledEvents.join(', ') },
    { label: 'Description', value: destination.description },
    { label: 'Created', value: destination.createdAt },
    { label: 'Updated', value: destination.updatedAt },
    { label: 'Deleted', value: destination.deletedAt }
  ])

export const webhookDestinationCreationDetails = (
  output: CliOutput,
  result: CreateWebhookDestinationOutput,
  heading = 'Created webhook destination'
): string[] => [
  ...webhookDestinationDetails(output, result.destination, heading),
  ...detail(output, 'One-time signing secret', [
    { label: 'Signing secret', value: result.signingSecret }
  ])
]

export const webhookSigningSecretRotationDetails = (
  output: CliOutput,
  destinationId: string | undefined,
  result: RotateWebhookSigningSecretOutput
): string[] =>
  detail(output, 'Rotated webhook signing secret', [
    { label: 'Destination ID', value: destinationId },
    {
      label: 'Previous secret expires',
      value: result.previousSecretExpiresAt
    },
    { label: 'New signing secret', value: result.signingSecret }
  ])

export const platformResourcePhoneNumber = (
  resource: PlatformResource
): string | undefined =>
  typeof resource.detail.phoneNumber === 'string'
    ? resource.detail.phoneNumber
    : undefined

export const platformResourceDomain = (
  resource: PlatformResource
): string | undefined =>
  typeof resource.detail.domain === 'string'
    ? resource.detail.domain
    : undefined

export const platformResourceTelegramUsername = (
  resource: PlatformResource
): string | undefined => {
  const bot = selectTelegramBotDetail(resource.detail)
  return bot === undefined ? undefined : `@${bot.username}`
}

export const platformResourceHealth = (
  resource: PlatformResource
): string | undefined => {
  const imessageStatus = selectImessageHealthStatus(resource.detail)
  if (imessageStatus !== undefined) {
    return imessageStatus
  }
  if (typeof resource.detail.healthy !== 'boolean') {
    return
  }
  return resource.detail.healthy ? 'healthy' : 'unhealthy'
}
