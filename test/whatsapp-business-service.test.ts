import { ApiError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import { AuthenticatedRequest } from '../src/auth/authenticated-request.ts'
import { ProjectService } from '../src/project/service.ts'
import {
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  instantPollClock
} from './project-test-support.ts'

const timestamp = '2026-08-19T21:04:31.000Z'

const whatsappNumber = (
  overrides: Record<string, unknown> = {}
): {
  abilities: string[]
  createdAt: string
  detail: Record<string, unknown>
  projectId: string
  resourceId: string
  retiredAt?: string
  state: string
  type: string
  updatedAt: string
} => ({
  abilities: ['whatsapp_business'],
  createdAt: timestamp,
  detail: {
    account: { wabaId: '112233445566778' },
    displayName: 'Acme Support',
    displayNameStatus: 'APPROVED',
    phoneNumber: '+14155550199',
    phoneNumberId: '123456789012345',
    qualityRating: 'GREEN',
    qualityRatingObservedAt: '2026-08-19T21:04:58.000Z',
    voipResourceId: 'pho_res_00000000000000000000000123'
  },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  state: 'active',
  type: 'whatsapp_sender',
  updatedAt: timestamp,
  ...overrides
})

const voipNumber = (
  resourceId = 'pho_res_00000000000000000000000123',
  phoneNumber = '+14155550199',
  overrides: Record<string, unknown> = {}
) => ({
  abilities: ['sms'],
  createdAt: timestamp,
  detail: { phoneNumber },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId,
  state: 'active',
  type: 'voip_line',
  updatedAt: timestamp,
  ...overrides
})

const resourceOperation = (
  state: string,
  operationId = 'remote_whatsapp_release'
) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  resourceType: 'whatsapp_sender',
  state,
  type: 'resource.release',
  updatedAt: timestamp
})

const provisionOperation = (state: string) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId: 'remote_whatsapp_provision',
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  resourceType: 'whatsapp_sender',
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const rawResponse = <Result>(
  data: Result,
  status: number,
  retryAfter = '5'
) => ({
  data,
  headers: new Headers({ 'retry-after': retryAfter }),
  status
})

const createRequest = (): AuthenticatedRequest =>
  new AuthenticatedRequest({
    tokenManager: {
      getAccessToken: () => Promise.resolve('access-token'),
      refreshAfterUnauthorized: () => Promise.resolve('rotated-token')
    }
  })

