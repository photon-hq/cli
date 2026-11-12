import { z } from 'zod'
import { transportCode } from '../core/api-problem.ts'
import { CliError } from '../core/errors.ts'
import { NetworkError, withNetworkErrors } from '../core/network.ts'
import { isOauthLoopbackHostname } from './url.ts'

export interface OauthAuthorizationServer {
  authorizationEndpoint: string
  issuer: string
  protectedResourceMetadataUrl: string
  resource: string
  tokenEndpoint: string
}

interface OauthDiscoveryOptions {
  apiOrigin: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAXIMUM_METADATA_BYTES = 256 * 1024

const protectedResourceSchema = z.object({
  authorization_servers: z.array(z.url()).min(1).max(10),
  resource: z.url()
})

const authorizationServerSchema = z.object({
  authorization_endpoint: z.url(),
  issuer: z.url(),
  token_endpoint: z.url()
})

const protocolError = (detail: string, cause?: unknown): CliError =>
  new CliError(
    'OAUTH_DISCOVERY_PROTOCOL_ERROR',
    'Photon returned invalid OAuth discovery metadata.',
    {
      ...(cause === undefined ? {} : { cause }),
      detail,
      retryable: true
    }
  )

const unavailableError = (
  detail: string,
  options: {
    cause?: unknown
    httpStatus?: number
    transportCode?: string | undefined
  } = {}
): CliError =>
  new CliError(
    'OAUTH_DISCOVERY_UNAVAILABLE',
    'Photon could not discover the OAuth authorization server.',
    {
      ...options,
      detail,
      retryable: true
    }
  )

const metadataUrl = (apiOrigin: string): URL =>
  new URL('/.well-known/oauth-protected-resource', apiOrigin)

const authorizationServerMetadataUrl = (issuer: string): URL => {
  const issuerUrl = new URL(issuer)
  const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname
  issuerUrl.pathname = `/.well-known/oauth-authorization-server${issuerPath}`
  issuerUrl.search = ''
  issuerUrl.hash = ''
  return issuerUrl
}

const isSecureUrl = (value: string): boolean => {
  const url = new URL(value)
  const localHttp =
    url.protocol === 'http:' && isOauthLoopbackHostname(url.hostname)
  return (
    (url.protocol === 'https:' || localHttp) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
  )
}

const normalizedResourceIdentifier = (value: string): string => {
  const resource = new URL(value)
  return resource.pathname === '/' &&
    resource.search.length === 0 &&
    resource.hash.length === 0
    ? resource.origin
    : resource.toString()
}

const requestSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
}

const responseJson = async (
  response: Response,
  label: string
): Promise<unknown> => {
  const contentLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAXIMUM_METADATA_BYTES
  ) {
    throw protocolError(`${label} metadata exceeded the response size limit.`)
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAXIMUM_METADATA_BYTES) {
    throw protocolError(`${label} metadata exceeded the response size limit.`)
  }
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    throw protocolError(
      `${label} metadata was not a valid JSON document.`,
      error
    )
  }
}

const fetchMetadata = async (
  fetch: typeof globalThis.fetch,
  url: URL,
  label: string,
  signal: AbortSignal
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal
    })
  } catch (error) {
    if (error instanceof NetworkError) {
      throw unavailableError(error.message, {
        cause: error,
        transportCode: transportCode(error)
      })
    }
    signal.throwIfAborted()
    throw unavailableError(`No ${label} metadata response was received.`, {
      cause: error
    })
  }
  if (!response.ok) {
    throw unavailableError(
      `${label} metadata returned HTTP ${response.status.toString()}.`,
      { httpStatus: response.status }
    )
  }
  return await responseJson(response, label)
}

const assertSecureMetadataUrl = (value: string, label: string): void => {
  if (!isSecureUrl(value)) {
    throw protocolError(`${label} must be a secure URL.`)
  }
}

export const discoverOauthAuthorizationServer = async (
  options: OauthDiscoveryOptions
): Promise<OauthAuthorizationServer> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const fetch = withNetworkErrors(options.fetch ?? globalThis.fetch, {
    timeoutMs
  })
  const signal = requestSignal(options.signal, timeoutMs)
  const protectedResourceMetadataUrl = metadataUrl(options.apiOrigin)
  const protectedResourceResult = protectedResourceSchema.safeParse(
    await fetchMetadata(
      fetch,
      protectedResourceMetadataUrl,
      'protected-resource',
      signal
    )
  )
  if (!protectedResourceResult.success) {
    throw protocolError(
      'Protected-resource metadata did not match the expected schema.'
    )
  }

  const protectedResource = protectedResourceResult.data
  if (
    normalizedResourceIdentifier(protectedResource.resource) !==
    normalizedResourceIdentifier(options.apiOrigin)
  ) {
    throw protocolError(
      'Protected-resource metadata identified a different Photon API resource.'
    )
  }
  const [issuer] = protectedResource.authorization_servers
  if (issuer === undefined) {
    throw protocolError(
      'Protected-resource metadata did not advertise an authorization server.'
    )
  }
  assertSecureMetadataUrl(issuer, 'OAuth authorization-server issuer')

  const authorizationMetadataUrl = authorizationServerMetadataUrl(issuer)
  const authorizationServerResult = authorizationServerSchema.safeParse(
    await fetchMetadata(
      fetch,
      authorizationMetadataUrl,
      'authorization-server',
      signal
    )
  )
  if (!authorizationServerResult.success) {
    throw protocolError(
      'Authorization-server metadata did not match the expected schema.'
    )
  }

  const authorizationServer = authorizationServerResult.data
  if (authorizationServer.issuer !== issuer) {
    throw protocolError(
      'Authorization-server metadata returned an unexpected issuer.'
    )
  }
  assertSecureMetadataUrl(
    authorizationServer.authorization_endpoint,
    'OAuth authorization endpoint'
  )
  assertSecureMetadataUrl(
    authorizationServer.token_endpoint,
    'OAuth token endpoint'
  )

  return {
    authorizationEndpoint: authorizationServer.authorization_endpoint,
    issuer,
    protectedResourceMetadataUrl: protectedResourceMetadataUrl.toString(),
    resource: protectedResource.resource,
    tokenEndpoint: authorizationServer.token_endpoint
  }
}
