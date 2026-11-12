import {
  type CreateOrganizationOauthClientOutput,
  CreateOrganizationOauthClientOutputSchema,
  type DeleteOrganizationOauthClientOutput,
  DeleteOrganizationOauthClientOutputSchema,
  type GetOrganizationOauthClientOutput,
  GetOrganizationOauthClientOutputSchema,
  type GetOrganizationOauthClientSecretOutput,
  GetOrganizationOauthClientSecretOutputSchema,
  type ListOauthScopesOutput,
  ListOauthScopesOutputSchema,
  type ListOrganizationOauthClientsOutput,
  ListOrganizationOauthClientsOutputSchema,
  type RotateOrganizationOauthClientSecretOutput,
  RotateOrganizationOauthClientSecretOutputSchema,
  type SetupOrganizationOauthClientSecretOutput,
  SetupOrganizationOauthClientSecretOutputSchema,
  type UpdateOrganizationOauthClientOutput,
  UpdateOrganizationOauthClientOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import {
  API,
  buildsDocument,
  type Declared,
  type FakeRoute,
  type GoldenCase,
  goldenRandomBytes,
  NEW_API_FIELD,
  printsResponse
} from './support.ts'

const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const ORGANIZATION = ['--org', ORGANIZATION_ID]
const CLIENT_ID = 'client_01k9yq3m7d2c8x4v6b5n0p1r2s'
const APPLICATION_ID = 'connect_app_01k9yq3m7d2c8x4v6b5n0p1r2s'
const CLIENTS = `/v1/organizations/${ORGANIZATION_ID}/oauth/clients`
const CLIENT = `${CLIENTS}/${CLIENT_ID}`
const SECRET = `${CLIENT}/secret`
const PLAINTEXT_SECRET = Buffer.alloc(32, 7).toString('base64url')
const ROTATED_SECRET = Buffer.alloc(32, 9).toString('base64url')
const timestamp = '2026-07-31T18:00:00.000Z'

const defaultRedirect = {
  default: true,
  uri: 'https://acme.example.test/callback'
}
const loopbackRedirect = {
  default: false,
  uri: 'http://localhost:3000/callback'
}

const client = {
  clientId: CLIENT_ID,
  createdAt: timestamp,
  description: 'Connects Acme to Photon',
  name: 'Acme Integration',
  redirectUris: [defaultRedirect, loopbackRedirect],
  scopes: ['account:read', 'project:read'],
  updatedAt: timestamp
} satisfies Declared<GetOrganizationOauthClientOutput>

// The client as a newer API sends it, with a field this SDK doesn't declare on
// the client and on one of its redirect URIs.
const newerClient = {
  ...client,
  ...NEW_API_FIELD,
  redirectUris: [{ ...defaultRedirect, ...NEW_API_FIELD }, loopbackRedirect]
}

const listed = {
  oauthClients: [
    newerClient,
    {
      ...client,
      clientId: 'client_01k9yq3m7d2c8x4v6b5n0p1r2t',
      description: null,
      name: 'Globex Sync',
      redirectUris: [defaultRedirect],
      scopes: []
    }
  ],
  ...NEW_API_FIELD
} satisfies Declared<ListOrganizationOauthClientsOutput>

const created =
  newerClient satisfies Declared<CreateOrganizationOauthClientOutput>

const updated = {
  ...newerClient,
  name: 'Acme Integration v2',
  updatedAt: '2026-08-01T18:00:00.000Z'
} satisfies Declared<UpdateOrganizationOauthClientOutput>

const deleted = {
  operationId: '1f0c2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  status: 'deleted',
  ...NEW_API_FIELD
} satisfies Declared<DeleteOrganizationOauthClientOutput>

const clientSecret = {
  current: {
    createdAt: '2026-08-01T18:00:00.000Z',
    hint: '…c0ffee',
    lastUsedAt: null,
    ...NEW_API_FIELD
  },
  previous: {
    createdAt: timestamp,
    hint: '…beef00',
    lastUsedAt: '2026-08-01T17:00:00.000Z',
    validUntil: '2026-08-01T19:00:00.000Z'
  },
  ...NEW_API_FIELD
} satisfies Declared<GetOrganizationOauthClientSecretOutput>

const setUp = {
  value: PLAINTEXT_SECRET,
  ...NEW_API_FIELD
} satisfies Declared<SetupOrganizationOauthClientSecretOutput>

const rotated = {
  previousSecretValidUntil: '2026-08-01T19:00:00.000Z',
  value: ROTATED_SECRET,
  ...NEW_API_FIELD
} satisfies Declared<RotateOrganizationOauthClientSecretOutput>

const scopes = {
  scopes: ['openid', 'profile', 'email', 'account:read', 'project:read'],
  ...NEW_API_FIELD
} satisfies Declared<ListOauthScopesOutput>

// What secret revoke prints. The API answers 204 with no body.
const RevokedSecretSchema = z.strictObject({
  clientId: z.string(),
  revoked: z.literal(true)
})

// What connection revoke prints. The API answers 204 with no body.
const RevokedConnectionSchema = z.strictObject({
  applicationId: z.string(),
  revoked: z.literal(true)
})

// Photon's OAuth discovery, as the fake API answers it. The CLI checks that
// the protected resource is the API it calls, then reads the authorization
// server it names, which here is the fake API too: the CLI accepts http there
// only on loopback.
const protectedResource = {
  authorization_servers: [API],
  bearer_methods_supported: ['header'],
  resource: API
}
const authorizationServer = {
  authorization_endpoint: `${API}/oauth2/authorize`,
  code_challenge_methods_supported: ['S256'],
  issuer: API,
  response_types_supported: ['code'],
  token_endpoint: `${API}/oauth2/token`
}

// The nonce and the state of an authorization request: 32 random bytes each,
// drawn in this order.
const NONCE = goldenRandomBytes(1, 32).toString('base64url')
const STATE = goldenRandomBytes(2, 32).toString('base64url')

// authorize reads the client, the discovery and the scope catalogue at once.
const clientRoute = {
  body: newerClient,
  method: 'GET',
  path: CLIENT
} satisfies FakeRoute
const protectedResourceRoute = {
  body: protectedResource,
  method: 'GET',
  path: '/.well-known/oauth-protected-resource'
} satisfies FakeRoute
const authorizationServerRoute = {
  body: authorizationServer,
  method: 'GET',
  path: '/.well-known/oauth-authorization-server'
} satisfies FakeRoute
const AUTHORIZE_ROUTES: readonly FakeRoute[] = [
  clientRoute,
  protectedResourceRoute,
  { body: scopes, method: 'GET', path: '/v1/auth/oauth/scopes', unshown: true },
  authorizationServerRoute
]

// What authorize prints: the authorization request it builds from the client
// and the authorization server the discovery names, and whether the browser
// opened it.
const authorization =
  (opened: boolean) =>
  (
    oauthClient: typeof newerClient,
    resource: typeof protectedResource,
    server: typeof authorizationServer
  ) => {
    const redirect = oauthClient.redirectUris.find(
      ({ default: isDefault }) => isDefault
    )
    if (redirect === undefined) {
      throw new Error('The client has no default redirect URI.')
    }
    const redirectUri = redirect.uri
    const requested = ['openid', ...oauthClient.scopes]
    const query = new URLSearchParams({
      client_id: oauthClient.clientId,
      nonce: NONCE,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requested.join(' '),
      state: STATE
    })
    return {
      authorization: {
        authorizationUrl: `${server.authorization_endpoint}?${query.toString()}`,
        clientId: oauthClient.clientId,
        issuer: resource.authorization_servers[0],
        nonce: NONCE,
        opened,
        redirectUri,
        scopes: requested,
        state: STATE
      }
    }
  }

// The authorization request's random values: 32 bytes, base64url.
const RandomValueSchema = z.string().regex(/^[\w-]{43}$/u)

// What authorize prints. The endpoint and the issuer are the fake API's,
// written as API, which stands in for the CLI's check that each is a secure
// URL. The CLI checks the scopes as below.
const AuthorizationSchema = z.strictObject({
  authorization: z.strictObject({
    authorizationUrl: z.string().startsWith(`${API}/`),
    clientId: GetOrganizationOauthClientOutputSchema.shape.clientId,
    issuer: z.literal(API),
    nonce: RandomValueSchema,
    opened: z.boolean(),
    redirectUri:
      GetOrganizationOauthClientOutputSchema.shape.redirectUris.element.shape
        .uri,
    scopes: z
      .array(
        z
          .string()
          .max(128)
          .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u)
      )
      .max(20),
    state: RandomValueSchema
  })
})

