import { writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

interface CapturedRequest {
  authorization?: string
  body: unknown
  idempotencyKey?: string
  method?: string
  url?: string
}

const servers: ReturnType<typeof createServer>[] = []

const accountResponse = {
  accountId: 'account_123',
  createdAt: '2026-07-01T00:00:00.000Z',
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: '2026-07-03T00:00:00.000Z'
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const serialized = Buffer.concat(chunks).toString('utf8')
  return serialized.length === 0 ? undefined : JSON.parse(serialized)
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200
): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
    )
  )
})

describe('generated account SDK integration', () => {
  test('uses exact account profile, avatar, and organization payment wire shapes', async () => {
    const requests: CapturedRequest[] = []
    const server = createServer(async (request, response) => {
      try {
        const idempotencyKey = request.headers['idempotency-key']
        requests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body: await readJsonBody(request),
          ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url })
        })

        if (request.url === '/v1/account') {
          writeJson(response, accountResponse)
          return
        }
        if (request.url === '/v1/account/profile-picture/uploads') {
          writeJson(
            response,
            {
              expiresAt: '2026-08-01T19:00:00.000Z',
              formFields: {
                key: 'account/avatar.png',
                policy: 'private-policy'
              },
              uploadId: 'pho_upl_00000000000000000000000000',
              uploadUrl: 'https://uploads.example.test/account-avatar'
            },
            201
          )
          return
        }
        if (request.url === '/v1/account/profile-picture') {
          writeJson(response, accountResponse)
          return
        }
        if (
          request.url ===
            '/v1/organizations/pho_org_00000000000000000000000001/billing/payment-method' &&
          request.method === 'GET'
        ) {
          writeJson(response, {
            addedByNewerApi: 'from-a-newer-api',
            cardOnFile: true,
            paymentMethod: {
              addedByNewerApi: 'from-a-newer-api',
              brand: 'visa',
              expiresMonth: 12,
              expiresYear: 2028,
              last4: '4242'
            }
          })
          return
        }
        if (
          request.url ===
            '/v1/organizations/pho_org_00000000000000000000000001/billing/checkout' &&
          request.method === 'POST'
        ) {
          writeJson(response, {
            checkoutUrl: 'https://checkout.example.test/session_sdk'
          })
          return
        }
        writeJson(response, { error: 'not_found' })
      } catch {
        response.writeHead(400)
        response.end()
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )
    const avatarPath = join(configDirectory, 'sdk-avatar.png')
    await writeFile(
      avatarPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    const storageRequests: RequestInit[] = []
    const transportFetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://uploads.example.test/account-avatar') {
        storageRequests.push(init ?? {})
        return new Response(null, { status: 204 })
      }
      return await globalThis.fetch(input, init)
    }

    const invoke = async (args: string[]): Promise<unknown> => {
      const stderr = collector()
      const stdout = collector()
      await runCli([...args, '--json'], {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        fetch: transportFetch,
        now: () => TEST_NOW,
        platform: 'linux',
        stderr,
        stdout
      })
      expect(stderr.value()).toBe('')
      return JSON.parse(stdout.value()) as unknown
    }

    await invoke([
      'account',
      'edit',
      '--first-name',
      'Grace',
      '--idempotency-key',
      'account-sdk-edit'
    ])
    await invoke([
      'account',
      'avatar',
      'upload',
      avatarPath,
      '--idempotency-key',
      'account-sdk-avatar'
    ])
    await invoke([
      'account',
      'avatar',
      'reset',
      '--yes',
      '--idempotency-key',
      'account-sdk-reset'
    ])
    const paymentStatus = await invoke([
      'org',
      'billing',
      'payment-method',
      'status',
      '--org',
      'pho_org_00000000000000000000000001'
    ])
    await invoke([
      'org',
      'billing',
      'payment-method',
      'setup',
      '--org',
      'pho_org_00000000000000000000000001',
      '--no-browser'
    ])

    expect(paymentStatus).toEqual({
      addedByNewerApi: 'from-a-newer-api',
      cardOnFile: true,
      paymentMethod: {
        addedByNewerApi: 'from-a-newer-api',
        brand: 'visa',
        expiresMonth: 12,
        expiresYear: 2028,
        last4: '4242'
      }
    })

    expect(requests).toEqual([
      {
        authorization: 'Bearer project-access-token',
        body: { firstName: 'Grace' },
        idempotencyKey: 'account-sdk-edit',
        method: 'PATCH',
        url: '/v1/account'
      },
      {
        authorization: 'Bearer project-access-token',
        body: { contentType: 'image/png' },
        idempotencyKey: 'account-sdk-avatar:upload',
        method: 'POST',
        url: '/v1/account/profile-picture/uploads'
      },
      {
        authorization: 'Bearer project-access-token',
        body: { uploadId: 'pho_upl_00000000000000000000000000' },
        idempotencyKey: 'account-sdk-avatar',
        method: 'PUT',
        url: '/v1/account/profile-picture'
      },
      {
        authorization: 'Bearer project-access-token',
        body: undefined,
        idempotencyKey: 'account-sdk-reset',
        method: 'DELETE',
        url: '/v1/account/profile-picture'
      },
      {
        authorization: 'Bearer project-access-token',
        body: undefined,
        method: 'GET',
        url: '/v1/organizations/pho_org_00000000000000000000000001/billing/payment-method'
      },
      {
        authorization: 'Bearer project-access-token',
        body: undefined,
        method: 'POST',
        url: '/v1/organizations/pho_org_00000000000000000000000001/billing/checkout'
      }
    ])
    expect(storageRequests).toHaveLength(1)
    expect(storageRequests[0]?.body).toBeInstanceOf(FormData)
    expect(new Headers(storageRequests[0]?.headers).has('authorization')).toBe(
      false
    )
  })
})
