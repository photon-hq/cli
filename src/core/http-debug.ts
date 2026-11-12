import { performance } from 'node:perf_hooks'
import { INTERNAL_SENSITIVE_PATH_PATTERNS } from '#internal'

export type HttpBodyOmissionReason =
  | 'invalid-json'
  | 'non-json'
  | 'too-large'
  | 'unreadable'

export type HttpBodyDiagnostic =
  | { kind: 'empty' }
  | { kind: 'json'; value: JsonDiagnosticValue }
  | {
      kind: 'omitted'
      mediaType?: string
      reason: HttpBodyOmissionReason
      sizeBytes?: number
    }

export interface HttpRequestDiagnostic {
  body: HttpBodyDiagnostic
  headers: Readonly<Record<string, string>>
  method: string
  queryParameterNames?: readonly string[]
  url: string
}

export interface HttpResponseDiagnostic {
  body: HttpBodyDiagnostic
  headers: Readonly<Record<string, string>>
  requestId?: string
  status: number
  statusText?: string
}

export interface HttpTransportErrorDiagnostic {
  code?: string
  message: string
  name: string
}

export interface HttpExchangeDiagnostic {
  durationMs: number
  request: HttpRequestDiagnostic
  response?: HttpResponseDiagnostic
  sequence: number
  startedAt: string
  transportError?: HttpTransportErrorDiagnostic
}

export interface HttpTraceDiagnostic {
  droppedExchangeCount: number
  exchanges: readonly HttpExchangeDiagnostic[]
}

export interface HttpTraceSource {
  settle: () => Promise<void>
  snapshot: () => HttpTraceDiagnostic | undefined
}

export type JsonDiagnosticValue =
  | JsonDiagnosticValue[]
  | { [key: string]: JsonDiagnosticValue }
  | boolean
  | null
  | number
  | string

interface HttpDebugRecorderOptions {
  now?: () => number
  trustedOrigin: string
}

interface BoundedBody {
  bytes?: Uint8Array
  sizeBytes: number
  tooLarge: boolean
}

const MAXIMUM_BODY_BYTES = 16 * 1024
const MAXIMUM_COLLECTION_ITEMS = 100
const MAXIMUM_DEBUG_EXCHANGES = 25
const MAXIMUM_FIRST_EXCHANGES = 3
const MAXIMUM_JSON_DEPTH = 8
const MAXIMUM_LATEST_EXCHANGES =
  MAXIMUM_DEBUG_EXCHANGES - MAXIMUM_FIRST_EXCHANGES
const MAXIMUM_STRING_LENGTH = 4096
const MAXIMUM_HEADER_VALUE_LENGTH = 1024
const MAXIMUM_ERROR_NAME_LENGTH = 128
const MAXIMUM_ERROR_MESSAGE_LENGTH = 1024

const REDACTED = '[REDACTED]'
const EXTERNAL_PATH_REDACTED = '[REDACTED]'
const MAXIMUM_DEPTH_MARKER = '[MAXIMUM DEPTH REACHED]'

const REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'traceparent',
  'user-agent',
  'x-client-request-id',
  'x-correlation-id',
  'x-request-id'
])

const RESPONSE_HEADERS = new Set([
  'age',
  'cache-control',
  'cf-ray',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'date',
  'etag',
  'keep-alive',
  'last-modified',
  'retry-after',
  'server',
  'traceparent',
  'transfer-encoding',
  'vary',
  'via',
  'x-amz-cf-id',
  'x-amzn-requestid',
  'x-amzn-trace-id',
  'x-client-request-id',
  'x-correlation-id',
  'x-envoy-upstream-service-time',
  'x-request-id',
  'x-vercel-id'
])

const CREDENTIAL_HEADER_PARTS = [
  'credential',
  'password',
  'secret',
  'session',
  'signature',
  'token'
] as const

const SENSITIVE_KEY_PARTS = [
  'accesskey',
  'address',
  'apikey',
  'authorization',
  'bankaccount',
  'cardnumber',
  'checkouturl',
  'cookie',
  'credential',
  'cvc',
  'cvv',
  'devicecode',
  'appealreason',
  'description',
  'email',
  'embeddedlinksample',
  'feedback',
  'firstname',
  'formfields',
  'fullname',
  'lastname',
  'messageflow',
  'passphrase',
  'password',
  'paymentintentid',
  'paymentmethodid',
  'phonenumber',
  'otppin',
  'privatekey',
  'profile',
  'providerid',
  'routingnumber',
  'samplemessages',
  'secret',
  'session',
  'signature',
  'token',
  'taxid',
  'uploadurl',
  'usercode',
  'verificationcode',
  'verificationuricomplete'
] as const

