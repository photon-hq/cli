import { validateId } from '../core/photon-id.ts'
import {
  boundedText,
  invalidInput,
  validateOpaqueToken
} from '../core/validation.ts'
import { validateIdempotencyKey } from '../operation/types.ts'
import type {
  OauthClientCreateInput,
  OauthClientUpdateInput,
  OauthConnectionListInput
} from './service.ts'
import { isOauthLoopbackHostname } from './url.ts'

const MAXIMUM_CLIENT_DESCRIPTION_LENGTH = 500
const MAXIMUM_CLIENT_NAME_LENGTH = 100
const MAXIMUM_CONNECTION_CURSOR_LENGTH = 128
const MAXIMUM_CONNECTION_LIMIT = 100
const MAXIMUM_REDIRECT_URI_COUNT = 10
const MAXIMUM_REDIRECT_URI_LENGTH = 2048
const MAXIMUM_SCOPE_COUNT = 20
const MAXIMUM_SCOPE_LENGTH = 128
const OAUTH_SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u

export const validateOauthClientId = (value: string): string =>
  validateId('oauthClient', value, 'OAuth client ID')

// OAuth creations are not journaled; a supplied key repeats an uncertain
// creation instead of starting a new one.
export const validateOauthIdempotencyKey = (
  value: string | undefined
): string | undefined =>
  value === undefined ? undefined : validateIdempotencyKey(value)

export const validateOauthApplicationId = (value: string): string =>
  validateId('oauthApplication', value, 'OAuth application ID')

export const validateOauthConnectionListInput = (input: {
  before?: string | undefined
  limit: number
  order?: 'asc' | 'desc' | 'normal' | undefined
  pageToken?: string | undefined
}): OauthConnectionListInput => {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw invalidInput('Limit must be a positive integer.')
  }
  if (input.limit > MAXIMUM_CONNECTION_LIMIT) {
    throw invalidInput(
      `Limit cannot exceed ${MAXIMUM_CONNECTION_LIMIT.toString()}.`
    )
  }
  return {
    ...(input.pageToken === undefined
      ? {}
      : {
          after: validateOpaqueToken(
            input.pageToken,
            'Page token',
            MAXIMUM_CONNECTION_CURSOR_LENGTH
          )
        }),
    ...(input.before === undefined
      ? {}
      : {
          before: validateOpaqueToken(
            input.before,
            'Before token',
            MAXIMUM_CONNECTION_CURSOR_LENGTH
          )
        }),
    limit: input.limit,
    ...(input.order === undefined ? {} : { order: input.order })
  }
}

const validateRedirectUri = (value: string): string => {
  const normalized = boundedText(
    value,
    'OAuth redirect URI',
    MAXIMUM_REDIRECT_URI_LENGTH
  )
  let redirectUri: URL
  try {
    redirectUri = new URL(normalized)
  } catch {
    // biome-ignore lint/style/useErrorCause: parser internals are intentionally omitted from argument errors.
    throw invalidInput('OAuth redirect URI must be a valid absolute URL.')
  }

  if (redirectUri.username.length > 0 || redirectUri.password.length > 0) {
    throw invalidInput('OAuth redirect URI cannot contain user information.')
  }
  if (redirectUri.hash.length > 0) {
    throw invalidInput('OAuth redirect URI cannot contain a fragment.')
  }

  const secureRedirect = redirectUri.protocol === 'https:'
  const localDevelopmentRedirect =
    redirectUri.protocol === 'http:' &&
    isOauthLoopbackHostname(redirectUri.hostname)
  if (!(secureRedirect || localDevelopmentRedirect)) {
    throw invalidInput(
      'OAuth redirect URI must use HTTPS, except for HTTP loopback development URLs.'
    )
  }

  return normalized
}

const uniqueValues = (values: readonly string[], label: string): string[] => {
  const unique = new Set(values)
  if (unique.size !== values.length) {
    throw invalidInput(`${label} cannot contain duplicate values.`)
  }
  return [...values]
}

