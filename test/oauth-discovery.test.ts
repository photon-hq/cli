import { describe, expect, test, vi } from 'vitest'
import { discoverOauthAuthorizationServer } from '../src/oauth/discovery.ts'

const apiOrigin = 'https://api.example.test'
const issuer = 'https://auth.example.test'

const discoveryFetch = (resource = apiOrigin, authorizationServer = issuer) =>
  vi.fn<typeof globalThis.fetch>((input) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url === `${apiOrigin}/.well-known/oauth-protected-resource`) {
      return Promise.resolve(
        Response.json({
          authorization_servers: [authorizationServer],
          resource
        })
      )
    }
    if (
      url === `${authorizationServer}/.well-known/oauth-authorization-server`
    ) {
      return Promise.resolve(
        Response.json({
          authorization_endpoint: `${authorizationServer}/oauth2/authorize`,
          issuer: authorizationServer,
          token_endpoint: `${authorizationServer}/oauth2/token`
        })
      )
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

describe('OAuth discovery', () => {
  test('normalizes equivalent protected-resource identifiers', async () => {
    const result = await discoverOauthAuthorizationServer({
      apiOrigin,
      fetch: discoveryFetch(`${apiOrigin}/`)
    })

    expect(result).toMatchObject({ issuer, resource: `${apiOrigin}/` })
  })

  test('accepts a bracketed IPv6 loopback authorization server', async () => {
    const ipv6Issuer = 'http://[::1]:3000'
    const result = await discoverOauthAuthorizationServer({
      apiOrigin,
      fetch: discoveryFetch(apiOrigin, ipv6Issuer)
    })

    expect(result.issuer).toBe(ipv6Issuer)
  })

  test('names the host and the time limit when metadata never arrives', async () => {
    const neverAnswers = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason)
          })
        })
    )

    await expect(
      discoverOauthAuthorizationServer({
        apiOrigin,
        fetch: neverAnswers,
        timeoutMs: 1000
      })
    ).rejects.toMatchObject({
      code: 'OAUTH_DISCOVERY_UNAVAILABLE',
      detail: "api.example.test didn't answer within 1 second.",
      transportCode: 'TimeoutError'
    })
  })

  test('rejects metadata for a different protected resource', async () => {
    await expect(
      discoverOauthAuthorizationServer({
        apiOrigin,
        fetch: discoveryFetch('https://other.example.test')
      })
    ).rejects.toMatchObject({ code: 'OAUTH_DISCOVERY_PROTOCOL_ERROR' })
  })
})
