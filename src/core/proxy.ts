import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { causeChain, ProxyUnreachableError } from './network.ts'

type Environment = Readonly<Record<string, string | undefined>>

const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const BRACKETS = /^\[|\]$/g
const PORT_SUFFIX = /:\d+$/
const DOMAIN_PREFIX = /^\*?\./
const NO_PROXY_SEPARATORS = /[\s,]+/
const TRAILING_DOT = /\.$/

// Read as undici reads them: the lower-case name first.
const proxyVariable = (env: Environment, name: string): string =>
  env[name.toLowerCase()] ?? env[name] ?? ''

// A proxy given without a scheme, such as proxy.example.com:3128, is an HTTP
// proxy, as curl, Go, Python's requests and Bun read it.
const proxyUrl = (value: string): string =>
  value === '' || URL_SCHEME.test(value) ? value : `http://${value}`

const bareHost = (host: string): string =>
  host.replace(BRACKETS, '').toLowerCase()

const proxyPort = (proxy: URL): number =>
  Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)

const proxyAddresses = async (proxy: URL): Promise<string[]> => {
  const host = bareHost(proxy.hostname)
  if (isIP(host) !== 0) {
    return [host]
  }
  try {
    return (await lookup(host, { all: true })).map(({ address }) => address)
  } catch {
    return []
  }
}

const noProxyHost = (entry: string): string => {
  if (entry.startsWith('[')) {
    return entry.slice(1, entry.indexOf(']'))
  }
  return isIP(entry) === 0
    ? entry
        .replace(PORT_SUFFIX, '')
        .replace(DOMAIN_PREFIX, '')
        .replace(TRAILING_DOT, '')
    : entry
}

// Whether Bun sends a request to url straight to the server because NO_PROXY
// lists its host (bun.com/docs/runtime/networking/fetch). As Bun does, it
// ignores a trailing dot on the host and on each entry. It reads the list
// more broadly than Bun does: an entry with a port, or a CIDR block for an IP
// address, counts for the host on every port. So in doubt the CLI names the
// server, never the proxy.
const bunBypassesProxy = (url: URL, env: Environment): boolean => {
  const host = bareHost(url.hostname).replace(TRAILING_DOT, '')
  return (env.no_proxy || env.NO_PROXY || '')
    .toLowerCase()
    .split(NO_PROXY_SEPARATORS)
    .some((entry) => {
      if (entry === '*') {
        return true
      }
      if (entry.includes('/')) {
        return isIP(host) !== 0
      }
      const name = noProxyHost(entry)
      return name !== '' && (host === name || host.endsWith(`.${name}`))
    })
}

// Each attempt behind an error, outermost first. When a host has several
// addresses, Node's error is an AggregateError of one attempt per address.
const attempts = (error: unknown): object[] =>
  causeChain(error).flatMap((cause) => {
    const errors: unknown = Reflect.get(cause, 'errors')
    return [
      cause,
      ...(Array.isArray(errors)
        ? errors.filter(
            (attempt): attempt is object =>
              typeof attempt === 'object' && attempt !== null
          )
        : [])
    ]
  })

// Each runtime's error names the host it failed to resolve, and Node's names
// the address and port it failed to connect to. Bun's refused connection
// names neither, so there the CLI works out whether Bun used the proxy. A
// server with the proxy's own name is never told apart from the proxy, so the
// CLI names the server.
const proxyFailure = async (
  error: unknown,
  url: URL,
  proxy: URL,
  usedProxy: () => boolean
): Promise<string | undefined> => {
  const failures = attempts(error).filter((attempt) =>
    ['ECONNREFUSED', 'ENOTFOUND'].includes(String(Reflect.get(attempt, 'code')))
  )
  const [failure] = failures
  if (failure === undefined) {
    return
  }
  const code = String(Reflect.get(failure, 'code'))
  if (code === 'ENOTFOUND') {
    const hostname: unknown = Reflect.get(failure, 'hostname')
    return typeof hostname === 'string' &&
      bareHost(hostname) === bareHost(proxy.hostname) &&
      bareHost(url.hostname) !== bareHost(proxy.hostname)
      ? code
      : undefined
  }
  const endpoints = failures.flatMap((attempt) => {
    const address: unknown = Reflect.get(attempt, 'address')
    const port: unknown = Reflect.get(attempt, 'port')
    return typeof address === 'string' && typeof port === 'number'
      ? [{ address, port }]
      : []
  })
  if (endpoints.length === 0) {
    return usedProxy() ? code : undefined
  }
  const addresses = await proxyAddresses(proxy)
  return endpoints.some(
    ({ address, port }) =>
      port === proxyPort(proxy) && addresses.includes(address)
  )
    ? code
    : undefined
}

