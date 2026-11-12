import { ApiError } from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import {
  type AccountScope,
  AccountService,
  isAccountServiceKeyCreation,
  validateAccountServiceKeyCreateInput,
  validateAccountServiceKeyId
} from '../src/account/service.ts'
import type { AuthRepository } from '../src/auth/storage/repository.ts'
import type { TokenManager } from '../src/auth/token-manager.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { photonKey } from './key-support.ts'

const now = Date.parse('2026-08-07T10:00:00.000Z')
const createdAt = '2026-08-07T09:00:00.000Z'
const expiresAt = '2027-08-07T10:00:00.000Z'
const accountId = 'pho_acc_01h455vb4pex5vsknk084sn02q'
const otherAccountId = 'pho_acc_01h455vb4pex5vsknk084sn02r'
const serviceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const otherServiceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02t')
const secret = `${serviceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`

type ServiceKeySdkCompatibility = Required<
  Pick<
    AccountScope,
    | 'createAccountServiceKey'
    | 'listAccountServiceKeys'
    | 'revokeAccountServiceKey'
  >
>

const serviceKey = (
  overrides: Partial<{
    accountId: string
    name: string
    revokedAt: null | string
    serviceKeyId: string
  }> = {}
) => ({
  accountId: overrides.accountId ?? accountId,
  addedByNewerApi: 'from-a-newer-api',
  createdAt,
  expiresAt,
  name: overrides.name ?? 'production automation',
  revokedAt: overrides.revokedAt ?? null,
  serviceKeyId: overrides.serviceKeyId ?? serviceKeyId
})

const createService = (
  serviceKeySdk: ServiceKeySdkCompatibility,
  requestAccountId?: string
): AccountService => {
  const account = { ...serviceKeySdk } as unknown as AccountScope
  const repository = {
    loadMetadata: () =>
      Promise.resolve(
        requestAccountId === undefined
          ? undefined
          : {
              accountId: requestAccountId,
              apiOrigin: BUILD_CONFIG.apiOrigin,
              backend: 'file',
              credentialKind: 'account_service_key',
              credentialLocator: 'test-service-key-entry',
              schemaVersion: 2,
              serviceKeyId
            }
      )
  } as unknown as AuthRepository
  const tokenManager = {
    getAccessToken: () => Promise.resolve('device-access-token'),
    refreshAfterUnauthorized: () => Promise.resolve()
  } as unknown as TokenManager
  return new AccountService({ account, repository, tokenManager })
}