const SENSITIVE_KEYS = new Set([
  'address',
  'apikey',
  'auth',
  'authentication',
  'authheader',
  'bankaccount',
  'bearer',
  'cardnumber',
  'chargeid',
  'challengecontext',
  'checkouturl',
  'checkoutsessionid',
  'clientsecret',
  'cvc',
  'cvv',
  'devicecode',
  'email',
  'ein',
  'feedback',
  'firstname',
  'formfields',
  'fullname',
  'lastname',
  'otp',
  'otppin',
  'paymentintentid',
  'paymentmethodid',
  'phone',
  'phonenumber',
  'pin',
  'profile',
  'privatekey',
  'providercustomerid',
  'providerid',
  'routingnumber',
  'setupintentid',
  'subscriptionid',
  'taxid',
  'uploadurl',
  'uri',
  'usercode',
  'verificationcode',
  'verificationuricomplete'
])

// A URL runs to whitespace or to a character that is never part of one (a
// double quote or an angle bracket). A closing parenthesis or bracket ends it
// unless it closes one opened inside it (/wiki/Foo_(bar), an IPv6 host, a
// [REDACTED] the credential pass left in its query), so "(see https://…)"
// ends at its ")". An apostrophe is legal in a URL (RFC 3986 sub-delims): one
// followed by a letter or digit is part of it, as in /users/o'brien, and any
// other closes a quote ('https://…') or ends the sentence.
const URL_PATTERN =
  /https?:\/\/(?:\([^\s<>"()[\]]*\)|\[[^\s<>"()[\]]*\]|'(?=[\p{L}\p{N}])|[^\s<>"')\]])+/giu
const SAFE_ERROR_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const JSON_MEDIA_TYPE_PATTERN =
  /^(?:application|text)\/(?:[a-z0-9.+-]*\+)?json$/u
// A created or rotated OAuth client secret is returned once, in a generic
// "value" member. The policy has no request method, so the secret's metadata is
// redacted too.
const OAUTH_CLIENT_SECRET_PATH_PATTERN =
  /^\/v1\/organizations\/[^/]+\/oauth\/clients\/[^/]+\/secret(?:\/rotate)?\/?$/u
const VOICE_PROFILE_PATH_PATTERN =
  /^\/v1\/projects\/[^/]+\/platforms\/voice\/profiles(?:\/[^/]+(?:\/(?:inbound|outbound(?:\/rotate)?))?)?\/?$/u
const WHATSAPP_CONNECT_PATH_PATTERN =
  /^\/v1\/projects\/[^/]+\/platforms\/whatsapp-business\/numbers\/?$/u
const WHATSAPP_VERIFICATION_CODE_PATH_PATTERN =
  /^\/v1\/projects\/[^/]+\/platforms\/whatsapp-business\/numbers\/[^/]+\/verification-code\/?$/u

