import type {
  CreateOrganizationOauthClientOutput,
  GetOrganizationOauthClientOutput,
  GetOrganizationOauthClientSecretOutput,
  ListOrganizationOauthClientsOutput,
  UpdateOrganizationOauthClientOutput
} from '@photon-ai/api'
import { CliError, type NextStep } from '../core/errors.ts'
import type { CliOutput } from '../core/output.ts'
import { detail } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'

type OauthClientResource =
  | CreateOrganizationOauthClientOutput
  | GetOrganizationOauthClientOutput
  | ListOrganizationOauthClientsOutput['oauthClients'][number]
  | UpdateOrganizationOauthClientOutput

const MAXIMUM_SECRET_LENGTH = 4096
const SECRET_PATTERN = /^[\x21-\x7e]+$/u

export const OAUTH_SECRET_WARNING =
  'Save this OAuth client secret now. It cannot be retrieved again.'

// Photon returns the plaintext only to the request that minted the secret. A
// retry with the same idempotency key reads the outcome with no plaintext.
export const withDeliveredOauthClientSecret = <
  Result extends { value: null | string }
>(
  result: Result,
  clientId: string
): Result & { value: string } => {
  const { value } = result
  const replacement: NextStep = {
    description: 'Replace it',
    run: `${CLI_NAME} org oauth-client secret rotate ${clientId}`
  }
  if (value === null) {
    throw new CliError(
      'OAUTH_SECRET_NOT_DELIVERED',
      'Photon did not return the OAuth client secret.',
      {
        detail:
          'An earlier request with this idempotency key minted the secret, and its plaintext is gone.',
        next: [replacement]
      }
    )
  }
  if (
    value.length === 0 ||
    value.length > MAXIMUM_SECRET_LENGTH ||
    !SECRET_PATTERN.test(value)
  ) {
    throw new CliError(
      'OAUTH_PROTOCOL_ERROR',
      'Photon returned an invalid OAuth client response.',
      {
        debugSafe: false,
        detail: 'The OAuth client secret was not safe to display.',
        next: [replacement],
        retryable: false
      }
    )
  }
  return { ...result, value }
}

const redirectUriLabels = (client: OauthClientResource): string[] =>
  client.redirectUris.map(({ default: isDefault, uri }) =>
    isDefault ? `${uri} (default)` : uri
  )

export const oauthClientDetails = (
  output: CliOutput,
  client: OauthClientResource,
  heading = 'OAuth client'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: client.name },
    { label: 'Client ID', value: client.clientId },
    { label: 'Description', value: client.description },
    { label: 'Redirect URIs', value: redirectUriLabels(client) },
    { label: 'Scopes', value: client.scopes },
    { label: 'Created', value: client.createdAt },
    { label: 'Updated', value: client.updatedAt }
  ])

export const oauthClientSecretDetails = (
  output: CliOutput,
  clientSecret: GetOrganizationOauthClientSecretOutput
): string[] => [
  ...detail(output, 'Current secret', [
    { label: 'Hint', value: clientSecret.current?.hint },
    { label: 'Created', value: clientSecret.current?.createdAt },
    { label: 'Last used', value: clientSecret.current?.lastUsedAt ?? 'never' }
  ]),
  ...(clientSecret.previous === null
    ? []
    : [
        '',
        ...detail(output, 'Previous secret', [
          { label: 'Hint', value: clientSecret.previous.hint },
          { label: 'Works until', value: clientSecret.previous.validUntil },
          {
            label: 'Last used',
            value: clientSecret.previous.lastUsedAt ?? 'never'
          }
        ])
      ])
]