describe('Account Service Key validation', () => {
  test('requires one expiry choice and normalizes a bounded future timestamp', () => {
    expect(
      validateAccountServiceKeyCreateInput(
        {
          expiresAt: '2027-08-07T03:00:00-07:00',
          name: ' production automation ',
          noExpiry: false
        },
        now
      )
    ).toEqual({ expiresAt, name: 'production automation' })
    expect(
      validateAccountServiceKeyCreateInput(
        { name: 'never expires', noExpiry: true },
        now
      )
    ).toEqual({ name: 'never expires' })

    for (const input of [
      { name: 'missing', noExpiry: false },
      { expiresAt, name: 'conflicting', noExpiry: true },
      {
        expiresAt: '2026-08-07T09:59:59.999Z',
        name: 'past',
        noExpiry: false
      },
      {
        expiresAt: '2036-08-08T10:00:00.001Z',
        name: 'too long',
        noExpiry: false
      }
    ]) {
      expect(() =>
        validateAccountServiceKeyCreateInput(input, now)
      ).toThrowError(expect.objectContaining({ code: 'ARGUMENT_VALIDATION' }))
    }
  })

  test('accepts only a canonical public ID, never a complete credential', () => {
    expect(validateAccountServiceKeyId(serviceKeyId)).toBe(serviceKeyId)
    expect(() => validateAccountServiceKeyId(secret)).toThrowError(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
    expect(() =>
      validateAccountServiceKeyId(photonKey('sk', '01h455vb4pex5vsknk084sn02s'))
    ).toThrowError(expect.objectContaining({ code: 'ARGUMENT_VALIDATION' }))
  })
})

describe('Account Service Key account adapter', () => {
  test('uses the generated SDK surface and returns the responses Photon sent', async () => {
    const create = vi.fn<ServiceKeySdkCompatibility['createAccountServiceKey']>(
      () =>
        Promise.resolve({
          secret,
          serviceKey: serviceKey()
        })
    )
    const list = vi.fn<ServiceKeySdkCompatibility['listAccountServiceKeys']>(
      () =>
        Promise.resolve({
          serviceKeys: [serviceKey()]
        })
    )
    const revoke = vi.fn<ServiceKeySdkCompatibility['revokeAccountServiceKey']>(
      () =>
        Promise.resolve({
          serviceKey: serviceKey({
            revokedAt: createdAt,
            serviceKeyId: otherServiceKeyId
          })
        })
    )
    const service = createService({
      createAccountServiceKey: create,
      listAccountServiceKeys: list,
      revokeAccountServiceKey: revoke
    })

    await expect(
      service.createServiceKey(
        { expiresAt, name: 'production automation' },
        'create-idempotency'
      )
    ).resolves.toEqual({ secret, serviceKey: serviceKey() })
    await expect(service.listServiceKeys()).resolves.toEqual({
      serviceKeys: [serviceKey()]
    })
    await expect(
      service.revokeServiceKey(otherServiceKeyId, 'revoke-idempotency')
    ).resolves.toEqual({
      serviceKey: serviceKey({
        revokedAt: createdAt,
        serviceKeyId: otherServiceKeyId
      })
    })

    expect(create).toHaveBeenCalledWith(
      {
        body: { expiresAt, name: 'production automation' },
        headers: { idempotencyKey: 'create-idempotency' }
      },
      undefined
    )
    expect(list).toHaveBeenCalledWith({}, undefined)
    expect(revoke).toHaveBeenCalledWith(
      {
        headers: { idempotencyKey: 'revoke-idempotency' },
        path: { serviceKeyId: otherServiceKeyId }
      },
      undefined
    )
  })

  test('fails closed when create returns a credential for another public ID', async () => {
    const mismatchedSecret = `${otherServiceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`
    const service = createService({
      createAccountServiceKey: () =>
        Promise.resolve({
          secret: mismatchedSecret,
          serviceKey: serviceKey()
        }),
      listAccountServiceKeys: () => Promise.resolve({ serviceKeys: [] }),
      revokeAccountServiceKey: () => Promise.reject(new Error('not used'))
    })

    const failure = await service
      .createServiceKey({ name: 'mismatched' }, 'mismatch-idempotency')
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'ACCOUNT_PROTOCOL_ERROR',
      debugSafe: false,
      retryable: true
    })
    expect(JSON.stringify(failure)).not.toContain(mismatchedSecret)
    expect(
      isAccountServiceKeyCreation({
        secret: mismatchedSecret,
        serviceKey: serviceKey()
      })
    ).toBe(false)
  })

  test('keeps control characters in a name as the API sent it', async () => {
    const name = 'ok\u001b[31m-forged-terminal-output'
    const service = createService({
      createAccountServiceKey: () => Promise.reject(new Error('not used')),
      listAccountServiceKeys: () =>
        Promise.resolve({
          serviceKeys: [serviceKey({ name })]
        }),
      revokeAccountServiceKey: () => Promise.reject(new Error('not used'))
    })

    await expect(service.listServiceKeys()).resolves.toMatchObject({
      serviceKeys: [{ name }]
    })
  })

  test('fails closed when a Service Key response belongs to another account', async () => {
    const service = createService(
      {
        createAccountServiceKey: () => Promise.reject(new Error('not used')),
        listAccountServiceKeys: () =>
          Promise.resolve({
            serviceKeys: [serviceKey({ accountId: otherAccountId })]
          }),
        revokeAccountServiceKey: () => Promise.reject(new Error('not used'))
      },
      accountId
    )

    await expect(service.listServiceKeys()).rejects.toMatchObject({
      code: 'ACCOUNT_PROTOCOL_ERROR',
      debugSafe: false
    })
  })

  test.each([
    {
      response: serviceKey({
        revokedAt: createdAt,
        serviceKeyId: otherServiceKeyId
      }),
      scenario: 'another key ID'
    },
    {
      response: serviceKey({ revokedAt: null }),
      scenario: 'a non-revoked key'
    }
  ])('fails closed when revoke returns $scenario', async ({ response }) => {
    const service = createService({
      createAccountServiceKey: () => Promise.reject(new Error('not used')),
      listAccountServiceKeys: () => Promise.resolve({ serviceKeys: [] }),
      revokeAccountServiceKey: () => Promise.resolve({ serviceKey: response })
    })

    await expect(
      service.revokeServiceKey(serviceKeyId, 'revoke-contract')
    ).rejects.toMatchObject({
      code: 'ACCOUNT_PROTOCOL_ERROR',
      debugSafe: false
    })
  })

  test('redacts a secret echoed by an API failure', async () => {
    const create = vi.fn<ServiceKeySdkCompatibility['createAccountServiceKey']>(
      () =>
        Promise.reject(
          new ApiError(`request failed with ${secret}`, {
            body: { code: 'UPSTREAM_FAILURE', detail: `echoed ${secret}` },
            headers: new Headers(),
            operationId: 'createAccountServiceKey',
            requestId: secret,
            status: 503
          })
        )
    )
    const service = createService({
      createAccountServiceKey: create,
      listAccountServiceKeys: () => Promise.resolve({ serviceKeys: [] }),
      revokeAccountServiceKey: () => Promise.reject(new Error('not used'))
    })

    const failure = await service
      .createServiceKey({ name: 'redaction' }, 'redaction-idempotency')
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      debugSafe: false,
      retryable: true
    })
    expect(failure).toHaveProperty('requestId', undefined)
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  test.each([
    { code: 'ACCOUNT_SERVICE_KEY_NOT_FOUND', status: 404 },
    { code: 'ACCOUNT_SERVICE_KEY_LIMIT_REACHED', status: 409 },
    { code: 'VALIDATION_FAILED', status: 422 },
    { code: 'IDEMPOTENCY_KEY_REUSED', status: 422 }
  ])(
    'maps $code without forwarding an arbitrary remote detail',
    async ({ code, status }) => {
      const create = vi.fn<
        ServiceKeySdkCompatibility['createAccountServiceKey']
      >(() =>
        Promise.reject(
          new ApiError(`request failed with ${secret}`, {
            body: { code, detail: `echoed ${secret}` },
            headers: new Headers(),
            operationId: 'createAccountServiceKey',
            requestId: 'request_known_service_key_problem',
            status
          })
        )
      )
      const service = createService({
        createAccountServiceKey: create,
        listAccountServiceKeys: () => Promise.resolve({ serviceKeys: [] }),
        revokeAccountServiceKey: () => Promise.reject(new Error('not used'))
      })

      const failure = await service
        .createServiceKey({ name: 'known problem' }, 'problem-idempotency')
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code,
        debugSafe: false,
        detail: undefined,
        httpStatus: status,
        message: `Photon's API answered HTTP ${status.toString()}.`,
        requestId: 'request_known_service_key_problem'
      })
      expect(JSON.stringify(failure)).not.toContain(secret)
    }
  )
})
