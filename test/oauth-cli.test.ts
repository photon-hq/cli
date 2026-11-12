import { ApiError, TransportError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  type OauthCatalogScope,
  type OauthRawScope,
  type OauthScope,
  OauthService
} from '../src/oauth/service.ts'
import {
  asProjectScope,
  cliInvoker,
  createAuthenticatedConfig
} from './project-test-support.ts'

const timestamp = '2026-08-07T04:24:09.000Z'
const applicationId = 'connect_app_123'
const authorizationId = 'authorized_connect_app_123'
const clientId = 'client_123'
const plaintextSecret = 'oauth-secret-value'
const apiOrigin = 'https://api.example.test'
const issuer = 'https://auth.example.test'
const oauthClientEtag = '"version-7"'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const supportedScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'account:read',
  'project:read'
]

const oauthClientFixture = {
  clientId,
  createdAt: timestamp,
  description: 'Connects Acme to Photon',
  futureField: 'from-a-newer-api',
  name: 'Acme Integration',
  redirectUris: [
    { default: true, uri: 'https://acme.example/callback' },
    { default: false, uri: 'http://localhost:3000/callback' }
  ],
  scopes: ['account:read', 'project:read'],
  updatedAt: timestamp
}

const oauthConnectionFixture = {
  application: {
    applicationType: 'web',
    clientId,
    createdAt: timestamp,
    description: 'Connects Acme to Photon',
    futureField: 'from-a-newer-api',
    id: applicationId,
    isFirstParty: false,
    name: 'Acme Integration',
    redirectUris: oauthClientFixture.redirectUris,
    scopes: oauthClientFixture.scopes,
    updatedAt: timestamp,
    usesPkce: true
  },
  authorizationId,
  futureField: 'from-a-newer-api',
  grantedScopes: ['account:read'],
  oauthResource: 'https://api.example.test'
}

const clientSecretFixture = {
  current: {
    createdAt: timestamp,
    futureField: 'from-a-newer-api',
    hint: '…c0ffee',
    lastUsedAt: null
  },
  previous: {
    createdAt: '2026-08-01T04:24:09.000Z',
    hint: '…beef00',
    lastUsedAt: timestamp,
    validUntil: '2026-08-07T05:24:09.000Z'
  }
}

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

interface OauthMocks {
  catalogScope: OauthCatalogScope
  createOauthClient: ReturnType<
    typeof vi.fn<OauthScope['createOrganizationOauthClient']>
  >
  deleteOauthClient: ReturnType<
    typeof vi.fn<OauthScope['deleteOrganizationOauthClient']>
  >
  deleteOauthClientSecret: ReturnType<
    typeof vi.fn<OauthScope['deleteOrganizationOauthClientSecret']>
  >
  getOauthClient: ReturnType<
    typeof vi.fn<OauthScope['getOrganizationOauthClient']>
  >
  getOauthClientSecret: ReturnType<
    typeof vi.fn<OauthScope['getOrganizationOauthClientSecret']>
  >
  listAuthorizedApplications: ReturnType<
    typeof vi.fn<OauthScope['listAuthorizedApplications']>
  >
  listOauthClients: ReturnType<
    typeof vi.fn<OauthScope['listOrganizationOauthClients']>
  >
  listOauthScopes: ReturnType<
    typeof vi.fn<OauthCatalogScope['listOauthScopes']>
  >
  rawGetOauthClient: ReturnType<
    typeof vi.fn<OauthRawScope['getOrganizationOauthClient']>
  >
  rawScope: OauthRawScope
  revokeAuthorizedApplication: ReturnType<
    typeof vi.fn<OauthScope['revokeAuthorizedApplication']>
  >
  rotateOauthClientSecret: ReturnType<
    typeof vi.fn<OauthScope['rotateOrganizationOauthClientSecret']>
  >
  scope: OauthScope
  setupOauthClientSecret: ReturnType<
    typeof vi.fn<OauthScope['setupOrganizationOauthClientSecret']>
  >
  updateOauthClient: ReturnType<
    typeof vi.fn<OauthScope['updateOrganizationOauthClient']>
  >
}

