type FetchInput = Parameters<typeof globalThis.fetch>[0]

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

interface NetworkErrorOptions {
  cause: unknown
  host: string
  timeoutMs?: number
}

/**
 * How long Node.js's fetch waits to set up a connection, the TLS handshake
 * included, before it gives up with UND_ERR_CONNECT_TIMEOUT: undici's
 * documented connect timeout, which Node's own fetch and the CLI's proxy agent
 * (src/core/proxy.ts) both keep. Bun's fetch has no separate limit, so there
 * the request's own time limit covers the connection too.
 */
const CONNECT_TIMEOUT_MS = 10_000

/** An error and its causes, each once, outermost first. */
export const causeChain = (error: unknown): object[] => {
  const chain: object[] = []
  let current = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !chain.includes(current)
  ) {
    chain.push(current)
    current = Reflect.get(current, 'cause')
  }
  return chain
}

/**
 * A request whose proxy couldn't be reached: the proxy refused the
 * connection, or its name didn't resolve. code is the runtime's, ECONNREFUSED
 * or ENOTFOUND. The message names the proxy's host and port, never its
 * credentials.
 */
export class ProxyUnreachableError extends Error {
  readonly code: string

  constructor(options: { cause: unknown; code: string; proxy: URL }) {
    super(`The proxy ${options.proxy.host} could not be reached.`, {
      cause: options.cause
    })
    this.name = 'ProxyUnreachableError'
    this.code = options.code
  }
}

const failureMessage = ({
  cause,
  host,
  timeoutMs
}: NetworkErrorOptions): string => {
  if (timeoutMs !== undefined) {
    const seconds = timeoutMs / 1000
    return `${host} didn't answer within ${seconds.toString()} ${seconds === 1 ? 'second' : 'seconds'}.`
  }
  const proxy = causeChain(cause).find(
    (error) => error instanceof ProxyUnreachableError
  )
  return proxy?.message ?? `${host} could not be reached.`
}

/**
 * A request that got no response. Its message names the host, or the proxy
 * when the proxy couldn't be reached, and after a timeout the time limit.
 * After a timeout its code is TimeoutError, the transport code the CLI
 * reports for every timeout.
 */
export class NetworkError extends Error {
  readonly code: 'TimeoutError' | undefined

  constructor(options: NetworkErrorOptions) {
    super(failureMessage(options), { cause: options.cause })
    this.name = 'NetworkError'
    this.code = options.timeoutMs === undefined ? undefined : 'TimeoutError'
  }
}

interface NetworkOptions {
  /** The time limit for each request, which a timeout's message names. */
  timeoutMs: number
}

const requestTarget = (
  input: FetchInput,
  init: RequestInit | undefined
): { signal: AbortSignal | undefined; url: URL } => {
  const request = input instanceof Request ? input : undefined
  return {
    signal: init?.signal ?? request?.signal ?? undefined,
    url: new URL(request?.url ?? String(input))
  }
}

const timedOut = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true &&
  signal.reason instanceof DOMException &&
  signal.reason.name === 'TimeoutError'

// Node's fetch rejects with a TypeError whose cause is undici's
// ConnectTimeoutError. Node and the bundled undici each have their own copy of
// that class, so the code identifies it.
const connectTimedOut = (error: unknown): boolean => {
  const visited = new Set<unknown>()
  let current = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current)
    if ('code' in current && current.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return true
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

const timeLimit = (
  error: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number
): number | undefined => {
  if (timedOut(signal)) {
    return timeoutMs
  }
  return connectTimedOut(error) ? CONNECT_TIMEOUT_MS : undefined
}

/**
 * A fetch whose requests fail with a NetworkError when they get no response,
 * except when the caller cancels them. The body is read within the request, so
 * a timeout while it arrives is reported the same way.
 */
export const withNetworkErrors =
  (
    fetchImplementation: typeof globalThis.fetch,
    options: NetworkOptions
  ): typeof globalThis.fetch =>
  async (input, init) => {
    const { signal, url } = requestTarget(input, init)
    let response: Response
    let body: ArrayBuffer | null
    try {
      response = await fetchImplementation(input, init)
      body = NULL_BODY_STATUSES.has(response.status)
        ? null
        : await response.arrayBuffer()
    } catch (error) {
      if (signal?.aborted === true && !timedOut(signal)) {
        throw error
      }
      const timeoutMs = timeLimit(error, signal, options.timeoutMs)
      // biome-ignore lint/style/useErrorCause: NetworkError forwards this cause through its options object.
      throw new NetworkError({
        cause: error,
        host: url.host,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
      })
    }
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    })
  }