const AUTHORIZATION_SCHEME_PATTERN = /((?:Basic|Bearer)\s+)[^\s,;]+/giu
// Each matches a key, what separates it from its value, and the value.
const KEYED_REDACTION_PATTERNS = [
  /((?:access|refresh|device|id)[_-]?token)(["'=:\s]+)([^\s,;"']+)/giu,
  /(api[_ -]?key|client[_-]?secret|device[_-]?code|secret)(["'=:\s]+)([^\s,;"']+)/giu,
  /(ein|otp(?:[_ -]?pin)?|pin|tax[_ -]?id)(["'=:\s]+)([^\s,;"']+)/giu
] as const
// A key containing a credential word, `=` or `:` right after it, and its
// value, quoted or not: `token=abc`, `token: abc`, `?token="abc"`,
// `"pageToken": "abc"`, `DB_PASSWORD='abc'`. A key counts only with its
// separator, as in Sentry's PII scrubber, so "Unexpected token < in JSON" is
// kept. The words name a value that is the secret itself. SENSITIVE_KEY_PARTS
// is right for a JSON key but too broad here: description, email or address is
// ordinary prose before a colon, and session or credential more often starts a
// sentence ("Cannot read the session: …") or names a kind ("Credential:
// oauth") than holds a secret. A key never starts after a slash, so a URL path
// such as /oauth/token: 404 or /tokens:rotate isn't one; the lookbehind also
// scans a long run of word characters once rather than from each of them.
// A quoted value runs to its closing quote, past escaped ones. An unquoted one
// ends where a query parameter or a JSON value would, less any ")", "}" or ">"
// that closes it, so {"token":123} stays balanced and ab)cd is redacted whole;
// a "]" stays in it, so a [REDACTED] an earlier rule wrote is matched whole. A
// URL value is left to the URL pass, which drops its query string: taken as a
// value, it would end at the first "&" and leave the rest of the query.
const CREDENTIAL_KEY_VALUE_PATTERN =
  /((?<![\w/-])[\w-]*(?:passphrase|passwd|password|private[_-]?key|secret|token)[\w-]*["']?[=:][^\S\r\n]*)(?:(")(?:[^"\\\r\n]|\\.)+"|(')(?:[^'\\\r\n]|\\.)+'|(?!https?:\/\/)["']?[^\s,;"'&]*[^\s,;"'&)}>])/giu
const WHITESPACE_PATTERN = /^\s+$/u
// A key followed by only spaces reads like prose ("API Key Not Found", "OAuth
// Secret Already Configured") or ends a function's name in a stack frame
// ("setUpClientSecret (/app/oauth.ts:12:3)"), so there a value is kept when it
// reads as a word (lowercase or capitalized letters, at most 24, maybe ending
// a sentence) or as the frame's location.
const PLAIN_WORD_PATTERN = /^\p{Lu}?\p{Ll}{1,23}[.!?]?$/u
const STACK_FRAME_LOCATION_PATTERN = /^\([^()]+:\d+:\d+\)$/u
const COMPLETE_REDACTION_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/gu,
  /otpauth:\/\/[^\s<>"')]+/giu,
  // A complete account service key, project API key or service identity API key.
  // A key ID alone, with no secret after it, is kept. A service identity
  // key's secret is its provider's, whose grammar is unspecified.
  /pho_(?:ask|sk)_[0-7][0-9a-hjkmnp-tv-z]{25}_[A-Za-z0-9_-]+/gu,
  /pho_scred_[0-7][0-9a-hjkmnp-tv-z]{25}_[^\s"',;<>]+/gu,
  /\b\d{2}-\d{7}\b/gu,
  /\+[1-9]\d{7,14}\b/gu
] as const

// A kept word is scanned again, since it may be a key itself ("pin otp 123456").
const redactKeyedValues = (value: string, pattern: RegExp): string => {
  let redacted = ''
  let copied = 0
  pattern.lastIndex = 0
  let match = pattern.exec(value)
  while (match !== null) {
    const [, key = '', separator = '', candidate = ''] = match
    const start = match.index + key.length + separator.length
    if (
      WHITESPACE_PATTERN.test(separator) &&
      (PLAIN_WORD_PATTERN.test(candidate) ||
        STACK_FRAME_LOCATION_PATTERN.test(candidate))
    ) {
      pattern.lastIndex = start
    } else {
      redacted += `${value.slice(copied, start)}${REDACTED}`
      copied = start + candidate.length
    }
    match = pattern.exec(value)
  }
  return redacted + value.slice(copied)
}

const registeredSecrets = new Set<string>()
const MINIMUM_REGISTERED_SECRET_LENGTH = 8

/**
 * Redacts this exact value wherever credentials are redacted, for the rest of
 * the process: a credential the CLI sends whose shape no pattern knows, such
 * as a key from the environment. A value shorter than 8 characters is
 * ignored, since redacting it everywhere would garble the output around it.
 */
export const registerSecret = (secret: string): void => {
  if (secret.length >= MINIMUM_REGISTERED_SECRET_LENGTH) {
    registeredSecrets.add(secret)
  }
}

/** The text with every credential the patterns know redacted, URLs left whole. */
export const redactCredentials = (value: string): string => {
  let redacted = value
  for (const secret of registeredSecrets) {
    redacted = redacted.replaceAll(secret, REDACTED)
  }
  redacted = redacted.replace(AUTHORIZATION_SCHEME_PATTERN, `$1${REDACTED}`)
  for (const pattern of KEYED_REDACTION_PATTERNS) {
    redacted = redactKeyedValues(redacted, pattern)
  }
  // $2 or $3 is the value's quote, kept around the redaction.
  redacted = redacted.replace(
    CREDENTIAL_KEY_VALUE_PATTERN,
    `$1$2$3${REDACTED}$2$3`
  )
  for (const pattern of COMPLETE_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED)
  }
  return redacted
}

export const redactDiagnosticText = (value: string): string =>
  redactCredentials(value).replace(URL_PATTERN, (candidate) => {
    try {
      const url = new URL(candidate)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return REDACTED
    }
  })

const cleanText = (value: string, maximumLength: number): string => {
  const redacted = redactDiagnosticText(value)
  if (redacted.length <= maximumLength) {
    return redacted
  }
  return `${redacted.slice(0, maximumLength)}[TRUNCATED]`
}

const normalizedKey = (key: string): string =>
  key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '')

export const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key)
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  )
}

const sanitizeUrlValue = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return
    }
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    // Non-URL strings are sanitized as ordinary text.
  }
}

const sanitizeStringValue = (value: string): string =>
  sanitizeUrlValue(value) ?? cleanText(value, MAXIMUM_STRING_LENGTH)

export const sanitizeJsonValue = (
  value: unknown,
  depth = 0
): JsonDiagnosticValue => {
  if (depth >= MAXIMUM_JSON_DEPTH) {
    return MAXIMUM_DEPTH_MARKER
  }
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'string') {
    return sanitizeStringValue(value)
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAXIMUM_COLLECTION_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1))
    if (value.length > MAXIMUM_COLLECTION_ITEMS) {
      items.push(
        `[${(value.length - MAXIMUM_COLLECTION_ITEMS).toString()} ITEMS OMITTED]`
      )
    }
    return items
  }
  if (typeof value !== 'object') {
    return cleanText(String(value), MAXIMUM_STRING_LENGTH)
  }

  const entries = Object.entries(value).slice(0, MAXIMUM_COLLECTION_ITEMS)
  const sanitizedEntries: [string, JsonDiagnosticValue][] = entries.map(
    ([key, fieldValue]) => {
      const safeKey = cleanText(key, 256)
      return [
        safeKey,
        isSensitiveKey(key)
          ? REDACTED
          : sanitizeJsonValue(fieldValue, depth + 1)
      ]
    }
  )
  const omittedFieldCount = Object.keys(value).length - entries.length
  if (omittedFieldCount > 0) {
    sanitizedEntries.push(['$photonDebugOmittedFields', omittedFieldCount])
  }
  return Object.fromEntries(sanitizedEntries)
}

