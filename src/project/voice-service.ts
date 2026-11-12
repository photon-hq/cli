import {
  type PhotonNamespaces,
  type RequestOptions,
  TransportError
} from '@photon-ai/api'
import type { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { CliError } from '../core/errors.ts'
import { normalizeSdkError, type SdkErrorOptions } from '../core/sdk-error.ts'
import type { KnownEnumValue } from '../core/validation.ts'
import type { PaginationOptions } from './service.ts'
import {
  isVoiceProfileOutboundDigestAlgorithm,
  type VoiceProfileOutboundDigestAlgorithm
} from './voice-outbound-authentication.ts'

type PlatformsScope = PhotonNamespaces['projects']['platforms']

export type VoiceScope = Pick<
  PlatformsScope,
  | 'assignVoiceLineProfile'
  | 'batchUpdateVoiceLineProfileAssignments'
  | 'configureVoiceProfileOutbound'
  | 'createDefaultVoiceProfile'
  | 'createVoiceProfile'
  | 'deleteVoiceProfile'
  | 'deleteVoiceProfileInbound'
  | 'deleteVoiceProfileOutbound'
  | 'getDefaultVoiceProfile'
  | 'getVoiceLineProfileAssignment'
  | 'getVoiceProfile'
  | 'listVoiceProfiles'
  | 'replaceVoiceProfileInbound'
  | 'rotateVoiceProfileOutboundCredential'
  | 'unassignVoiceLineProfile'
  | 'updateDefaultVoiceProfile'
  | 'updateVoiceProfile'
  | 'updateVoiceProfileInbound'
  | 'updateVoiceProfileOutboundAuthentication'
>

export type VoiceProfile = Awaited<ReturnType<VoiceScope['getVoiceProfile']>>
export type VoiceProfileList = Awaited<
  ReturnType<VoiceScope['listVoiceProfiles']>
>
type VoiceProfileOutbound = NonNullable<
  VoiceProfile['configuration']['outbound']
>
export type VoiceProfileInboundResult = Awaited<
  ReturnType<VoiceScope['updateVoiceProfileInbound']>
>
export type VoiceProfileOutboundSetupResult = Awaited<
  ReturnType<VoiceScope['configureVoiceProfileOutbound']>
>
export type VoiceProfileOutboundAuthenticationResult = Awaited<
  ReturnType<VoiceScope['updateVoiceProfileOutboundAuthentication']>
>
export type VoiceProfileOutboundRotationResult = Awaited<
  ReturnType<VoiceScope['rotateVoiceProfileOutboundCredential']>
>
export type VoiceProfileOutboundRevocationResult = Awaited<
  ReturnType<VoiceScope['deleteVoiceProfileOutbound']>
>
export type VoiceProfileReference = 'default' | string
export type VoiceLineProfileAssignment = Awaited<
  ReturnType<VoiceScope['getVoiceLineProfileAssignment']>
>

type CreateVoiceProfileBody = Parameters<
  VoiceScope['createVoiceProfile']
>[0]['body']
export type VoiceProfileCreateInput = CreateVoiceProfileBody
export type VoiceSipCredentialsInput = NonNullable<
  VoiceProfileInboundReplaceInput['credentials']
>

export type VoiceDefaultProfileCreateInput = Parameters<
  VoiceScope['createDefaultVoiceProfile']
>[0]['body']

type UpdateVoiceProfileBody = Parameters<
  VoiceScope['updateVoiceProfile']
>[0]['body']
export type VoiceProfileChanges = Omit<
  UpdateVoiceProfileBody,
  'expectedVersion'
>

type ReplaceVoiceProfileInboundBody = Parameters<
  VoiceScope['replaceVoiceProfileInbound']
>[0]['body']
export type VoiceProfileInboundReplaceInput = Omit<
  ReplaceVoiceProfileInboundBody,
  'expectedVersion'
>

type UpdateVoiceProfileInboundBody = Parameters<
  VoiceScope['updateVoiceProfileInbound']
>[0]['body']
export type VoiceProfileInboundChanges = Omit<
  UpdateVoiceProfileInboundBody,
  'expectedVersion'
>

type RotateVoiceProfileOutboundBody = Parameters<
  VoiceScope['rotateVoiceProfileOutboundCredential']
>[0]['body']
export type VoiceProfileOutboundRotationMode = KnownEnumValue<
  RotateVoiceProfileOutboundBody['mode']
>

export type VoiceLineProfileAssignmentUpdate = Parameters<
  VoiceScope['batchUpdateVoiceLineProfileAssignments']
>[0]['body']['updates'][number]

interface VoiceServiceOptions {
  request: AuthenticatedRequest
  scope: VoiceScope
  signal?: AbortSignal
}

interface PageRequest<Result> extends PaginationOptions {
  maximumPageSize: number
  request: (
    pageSize: number,
    pageToken: string | undefined
  ) => Promise<{ items: Result[]; nextPageToken?: string }>
}

const MAXIMUM_PAGINATION_PAGES = 100
const VOICE_PROFILE_PAGE_SIZE_LIMIT = 200

const paginationError = (message: string): CliError =>
  new CliError('VOICE_PROTOCOL_ERROR', message)

const assertSupportedOutboundAlgorithm = (
  outbound: VoiceProfileOutbound | null
): void => {
  if (
    outbound === null ||
    isVoiceProfileOutboundDigestAlgorithm(outbound.authentication.algorithm)
  ) {
    return
  }
  throw new CliError(
    'VOICE_PROTOCOL_ERROR',
    'Photon returned an invalid Voice response.',
    {
      detail: `The outbound SIP authentication algorithm "${outbound.authentication.algorithm}" is unsupported.`,
      next: [
        {
          description:
            'Retry the command. If the response still reports an unsupported algorithm, contact Photon support.'
        }
      ]
    }
  )
}

const checkedProfile = (profile: VoiceProfile): VoiceProfile => {
  assertSupportedOutboundAlgorithm(profile.configuration.outbound)
  return profile
}

export class VoiceService {
  readonly #request: AuthenticatedRequest
  readonly #scope: VoiceScope
  readonly #signal: AbortSignal | undefined

  constructor(options: VoiceServiceOptions) {
    this.#request = options.request
    this.#scope = options.scope
    this.#signal = options.signal
  }

  async assignLineProfile(
    projectId: string,
    resourceId: string,
    profileId: string,
    expectedVersion: number
  ): Promise<VoiceLineProfileAssignment> {
    return await this.#execute((scope, options) =>
      scope.assignVoiceLineProfile(
        {
          body: { expectedVersion, profileId },
          path: { id: projectId, resourceId }
        },
        options
      )
    )
  }

  async batchUpdateLineProfileAssignments(
    projectId: string,
    updates: VoiceLineProfileAssignmentUpdate[]
  ): Promise<VoiceLineProfileAssignment[]> {
    const response = await this.#execute((scope, options) =>
      scope.batchUpdateVoiceLineProfileAssignments(
        { body: { updates }, path: { id: projectId } },
        options
      )
    )
    return response.assignments
  }

  async createProfile(
    projectId: string,
    input: VoiceProfileCreateInput
  ): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute((scope, options) =>
        scope.createVoiceProfile(
          { body: input, path: { id: projectId } },
          options
        )
      )
    )
  }

  async createDefaultProfile(
    projectId: string,
    input: VoiceDefaultProfileCreateInput
  ): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute((scope, options) =>
        scope.createDefaultVoiceProfile(
          { body: input, path: { id: projectId } },
          options
        )
      )
    )
  }

  async clearProfileInbound(
    projectId: string,
    profileId: string,
    expectedVersion: number
  ): Promise<VoiceProfileInboundResult> {
    return await this.#execute((scope, options) =>
      scope.deleteVoiceProfileInbound(
        {
          path: { id: projectId, profileId },
          query: { expectedVersion }
        },
        options
      )
    )
  }

  async enableProfileOutbound(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    digestAlgorithm: VoiceProfileOutboundDigestAlgorithm,
    idempotencyKey: string
  ): Promise<VoiceProfileOutboundSetupResult> {
    const result = await this.#executeKeyed((scope, options) =>
      scope.configureVoiceProfileOutbound(
        {
          body: {
            authentication: { algorithm: digestAlgorithm },
            expectedVersion
          },
          headers: { idempotencyKey },
          path: { id: projectId, profileId }
        },
        options
      )
    )
    assertSupportedOutboundAlgorithm(result.outbound)
    return result
  }

  async replaceProfileInbound(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    input: VoiceProfileInboundReplaceInput
  ): Promise<VoiceProfileInboundResult> {
    return await this.#execute(
      (scope, options) =>
        scope.replaceVoiceProfileInbound(
          {
            body: { expectedVersion, ...input },
            path: { id: projectId, profileId }
          },
          options
        ),
      true
    )
  }

  async updateProfileOutboundAuthentication(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    digestAlgorithm: VoiceProfileOutboundDigestAlgorithm
  ): Promise<VoiceProfileOutboundAuthenticationResult> {
    const result = await this.#execute((scope, options) =>
      scope.updateVoiceProfileOutboundAuthentication(
        {
          body: {
            authentication: { algorithm: digestAlgorithm },
            expectedVersion
          },
          path: { id: projectId, profileId }
        },
        options
      )
    )
    assertSupportedOutboundAlgorithm(result.outbound)
    return result
  }

  async revokeProfileOutbound(
    projectId: string,
    profileId: string,
    expectedVersion: number
  ): Promise<VoiceProfileOutboundRevocationResult> {
    return await this.#execute((scope, options) =>
      scope.deleteVoiceProfileOutbound(
        {
          path: { id: projectId, profileId },
          query: { expectedVersion }
        },
        options
      )
    )
  }

  async rotateProfileOutbound(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    mode: VoiceProfileOutboundRotationMode,
    idempotencyKey: string
  ): Promise<VoiceProfileOutboundRotationResult> {
    return await this.#executeKeyed((scope, options) =>
      scope.rotateVoiceProfileOutboundCredential(
        {
          body: { expectedVersion, mode },
          headers: { idempotencyKey },
          path: { id: projectId, profileId }
        },
        options
      )
    )
  }

  async deleteProfile(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    unassignLines: boolean
  ): Promise<void> {
    await this.#execute((scope, options) =>
      scope.deleteVoiceProfile(
        {
          path: { id: projectId, profileId },
          query: {
            expectedVersion,
            force: unassignLines ? 'true' : 'false'
          }
        },
        options
      )
    )
  }

  async getLineProfileAssignment(
    projectId: string,
    resourceId: string
  ): Promise<VoiceLineProfileAssignment> {
    return await this.#execute((scope, options) =>
      scope.getVoiceLineProfileAssignment(
        { path: { id: projectId, resourceId } },
        options
      )
    )
  }

  async getDefaultProfile(projectId: string): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute(
        (scope, options) =>
          scope.getDefaultVoiceProfile({ path: { id: projectId } }, options),
        true
      )
    )
  }

  async getProfile(
    projectId: string,
    profileId: string
  ): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute(
        (scope, options) =>
          scope.getVoiceProfile(
            { path: { id: projectId, profileId } },
            options
          ),
        true
      )
    )
  }

  async listProfiles(
    projectId: string,
    pagination: PaginationOptions,
    isDefault?: boolean
  ): Promise<VoiceProfileList> {
    let lastPage: VoiceProfileList = { profiles: [] }
    const result = await this.#paginate<VoiceProfileList['profiles'][number]>({
      ...pagination,
      maximumPageSize: VOICE_PROFILE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) => {
        lastPage = await this.#execute(
          (scope, options) =>
            scope.listVoiceProfiles(
              {
                path: { id: projectId },
                query: {
                  ...(isDefault === undefined
                    ? {}
                    : { default: isDefault ? 'true' : 'false' }),
                  pageSize,
                  ...(pageToken === undefined ? {} : { pageToken })
                }
              },
              options
            ),
          true
        )
        for (const profile of lastPage.profiles) {
          assertSupportedOutboundAlgorithm(profile.configuration.outbound)
        }
        return {
          items: lastPage.profiles,
          ...(lastPage.nextPageToken === undefined
            ? {}
            : { nextPageToken: lastPage.nextPageToken })
        }
      }
    })
    const { nextPageToken: _lastPageToken, ...fields } = lastPage
    return {
      ...fields,
      profiles: result.items,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken })
    }
  }

  async unassignLineProfile(
    projectId: string,
    resourceId: string,
    expectedVersion: number
  ): Promise<void> {
    await this.#execute((scope, options) =>
      scope.unassignVoiceLineProfile(
        {
          path: { id: projectId, resourceId },
          query: { expectedVersion }
        },
        options
      )
    )
  }

  async updateDefaultProfile(
    projectId: string,
    expectedVersion: number,
    changes: Omit<VoiceProfileChanges, 'name'>
  ): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute(
        (scope, options) =>
          scope.updateDefaultVoiceProfile(
            {
              body: { expectedVersion, ...changes },
              path: { id: projectId }
            },
            options
          ),
        false
      )
    )
  }

  async updateProfile(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    changes: VoiceProfileChanges
  ): Promise<VoiceProfile> {
    return checkedProfile(
      await this.#execute(
        (scope, options) =>
          scope.updateVoiceProfile(
            {
              body: { expectedVersion, ...changes },
              path: { id: projectId, profileId }
            },
            options
          ),
        false
      )
    )
  }

  async updateProfileInbound(
    projectId: string,
    profileId: string,
    expectedVersion: number,
    changes: VoiceProfileInboundChanges
  ): Promise<VoiceProfileInboundResult> {
    return await this.#execute(
      (scope, options) =>
        scope.updateVoiceProfileInbound(
          {
            body: { expectedVersion, ...changes },
            path: { id: projectId, profileId }
          },
          options
        ),
      changes.credentials !== undefined
    )
  }

  async #execute<Result>(
    run: (scope: VoiceScope, options?: RequestOptions) => Promise<Result>,
    sensitive = false
  ): Promise<Result> {
    try {
      return await this.#request.run((options) => run(this.#scope, options))
    } catch (error) {
      throw normalizeSdkError(error, this.#errorOptions(sensitive))
    }
  }

  async #executeKeyed<Result>(
    run: (scope: VoiceScope, options?: RequestOptions) => Promise<Result>
  ): Promise<Result> {
    try {
      return await this.#request.run((options) => run(this.#scope, options))
    } catch (error) {
      this.#signal?.throwIfAborted()
      if (!(error instanceof TransportError)) {
        throw normalizeSdkError(error, this.#errorOptions(true))
      }
    }
    try {
      return await this.#request.run((options) => run(this.#scope, options))
    } catch (error) {
      throw normalizeSdkError(error, this.#errorOptions(true))
    }
  }

  #errorOptions(sensitive: boolean): SdkErrorOptions {
    return {
      sensitive,
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    }
  }

  async #paginate<Result>(
    input: PageRequest<Result>
  ): Promise<{ items: Result[]; nextPageToken?: string }> {
    const items: Result[] = []
    const seenTokens = new Set<string>()
    let { pageToken } = input
    let pages = 0

    while (items.length < input.limit) {
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw paginationError(
            'Voice profile pagination repeated a page token.'
          )
        }
        seenTokens.add(pageToken)
      }
      if (pages >= MAXIMUM_PAGINATION_PAGES) {
        throw paginationError(
          'Voice profile pagination exceeded the safety page limit.'
        )
      }
      const pageSize = Math.min(
        input.maximumPageSize,
        input.limit - items.length
      )
      // biome-ignore lint/performance/noAwaitInLoops: each request depends on the previous response's opaque page token.
      const page = await input.request(pageSize, pageToken)
      pages += 1
      if (page.items.length > pageSize) {
        throw paginationError(
          'Voice profile pagination returned more records than requested.'
        )
      }
      items.push(...page.items)
      if (page.items.length === 0 || page.nextPageToken === undefined) {
        return { items }
      }
      pageToken = page.nextPageToken
    }
    return {
      items,
      ...(pageToken === undefined ? {} : { nextPageToken: pageToken })
    }
  }
}