/**
 * Sends requests through the proxy that HTTPS_PROXY or HTTP_PROXY names,
 * except for the hosts NO_PROXY lists. Node's fetch ignores these variables
 * unless NODE_USE_ENV_PROXY is set, and Node 22 has no
 * http.setGlobalProxyFromEnv(), so on Node the requests go through undici's
 * EnvHttpProxyAgent. Bun's fetch reads the variables itself, and ALL_PROXY
 * too. A request whose proxy refused the connection, or whose proxy's name
 * didn't resolve, fails with a ProxyUnreachableError.
 */
export const withEnvironmentProxy = (
  fetchImplementation: typeof globalThis.fetch,
  env: Environment
): typeof globalThis.fetch => {
  const httpProxy = proxyUrl(proxyVariable(env, 'HTTP_PROXY'))
  const httpsProxy = proxyUrl(proxyVariable(env, 'HTTPS_PROXY'))
  const onBun = process.versions.bun !== undefined
  const allProxy = onBun ? proxyUrl(proxyVariable(env, 'ALL_PROXY')) : ''
  if (httpProxy === '' && httpsProxy === '' && allProxy === '') {
    return fetchImplementation
  }
  // The proxy each runtime picks for a URL: undici falls back from
  // HTTPS_PROXY to HTTP_PROXY, and Bun from either one to ALL_PROXY.
  const proxyFor = (url: URL): string => {
    if (url.protocol !== 'https:') {
      return httpProxy || allProxy
    }
    return httpsProxy || (onBun ? allProxy : httpProxy)
  }
  let dispatcher: Promise<NonNullable<RequestInit['dispatcher']>> | undefined
  const send = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit | undefined
  ): Promise<Response> => {
    if (onBun) {
      return await fetchImplementation(input, init)
    }
    dispatcher ??= import('undici').then(
      ({ EnvHttpProxyAgent }) =>
        // Node's fetch is typed with an older undici than the undici package.
        new EnvHttpProxyAgent({
          httpProxy,
          httpsProxy,
          noProxy: proxyVariable(env, 'NO_PROXY')
        }) as unknown as NonNullable<RequestInit['dispatcher']>
    )
    return await fetchImplementation(input, {
      ...init,
      dispatcher: await dispatcher
    })
  }
  return async (input, init) => {
    try {
      return await send(input, init)
    } catch (error) {
      const target = input instanceof Request ? input.url : String(input)
      if (!URL.canParse(target)) {
        throw error
      }
      const url = new URL(target)
      const proxyValue = proxyFor(url)
      if (!URL.canParse(proxyValue)) {
        throw error
      }
      const proxy = new URL(proxyValue)
      if (!['http:', 'https:'].includes(proxy.protocol)) {
        throw error
      }
      const code = await proxyFailure(
        error,
        url,
        proxy,
        () => onBun && !bunBypassesProxy(url, env)
      )
      if (code === undefined) {
        throw error
      }
      // biome-ignore lint/style/useErrorCause: ProxyUnreachableError forwards this cause through its options object.
      throw new ProxyUnreachableError({ cause: error, code, proxy })
    }
  }
}