const contentLength = (headers: Headers): number | undefined => {
  const value = headers.get('content-length')
  if (value === null) {
    return
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const mediaType = (headers: Headers): string | undefined => {
  const value = headers.get('content-type')?.split(';', 1)[0]?.trim()
  return value === undefined || value.length === 0
    ? undefined
    : value.toLocaleLowerCase('en-US')
}

const omittedBody = (
  reason: HttpBodyOmissionReason,
  headers: Headers,
  sizeBytes?: number
): HttpBodyDiagnostic => {
  const type = mediaType(headers)
  return {
    kind: 'omitted',
    reason,
    ...(type === undefined ? {} : { mediaType: type }),
    ...(sizeBytes === undefined ? {} : { sizeBytes })
  }
}

const cancelUninspectedBody = (body: ReadableStream<Uint8Array>): void => {
  // `Response.clone()` tees its body. A retrying transport can cancel the
  // original branch only after this diagnostic branch is consumed or
  // cancelled, so leaving an omitted body untouched can deadlock the retry.
  // Defer one turn so an in-memory undici body can finish initializing before
  // both tee branches are cancelled. Do not await here: tee cancellation
  // itself settles only after the caller finishes with the original branch.
  setTimeout(() => {
    body.cancel().catch(() => undefined)
  }, 0)
}

const readBoundedBody = async (
  body: ReadableStream<Uint8Array>
): Promise<BoundedBody> => {
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  let sizeBytes = 0
  try {
    let chunk = await reader.read()
    while (!chunk.done) {
      sizeBytes += chunk.value.byteLength
      if (sizeBytes > MAXIMUM_BODY_BYTES) {
        // biome-ignore lint/performance/noAwaitInLoops: canceling the sequential stream prevents further buffering.
        await reader.cancel()
        return { sizeBytes, tooLarge: true }
      }
      chunks.push(chunk.value)
      chunk = await reader.read()
    }
    return {
      bytes: Buffer.concat(chunks, sizeBytes),
      sizeBytes,
      tooLarge: false
    }
  } finally {
    reader.releaseLock()
  }
}

const captureJsonBody = async (
  body: ReadableStream<Uint8Array>,
  headers: Headers
): Promise<HttpBodyDiagnostic> => {
  try {
    const captured = await readBoundedBody(body)
    if (captured.tooLarge) {
      return omittedBody('too-large', headers, captured.sizeBytes)
    }
    if (captured.sizeBytes === 0 || captured.bytes === undefined) {
      return { kind: 'empty' }
    }
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(captured.bytes)
      )
      return { kind: 'json', value: sanitizeJsonValue(parsed) }
    } catch {
      return omittedBody('invalid-json', headers, captured.sizeBytes)
    }
  } catch {
    return omittedBody('unreadable', headers)
  }
}

