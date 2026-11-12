import type { GetOrganizationOauthClientOutput } from '@photon-ai/api'
import { argumentValidationError, CliError } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import type { OauthAuthorizationServer } from './discovery.ts'
import { validateOauthScopes } from './validation.ts'

export interface OauthAuthorization {
  authorizationUrl: string
  clientId: string
  issuer: string
  nonce: string
  redirectUri: string
  scopes: readonly string[]
  state: string
}

interface CreateOauthAuthorizationOptions {
  client: GetOrganizationOauthClientOutput
  randomBytes: (size: number) => Buffer
  redirectUri?: string
  scopes?: readonly string[]
  scopesSupported: readonly string[]
  server: OauthAuthorizationServer
}

const STANDARD_SCOPES = new Set([
  'email',
  'offline_access',
  'openid',
  'profile'
])

const selectRedirectUri = (
  client: GetOrganizationOauthClientOutput,
  requested: string | undefined
): string => {
  if (requested !== undefined) {
    const registered = client.redirectUris.some(({ uri }) => uri === requested)
    if (!registered) {
      throw argumentValidationError(
        '--redirect-uri must exactly match a redirect URI registered on the OAuth client.'
      )
    }
    return requested
  }

  const defaultRedirect = client.redirectUris.find(
    ({ default: isDefault }) => isDefault
  )
  if (defaultRedirect === undefined) {
    throw new CliError(
      'OAUTH_PROTOCOL_ERROR',
      'Photon returned an OAuth client without a default redirect URI.',
      {
        next: [
          {
            description: `Update OAuth client ${client.clientId} with a default redirect URI, then retry.`
          }
        ]
      }
    )
  }
  return defaultRedirect.uri
}

const selectScopes = (
  client: GetOrganizationOauthClientOutput,
  requested: readonly string[] | undefined,
  supported: readonly string[]
): readonly string[] => {
  const selected = validateOauthScopes(requested ?? client.scopes)
  const unregistered = selected.filter(
    (scope) => !(STANDARD_SCOPES.has(scope) || client.scopes.includes(scope))
  )
  if (unregistered.length > 0) {
    throw argumentValidationError(
      `OAuth client ${client.clientId} is not registered for: ${unregistered.join(', ')}.`
    )
  }

  const scopes = [...new Set(['openid', ...selected])]
  const supportedScopes = new Set(supported)
  const unavailable = scopes.filter((scope) => !supportedScopes.has(scope))
  if (unavailable.length > 0) {
    throw new CliError(
      'OAUTH_SCOPE_UNAVAILABLE',
      'The OAuth authorization server does not advertise every requested scope.',
      {
        detail: `Unavailable scopes: ${unavailable.join(', ')}.`,
        next: [
          {
            description: 'Inspect the live Photon OAuth scope catalogue',
            run: `${CLI_NAME} account oauth scope list`
          },
          {
            description:
              'Wait for the missing scopes to be published before retrying.'
          }
        ]
      }
    )
  }
  return scopes
}

export const createOauthAuthorization = (
  options: CreateOauthAuthorizationOptions
): OauthAuthorization => {
  const redirectUri = selectRedirectUri(options.client, options.redirectUri)
  const scopes = selectScopes(
    options.client,
    options.scopes,
    options.scopesSupported
  )
  const nonce = options.randomBytes(32).toString('base64url')
  const state = options.randomBytes(32).toString('base64url')
  const authorizationUrl = new URL(options.server.authorizationEndpoint)
  authorizationUrl.searchParams.set('client_id', options.client.clientId)
  authorizationUrl.searchParams.set('nonce', nonce)
  authorizationUrl.searchParams.set('redirect_uri', redirectUri)
  authorizationUrl.searchParams.set('response_type', 'code')
  authorizationUrl.searchParams.set('scope', scopes.join(' '))
  authorizationUrl.searchParams.set('state', state)

  return {
    authorizationUrl: authorizationUrl.toString(),
    clientId: options.client.clientId,
    issuer: options.server.issuer,
    nonce,
    redirectUri,
    scopes,
    state
  }
}