const validateRedirectUris = (
  values: readonly string[],
  defaultRedirectUri: string
): OauthClientCreateInput['redirectUris'] => {
  if (values.length === 0) {
    throw invalidInput('Pass at least one --redirect-uri.')
  }
  if (values.length > MAXIMUM_REDIRECT_URI_COUNT) {
    throw invalidInput(
      `OAuth clients cannot have more than ${MAXIMUM_REDIRECT_URI_COUNT.toString()} redirect URIs.`
    )
  }

  const redirectUris = uniqueValues(
    values.map(validateRedirectUri),
    'OAuth redirect URI list'
  )
  const normalizedDefault = validateRedirectUri(defaultRedirectUri)
  if (!redirectUris.includes(normalizedDefault)) {
    throw invalidInput(
      '--default-redirect-uri must exactly match one of the --redirect-uri values.'
    )
  }

  return redirectUris.map((uri) => ({
    default: uri === normalizedDefault,
    uri
  }))
}

export const validateOauthScopes = (
  values: readonly string[],
  clearHint?: string
): string[] => {
  if (values.length > MAXIMUM_SCOPE_COUNT) {
    throw invalidInput(
      `OAuth clients cannot request more than ${MAXIMUM_SCOPE_COUNT.toString()} scopes.`
    )
  }
  const scopes = values.map((value) =>
    boundedText(value, 'OAuth scope', MAXIMUM_SCOPE_LENGTH, clearHint)
  )
  for (const scope of scopes) {
    if (!OAUTH_SCOPE_PATTERN.test(scope)) {
      throw invalidInput(
        'OAuth scopes cannot contain spaces, quotes, backslashes, or control characters.'
      )
    }
  }
  return uniqueValues(scopes, 'OAuth scope list')
}

export const validateOauthClientCreateInput = (input: {
  defaultRedirectUri: string
  description?: string
  name: string
  redirectUris: readonly string[]
  scopes?: readonly string[]
}): OauthClientCreateInput => {
  const description =
    input.description === undefined
      ? undefined
      : boundedText(
          input.description,
          'OAuth client description',
          MAXIMUM_CLIENT_DESCRIPTION_LENGTH
        )
  // The contract requires the scope list; no --scope means no delegated scopes.
  const scopes =
    input.scopes === undefined ? [] : validateOauthScopes(input.scopes)

  return {
    ...(description === undefined ? {} : { description }),
    name: boundedText(
      input.name,
      'OAuth client name',
      MAXIMUM_CLIENT_NAME_LENGTH
    ),
    redirectUris: validateRedirectUris(
      input.redirectUris,
      input.defaultRedirectUri
    ),
    scopes
  }
}

export const validateOauthClientUpdateInput = (input: {
  clearDescription: boolean
  clearScopes: boolean
  defaultRedirectUri?: string
  description?: string
  name?: string
  redirectUris?: readonly string[]
  scopes?: readonly string[]
}): OauthClientUpdateInput => {
  if (
    input.redirectUris !== undefined &&
    input.defaultRedirectUri === undefined
  ) {
    throw invalidInput(
      'Pass --default-redirect-uri when replacing redirect URIs.'
    )
  }
  if (
    input.redirectUris === undefined &&
    input.defaultRedirectUri !== undefined
  ) {
    throw invalidInput(
      'Pass at least one --redirect-uri with --default-redirect-uri.'
    )
  }

  const changes: OauthClientUpdateInput = {}
  if (input.clearDescription) {
    changes.description = null
  } else if (input.description !== undefined) {
    changes.description = boundedText(
      input.description,
      'OAuth client description',
      MAXIMUM_CLIENT_DESCRIPTION_LENGTH,
      'To remove it, pass --clear-description.'
    )
  }
  if (input.name !== undefined) {
    changes.name = boundedText(
      input.name,
      'OAuth client name',
      MAXIMUM_CLIENT_NAME_LENGTH
    )
  }
  if (
    input.redirectUris !== undefined &&
    input.defaultRedirectUri !== undefined
  ) {
    changes.redirectUris = validateRedirectUris(
      input.redirectUris,
      input.defaultRedirectUri
    )
  }
  if (input.clearScopes) {
    changes.scopes = []
  } else if (input.scopes !== undefined) {
    changes.scopes = validateOauthScopes(
      input.scopes,
      'To remove every scope, pass --clear-scopes.'
    )
  }

  if (Object.keys(changes).length === 0) {
    throw invalidInput(
      'Pass a name, description, redirect URI set, scope, or clear option to update the OAuth client.'
    )
  }
  return changes
}