/** Golden tests for the OAuth client, connection and scope commands. */
export const OAUTH_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: ORGANIZATION,
    command: 'org oauth-client list',
    route: { body: listed, method: 'GET', path: CLIENTS },
    schema: ListOrganizationOauthClientsOutputSchema,
    shows: 'Globex Sync'
  }),
  printsResponse({
    args: [CLIENT_ID, ...ORGANIZATION],
    command: 'org oauth-client view',
    route: { body: newerClient, method: 'GET', path: CLIENT },
    schema: GetOrganizationOauthClientOutputSchema,
    shows: client.description
  }),
  printsResponse({
    args: [
      ...ORGANIZATION,
      '--name',
      client.name,
      '--description',
      client.description,
      '--redirect-uri',
      defaultRedirect.uri,
      '--redirect-uri',
      loopbackRedirect.uri,
      '--default-redirect-uri',
      defaultRedirect.uri,
      '--scope',
      'account:read',
      '--scope',
      'project:read',
      '--idempotency-key',
      'golden-oauth-client-create'
    ],
    command: 'org oauth-client create',
    route: {
      body: created,
      method: 'POST',
      path: CLIENTS,
      requestBody: {
        description: client.description,
        name: client.name,
        redirectUris: [defaultRedirect, loopbackRedirect],
        scopes: client.scopes
      },
      status: 201
    },
    schema: CreateOrganizationOauthClientOutputSchema,
    shows: 'Created OAuth client'
  }),
  // A workflow: it reads the client for its ETag, then updates it, and prints
  // the update's response.
  {
    args: [CLIENT_ID, ...ORGANIZATION, '--name', updated.name],
    command: 'org oauth-client update',
    document: updated,
    routes: [
      {
        body: client,
        headers: { etag: '"version-7"' },
        method: 'GET',
        path: CLIENT
      },
      {
        body: updated,
        method: 'PATCH',
        path: CLIENT,
        requestBody: { name: updated.name }
      }
    ],
    schema: UpdateOrganizationOauthClientOutputSchema,
    shows: updated.name
  },
  printsResponse({
    args: [CLIENT_ID, ...ORGANIZATION, '--yes'],
    command: 'org oauth-client delete',
    route: { body: deleted, method: 'DELETE', path: CLIENT },
    schema: DeleteOrganizationOauthClientOutputSchema,
    shows: `Deleted OAuth client ${CLIENT_ID}.`
  }),
  printsResponse({
    args: [CLIENT_ID, ...ORGANIZATION],
    command: 'org oauth-client secret view',
    route: { body: clientSecret, method: 'GET', path: SECRET },
    schema: GetOrganizationOauthClientSecretOutputSchema,
    shows: clientSecret.current.hint
  }),
  printsResponse({
    args: [
      CLIENT_ID,
      ...ORGANIZATION,
      '--idempotency-key',
      'golden-oauth-secret-create'
    ],
    checkedSecret: 'value',
    command: 'org oauth-client secret create',
    route: { body: setUp, method: 'PUT', path: SECRET, status: 201 },
    schema: SetupOrganizationOauthClientSecretOutputSchema,
    shows: PLAINTEXT_SECRET,
    showsNoApiText: true
  }),
  printsResponse({
    args: [
      CLIENT_ID,
      ...ORGANIZATION,
      '--idempotency-key',
      'golden-oauth-secret-rotate',
      '--yes'
    ],
    checkedSecret: 'value',
    command: 'org oauth-client secret rotate',
    route: {
      body: rotated,
      method: 'POST',
      path: `${SECRET}/rotate`,
      requestBody: { mode: 'normal' }
    },
    schema: RotateOrganizationOauthClientSecretOutputSchema,
    shows: ROTATED_SECRET
  }),
  {
    args: [CLIENT_ID, ...ORGANIZATION, '--yes'],
    command: 'org oauth-client secret revoke',
    document: { clientId: CLIENT_ID, revoked: true },
    routes: [{ method: 'DELETE', path: SECRET, status: 204 }],
    schema: RevokedSecretSchema,
    shows: `Revoked the secret of OAuth client ${CLIENT_ID}.`,
    showsNoApiText: true
  },
  {
    args: [APPLICATION_ID, '--yes'],
    command: 'account oauth connection revoke',
    document: { applicationId: APPLICATION_ID, revoked: true },
    routes: [
      {
        method: 'DELETE',
        path: `/v1/account/oauth/authorized-applications/${APPLICATION_ID}`,
        status: 204
      }
    ],
    schema: RevokedConnectionSchema,
    shows: `Revoked OAuth connection ${APPLICATION_ID}.`,
    showsNoApiText: true
  },
  printsResponse({
    args: [],
    command: 'account oauth scope list',
    route: { body: scopes, method: 'GET', path: '/v1/auth/oauth/scopes' },
    schema: ListOauthScopesOutputSchema,
    shows: 'project:read'
  }),
  // A workflow: it prints the authorization request it builds, from four
  // requests sent at once. With --no-browser, text shows only the
  // authorization URL: the client's values are percent-encoded in its query,
  // and the endpoint before it must parse as a URL.
  buildsDocument({
    args: [CLIENT_ID, ...ORGANIZATION, '--no-browser'],
    build: authorization(false),
    command: 'org oauth-client authorize',
    concurrent: 4,
    from: [clientRoute, protectedResourceRoute, authorizationServerRoute],
    routes: AUTHORIZE_ROUTES,
    schema: AuthorizationSchema,
    shows: `Authorization URL: ${API}/oauth2/authorize?client_id=${CLIENT_ID}&nonce=${NONCE}&redirect_uri=https%3A%2F%2Facme.example.test%2Fcallback&response_type=code&scope=openid+account%3Aread+project%3Aread&state=${STATE}`,
    showsNoApiText: true
  }),
  buildsDocument({
    args: [CLIENT_ID, ...ORGANIZATION],
    build: authorization(true),
    command: 'org oauth-client authorize',
    concurrent: 4,
    from: [clientRoute, protectedResourceRoute, authorizationServerRoute],
    routes: AUTHORIZE_ROUTES,
    schema: AuthorizationSchema,
    shows: 'Opened OAuth authorization in your browser.',
    showsNoApiText: true
  })
]