const oauthMocks = (): OauthMocks => {
  const createOauthClient = vi.fn<OauthScope['createOrganizationOauthClient']>(
    () => Promise.resolve(oauthClientFixture)
  )
  const setupOauthClientSecret = vi.fn<
    OauthScope['setupOrganizationOauthClientSecret']
  >(() => Promise.resolve({ value: plaintextSecret }))
  const rotateOauthClientSecret = vi.fn<
    OauthScope['rotateOrganizationOauthClientSecret']
  >(() =>
    Promise.resolve({
      previousSecretValidUntil: '2026-08-07T05:24:09.000Z',
      value: plaintextSecret
    })
  )
  const deleteOauthClient = vi.fn<OauthScope['deleteOrganizationOauthClient']>(
    () =>
      Promise.resolve({
        operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
        status: 'deleted'
      })
  )
  const deleteOauthClientSecret = vi.fn<
    OauthScope['deleteOrganizationOauthClientSecret']
  >(() => Promise.resolve(undefined))
  const getOauthClient = vi.fn<OauthScope['getOrganizationOauthClient']>(() =>
    Promise.resolve(oauthClientFixture)
  )
  const getOauthClientSecret = vi.fn<
    OauthScope['getOrganizationOauthClientSecret']
  >(() => Promise.resolve(clientSecretFixture))
  const listAuthorizedApplications = vi.fn<
    OauthScope['listAuthorizedApplications']
  >(() =>
    Promise.resolve({
      authorizedApplications: [oauthConnectionFixture],
      listMetadata: { after: 'connect_app_next', before: null }
    })
  )
  const listOauthClients = vi.fn<OauthScope['listOrganizationOauthClients']>(
    () => Promise.resolve({ oauthClients: [oauthClientFixture] })
  )
  const listOauthScopes = vi.fn<OauthCatalogScope['listOauthScopes']>(() =>
    Promise.resolve({ scopes: supportedScopes })
  )
  const updateOauthClient = vi.fn<OauthScope['updateOrganizationOauthClient']>(
    () => Promise.resolve(oauthClientFixture)
  )
  const rawGetOauthClient = vi.fn<OauthRawScope['getOrganizationOauthClient']>(
    () =>
      Promise.resolve({
        data: oauthClientFixture,
        headers: new Headers({ etag: oauthClientEtag }),
        requestId: 'request_oauth_client',
        status: 200
      })
  )
  const revokeAuthorizedApplication = vi.fn<
    OauthScope['revokeAuthorizedApplication']
  >(() => Promise.resolve(undefined))
  return {
    catalogScope: { listOauthScopes },
    createOauthClient,
    deleteOauthClient,
    deleteOauthClientSecret,
    getOauthClient,
    getOauthClientSecret,
    listAuthorizedApplications,
    listOauthClients,
    listOauthScopes,
    rawGetOauthClient,
    rawScope: { getOrganizationOauthClient: rawGetOauthClient },
    revokeAuthorizedApplication,
    rotateOauthClientSecret,
    scope: {
      createOrganizationOauthClient: createOauthClient,
      deleteOrganizationOauthClient: deleteOauthClient,
      deleteOrganizationOauthClientSecret: deleteOauthClientSecret,
      getOrganizationOauthClient: getOauthClient,
      getOrganizationOauthClientSecret: getOauthClientSecret,
      listAuthorizedApplications,
      listOrganizationOauthClients: listOauthClients,
      revokeAuthorizedApplication,
      rotateOrganizationOauthClientSecret: rotateOauthClientSecret,
      setupOrganizationOauthClientSecret: setupOauthClientSecret,
      updateOrganizationOauthClient: updateOauthClient
    },
    setupOauthClientSecret,
    updateOauthClient
  }
}

const createInvoke = async (
  overrides: Parameters<typeof cliInvoker>[2] = {}
) => {
  const authenticated = await createAuthenticatedConfig(
    'user_ada',
    overrides.baseUrl === undefined
      ? undefined
      : new URL(overrides.baseUrl).origin
  )
  const mocks = oauthMocks()
  return {
    invoke: cliInvoker(authenticated.configDirectory, asProjectScope({}), {
      oauthCatalogScope: mocks.catalogScope,
      oauthRawScope: mocks.rawScope,
      oauthScope: mocks.scope,
      ...overrides
    }),
    mocks
  }
}

