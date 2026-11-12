import { describe, expect, test } from 'vitest'
import { accessTokenExpiresAt } from '../src/auth/token-expiry.ts'

const jwt = (payload: object): string =>
  [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'unverified-signature'
  ].join('.')

describe('access-token scheduling', () => {
  test('uses an unverified JWT exp only for refresh scheduling', () => {
    const expiresAt = accessTokenExpiresAt(jwt({ exp: 2_000_000_000 }), 300, 0)
    expect(expiresAt.toISOString()).toBe('2033-05-18T03:33:20.000Z')
  })

  test('falls back to received time plus expires_in for opaque tokens', () => {
    const expiresAt = accessTokenExpiresAt('opaque-token', 300, 1000)
    expect(expiresAt.getTime()).toBe(301_000)
  })

  test('falls back when JWT exp is invalid or outside the Date range', () => {
    const invalidExpirations = ['not-a-number', 0, 9_000_000_000_000]
    for (const exp of invalidExpirations) {
      expect(accessTokenExpiresAt(jwt({ exp }), 300, 1000).getTime()).toBe(
        301_000
      )
    }
  })

  test('rejects a non-finite server lifetime', () => {
    expect(() =>
      accessTokenExpiresAt('opaque-token', Number.POSITIVE_INFINITY)
    ).toThrow(RangeError)
  })
})
