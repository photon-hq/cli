const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const normalizedHostname = (hostname: string): string => {
  const lowercaseHostname = hostname.toLowerCase()
  return lowercaseHostname.startsWith('[') && lowercaseHostname.endsWith(']')
    ? lowercaseHostname.slice(1, -1)
    : lowercaseHostname
}

export const isOauthLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(normalizedHostname(hostname))
