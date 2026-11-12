import { ApiError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import {
  AuthenticatedRequest,
  requiresReauthentication
} from '../src/auth/authenticated-request.ts'
import type {
  BearerCredentialProvider,
  BearerCredentialSnapshot
} from '../src/auth/credential-provider.ts'

const challenge = (): ApiError =>
  new ApiError('recent authentication required', {
    body: { error: 'insufficient_user_authentication' },
    headers: new Headers({
      'www-authenticate':
        'Bearer error="insufficient_user_authentication", max_age="300"'
    }),
    status: 401
  })

const headerOnlyChallenge = (errorCode: string): ApiError =>
  new ApiError('unauthorized', {
    body: { detail: 'unauthorized' },
    headers: new Headers({
      'www-authenticate': `Bearer realm="photon", max_age="300", error="${errorCode}"`
    }),
    status: 401
  })

const snapshot = (
  bearer: string,
  publicId = 'user_ada'
): BearerCredentialSnapshot => ({
  bearer,
  identity: { kind: 'device', publicId },
  kind: 'device'
})

const provider = (): BearerCredentialProvider & {
  current: BearerCredentialSnapshot
} => {
  const result = {
    assertCurrent: vi.fn(() => Promise.resolve()),
    current: snapshot('old-token'),
    getBearer: vi.fn(async () => result.current.bearer),
    getSnapshot: vi.fn(async () => result.current),
    refreshAfterUnauthorized: vi.fn(async () => snapshot('refreshed-token')),
    withSnapshot: vi.fn(async (_credential, action) => await action())
  }
  return result
}

describe('authenticated request reauthentication', () => {
  test('detects only the reauthentication error in a header-only challenge', () => {
    expect(
      requiresReauthentication(
        headerOnlyChallenge('insufficient_user_authentication')
      )
    ).toBe(true)
    expect(requiresReauthentication(headerOnlyChallenge('invalid_token'))).toBe(
      false
    )
  })

  test('performs one fresh-login retry without refreshing the old token', async () => {
    const credentials = provider()
    const reauthenticate = vi.fn(() => {
      credentials.current = snapshot('fresh-login-token')
      return Promise.resolve()
    })
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(challenge())
      .mockResolvedValueOnce('done')
    const request = new AuthenticatedRequest({
      credentialProvider: credentials
    })

    await expect(request.run(invoke, { reauthenticate })).resolves.toBe('done')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(reauthenticate).toHaveBeenCalledOnce()
    expect(credentials.refreshAfterUnauthorized).not.toHaveBeenCalled()
  })

  test('does not loop when the retry still requires recent authentication', async () => {
    const credentials = provider()
    const reauthenticate = vi.fn(() => {
      credentials.current = snapshot('fresh-login-token')
      return Promise.resolve()
    })
    const invoke = vi.fn(() => Promise.reject(challenge()))
    const request = new AuthenticatedRequest({
      credentialProvider: credentials
    })

    await expect(request.run(invoke, { reauthenticate })).rejects.toMatchObject(
      { code: 'AUTH_REAUTHENTICATION_REQUIRED' }
    )
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(reauthenticate).toHaveBeenCalledOnce()
    expect(credentials.refreshAfterUnauthorized).not.toHaveBeenCalled()
  })

  test('does not retry under a different account identity', async () => {
    const credentials = provider()
    const reauthenticate = vi.fn(() => {
      credentials.current = snapshot('fresh-login-token', 'user_grace')
      return Promise.resolve()
    })
    const invoke = vi.fn(() => Promise.reject(challenge()))
    const request = new AuthenticatedRequest({
      credentialProvider: credentials
    })

    await expect(request.run(invoke, { reauthenticate })).rejects.toMatchObject(
      { code: 'AUTH_SESSION_CHANGED' }
    )
    expect(invoke).toHaveBeenCalledOnce()
  })

  test('reports the challenge without refreshing when no handler is supplied', async () => {
    const credentials = provider()
    const invoke = vi.fn(() => Promise.reject(challenge()))
    const request = new AuthenticatedRequest({
      credentialProvider: credentials
    })

    await expect(request.run(invoke)).rejects.toMatchObject({
      code: 'AUTH_REAUTHENTICATION_REQUIRED'
    })
    expect(credentials.refreshAfterUnauthorized).not.toHaveBeenCalled()
  })
})
