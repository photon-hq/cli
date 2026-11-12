import { ApiError, TransportError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import {
  type VoiceLineProfileAssignment,
  type VoiceScope,
  VoiceService
} from '../src/project/voice-service.ts'

const projectId = 'pho_prj_01h455vb4pex5vsknk084sn02q'
const profileId = 'pho_vpf_01h455vb4pex5vsknk084sn02q'
const resourceId = 'pho_res_01h455vb4pex5vsknk084sn02q'
const timestamp = '2026-08-21T18:00:00.000Z'
type SdkVoiceProfile = Awaited<ReturnType<VoiceScope['getVoiceProfile']>>
type SdkVoiceProfileOutbound = NonNullable<
  SdkVoiceProfile['configuration']['outbound']
>

const outbound = (
  overrides: Partial<SdkVoiceProfileOutbound> = {}
): SdkVoiceProfileOutbound => ({
  authentication: {
    algorithm: 'sha-256',
    previousPasswordValidUntil: null,
    username: 'profile-outbound-user',
    validFrom: timestamp
  },
  connection: {
    endpoints: [
      {
        host: 'sip.example.test',
        port: 5071,
        transport: 'tls'
      }
    ],
    realm: 'sip.example.test'
  },
  ...overrides
})

const profile = (
  overrides: Partial<SdkVoiceProfile> = {}
): SdkVoiceProfile => ({
  configuration: {
    inbound: {
      credentials: null,
      destinationUri: 'sips:agent@example.test:5061'
    },
    outbound: null
  },
  createdAt: timestamp,
  isDefault: false,
  lineCount: 0,
  mediaEncryption: 'auto',
  name: 'Production agent',
  profileId,
  projectId,
  protocol: 'sip',
  updatedAt: timestamp,
  version: 1,
  ...overrides
})

const assignment = (
  overrides: Partial<VoiceLineProfileAssignment> = {}
): VoiceLineProfileAssignment => ({
  profileId,
  profileVersion: 1,
  projectId,
  resourceId,
  resourceVersion: 2,
  updatedAt: timestamp,
  ...overrides
})

const voiceScope = (overrides: Partial<VoiceScope> = {}): VoiceScope => ({
  assignVoiceLineProfile: vi.fn(() => Promise.resolve(assignment())),
  batchUpdateVoiceLineProfileAssignments: vi.fn(() =>
    Promise.resolve({ assignments: [assignment()] })
  ),
  configureVoiceProfileOutbound: vi.fn(() =>
    Promise.resolve({
      outbound: outbound(),
      password: 'outbound-password',
      profileVersion: 2
    })
  ),
  createDefaultVoiceProfile: vi.fn(() =>
    Promise.resolve(profile({ isDefault: true }))
  ),
  createVoiceProfile: vi.fn(() => Promise.resolve(profile())),
  deleteVoiceProfile: vi.fn(() => Promise.resolve(undefined)),
  deleteVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({ inbound: null, profileVersion: 2 })
  ),
  deleteVoiceProfileOutbound: vi.fn(() =>
    Promise.resolve({ outbound: null, profileVersion: 2 })
  ),
  getDefaultVoiceProfile: vi.fn(() =>
    Promise.resolve(profile({ isDefault: true }))
  ),
  getVoiceLineProfileAssignment: vi.fn(() => Promise.resolve(assignment())),
  getVoiceProfile: vi.fn(() => Promise.resolve(profile())),
  listVoiceProfiles: vi.fn(() => Promise.resolve({ profiles: [profile()] })),
  replaceVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({
      inbound: {
        credentials: null,
        destinationUri: 'sips:agent@example.test:5061'
      },
      profileVersion: 2
    })
  ),
  rotateVoiceProfileOutboundCredential: vi.fn(() =>
    Promise.resolve({
      password: 'rotated-password',
      previousPasswordValidUntil: null,
      profileVersion: 3
    })
  ),
  unassignVoiceLineProfile: vi.fn(() => Promise.resolve(undefined)),
  updateDefaultVoiceProfile: () =>
    Promise.resolve(profile({ isDefault: true })),
  updateVoiceProfile: vi.fn(() => Promise.resolve(profile({ version: 2 }))),
  updateVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({
      inbound: {
        credentials: null,
        destinationUri: 'sips:agent@example.test:5061'
      },
      profileVersion: 2
    })
  ),
  updateVoiceProfileOutboundAuthentication: vi.fn(() =>
    Promise.resolve({ outbound: outbound(), profileVersion: 2 })
  ),
  ...overrides
})