describe('WhatsApp Business project service', () => {
  test('reads the single account and preserves capacity and review metadata', async () => {
    const account = {
      accountName: 'Support',
      alerts: [],
      businessId: 'business_1',
      businessName: 'Example',
      connectedAt: timestamp,
      outboundCapacity: 'UNKNOWN' as const,
      restriction: null,
      reviewStatus: 'UNKNOWN' as const,
      senderCount: 1,
      wabaId: 'waba_1'
    }
    const getWhatsappBusinessAccount = vi.fn(() => Promise.resolve(account))
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({ platforms: { getWhatsappBusinessAccount } })
    })
    await expect(
      service.listWhatsappBusinessAccounts(
        'pho_prj_00000000000000000000000001',
        { limit: 2 }
      )
    ).resolves.toEqual({ accounts: [account] })
    expect(getWhatsappBusinessAccount).toHaveBeenCalledWith(
      { path: { id: 'pho_prj_00000000000000000000000001' } },
      undefined
    )
  })

  test('rejects obsolete account pagination before making a request', async () => {
    const getWhatsappBusinessAccount = vi.fn()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({ platforms: { getWhatsappBusinessAccount } })
    })
    await expect(
      service.listWhatsappBusinessAccounts(
        'pho_prj_00000000000000000000000001',
        {
          limit: 3,
          pageToken: 'old-token'
        }
      )
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(getWhatsappBusinessAccount).not.toHaveBeenCalled()
  })

  test('lists active numbers through the generic ability filter only', async () => {
    const listResources = vi.fn(() =>
      Promise.resolve({ resources: [whatsappNumber()] })
    )
    const listOperations = vi.fn()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({
        platforms: { listOperations, listResources }
      })
    })

    await expect(
      service.listWhatsappBusinessNumbers(
        'pho_prj_00000000000000000000000001',
        { limit: 30 }
      )
    ).resolves.toMatchObject({
      response: { resources: [whatsappNumber()] },
      senders: [
        {
          resource: whatsappNumber(),
          sender: {
            detail: {
              account: { wabaId: '112233445566778' },
              displayName: 'Acme Support',
              displayNameStatus: 'APPROVED',
              phoneNumber: '+14155550199',
              phoneNumberId: '123456789012345',
              qualityRating: 'GREEN',
              voipResourceId: 'pho_res_00000000000000000000000123'
            },
            resourceId: 'pho_res_00000000000000000000000001',
            type: 'whatsapp_sender'
          }
        }
      ]
    })
    expect(listResources).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'whatsapp_business', pageSize: 30, state: 'active' }
      },
      undefined
    )
    expect(listOperations).not.toHaveBeenCalled()
  })

  test('rejects an inactive row in an active-only page without weakening active validation', async () => {
    const retired = whatsappNumber({
      retiredAt: timestamp,
      state: 'retired'
    })
    const active = whatsappNumber({
      resourceId: 'pho_res_00000000000000000000000002'
    })
    const malformedActive = whatsappNumber({
      detail: { phoneNumber: '4155550199' },
      resourceId: 'pho_res_00000000000000000000000003'
    })
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({ resources: [retired, active] })
      .mockResolvedValueOnce({ resources: [malformedActive] })
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({ platforms: { listResources } })
    })

    await expect(
      service.listWhatsappBusinessNumbers(
        'pho_prj_00000000000000000000000001',
        { limit: 30 }
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
    await expect(
      service.listWhatsappBusinessNumbers(
        'pho_prj_00000000000000000000000001',
        { limit: 30 }
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
  })

  test('views retired senders and rejects wrong types or malformed detail', async () => {
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(
        whatsappNumber({
          abilities: [],
          retiredAt: timestamp,
          state: 'retired'
        })
      )
      .mockResolvedValueOnce(whatsappNumber({ type: 'voip_line' }))
      .mockResolvedValueOnce(
        whatsappNumber({ detail: { phoneNumber: '4155550199' } })
      )
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({ platforms: { getResource } })
    })

    await expect(
      service.getWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).resolves.toMatchObject({
      resource: whatsappNumber({
        abilities: [],
        retiredAt: timestamp,
        state: 'retired'
      }),
      sender: { state: 'retired' }
    })
    await expect(
      service.getWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).rejects.toMatchObject({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
    await expect(
      service.getWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).rejects.toMatchObject({ code: 'PROJECT_PROTOCOL_ERROR' })
  })

  test.each([
    [
      { projectId: 'pho_prj_00000000000000000000000002' },
      'PROJECT_PROTOCOL_ERROR'
    ],
    [
      { abilities: [], retiredAt: timestamp, state: 'retired' },
      'ARGUMENT_VALIDATION'
    ],
    [{ abilities: ['sms'] }, 'ARGUMENT_VALIDATION'],
    [
      {
        detail: {
          account: { wabaId: '112233445566778' },
          phoneNumber: '4155550199',
          phoneNumberId: '123456789012345',
          qualityRating: 'GREEN',
          qualityRatingObservedAt: '2026-08-19T21:04:58.000Z'
        }
      },
      'PROJECT_PROTOCOL_ERROR'
    ]
  ])('rejects an invalid delete preflight with %s', async (overrides, code) => {
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          getResource: () => Promise.resolve(whatsappNumber(overrides))
        }
      })
    })

    await expect(
      service.getActiveWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).rejects.toMatchObject({ code })
  })

  test('filters Photon SMS numbers already linked by resource ID or legacy E.164 fallback', async () => {
    const linkedById = whatsappNumber({
      detail: {
        ...whatsappNumber().detail,
        phoneNumber: '+14155550999',
        voipResourceId: 'pho_res_00000000000000000000000101'
      },
      resourceId: 'sender_1'
    })
    const linkedByPhone = whatsappNumber({
      detail: {
        ...whatsappNumber().detail,
        phoneNumber: '+1 (415) 555-0102',
        voipResourceId: undefined
      },
      resourceId: 'sender_2'
    })
    const listResources = vi.fn(
      (input: { query?: { ability?: string | undefined } | undefined }) =>
        Promise.resolve({
          resources:
            input.query?.ability === 'sms'
              ? [
                  voipNumber(
                    'pho_res_00000000000000000000000101',
                    '+14155550101'
                  ),
                  voipNumber(
                    'pho_res_00000000000000000000000102',
                    '+14155550102'
                  ),
                  voipNumber(
                    'pho_res_00000000000000000000000202',
                    'not-a-phone-number'
                  ),
                  voipNumber(
                    'pho_res_00000000000000000000000103',
                    '+14155550103'
                  ),
                  voipNumber(
                    'pho_res_00000000000000000000000201',
                    '+14155550104',
                    {
                      retiredAt: timestamp,
                      state: 'retired'
                    }
                  )
                ]
              : [linkedById, linkedByPhone]
        })
    )
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          listOperations: () => Promise.resolve({ operations: [] }),
          listResources
        }
      })
    })

    await expect(
      service.listEligibleWhatsappVoipNumbers(
        'pho_prj_00000000000000000000000001'
      )
    ).resolves.toMatchObject([
      {
        displayPhoneNumber: '+14155550103',
        resource: { resourceId: 'pho_res_00000000000000000000000103' }
      }
    ])
  })

  test('provisions a Photon sender and returns the strict public WhatsApp resource', async () => {
    const { qualityRatingObservedAt: _observedAt, ...checkedDetail } =
      whatsappNumber().detail
    const clock = instantPollClock()
    const accepted = vi.fn(() => Promise.resolve())
    const createWhatsappVoipSender = vi.fn(() =>
      Promise.resolve(rawResponse(provisionOperation('pending'), 202, '6'))
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: provisionOperation('succeeded'),
        resource: whatsappNumber()
      })
    )
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({
        platforms: { createWhatsappVoipSender }
      }),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          getOperation,
          getWhatsappBusinessAccount: () =>
            Promise.resolve({
              accountName: null,
              alerts: [],
              businessId: 'business_1',
              businessName: null,
              connectedAt: timestamp,
              outboundCapacity: 'UNKNOWN',
              restriction: null,
              reviewStatus: 'UNKNOWN',
              senderCount: 0,
              wabaId: '112233445566778'
            })
        }
      })
    })

    await expect(
      service.createWhatsappVoipSender(
        'pho_prj_00000000000000000000000001',
        '112233445566778',
        {
          displayName: 'Acme Support',
          voipResourceId: 'pho_res_00000000000000000000000123'
        },
        'stable-key',
        accepted
      )
    ).resolves.toEqual({
      response: {
        operation: provisionOperation('succeeded'),
        resource: whatsappNumber()
      },
      sender: whatsappNumber({ detail: checkedDetail })
    })
    expect(accepted).toHaveBeenCalledWith('remote_whatsapp_provision')
    expect(clock.sleeps).toEqual([6000])
    expect(createWhatsappVoipSender).toHaveBeenCalledWith(
      {
        body: {
          displayName: 'Acme Support',
          voipResourceId: 'pho_res_00000000000000000000000123'
        },
        headers: { idempotencyKey: 'stable-key' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('polls OTP with jittered backoff and respects a longer Retry-After', async () => {
    const clock = instantPollClock()
    const getWhatsappBusinessVerificationCode = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError('not found', {
          body: { code: 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND' },
          headers: new Headers({ 'retry-after': '5' }),
          operationId: 'getWhatsappBusinessVerificationCode',
          status: 404
        })
      )
      .mockResolvedValueOnce({
        code: '864209',
        receivedAt: '2026-08-19T21:04:35.000Z'
      })
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      random: () => 0.5,
      request: createRequest(),
      scope: asProjectScope({
        platforms: { getWhatsappBusinessVerificationCode }
      })
    })

    await expect(
      service.waitForWhatsappBusinessVerificationCode(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000123',
        timestamp
      )
    ).resolves.toEqual({
      code: '864209',
      receivedAt: '2026-08-19T21:04:35.000Z'
    })
    expect(clock.sleeps).toEqual([2000, 5000])
    expect(getWhatsappBusinessVerificationCode).toHaveBeenNthCalledWith(
      1,
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000123'
        },
        query: { receivedAfter: timestamp }
      },
      undefined
    )
  })

  test('retries OTP rate limits within the same readiness window', async () => {
    const clock = instantPollClock()
    const getWhatsappBusinessVerificationCode = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError('rate limited', {
          body: { code: 'RATE_LIMITED' },
          headers: new Headers({ 'retry-after': '7' }),
          operationId: 'getWhatsappBusinessVerificationCode',
          status: 429
        })
      )
      .mockResolvedValueOnce({
        code: '864209',
        receivedAt: '2026-08-19T21:04:35.000Z'
      })
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      random: () => 0.5,
      request: createRequest(),
      scope: asProjectScope({
        platforms: { getWhatsappBusinessVerificationCode }
      })
    })

    await expect(
      service.waitForWhatsappBusinessVerificationCode(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000123',
        timestamp
      )
    ).resolves.toMatchObject({ code: '864209' })
    expect(clock.sleeps).toEqual([2000, 7000])
  })

  test.each([
    [422, 'WHATSAPP_VERIFICATION_WINDOW_EXPIRED'],
    [404, 'RESOURCE_NOT_FOUND'],
    [422, 'VALIDATION_FAILED']
  ])(
    'keeps the code of OTP terminal error %s/%s and adds no fix of its own',
    async (status, code) => {
      const getWhatsappBusinessVerificationCode = vi.fn(() =>
        Promise.reject(
          new ApiError('verification failed', {
            body: { code },
            headers: new Headers(),
            operationId: 'getWhatsappBusinessVerificationCode',
            status
          })
        )
      )
      const service = new ProjectService({
        organizationScope: asOrganizationScope(),
        request: createRequest(),
        scope: asProjectScope({
          platforms: { getWhatsappBusinessVerificationCode }
        })
      })

      await expect(
        service.getWhatsappBusinessVerificationCode(
          'pho_prj_00000000000000000000000001',
          'pho_res_00000000000000000000000123',
          timestamp
        )
      ).rejects.toMatchObject({
        code,
        httpStatus: status,
        next: [],
        retryable: false
      })
    }
  )

  test('returns the documented remediation when a WABA is not connected', async () => {
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          getWhatsappBusinessAccount: () =>
            Promise.reject(
              new ApiError('No account', {
                body: { code: 'WHATSAPP_WABA_NOT_CONNECTED' },
                headers: new Headers(),
                status: 404
              })
            )
        }
      })
    })

    await expect(
      service.assertWhatsappBusinessAccountConnected(
        'pho_prj_00000000000000000000000001',
        '112233445566778'
      )
    ).rejects.toMatchObject({
      code: 'WHATSAPP_WABA_NOT_CONNECTED',
      next: [
        {
          description:
            'Use --new-waba to continue through the Photon dashboard.'
        },
        {
          description:
            'Or run number add interactively and choose Connect another WABA.'
        }
      ],
      retryable: false
    })
  })

  test('validates a terminal 200 release without polling', async () => {
    const clock = instantPollClock()
    const getOperation = vi.fn()
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('succeeded'), 200))
    )
    const accepted = vi.fn(() => Promise.resolve())
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { releaseResource } }),
      request: createRequest(),
      scope: asProjectScope({ platforms: { getOperation, getResource } })
    })

    await expect(
      service.releaseWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001',
        accepted,
        undefined
      )
    ).resolves.toEqual({ operation: resourceOperation('succeeded') })
    expect(accepted).toHaveBeenCalledWith('remote_whatsapp_release')
    expect(getOperation).not.toHaveBeenCalled()
    expect(clock.sleeps).toEqual([])
  })

  test('respects Retry-After while polling an accepted 202 release', async () => {
    const clock = instantPollClock()
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('pending'), 202, '7'))
    )
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: resourceOperation('succeeded') })
    )
    const service = new ProjectService({
      clock,
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { releaseResource } }),
      request: createRequest(),
      scope: asProjectScope({ platforms: { getOperation, getResource } })
    })

    await expect(
      service.releaseWhatsappBusinessNumber(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).resolves.toEqual({ operation: resourceOperation('succeeded') })
    expect(clock.sleeps).toEqual([7000])
    expect(getOperation).toHaveBeenCalledOnce()
  })

  test.each([
    ['failed', 'PROJECT_OPERATION_FAILED'],
    ['cancelled', 'PROJECT_OPERATION_CANCELLED']
  ])('maps a %s remote release to %s', async (state, code) => {
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          getOperation: () =>
            Promise.resolve({ operation: resourceOperation(state) })
        }
      })
    })

    await expect(
      service.resumeWhatsappBusinessNumberRelease(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001',
        'remote_whatsapp_release'
      )
    ).rejects.toMatchObject({ code })
  })

  test('converges a replay when the sender is already retired', async () => {
    const releaseResource = vi.fn()
    const service = new ProjectService({
      organizationScope: asOrganizationScope(),
      rawScope: asProjectRawScope({ platforms: { releaseResource } }),
      request: createRequest(),
      scope: asProjectScope({
        platforms: {
          getResource: () =>
            Promise.resolve(
              whatsappNumber({
                abilities: [],
                retiredAt: timestamp,
                state: 'retired'
              })
            )
        }
      })
    })

    await expect(
      service.replayWhatsappBusinessNumberRelease(
        'pho_prj_00000000000000000000000001',
        'pho_res_00000000000000000000000001'
      )
    ).resolves.toEqual({
      resource: whatsappNumber({
        abilities: [],
        retiredAt: timestamp,
        state: 'retired'
      })
    })
    expect(releaseResource).not.toHaveBeenCalled()
  })
})