describe('OAuth CLI', () => {
  test('lists the live scopes through the typed public endpoint', async () => {
    const { invoke, mocks } = await createInvoke({ baseUrl: apiOrigin })

    const result = await invoke(['account', 'oauth', 'scope', 'list'])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({ scopes: supportedScopes })
    expect(mocks.listOauthScopes).toHaveBeenCalledWith({}, undefined)
  })

  test('opens a discovered authorization request for an owned client', async () => {
    const browserLauncher = vi.fn(() => Promise.resolve())
    const { invoke, mocks } = await createInvoke({
      baseUrl: apiOrigin,
      browserLauncher,
      fetch: discoveryFetch()
    })

    const result = await invoke(['org', 'oauth-client', 'authorize', clientId])

    expect(result.exitCodes).toEqual([])
    const payload = JSON.parse(result.stdout) as {
      authorization: {
        authorizationUrl: string
        clientId: string
        issuer: string
        nonce: string
        opened: boolean
        redirectUri: string
        scopes: string[]
        state: string
      }
    }
    expect(payload.authorization).toMatchObject({
      clientId,
      issuer,
      opened: true,
      redirectUri: 'https://acme.example/callback',
      scopes: ['openid', 'account:read', 'project:read']
    })
    expect(payload.authorization.nonce).toHaveLength(43)
    expect(payload.authorization.state).toHaveLength(43)

    const authorizationUrl = new URL(payload.authorization.authorizationUrl)
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${issuer}/oauth2/authorize`
    )
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      client_id: clientId,
      nonce: payload.authorization.nonce,
      redirect_uri: 'https://acme.example/callback',
      response_type: 'code',
      scope: 'openid account:read project:read',
      state: payload.authorization.state
    })
    expect(browserLauncher).toHaveBeenCalledWith(
      payload.authorization.authorizationUrl
    )
    expect(mocks.getOauthClient).toHaveBeenCalledWith(
      {
        path: { clientId, organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('prints an authorization URL without opening a browser', async () => {
    const browserLauncher = vi.fn(() => Promise.resolve())
    const { invoke } = await createInvoke({
      baseUrl: apiOrigin,
      browserLauncher,
      fetch: discoveryFetch()
    })

    const printed = await invoke([
      'org',
      'oauth-client',
      'authorize',
      clientId,
      '--redirect-uri',
      'http://localhost:3000/callback',
      '--scope',
      'account:read',
      '--no-browser'
    ])
    expect(JSON.parse(printed.stdout)).toMatchObject({
      authorization: {
        clientId,
        opened: false,
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['openid', 'account:read']
      }
    })
    expect(browserLauncher).not.toHaveBeenCalled()
  })

  test('prints the authorization URL with a warning when the browser cannot open it', async () => {
    const browserLauncher = vi.fn(() => Promise.reject(new Error('no browser')))
    const { invoke } = await createInvoke({
      baseUrl: apiOrigin,
      browserLauncher,
      fetch: discoveryFetch()
    })

    const result = await invoke(['org', 'oauth-client', 'authorize', clientId])

    expect(result.exitCodes).toEqual([])
    const { authorization } = JSON.parse(result.stdout) as {
      authorization: { authorizationUrl: string; opened: boolean }
    }
    expect(authorization.opened).toBe(false)
    expect(browserLauncher).toHaveBeenCalledWith(authorization.authorizationUrl)
    expect(result.stderr).toContain(
      'The browser could not be opened. Open the authorization URL manually.'
    )
  })

  test('draws a new state and nonce for every authorization request', async () => {
    const authorize = async () => {
      const { invoke } = await createInvoke({
        baseUrl: apiOrigin,
        fetch: discoveryFetch()
      })
      const result = await invoke([
        'org',
        'oauth-client',
        'authorize',
        clientId,
        '--no-browser'
      ])
      const { authorization } = JSON.parse(result.stdout) as {
        authorization: { nonce: string; state: string }
      }
      return [authorization.nonce, authorization.state]
    }

    const values = [...(await authorize()), ...(await authorize())]

    expect(new Set(values).size).toBe(4)
  })

  test('rejects scopes missing from the live catalogue', async () => {
    const { invoke, mocks } = await createInvoke({
      baseUrl: apiOrigin,
      fetch: discoveryFetch()
    })
    mocks.listOauthScopes.mockResolvedValueOnce({ scopes: ['openid'] })

    const rejected = await invoke([
      'org',
      'oauth-client',
      'authorize',
      clientId,
      '--scope',
      'account:read',
      '--no-browser'
    ])
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      error: {
        code: 'OAUTH_SCOPE_UNAVAILABLE',
        detail: 'Unavailable scopes: account:read.'
      }
    })
    expect(rejected.exitCodes).toEqual([1])
  })

  test("lists and views clients as the API's responses", async () => {
    const { invoke, mocks } = await createInvoke()

    const listed = await invoke(['org', 'oauth-client', 'list'])
    expect(JSON.parse(listed.stdout)).toEqual({
      oauthClients: [oauthClientFixture]
    })
    expect(mocks.listOauthClients).toHaveBeenCalledWith(
      { path: { organizationId: 'pho_org_00000000000000000000000001' } },
      undefined
    )

    const viewed = await invoke(['org', 'oauth-client', 'view', clientId])
    expect(JSON.parse(viewed.stdout)).toEqual(oauthClientFixture)
    expect(mocks.getOauthClient).toHaveBeenCalledWith(
      {
        path: { clientId, organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('lists and revokes connected OAuth applications', async () => {
    const { invoke, mocks } = await createInvoke()

    const listed = await invoke([
      'account',
      'oauth',
      'connection',
      'list',
      '--page-token',
      'connect_app_cursor',
      '--limit',
      '25',
      '--order',
      'desc'
    ])
    expect(JSON.parse(listed.stdout)).toEqual({
      authorizedApplications: [oauthConnectionFixture],
      listMetadata: { after: 'connect_app_next', before: null }
    })
    expect(mocks.listAuthorizedApplications).toHaveBeenCalledWith(
      {
        query: {
          after: 'connect_app_cursor',
          limit: 25,
          order: 'desc'
        }
      },
      undefined
    )

    const invalid = await invoke([
      'account',
      'oauth',
      'connection',
      'list',
      '--limit',
      '101'
    ])
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(invalid.exitCodes).toEqual([2])
    expect(mocks.listAuthorizedApplications).toHaveBeenCalledOnce()

    const invalidId = await invoke([
      'account',
      'oauth',
      'connection',
      'revoke',
      'client_not_an_application',
      '--yes'
    ])
    expect(JSON.parse(invalidId.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(invalidId.exitCodes).toEqual([2])
    expect(mocks.revokeAuthorizedApplication).not.toHaveBeenCalled()

    const revoked = await invoke([
      'account',
      'oauth',
      'connection',
      'revoke',
      applicationId,
      '--yes'
    ])
    expect(JSON.parse(revoked.stdout)).toEqual({ applicationId, revoked: true })
    expect(mocks.revokeAuthorizedApplication).toHaveBeenCalledWith(
      { path: { applicationId } },
      undefined
    )
  })

  test('keeps the code of a missing connection', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.revokeAuthorizedApplication.mockRejectedValueOnce(
      new ApiError('missing connection', {
        body: { code: 'NOT_FOUND' },
        headers: new Headers(),
        operationId: 'revokeAuthorizedApplication',
        status: 404
      })
    )

    const result = await invoke([
      'account',
      'oauth',
      'connection',
      'revoke',
      applicationId,
      '--yes'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        problem: { code: 'NOT_FOUND', status: 404 }
      }
    })
    expect(result.exitCodes).toEqual([1])
  })

  test('creates a client with repeatable redirect URIs and scopes', async () => {
    const { invoke, mocks } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      ' Acme Integration ',
      '--description',
      ' Connects Acme to Photon ',
      '--redirect-uri',
      'https://acme.example/callback',
      '--redirect-uri',
      'http://localhost:3000/callback',
      '--default-redirect-uri',
      'https://acme.example/callback',
      '--scope',
      'account:read',
      '--scope',
      'project:read'
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toHaveProperty('clientId', clientId)
    expect(mocks.createOauthClient).toHaveBeenCalledWith(
      {
        body: {
          description: 'Connects Acme to Photon',
          name: 'Acme Integration',
          redirectUris: oauthClientFixture.redirectUris,
          scopes: ['account:read', 'project:read']
        },
        headers: { 'idempotency-key': expect.stringMatching(UUID_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('rejects unsafe or inconsistent redirect URIs before HTTP', async () => {
    const { invoke, mocks } = await createInvoke()

    for (const args of [
      [
        '--redirect-uri',
        'http://example.com/callback',
        '--default-redirect-uri',
        'http://example.com/callback'
      ],
      [
        '--redirect-uri',
        'https://acme.example/callback',
        '--default-redirect-uri',
        'https://different.example/callback'
      ]
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case verifies an independent CLI invocation.
      const result = await invoke([
        'org',
        'oauth-client',
        'create',
        '--name',
        'Invalid client',
        ...args
      ])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
      expect(result.exitCodes).toEqual([2])
    }
    expect(mocks.createOauthClient).not.toHaveBeenCalled()
  })

  test('accepts an IPv6 loopback redirect URI', async () => {
    const { invoke, mocks } = await createInvoke()
    const redirectUri = 'http://[::1]:3000/callback'

    const result = await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      'IPv6 client',
      '--redirect-uri',
      redirectUri,
      '--default-redirect-uri',
      redirectUri
    ])

    expect(result.exitCodes).toEqual([])
    expect(mocks.createOauthClient).toHaveBeenCalledWith(
      {
        body: {
          name: 'IPv6 client',
          redirectUris: [{ default: true, uri: redirectUri }],
          scopes: []
        },
        headers: { 'idempotency-key': expect.stringMatching(UUID_PATTERN) },
        path: { organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('updates fields, clears metadata, and replaces redirect URIs', async () => {
    const { invoke, mocks } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'update',
      clientId,
      '--name',
      'Updated client',
      '--clear-description',
      '--clear-scopes',
      '--redirect-uri',
      'https://new.example/callback',
      '--default-redirect-uri',
      'https://new.example/callback'
    ])

    expect(result.exitCodes).toEqual([])
    expect(mocks.updateOauthClient).toHaveBeenCalledWith(
      {
        body: {
          description: null,
          name: 'Updated client',
          redirectUris: [
            { default: true, uri: 'https://new.example/callback' }
          ],
          scopes: []
        },
        headers: { 'if-match': oauthClientEtag },
        path: { clientId, organizationId: 'pho_org_00000000000000000000000001' }
      },
      { headers: expect.any(Headers) }
    )
    const updateOptions = mocks.updateOauthClient.mock.calls[0]?.[1]
    expect(new Headers(updateOptions?.headers).get('if-match')).toBe(
      oauthClientEtag
    )
    expect(mocks.rawGetOauthClient).toHaveBeenCalledWith(
      {
        path: { clientId, organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('rejects missing and weak ETags before updating a client', async () => {
    const { invoke, mocks } = await createInvoke()

    for (const headers of [new Headers(), new Headers({ etag: 'W/"weak"' })]) {
      mocks.rawGetOauthClient.mockResolvedValueOnce({
        data: oauthClientFixture,
        headers,
        requestId: 'request_oauth_client',
        status: 200
      })
      // biome-ignore lint/performance/noAwaitInLoops: each case verifies an independent CLI invocation.
      const result = await invoke([
        'org',
        'oauth-client',
        'update',
        clientId,
        '--name',
        'Rejected update'
      ])

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'OAUTH_PROTOCOL_ERROR',
          detail: 'The OAuth client response did not include a strong ETag.'
        }
      })
      expect(result.exitCodes).toEqual([1])
    }
    expect(mocks.updateOauthClient).not.toHaveBeenCalled()
  })

  test('keeps the code of a stale client update', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.updateOauthClient.mockRejectedValueOnce(
      new ApiError('stale client', {
        body: { code: 'OAUTH_CLIENT_PRECONDITION_FAILED' },
        headers: new Headers(),
        operationId: 'updateOauthClient',
        status: 412
      })
    )

    const result = await invoke([
      'org',
      'oauth-client',
      'update',
      clientId,
      '--name',
      'Stale update'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'OAUTH_CLIENT_PRECONDITION_FAILED',
        problem: { status: 412 }
      }
    })
    expect(result.exitCodes).toEqual([1])
  })

  test('cancels or force-deletes a client', async () => {
    const prompts: string[] = []
    const { invoke, mocks } = await createInvoke({
      confirm: (message) => {
        prompts.push(message)
        return Promise.resolve(false)
      }
    })

    const cancelled = await invoke(['org', 'oauth-client', 'delete', clientId])
    expect(cancelled.stdout).toBe('')
    expect(mocks.deleteOauthClient).not.toHaveBeenCalled()
    expect(prompts).toHaveLength(1)

    const deleted = await invoke([
      'org',
      'oauth-client',
      'delete',
      clientId,
      '--yes'
    ])
    expect(JSON.parse(deleted.stdout)).toEqual({
      operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      status: 'deleted'
    })
    expect(mocks.deleteOauthClient).toHaveBeenCalledWith(
      {
        path: { clientId, organizationId: 'pho_org_00000000000000000000000001' }
      },
      undefined
    )
  })

  test.each([
    [['delete', clientId], 'deleteOauthClient'],
    [['secret', 'rotate', clientId], 'rotateOauthClientSecret'],
    [['secret', 'revoke', clientId], 'deleteOauthClientSecret']
  ] as const)(
    "writes the organization into the rerun of %j when it didn't come from --org",
    async (args, mutation) => {
      const { invoke, mocks } = await createInvoke()

      const result = await invoke(['org', 'oauth-client', ...args])

      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'CONFIRMATION_REQUIRED',
          next: [
            {
              description: 'Run it again with --yes',
              run: `${CLI_NAME} org oauth-client ${args.join(' ')} --json --org pho_org_00000000000000000000000001 --yes`
            }
          ]
        }
      })
      expect(mocks[mutation]).not.toHaveBeenCalled()
    }
  )

  test('reports a deletion still waiting for provider cleanup as pending', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.deleteOauthClient.mockResolvedValueOnce({
      operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      status: 'cleanup_required'
    })

    const result = await invoke([
      'org',
      'oauth-client',
      'delete',
      clientId,
      '--yes'
    ])
    expect(JSON.parse(result.stdout)).toEqual({
      operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
      status: 'cleanup_required'
    })
    expect(result.stderr).toContain('provider cleanup is still pending')
  })

  test('views, creates, rotates, and force-revokes the client secret', async () => {
    const { invoke, mocks } = await createInvoke()
    const path = {
      clientId,
      organizationId: 'pho_org_00000000000000000000000001'
    }

    const viewed = await invoke([
      'org',
      'oauth-client',
      'secret',
      'view',
      clientId
    ])
    expect(JSON.parse(viewed.stdout)).toEqual(clientSecretFixture)
    expect(mocks.getOauthClientSecret).toHaveBeenCalledWith({ path }, undefined)

    const created = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId
    ])
    expect(JSON.parse(created.stdout)).toEqual({ value: plaintextSecret })
    expect(mocks.setupOauthClientSecret).toHaveBeenCalledWith(
      {
        headers: { 'idempotency-key': expect.stringMatching(UUID_PATTERN) },
        path
      },
      undefined
    )
    expect(created.stderr).toContain('cannot be retrieved again')
    expect(created.stderr).not.toContain(plaintextSecret)

    const rotated = await invoke([
      'org',
      'oauth-client',
      'secret',
      'rotate',
      clientId,
      '--yes'
    ])
    expect(JSON.parse(rotated.stdout)).toEqual({
      previousSecretValidUntil: '2026-08-07T05:24:09.000Z',
      value: plaintextSecret
    })
    expect(mocks.rotateOauthClientSecret).toHaveBeenLastCalledWith(
      {
        body: { mode: 'normal' },
        headers: { 'idempotency-key': expect.stringMatching(UUID_PATTERN) },
        path
      },
      undefined
    )
    expect(rotated.stderr).not.toContain(plaintextSecret)

    await invoke([
      'org',
      'oauth-client',
      'secret',
      'rotate',
      clientId,
      '--emergency',
      '--yes'
    ])
    expect(mocks.rotateOauthClientSecret).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { mode: 'emergency' } }),
      undefined
    )

    const revoked = await invoke([
      'org',
      'oauth-client',
      'secret',
      'revoke',
      clientId,
      '--yes'
    ])
    expect(JSON.parse(revoked.stdout)).toEqual({ clientId, revoked: true })
    expect(mocks.deleteOauthClientSecret).toHaveBeenCalledWith(
      { path },
      undefined
    )
  })

  test('refuses the old secret ID argument instead of revoking the current secret', async () => {
    const { invoke, mocks } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'revoke',
      clientId,
      'secret_old',
      '--yes'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail: expect.stringContaining('not a secret ID')
      }
    })
    expect(result.exitCodes).toEqual([2])
    expect(mocks.deleteOauthClientSecret).not.toHaveBeenCalled()
  })

  test('reports several secret IDs the way it reports one', async () => {
    const { invoke, mocks } = await createInvoke()
    const revoke = ['org', 'oauth-client', 'secret', 'revoke', clientId]

    const one = await invoke([...revoke, 'secret_old', '--yes'])
    const several = await invoke([
      ...revoke,
      'secret_old',
      'secret_older',
      '--yes'
    ])

    expect(several.stderr).toBe(one.stderr)
    expect(several.exitCodes).toEqual([2])
    expect(mocks.deleteOauthClientSecret).not.toHaveBeenCalled()
  })

  test('lists the one-secret issue once beside another invalid argument', async () => {
    const { invoke } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'revoke',
      clientId,
      'secret_old',
      'secret_older',
      '--yes',
      '--bogus'
    ])

    const { issues } = JSON.parse(result.stdout).error as {
      issues: { message: string }[]
    }
    expect(
      issues.filter(({ message }) => message.includes('not a secret ID'))
    ).toHaveLength(1)
    expect(issues).toHaveLength(2)
    expect(result.exitCodes).toEqual([2])
  })

  test('keeps the next steps an argument error brings', async () => {
    const { invoke } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'revoke',
      clientId,
      'secret_old',
      '--yes'
    ])

    expect(JSON.parse(result.stdout).error.next).toEqual([
      {
        description: 'See the secret',
        run: `${CLI_NAME} org oauth-client secret view <client-id>`
      },
      {
        description: 'Revoke it',
        run: `${CLI_NAME} org oauth-client secret revoke <client-id>`
      }
    ])
    expect(result.exitCodes).toEqual([2])
  })

  test("names this build's command in an argument error's help hint", async () => {
    const { invoke } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'view',
      clientId,
      'secret_old'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail: 'Unexpected argument: secret_old',
        next: [
          {
            description: 'See the valid options',
            run: `${CLI_NAME} org oauth-client secret view --help`
          }
        ]
      }
    })
    expect(result.exitCodes).toEqual([2])
  })

  test('refuses a secret ID passed after the option terminator', async () => {
    const { invoke, mocks } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'revoke',
      clientId,
      '--yes',
      '--',
      'secret_old'
    ])

    expect(result.stderr).toContain('ARGUMENT_VALIDATION')
    expect(result.stderr).toContain('not a secret ID')
    expect(result.stderr).toContain(
      `1. See the secret: ${CLI_NAME} org oauth-client secret view <client-id>`
    )
    expect(result.stderr).toContain(
      `2. Revoke it: ${CLI_NAME} org oauth-client secret revoke <client-id>`
    )
    expect(result.stderr).not.toContain('See the valid options')
    expect(result.exitCodes).toEqual([2])
    expect(mocks.deleteOauthClientSecret).not.toHaveBeenCalled()
  })

  test('keeps the step an invalid idempotency key brings', async () => {
    const { invoke, mocks } = await createInvoke()

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId,
      '--idempotency-key',
      'bad key'
    ])

    expect(JSON.parse(result.stdout).error.next).toEqual([
      {
        description:
          'Use a stable key for one logical request, or omit --idempotency-key to generate one.'
      }
    ])
    expect(result.exitCodes).toEqual([2])
    expect(mocks.setupOauthClientSecret).not.toHaveBeenCalled()
  })

  test('reports the API problem when a client has a secret already, or none to rotate', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.getOauthClientSecret.mockResolvedValueOnce({
      current: null,
      previous: null
    })
    mocks.setupOauthClientSecret.mockRejectedValueOnce(
      new ApiError('configured', {
        body: {
          code: 'OAUTH_SECRET_CONFIGURED',
          status: 409,
          title: 'OAuth Secret Already Configured'
        },
        headers: new Headers(),
        operationId: 'setupOrganizationOauthClientSecret',
        status: 409
      })
    )
    mocks.rotateOauthClientSecret.mockRejectedValueOnce(
      new ApiError('not configured', {
        body: {
          code: 'OAUTH_SECRET_NOT_CONFIGURED',
          status: 409,
          title: 'OAuth Secret Not Configured'
        },
        headers: new Headers(),
        operationId: 'rotateOrganizationOauthClientSecret',
        status: 409
      })
    )

    const viewed = await invoke([
      'org',
      'oauth-client',
      'secret',
      'view',
      clientId
    ])
    expect(JSON.parse(viewed.stdout)).toEqual({ current: null, previous: null })

    const created = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId
    ])
    const configured = JSON.parse(created.stdout).error
    expect(configured).toMatchObject({
      code: 'OAUTH_SECRET_CONFIGURED',
      message: 'OAuth Secret Already Configured'
    })
    expect(configured).not.toHaveProperty('next')

    const rotated = await invoke([
      'org',
      'oauth-client',
      'secret',
      'rotate',
      clientId,
      '--yes'
    ])
    const notConfigured = JSON.parse(rotated.stdout).error
    expect(notConfigured).toMatchObject({
      code: 'OAUTH_SECRET_NOT_CONFIGURED',
      message: 'OAuth Secret Not Configured'
    })
    expect(notConfigured).not.toHaveProperty('next')
  })

  test('points the removed secret list command to secret view', async () => {
    const { invoke, mocks } = await createInvoke()

    const results = await Promise.all([
      invoke(['org', 'oauth-client', 'secret', 'list', clientId]),
      invoke(['account', 'oauth', 'secret', 'list', clientId])
    ])
    for (const result of results) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'COMMAND_MOVED',
          next: [
            {
              description: 'Use the new command',
              run: `${CLI_NAME} org oauth-client secret view ${clientId} --json`
            }
          ]
        }
      })
      expect(result.exitCodes).toEqual([2])
    }
    expect(mocks.getOauthClientSecret).not.toHaveBeenCalled()
  })

  test('does not mark an unusable created secret as retryable', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.setupOauthClientSecret.mockResolvedValueOnce({ value: '' })

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'OAUTH_PROTOCOL_ERROR',
        retryable: false
      }
    })
    expect(result.exitCodes).toEqual([1])
  })

  test('rejects a secret with control characters before anything prints', async () => {
    const { invoke, mocks } = await createInvoke()
    const unsafeSecret = `${plaintextSecret}\u001b[31m\u202e`
    mocks.setupOauthClientSecret.mockResolvedValueOnce({ value: unsafeSecret })
    mocks.rotateOauthClientSecret.mockResolvedValueOnce({
      previousSecretValidUntil: null,
      value: unsafeSecret
    })

    const results = [
      await invoke(['org', 'oauth-client', 'secret', 'create', clientId]),
      await invoke([
        'org',
        'oauth-client',
        'secret',
        'rotate',
        clientId,
        '--yes'
      ])
    ]

    for (const result of results) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'OAUTH_PROTOCOL_ERROR', retryable: false }
      })
      expect(result.stdout + result.stderr).not.toContain(plaintextSecret)
      expect(result.stderr).not.toContain('Save this OAuth client secret')
      expect(result.exitCodes).toEqual([1])
    }
  })

  test('reports a secret whose plaintext was already delivered', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.setupOauthClientSecret.mockResolvedValueOnce({ value: null })

    const result = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'OAUTH_SECRET_NOT_DELIVERED', retryable: false }
    })
    expect(result.stderr).toBe('')
    expect(result.exitCodes).toEqual([1])
  })

  test('reuses one idempotency key when creation is retried after a token refresh', async () => {
    const mocks = oauthMocks()
    mocks.createOauthClient.mockRejectedValueOnce(
      new ApiError('unauthorized', {
        body: { code: 'UNAUTHORIZED' },
        headers: new Headers(),
        operationId: 'createOrganizationOauthClient',
        status: 401
      })
    )
    mocks.setupOauthClientSecret.mockRejectedValueOnce(
      new ApiError('unauthorized', {
        body: { code: 'UNAUTHORIZED' },
        headers: new Headers(),
        operationId: 'setupOrganizationOauthClientSecret',
        status: 401
      })
    )
    const tokenManager = {
      getAccessToken: vi.fn(() => Promise.resolve('access-token')),
      refreshAfterUnauthorized: vi.fn(() => Promise.resolve('rotated-token'))
    }
    const service = new OauthService({
      apiOrigin,
      catalog: mocks.catalogScope,
      rawScope: mocks.rawScope,
      request: new AuthenticatedRequest({ tokenManager }),
      scope: mocks.scope
    })

    await service.createClient('pho_org_00000000000000000000000001', {
      name: 'Acme Integration',
      redirectUris: [{ default: true, uri: 'https://acme.example/callback' }],
      scopes: []
    })
    await service.setUpClientSecret(
      'pho_org_00000000000000000000000001',
      clientId
    )

    expect(tokenManager.refreshAfterUnauthorized).toHaveBeenCalledTimes(2)
    for (const mock of [
      mocks.createOauthClient,
      mocks.setupOauthClientSecret
    ]) {
      expect(mock).toHaveBeenCalledTimes(2)
      const [first, second] = mock.mock.calls.map(
        ([input]) => input.headers['idempotency-key']
      )
      expect(first).toMatch(UUID_PATTERN)
      expect(second).toBe(first)
    }
  })

  test('honours --idempotency-key for client and secret creation', async () => {
    const { invoke, mocks } = await createInvoke()

    const created = await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      'Acme Integration',
      '--redirect-uri',
      'https://acme.example/callback',
      '--default-redirect-uri',
      'https://acme.example/callback',
      '--idempotency-key',
      'client-create-1'
    ])
    expect(created.exitCodes).toEqual([])
    expect(mocks.createOauthClient.mock.calls[0]?.[0].headers).toEqual({
      'idempotency-key': 'client-create-1'
    })

    const secret = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId,
      '--idempotency-key',
      'secret-create-1'
    ])
    expect(secret.exitCodes).toEqual([])
    expect(mocks.setupOauthClientSecret.mock.calls[0]?.[0].headers).toEqual({
      'idempotency-key': 'secret-create-1'
    })

    const invalid = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId,
      '--idempotency-key',
      'has spaces'
    ])
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(invalid.exitCodes).toEqual([2])
    expect(mocks.setupOauthClientSecret).toHaveBeenCalledOnce()
  })

  test('names the idempotency key to retry with after an uncertain creation', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.createOauthClient.mockRejectedValueOnce(
      new TransportError('connection reset')
    )
    mocks.setupOauthClientSecret.mockRejectedValueOnce(
      new ApiError('unavailable', {
        body: { code: 'UPSTREAM_UNAVAILABLE' },
        headers: new Headers(),
        operationId: 'setupOrganizationOauthClientSecret',
        status: 503
      })
    )

    const client = await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      'Acme Integration',
      '--redirect-uri',
      'https://acme.example/callback',
      '--default-redirect-uri',
      'https://acme.example/callback'
    ])
    const clientKey =
      mocks.createOauthClient.mock.calls[0]?.[0].headers['idempotency-key']
    expect(JSON.parse(client.stdout)).toMatchObject({
      error: {
        code: 'API_CONNECTION_ERROR',
        idempotencyKey: clientKey,
        next: [
          {
            description: `Retry the same command with --idempotency-key ${clientKey}`
          }
        ]
      }
    })

    const secret = await invoke([
      'org',
      'oauth-client',
      'secret',
      'create',
      clientId,
      '--idempotency-key',
      'secret-create-uncertain'
    ])
    const {
      error: { next }
    } = JSON.parse(secret.stdout) as {
      error: { next: { description: string }[] }
    }
    expect(next[0]?.description).toContain(
      '--idempotency-key secret-create-uncertain'
    )
    expect(secret.stderr).not.toContain(plaintextSecret)
    expect(secret.stdout).not.toContain(plaintextSecret)
  })

  test('keeps the code of an OAuth quota failure', async () => {
    const { invoke, mocks } = await createInvoke()
    mocks.createOauthClient.mockRejectedValueOnce(
      new ApiError('quota', {
        body: { code: 'OAUTH_CLIENT_QUOTA_EXCEEDED' },
        headers: new Headers(),
        operationId: 'createOauthClient',
        status: 409
      })
    )

    const result = await invoke([
      'org',
      'oauth-client',
      'create',
      '--name',
      'Quota client',
      '--redirect-uri',
      'https://quota.example/callback',
      '--default-redirect-uri',
      'https://quota.example/callback'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'OAUTH_CLIENT_QUOTA_EXCEEDED',
        problem: { status: 409 },
        retryable: false
      }
    })
    expect(result.exitCodes).toEqual([1])
  })
})