const createRequest = (signal?: AbortSignal): AuthenticatedRequest =>
  new AuthenticatedRequest({
    ...(signal === undefined ? {} : { signal }),
    tokenManager: {
      getAccessToken: vi.fn(() => Promise.resolve('access-token')),
      refreshAfterUnauthorized: vi.fn(() => Promise.resolve('rotated-token'))
    }
  })

describe('Voice service', () => {
  test('refreshes a stored sign-in after a 401 and sends the request again', async () => {
    const refreshAfterUnauthorized = vi.fn(() =>
      Promise.resolve('rotated-token')
    )
    const getVoiceLineProfileAssignment = vi
      .fn<VoiceScope['getVoiceLineProfileAssignment']>()
      .mockRejectedValueOnce(
        new ApiError('unauthorized', {
          body: { status: 401, title: 'Unauthorized' },
          headers: new Headers(),
          status: 401
        })
      )
      .mockResolvedValueOnce(assignment())
    const service = new VoiceService({
      request: new AuthenticatedRequest({
        tokenManager: {
          getAccessToken: vi.fn(() => Promise.resolve('access-token')),
          refreshAfterUnauthorized
        }
      }),
      scope: voiceScope({ getVoiceLineProfileAssignment })
    })

    await expect(
      service.getLineProfileAssignment(projectId, resourceId)
    ).resolves.toEqual(assignment())
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1)
    expect(getVoiceLineProfileAssignment).toHaveBeenCalledTimes(2)
  })

  test.each(['sha-256', 'md5'] as const)(
    'edits outbound authentication to %s through the generated non-keyed method',
    async (algorithm) => {
      const expectedOutbound = outbound({
        authentication: {
          ...outbound().authentication,
          algorithm,
          previousPasswordValidUntil: timestamp
        }
      })
      const response = { outbound: expectedOutbound, profileVersion: 17 }
      const updateVoiceProfileOutboundAuthentication = vi
        .fn<VoiceScope['updateVoiceProfileOutboundAuthentication']>()
        .mockResolvedValue(response)
      const { signal } = new AbortController()
      const service = new VoiceService({
        request: createRequest(signal),
        scope: voiceScope({ updateVoiceProfileOutboundAuthentication }),
        signal
      })

      await expect(
        service.updateProfileOutboundAuthentication(
          projectId,
          profileId,
          16,
          algorithm
        )
      ).resolves.toBe(response)
      expect(
        updateVoiceProfileOutboundAuthentication
      ).toHaveBeenCalledExactlyOnceWith(
        {
          body: { authentication: { algorithm }, expectedVersion: 16 },
          path: { id: projectId, profileId }
        },
        { signal }
      )
    }
  )

  test('throws the cancellation, not a connection error, once the command is cancelled', async () => {
    const controller = new AbortController()
    const cancelled = new Error('cancelled')
    const updateVoiceProfileOutboundAuthentication = vi.fn<
      VoiceScope['updateVoiceProfileOutboundAuthentication']
    >(() => {
      controller.abort(cancelled)
      return Promise.reject(new TransportError('response interrupted'))
    })
    const service = new VoiceService({
      request: createRequest(controller.signal),
      scope: voiceScope({ updateVoiceProfileOutboundAuthentication }),
      signal: controller.signal
    })

    await expect(
      service.updateProfileOutboundAuthentication(
        projectId,
        profileId,
        16,
        'md5'
      )
    ).rejects.toBe(cancelled)
  })

  test('does not retry a non-keyed outbound edit after a transport interruption', async () => {
    const updateVoiceProfileOutboundAuthentication = vi
      .fn<VoiceScope['updateVoiceProfileOutboundAuthentication']>()
      .mockRejectedValue(new TransportError('response interrupted'))
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ updateVoiceProfileOutboundAuthentication })
    })

    await expect(
      service.updateProfileOutboundAuthentication(
        projectId,
        profileId,
        16,
        'md5'
      )
    ).rejects.toMatchObject({ code: 'API_CONNECTION_ERROR' })
    expect(updateVoiceProfileOutboundAuthentication).toHaveBeenCalledTimes(1)
  })

  test.each([
    'VOICE_PROFILE_VERSION_CONFLICT',
    'VOICE_OUTBOUND_OPERATION_PENDING'
  ])('preserves the distinct %s edit recovery path', async (code) => {
    const updateVoiceProfileOutboundAuthentication = vi
      .fn<VoiceScope['updateVoiceProfileOutboundAuthentication']>()
      .mockRejectedValue(
        new ApiError('conflict', {
          body: { code },
          headers: new Headers(),
          operationId: 'updateVoiceProfileOutboundAuthentication',
          status: 409
        })
      )
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ updateVoiceProfileOutboundAuthentication })
    })

    await expect(
      service.updateProfileOutboundAuthentication(
        projectId,
        profileId,
        16,
        'md5'
      )
    ).rejects.toMatchObject({ code, httpStatus: 409, next: [] })
    expect(updateVoiceProfileOutboundAuthentication).toHaveBeenCalledTimes(1)
  })

  test('rejects an unsupported algorithm returned by an outbound edit', async () => {
    const scope = voiceScope({
      updateVoiceProfileOutboundAuthentication: vi.fn().mockResolvedValue({
        outbound: outbound({
          authentication: {
            ...outbound().authentication,
            algorithm: 'unspecified'
          }
        }),
        profileVersion: 17
      })
    })
    const service = new VoiceService({ request: createRequest(), scope })

    await expect(
      service.updateProfileOutboundAuthentication(
        projectId,
        profileId,
        16,
        'md5'
      )
    ).rejects.toMatchObject({ code: 'VOICE_PROTOCOL_ERROR' })
  })

  test('maps profile and assignment calls to the generated SDK wire shapes', async () => {
    const scope = voiceScope()
    const service = new VoiceService({ request: createRequest(), scope })
    const credentials = { password: 'exact password\n', username: 'alice' }

    const created = await service.createProfile(projectId, {
      name: 'Production agent',
      protocol: 'sip'
    })
    await service.createDefaultProfile(projectId, {
      protocol: 'sip'
    })
    await service.updateProfile(projectId, profileId, 1, {
      name: 'Renamed'
    })
    await service.replaceProfileInbound(projectId, profileId, 2, {
      credentials,
      destinationUri: 'sips:replacement@example.test:5061'
    })
    await service.updateProfileInbound(projectId, profileId, 3, {
      credentials: null
    })
    await service.clearProfileInbound(projectId, profileId, 4)
    const enabled = await service.enableProfileOutbound(
      projectId,
      profileId,
      5,
      'md5',
      'enable-key'
    )
    const rotated = await service.rotateProfileOutbound(
      projectId,
      profileId,
      6,
      'emergency',
      'rotate-key'
    )
    await service.revokeProfileOutbound(projectId, profileId, 7)
    await service.replaceProfileInbound(projectId, profileId, 9, {
      credentials: null,
      destinationUri: 'sips:id-route@example.test:5061'
    })
    await service.updateProfileInbound(projectId, profileId, 10, {
      destinationUri: 'sips:default-route@example.test:5061'
    })
    await service.clearProfileInbound(projectId, profileId, 11)
    await service.enableProfileOutbound(
      projectId,
      profileId,
      12,
      'sha-256',
      'id-enable'
    )
    await service.rotateProfileOutbound(
      projectId,
      profileId,
      13,
      'normal',
      'id-rotate'
    )
    await service.revokeProfileOutbound(projectId, profileId, 14)
    await service.deleteProfile(projectId, profileId, 2, true)
    await service.assignLineProfile(projectId, resourceId, profileId, 3)
    await service.unassignLineProfile(projectId, resourceId, 4)

    expect(created.configuration.inbound).toEqual({
      credentials: null,
      destinationUri: 'sips:agent@example.test:5061'
    })
    expect(enabled.password).toBe('outbound-password')
    expect(enabled.outbound).toEqual(outbound())
    expect(rotated.password).toBe('rotated-password')
    expect(scope.createVoiceProfile).toHaveBeenCalledWith(
      {
        body: {
          name: 'Production agent',
          protocol: 'sip'
        },
        path: { id: projectId }
      },
      undefined
    )
    expect(scope.createDefaultVoiceProfile).toHaveBeenCalledWith(
      {
        body: {
          protocol: 'sip'
        },
        path: { id: projectId }
      },
      undefined
    )
    expect(scope.updateVoiceProfile).toHaveBeenCalledWith(
      {
        body: {
          expectedVersion: 1,
          name: 'Renamed'
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.replaceVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          credentials,
          destinationUri: 'sips:replacement@example.test:5061',
          expectedVersion: 2
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.updateVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: { credentials: null, expectedVersion: 3 },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.deleteVoiceProfileInbound).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 4 }
      },
      undefined
    )
    expect(scope.configureVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        body: {
          authentication: { algorithm: 'md5' },
          expectedVersion: 5
        },
        headers: { idempotencyKey: 'enable-key' },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.rotateVoiceProfileOutboundCredential).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 6, mode: 'emergency' },
        headers: { idempotencyKey: 'rotate-key' },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.deleteVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 7 }
      },
      undefined
    )
    expect(scope.replaceVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          credentials: null,
          destinationUri: 'sips:id-route@example.test:5061',
          expectedVersion: 9
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.updateVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          destinationUri: 'sips:default-route@example.test:5061',
          expectedVersion: 10
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.deleteVoiceProfileInbound).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 11 }
      },
      undefined
    )
    expect(scope.configureVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        body: {
          authentication: { algorithm: 'sha-256' },
          expectedVersion: 12
        },
        headers: { idempotencyKey: 'id-enable' },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.rotateVoiceProfileOutboundCredential).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 13, mode: 'normal' },
        headers: { idempotencyKey: 'id-rotate' },
        path: { id: projectId, profileId }
      },
      undefined
    )
    expect(scope.deleteVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 14 }
      },
      undefined
    )
    expect(scope.deleteVoiceProfile).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 2, force: 'true' }
      },
      undefined
    )
    expect(scope.assignVoiceLineProfile).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 3, profileId },
        path: { id: projectId, resourceId }
      },
      undefined
    )
    expect(scope.unassignVoiceLineProfile).toHaveBeenCalledWith(
      {
        path: { id: projectId, resourceId },
        query: { expectedVersion: 4 }
      },
      undefined
    )
  })

  test('follows profile pagination while respecting the requested limit', async () => {
    const listVoiceProfiles = vi
      .fn<VoiceScope['listVoiceProfiles']>()
      .mockResolvedValueOnce({
        nextPageToken: 'page-2',
        profiles: [profile({ profileId: `${profileId.slice(0, -1)}r` })]
      })
      .mockResolvedValueOnce({ profiles: [profile()] })
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ listVoiceProfiles })
    })

    await expect(
      service.listProfiles(projectId, { limit: 2 }, false)
    ).resolves.toMatchObject({ profiles: [{}, {}] })
    expect(listVoiceProfiles).toHaveBeenNthCalledWith(
      1,
      {
        path: { id: projectId },
        query: { default: 'false', pageSize: 2 }
      },
      undefined
    )
    expect(listVoiceProfiles).toHaveBeenNthCalledWith(
      2,
      {
        path: { id: projectId },
        query: { default: 'false', pageSize: 1, pageToken: 'page-2' }
      },
      undefined
    )
  })

  test('reuses each outbound key and body for one transport retry', async () => {
    const configureVoiceProfileOutbound = vi
      .fn<VoiceScope['configureVoiceProfileOutbound']>()
      .mockRejectedValueOnce(new TransportError('response interrupted'))
      .mockResolvedValueOnce({
        outbound: outbound(),
        password: null,
        profileVersion: 2
      })
    const rotateVoiceProfileOutboundCredential = vi
      .fn<VoiceScope['rotateVoiceProfileOutboundCredential']>()
      .mockRejectedValueOnce(new TransportError('response interrupted'))
      .mockResolvedValueOnce({
        password: null,
        previousPasswordValidUntil: timestamp,
        profileVersion: 3
      })
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({
        configureVoiceProfileOutbound,
        rotateVoiceProfileOutboundCredential
      })
    })

    await expect(
      service.enableProfileOutbound(
        projectId,
        profileId,
        1,
        'sha-256',
        'stable-enable-key'
      )
    ).resolves.toMatchObject({ password: null, profileVersion: 2 })
    await expect(
      service.rotateProfileOutbound(
        projectId,
        profileId,
        2,
        'normal',
        'stable-rotate-key'
      )
    ).resolves.toMatchObject({ password: null, profileVersion: 3 })
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(2)
    expect(configureVoiceProfileOutbound.mock.calls[0]).toEqual(
      configureVoiceProfileOutbound.mock.calls[1]
    )
    expect(rotateVoiceProfileOutboundCredential).toHaveBeenCalledTimes(2)
    expect(rotateVoiceProfileOutboundCredential.mock.calls[0]).toEqual(
      rotateVoiceProfileOutboundCredential.mock.calls[1]
    )
  })

  test('rejects an unspecified outbound digest algorithm from the service', async () => {
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() =>
      Promise.resolve({
        outbound: outbound({
          authentication: {
            algorithm: 'unspecified',
            previousPasswordValidUntil: null,
            username: 'profile-outbound-user',
            validFrom: timestamp
          }
        }),
        password: 'outbound-password',
        profileVersion: 2
      })
    )
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ configureVoiceProfileOutbound })
    })

    await expect(
      service.enableProfileOutbound(
        projectId,
        profileId,
        1,
        'sha-256',
        'enable-key'
      )
    ).rejects.toMatchObject({
      code: 'VOICE_PROTOCOL_ERROR',
      detail: expect.stringContaining('"unspecified" is unsupported'),
      next: [{ description: expect.stringContaining('contact Photon support') }]
    })
  })

  test('normalizes optimistic concurrency conflicts with rerun guidance', async () => {
    const updateVoiceProfile = vi.fn<VoiceScope['updateVoiceProfile']>(() =>
      Promise.reject(
        new ApiError('conflict', {
          body: { code: 'VOICE_PROFILE_VERSION_CONFLICT' },
          headers: new Headers(),
          operationId: 'updateVoiceProfile',
          status: 409
        })
      )
    )
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ updateVoiceProfile })
    })

    await expect(
      service.updateProfile(projectId, profileId, 1, { name: 'Renamed' })
    ).rejects.toMatchObject({
      code: 'VOICE_PROFILE_VERSION_CONFLICT',
      httpStatus: 409,
      next: []
    })
  })

  test.each([
    ['VOICE_OUTBOUND_CONFIGURED', 'Outbound calling is already configured.'],
    ['VOICE_OUTBOUND_NOT_CONFIGURED', 'Outbound calling is not configured.']
  ])(
    'keeps the code of %s, adds no fix, and hides the credential request detail',
    async (code, detail) => {
      const configureVoiceProfileOutbound = vi.fn<
        VoiceScope['configureVoiceProfileOutbound']
      >(() =>
        Promise.reject(
          new ApiError('conflict', {
            body: { code, detail },
            headers: new Headers(),
            operationId: 'configureVoiceProfileOutbound',
            status: 409
          })
        )
      )
      const service = new VoiceService({
        request: createRequest(),
        scope: voiceScope({ configureVoiceProfileOutbound })
      })

      await expect(
        service.enableProfileOutbound(
          projectId,
          profileId,
          1,
          'sha-256',
          'enable-key'
        )
      ).rejects.toMatchObject({
        code,
        message: "Photon's API answered HTTP 409.",
        next: []
      })
    }
  )

  test('surfaces an existing-default conflict with its code and no fix of its own', async () => {
    const createDefaultVoiceProfile = vi.fn<
      VoiceScope['createDefaultVoiceProfile']
    >(() =>
      Promise.reject(
        new ApiError('default exists', {
          body: { code: 'VOICE_DEFAULT_PROFILE_EXISTS' },
          headers: new Headers(),
          operationId: 'createDefaultVoiceProfile',
          status: 409
        })
      )
    )
    const service = new VoiceService({
      request: createRequest(),
      scope: voiceScope({ createDefaultVoiceProfile })
    })

    await expect(
      service.createDefaultProfile(projectId, {
        protocol: 'sip'
      })
    ).rejects.toMatchObject({
      code: 'VOICE_DEFAULT_PROFILE_EXISTS',
      httpStatus: 409,
      next: []
    })
  })
})
