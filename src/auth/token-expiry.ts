const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000

const parseJwtExpiration = (accessToken: string): number | undefined => {
  const parts = accessToken.split('.')
  const [header, payload, signature] = parts
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    payload.length === 0
  ) {
    return
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('exp' in parsed) ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp) ||
      parsed.exp <= 0
    ) {
      return
    }
    const expiration = Math.floor(parsed.exp * 1000)
    return Number.isFinite(expiration) &&
      expiration <= MAXIMUM_DATE_MILLISECONDS
      ? expiration
      : undefined
  } catch {
    // Access tokens may be opaque. The server-provided lifetime remains the
    // safe scheduling fallback.
  }
}

export const accessTokenExpiresAt = (
  accessToken: string,
  expiresInSeconds: number,
  receivedAtMilliseconds: number = Date.now()
): Date => {
  if (!Number.isFinite(expiresInSeconds)) {
    throw new RangeError('expiresInSeconds must be finite.')
  }

  const jwtExpiration = parseJwtExpiration(accessToken)
  const fallbackExpiration =
    receivedAtMilliseconds + Math.max(0, expiresInSeconds) * 1000
  return new Date(jwtExpiration ?? fallbackExpiration)
}