const captureBody = async (
  body: ReadableStream<Uint8Array> | null,
  headers: Headers
): Promise<HttpBodyDiagnostic> => {
  if (body === null || contentLength(headers) === 0) {
    return { kind: 'empty' }
  }
  const length = contentLength(headers)
  if (length !== undefined && length > MAXIMUM_BODY_BYTES) {
    cancelUninspectedBody(body)
    return omittedBody('too-large', headers, length)
  }
  const type = mediaType(headers)
  if (type === undefined || !JSON_MEDIA_TYPE_PATTERN.test(type)) {
    cancelUninspectedBody(body)
    return omittedBody('non-json', headers, length)
  }
  return await captureJsonBody(body, headers)
}

const redactRouteSensitiveBody = (
  body: HttpBodyDiagnostic,
  endpoint: string,
  trustedOrigin: string,
  context: { direction: 'request' | 'response'; status?: number } = {
    direction: 'request'
  }
): HttpBodyDiagnostic => {
  if (body.kind !== 'json') {
    return body
  }
  try {
    const url = new URL(endpoint)
    if (
      url.origin === trustedOrigin &&
      (INTERNAL_SENSITIVE_PATH_PATTERNS.some((pattern) =>
        pattern.test(url.pathname)
      ) ||
        VOICE_PROFILE_PATH_PATTERN.test(url.pathname) ||
        (context.direction === 'request' &&
          WHATSAPP_CONNECT_PATH_PATTERN.test(url.pathname)) ||
        (context.direction === 'response' &&
          context.status !== undefined &&
          context.status >= 200 &&
          context.status < 300 &&
          (OAUTH_CLIENT_SECRET_PATH_PATTERN.test(url.pathname) ||
            WHATSAPP_VERIFICATION_CODE_PATH_PATTERN.test(url.pathname))))
    ) {
      return { kind: 'json', value: REDACTED }
    }
  } catch {
    // An unavailable endpoint cannot match a route-sensitive body policy.
  }
  return body
}

const isCredentialHeader = (name: string): boolean => {
  const normalized = normalizedKey(name)
  return (
    normalized === 'authorization' ||
    normalized === 'proxyauthorization' ||
    normalized === 'cookie' ||
    normalized === 'setcookie' ||
    normalized === 'apikey' ||
    normalized === 'xapikey' ||
    CREDENTIAL_HEADER_PARTS.some((part) => normalized.includes(part))
  )
}

const isRateLimitHeader = (name: string): boolean =>
  name.startsWith('ratelimit-') || name.startsWith('x-ratelimit-')

const captureHeaders = (
  headers: Headers,
  allowedHeaders: ReadonlySet<string>,
  allowRateLimits = false
): Readonly<Record<string, string>> => {
  const entries: [string, string][] = []
  headers.forEach((value, name) => {
    const normalizedName = name.toLocaleLowerCase('en-US')
    if (isCredentialHeader(normalizedName)) {
      return
    }
    if (
      !(
        allowedHeaders.has(normalizedName) ||
        (allowRateLimits && isRateLimitHeader(normalizedName))
      )
    ) {
      return
    }
    entries.push([
      normalizedName,
      cleanText(value, MAXIMUM_HEADER_VALUE_LENGTH)
    ])
  })
  entries.sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(entries)
}

