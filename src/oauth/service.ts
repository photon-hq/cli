import { randomUUID } from 'node:crypto'
import type {
  CreateOrganizationOauthClientInput,
  CreateOrganizationOauthClientOutput,
  DeleteOrganizationOauthClientOutput,
  GetOrganizationOauthClientOutput,
  GetOrganizationOauthClientSecretOutput,
  ListAuthorizedApplicationsInput,
  ListAuthorizedApplicationsOutput,
  ListOauthScopesOutput,
  ListOrganizationOauthClientsOutput,
  PhotonNamespaces,
  PhotonRawNamespaces,
  RequestOptions,
  RotateOrganizationOauthClientSecretInput,
  RotateOrganizationOauthClientSecretOutput,
  SetupOrganizationOauthClientSecretOutput,
  UpdateOrganizationOauthClientInput,
  UpdateOrganizationOauthClientOutput
} from '@photon-ai/api'
import type { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { CliError, copyCliError } from '../core/errors.ts'
import { normalizeSdkError } from '../core/sdk-error.ts'
import { CLI_NAME } from '../meta.ts'
import {
  discoverOauthAuthorizationServer,
  type OauthAuthorizationServer
} from './discovery.ts'

type AccountNamespace = PhotonNamespaces['account']
type AuthNamespace = PhotonNamespaces['auth']
type OrganizationNamespace = PhotonNamespaces['organizations']
type RawOrganizationNamespace = PhotonRawNamespaces['organizations']

// Connected (authorized) applications belong to the account; OAuth clients
// and their secret belong to an organization. A client has one secret, plus
// the one it replaced while that one's grace period lasts.
export type OauthScope = Pick<
  AccountNamespace,
  'listAuthorizedApplications' | 'revokeAuthorizedApplication'
> &
  Pick<
    OrganizationNamespace,
    | 'createOrganizationOauthClient'
    | 'deleteOrganizationOauthClient'
    | 'deleteOrganizationOauthClientSecret'
    | 'getOrganizationOauthClient'
    | 'getOrganizationOauthClientSecret'
    | 'listOrganizationOauthClients'
    | 'rotateOrganizationOauthClientSecret'
    | 'setupOrganizationOauthClientSecret'
    | 'updateOrganizationOauthClient'
  >

export type OauthCatalogScope = Pick<AuthNamespace, 'listOauthScopes'>
export type OauthRawScope = Pick<
  RawOrganizationNamespace,
  'getOrganizationOauthClient'
>

export type OauthClientCreateInput = CreateOrganizationOauthClientInput['body']
export type OauthClientUpdateInput = UpdateOrganizationOauthClientInput['body']
export type OauthSecretRotationMode =
  RotateOrganizationOauthClientSecretInput['body']['mode']
export type OauthConnectionListInput = NonNullable<
  ListAuthorizedApplicationsInput['query']
>

interface OauthServiceOptions {
  apiOrigin: string
  catalog: OauthCatalogScope
  fetch?: typeof globalThis.fetch
  rawScope: OauthRawScope
  request: AuthenticatedRequest
  scope: OauthScope
  signal?: AbortSignal
  timeoutMs?: number
}

type OauthRequest<Result> = (options?: RequestOptions) => Promise<Result>

// A creation whose outcome is unknown is safe to repeat with its key: Photon
// returns what the first request created instead of creating it again.
const retryWithKey =
  (idempotencyKey: string) =>
  (error: CliError): CliError =>
    copyCliError(error, {
      idempotencyKey,
      ...(error.retryable ||
      error.httpStatus === undefined ||
      error.httpStatus >= 500
        ? {
            next: [
              {
                description: `Retry the same command with --idempotency-key ${idempotencyKey}`
              }
            ]
          }
        : {})
    })

const STRONG_ETAG_PATTERN = /^"[\x21\x23-\x7e\x80-\xff]*"$/u

export class OauthService {
  readonly #apiOrigin: string
  readonly #catalog: OauthCatalogScope
  readonly #fetch: typeof globalThis.fetch
  readonly #rawScope: OauthRawScope
  readonly #request: AuthenticatedRequest
  readonly #scope: OauthScope
  readonly #signal: AbortSignal | undefined
  readonly #timeoutMs: number | undefined

  constructor(options: OauthServiceOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#catalog = options.catalog
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#rawScope = options.rawScope
    this.#request = options.request
    this.#scope = options.scope
    this.#signal = options.signal
    this.#timeoutMs = options.timeoutMs
  }

  async discoverAuthorizationServer(): Promise<OauthAuthorizationServer> {
    return await discoverOauthAuthorizationServer({
      apiOrigin: this.#apiOrigin,
      fetch: this.#fetch,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs })
    })
  }

  async listScopes(): Promise<ListOauthScopesOutput> {
    try {
      return await this.#catalog.listOauthScopes(
        {},
        this.#signal === undefined ? undefined : { signal: this.#signal }
      )
    } catch (error) {
      return this.#throwOauthError(error)
    }
  }

  async listClients(
    organizationId: string
  ): Promise<ListOrganizationOauthClientsOutput> {
    return await this.#run((options) =>
      this.#scope.listOrganizationOauthClients(
        { path: { organizationId } },
        options
      )
    )
  }

  async listConnections(
    input: OauthConnectionListInput
  ): Promise<ListAuthorizedApplicationsOutput> {
    return await this.#run((options) =>
      this.#scope.listAuthorizedApplications({ query: input }, options)
    )
  }

  async revokeConnection(applicationId: string): Promise<void> {
    await this.#run((options) =>
      this.#scope.revokeAuthorizedApplication(
        { path: { applicationId } },
        options
      )
    )
  }

  async getClient(
    organizationId: string,
    clientId: string
  ): Promise<GetOrganizationOauthClientOutput> {
    return await this.#run((options) =>
      this.#scope.getOrganizationOauthClient(
        { path: { clientId, organizationId } },
        options
      )
    )
  }

  // The key is chosen once, so a retry after a token refresh repeats the same
  // logical creation. An uncertain outcome must be retried with the same key,
  // never a new one.
  async createClient(
    organizationId: string,
    input: OauthClientCreateInput,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateOrganizationOauthClientOutput> {
    return await this.#run(
      (options) =>
        this.#scope.createOrganizationOauthClient(
          {
            body: input,
            headers: { 'idempotency-key': idempotencyKey },
            path: { organizationId }
          },
          options
        ),
      idempotencyKey
    )
  }

  async updateClient(
    organizationId: string,
    clientId: string,
    input: OauthClientUpdateInput
  ): Promise<UpdateOrganizationOauthClientOutput> {
    const etag = await this.#getClientEtag(organizationId, clientId)
    return await this.#run((options) => {
      const headers = new Headers(options?.headers)
      headers.set('if-match', etag)
      return this.#scope.updateOrganizationOauthClient(
        {
          body: input,
          headers: { 'if-match': etag },
          path: { clientId, organizationId }
        },
        { ...options, headers }
      )
    })
  }

  async deleteClient(
    organizationId: string,
    clientId: string
  ): Promise<DeleteOrganizationOauthClientOutput> {
    return await this.#run((options) =>
      this.#scope.deleteOrganizationOauthClient(
        { path: { clientId, organizationId } },
        options
      )
    )
  }

  async getClientSecret(
    organizationId: string,
    clientId: string
  ): Promise<GetOrganizationOauthClientSecretOutput> {
    return await this.#run((options) =>
      this.#scope.getOrganizationOauthClientSecret(
        { path: { clientId, organizationId } },
        options
      )
    )
  }

  async setUpClientSecret(
    organizationId: string,
    clientId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<SetupOrganizationOauthClientSecretOutput> {
    return await this.#run(
      (options) =>
        this.#scope.setupOrganizationOauthClientSecret(
          {
            headers: { 'idempotency-key': idempotencyKey },
            path: { clientId, organizationId }
          },
          options
        ),
      idempotencyKey
    )
  }

  async rotateClientSecret(
    organizationId: string,
    clientId: string,
    mode: OauthSecretRotationMode,
    idempotencyKey: string = randomUUID()
  ): Promise<RotateOrganizationOauthClientSecretOutput> {
    return await this.#run(
      (options) =>
        this.#scope.rotateOrganizationOauthClientSecret(
          {
            body: { mode },
            headers: { 'idempotency-key': idempotencyKey },
            path: { clientId, organizationId }
          },
          options
        ),
      idempotencyKey
    )
  }

  async revokeClientSecret(
    organizationId: string,
    clientId: string
  ): Promise<void> {
    await this.#run((options) =>
      this.#scope.deleteOrganizationOauthClientSecret(
        { path: { clientId, organizationId } },
        options
      )
    )
  }

  async #run<Result>(
    request: OauthRequest<Result>,
    idempotencyKey?: string
  ): Promise<Result> {
    try {
      return await this.#request.run(request)
    } catch (error) {
      return this.#throwOauthError(error, idempotencyKey)
    }
  }

  async #getClientEtag(
    organizationId: string,
    clientId: string
  ): Promise<string> {
    const response = await this.#run((options) =>
      this.#rawScope.getOrganizationOauthClient(
        { path: { clientId, organizationId } },
        options
      )
    )
    const etag = response.headers.get('etag')
    if (etag === null || !STRONG_ETAG_PATTERN.test(etag)) {
      throw new CliError(
        'OAUTH_PROTOCOL_ERROR',
        'Photon returned an invalid OAuth response.',
        {
          detail: 'The OAuth client response did not include a strong ETag.',
          next: [
            {
              description: 'View the client, then retry the update',
              run: `${CLI_NAME} org oauth-client view ${clientId}`
            }
          ],
          retryable: true
        }
      )
    }
    return etag
  }

  #throwOauthError(error: unknown, idempotencyKey?: string): never {
    throw normalizeSdkError(error, {
      ...(idempotencyKey === undefined
        ? {}
        : { override: retryWithKey(idempotencyKey) }),
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    })
  }
}