const sanitizeEndpoint = (
  value: string,
  trustedOrigin: string | undefined
): Pick<HttpRequestDiagnostic, 'queryParameterNames' | 'url'> => {
  try {
    const url = new URL(value)
    if (url.origin !== trustedOrigin) {
      return { url: `${url.origin}/${EXTERNAL_PATH_REDACTED}` }
    }
    const queryParameterNames = [...new Set(url.searchParams.keys())].sort()
    return {
      url: `${url.origin}${url.pathname}`,
      ...(queryParameterNames.length === 0 ? {} : { queryParameterNames })
    }
  } catch {
    return { url: '[UNAVAILABLE]' }
  }
}

const diagnosticRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1]
): Request => {
  const source = input instanceof Request ? input.clone() : input
  return new Request(source, init)
}

const fallbackRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  trustedOrigin: string
): HttpRequestDiagnostic => {
  const inputRequest = input instanceof Request ? input : undefined
  const url = inputRequest?.url ?? String(input)
  let headers = new Headers()
  try {
    headers = new Headers(init?.headers ?? inputRequest?.headers)
  } catch {
    // Invalid headers are left for the underlying fetch implementation to reject.
  }
  return {
    body: omittedBody('unreadable', headers),
    headers: captureHeaders(headers, REQUEST_HEADERS),
    method: cleanText(init?.method ?? inputRequest?.method ?? 'GET', 32),
    ...sanitizeEndpoint(url, trustedOrigin)
  }
}

const captureRequest = async (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  trustedOrigin: string
): Promise<HttpRequestDiagnostic> => {
  try {
    const request = diagnosticRequest(input, init)
    const body = await captureBody(request.body, request.headers)
    return {
      body: redactRouteSensitiveBody(body, request.url, trustedOrigin, {
        direction: 'request'
      }),
      headers: captureHeaders(request.headers, REQUEST_HEADERS),
      method: cleanText(request.method, 32),
      ...sanitizeEndpoint(request.url, trustedOrigin)
    }
  } catch {
    return fallbackRequest(input, init, trustedOrigin)
  }
}

const responseRequestId = (
  headers: Readonly<Record<string, string>>
): string | undefined => {
  const correlationHeaders = [
    'x-request-id',
    'x-correlation-id',
    'x-client-request-id'
  ]
  for (const name of correlationHeaders) {
    const entry = Object.entries(headers).find(([key]) => key === name)
    if (entry !== undefined) {
      return entry[1]
    }
  }
}

const captureResponse = async (
  response: Response,
  endpoint: string,
  trustedOrigin: string
): Promise<HttpResponseDiagnostic> => {
  const headers = captureHeaders(response.headers, RESPONSE_HEADERS, true)
  try {
    const cloned = response.clone()
    const body = redactRouteSensitiveBody(
      await captureBody(cloned.body, cloned.headers),
      endpoint,
      trustedOrigin,
      { direction: 'response', status: response.status }
    )
    const requestId = responseRequestId(headers)
    const statusText = cleanText(response.statusText, 256)
    return {
      body,
      headers,
      ...(requestId === undefined ? {} : { requestId }),
      status: response.status,
      ...(statusText.length === 0 ? {} : { statusText })
    }
  } catch {
    return {
      body: omittedBody('unreadable', response.headers),
      headers,
      status: response.status
    }
  }
}

const transportErrorCode = (error: unknown): string | undefined => {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !SAFE_ERROR_CODE_PATTERN.test(error.code)
  ) {
    return
  }
  return error.code
}

const sanitizeErrorUrls = (
  message: string,
  trustedOrigin: string | undefined
): string =>
  message.replace(URL_PATTERN, (candidate) => {
    const { url } = sanitizeEndpoint(candidate, trustedOrigin)
    return url
  })

const cleanErrorText = (
  value: string,
  trustedOrigin: string | undefined,
  maximumLength: number
): string =>
  cleanText(
    sanitizeErrorUrls(redactCredentials(value), trustedOrigin),
    maximumLength
  )

export const errorDiagnostic = (
  error: Error,
  trustedOrigin?: string
): { message: string; name: string; stack?: string } => ({
  message: cleanErrorText(
    error.message,
    trustedOrigin,
    MAXIMUM_ERROR_MESSAGE_LENGTH
  ),
  name: cleanErrorText(error.name, trustedOrigin, MAXIMUM_ERROR_NAME_LENGTH),
  ...(error.stack === undefined
    ? {}
    : {
        stack: cleanErrorText(error.stack, trustedOrigin, MAXIMUM_STRING_LENGTH)
      })
})

const captureTransportError = (
  error: unknown,
  trustedOrigin: string
): HttpTransportErrorDiagnostic => {
  const { message, name } =
    error instanceof Error
      ? errorDiagnostic(error, trustedOrigin)
      : {
          message: 'The HTTP transport failed with a non-Error value.',
          name: 'Error'
        }
  const code = transportErrorCode(error)
  return {
    ...(code === undefined ? {} : { code }),
    message,
    name
  }
}

export class HttpDebugRecorder implements HttpTraceSource {
  readonly #firstExchanges: HttpExchangeDiagnostic[] = []
  readonly #latestExchanges: HttpExchangeDiagnostic[] = []
  readonly #now: () => number
  readonly #pending = new Set<Promise<void>>()
  readonly #trustedOrigin: string
  #completedExchangeCount = 0
  #nextSequence = 1

  constructor(options: HttpDebugRecorderOptions) {
    this.#now = options.now ?? Date.now
    this.#trustedOrigin = options.trustedOrigin
  }

  wrap(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const sequence = this.#nextSequence
      this.#nextSequence += 1
      const startedAt = new Date(this.#now()).toISOString()
      const startedAtMonotonic = performance.now()
      const request = captureRequest(input, init, this.#trustedOrigin)

      try {
        const response = await fetchImplementation(input, init)
        const durationMs = this.#duration(startedAtMonotonic)
        const endpoint = input instanceof Request ? input.url : String(input)
        const capture = Promise.all([
          request,
          captureResponse(response, endpoint, this.#trustedOrigin)
        ]).then(([requestDiagnostic, responseDiagnostic]) => {
          this.#record({
            durationMs,
            request: requestDiagnostic,
            response: responseDiagnostic,
            sequence,
            startedAt
          })
        })
        this.#track(capture)
        return response
      } catch (error) {
        const durationMs = this.#duration(startedAtMonotonic)
        const capture = request.then((requestDiagnostic) => {
          this.#record({
            durationMs,
            request: requestDiagnostic,
            sequence,
            startedAt,
            transportError: captureTransportError(error, this.#trustedOrigin)
          })
        })
        this.#track(capture)
        throw error
      }
    }
  }

  async settle(): Promise<void> {
    await Promise.all([...this.#pending])
  }

  snapshot(): HttpTraceDiagnostic | undefined {
    const exchanges = [...this.#firstExchanges, ...this.#latestExchanges].sort(
      (left, right) => left.sequence - right.sequence
    )
    if (exchanges.length === 0) {
      return
    }
    return {
      droppedExchangeCount: this.#completedExchangeCount - exchanges.length,
      exchanges
    }
  }

  #duration(startedAt: number): number {
    return Math.max(0, Math.round(performance.now() - startedAt))
  }

  #record(exchange: HttpExchangeDiagnostic): void {
    this.#completedExchangeCount += 1
    if (exchange.sequence <= MAXIMUM_FIRST_EXCHANGES) {
      this.#firstExchanges.push(exchange)
      return
    }
    if (this.#latestExchanges.length < MAXIMUM_LATEST_EXCHANGES) {
      this.#latestExchanges.push(exchange)
      return
    }
    let earliestIndex = 0
    for (let index = 1; index < this.#latestExchanges.length; index += 1) {
      const candidate = this.#latestExchanges[index]
      const earliest = this.#latestExchanges[earliestIndex]
      if (
        candidate !== undefined &&
        earliest !== undefined &&
        candidate.sequence < earliest.sequence
      ) {
        earliestIndex = index
      }
    }
    const earliest = this.#latestExchanges[earliestIndex]
    if (earliest !== undefined && exchange.sequence > earliest.sequence) {
      this.#latestExchanges[earliestIndex] = exchange
    }
  }

  #track(capture: Promise<void>): void {
    const safeCapture = capture.catch(() => undefined)
    this.#pending.add(safeCapture)
    safeCapture.finally(() => {
      this.#pending.delete(safeCapture)
    })
  }
}
