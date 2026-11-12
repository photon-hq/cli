import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const servers: ReturnType<typeof createServer>[] = []
const AUTHORIZATION_PATTERN = /authorization/iu
const SET_COOKIE_PATTERN = /set-cookie/iu

const base64url = (text: string): string =>
  Buffer.from(text).toString('base64url')

const pemBlock = (label: string, body: string): string =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`

const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port.toString()}`
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers
  })
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

describe('CLI HTTP debug integration', () => {
  test('does not emit an empty trace for commands without HTTP', async () => {
    const stderr = collector()
    const stdout = collector()

    await runCli(['--debug', '--json'], {
      stderr,
      stdout
    })

    expect(JSON.parse(stdout.value())).toMatchObject({ name: CLI_NAME })
    expect(stderr.value()).toBe('')
  })

  test('adds a sanitized payment failure exchange to the single JSON error', async () => {
    let receivedAuthorization: string | undefined
    const baseUrl = await listen((request, response) => {
      receivedAuthorization = request.headers.authorization
      writeJson(
        response,
        {
          accessToken: 'private-response-token',
          checkoutUrl: 'https://checkout.example.test/private-session',
          code: 'UPSTREAM_UNAVAILABLE',
          detail: 'The account dependency is unavailable.',
          email: 'ada@example.test'
        },
        502,
        {
          'content-type': 'application/problem+json',
          'retry-after': '60',
          'set-cookie': 'session=private-cookie',
          'x-request-id': 'request_payment_debug'
        }
      )
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'org',
        'billing',
        'payment-method',
        'setup',
        '--org',
        'pho_org_00000000000000000000000001',
        '--no-browser',
        '--debug',
        '--json'
      ],
      {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      }
    )

    expect(receivedAuthorization).toBe('Bearer project-access-token')
    expect(stderr.value()).toBe('')
    expect(exitCodes).toEqual([1])
    const payload: unknown = JSON.parse(stdout.value())
    expect(payload).toMatchObject({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        debug: {
          http: {
            droppedExchangeCount: 0,
            exchanges: [
              {
                request: {
                  body: { kind: 'empty' },
                  headers: {},
                  method: 'POST',
                  url: `${baseUrl}/v1/organizations/pho_org_00000000000000000000000001/billing/checkout`
                },
                response: {
                  body: {
                    kind: 'json',
                    value: {
                      accessToken: '[REDACTED]',
                      checkoutUrl: '[REDACTED]',
                      code: 'UPSTREAM_UNAVAILABLE',
                      detail: 'The account dependency is unavailable.',
                      email: '[REDACTED]'
                    }
                  },
                  headers: {
                    'content-type': 'application/problem+json',
                    'retry-after': '60',
                    'x-request-id': 'request_payment_debug'
                  },
                  requestId: 'request_payment_debug',
                  status: 502
                },
                sequence: 1,
                startedAt: '2026-07-31T18:00:00.000Z'
              }
            ]
          }
        },
        problem: expect.objectContaining({ status: 502 }),
        requestId: 'request_payment_debug',
        retryAfterSeconds: 60
      }
    })
    const diagnostics = stderr.value()
    expect(diagnostics.trim().split('\n')).toHaveLength(1)
    expect(diagnostics).not.toMatch(AUTHORIZATION_PATTERN)
    expect(diagnostics).not.toMatch(SET_COOKIE_PATTERN)
    expect(diagnostics).not.toContain('project-access-token')
    expect(diagnostics).not.toContain('private-response-token')
    expect(diagnostics).not.toContain('private-session')
    expect(diagnostics).not.toContain('private-cookie')
  })

  test('emits buffered diagnostics after successful JSON and human commands', async () => {
    const checkoutUrl = 'https://checkout.example.test/private-success-session'
    const baseUrl = await listen((_request, response) => {
      writeJson(response, { checkoutUrl }, 200, {
        'x-request-id': 'request_payment_success'
      })
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )

    const jsonStderr = collector()
    const jsonStdout = collector()
    await runCli(
      [
        'org',
        'billing',
        'payment-method',
        'setup',
        '--org',
        'pho_org_00000000000000000000000001',
        '--no-browser',
        '--debug',
        '--json'
      ],
      {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        stderr: jsonStderr,
        stdout: jsonStdout
      }
    )

    expect(JSON.parse(jsonStdout.value())).toEqual({
      checkout: { checkoutUrl },
      opened: false
    })
    expect(JSON.parse(jsonStderr.value())).toMatchObject({
      debug: {
        http: {
          exchanges: [
            {
              request: {
                method: 'POST',
                url: `${baseUrl}/v1/organizations/pho_org_00000000000000000000000001/billing/checkout`
              },
              response: {
                body: {
                  kind: 'json',
                  value: { checkoutUrl: '[REDACTED]' }
                },
                status: 200
              }
            }
          ]
        }
      }
    })
    expect(jsonStderr.value()).not.toContain('private-success-session')

    const humanStderr = collector()
    const humanStdout = collector()
    await runCli(
      [
        'org',
        'billing',
        'payment-method',
        'setup',
        '--org',
        'pho_org_00000000000000000000000001',
        '--no-browser',
        '--debug'
      ],
      {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        stderr: humanStderr,
        stdout: humanStdout
      }
    )

    expect(humanStdout.value()).toContain(`Checkout URL: ${checkoutUrl}`)
    expect(humanStderr.value()).toContain('Debug:')
    expect(humanStderr.value()).toContain('HTTP exchanges:')
    expect(humanStderr.value()).toContain(
      `POST ${baseUrl}/v1/organizations/pho_org_00000000000000000000000001/billing/checkout`
    )
    expect(humanStderr.value()).toContain('Response: 200 OK')
    expect(humanStderr.value()).toContain(
      'Response body: {"checkoutUrl":"[REDACTED]"}'
    )
    expect(humanStderr.value()).not.toMatch(AUTHORIZATION_PATTERN)
    expect(humanStderr.value()).not.toContain('private-success-session')
  })

  test('records every physical SDK retry attempt', async () => {
    let attempt = 0
    const baseUrl = await listen((_request, response) => {
      attempt += 1
      if (attempt < 3) {
        writeJson(
          response,
          {
            code: 'UPSTREAM_UNAVAILABLE',
            detail: `Attempt ${attempt.toString()} failed.`
          },
          502,
          { 'retry-after': '0', 'x-request-id': `request_retry_${attempt}` }
        )
        return
      }
      writeJson(response, { cardOnFile: false, paymentMethod: null }, 200, {
        'x-request-id': 'request_retry_3'
      })
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )
    const stderr = collector()
    const stdout = collector()

    await runCli(
      [
        'org',
        'billing',
        'payment-method',
        'status',
        '--org',
        'pho_org_00000000000000000000000001',
        '--debug',
        '--json'
      ],
      {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        stderr,
        stdout
      }
    )

    expect(JSON.parse(stdout.value())).toEqual({
      cardOnFile: false,
      paymentMethod: null
    })
    const debug = JSON.parse(stderr.value()) as {
      debug: {
        http: {
          exchanges: Array<{
            request: { method: string }
            response: { status: number }
            sequence: number
          }>
        }
      }
    }
    expect(debug.debug.http.exchanges).toHaveLength(3)
    expect(debug.debug.http.exchanges.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3
    ])
    expect(
      debug.debug.http.exchanges.map(({ response }) => response.status)
    ).toEqual([502, 502, 200])
    expect(
      debug.debug.http.exchanges.map(({ request }) => request.method)
    ).toEqual(['GET', 'GET', 'GET'])
    expect(stderr.value()).not.toContain('project-access-token')
    expect(stderr.value()).not.toMatch(AUTHORIZATION_PATTERN)
  })

  test('redacts refresh credentials before tracing the authenticated retry', async () => {
    const refreshedAccessToken = 'private-rotated-access-token'
    const refreshedRefreshToken = 'private-rotated-refresh-token'
    const baseUrl = await listen((request, response) => {
      if (request.url === '/v1/auth/device/token') {
        writeJson(response, {
          access_token: refreshedAccessToken,
          expires_in: 3600,
          refresh_token: refreshedRefreshToken,
          user: {
            email: 'ada@example.test',
            first_name: 'Ada',
            id: 'user_ada',
            last_name: 'Lovelace'
          }
        })
        return
      }
      expect(request.headers.authorization).toBe(
        `Bearer ${refreshedAccessToken}`
      )
      writeJson(response, {
        accountId: 'account_123',
        createdAt: null,
        deletedAt: null,
        email: 'ada@example.test',
        firstName: 'Ada',
        lastName: 'Lovelace',
        onboarded: true,
        phoneNumber: null,
        phoneVerifiedAt: null,
        pictureUrl: 'https://images.example.test/ada.png',
        updatedAt: null
      })
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )
    const stderr = collector()
    const stdout = collector()

    await runCli(['whoami', '--debug', '--json'], {
      baseUrl,
      configDirectory,
      now: () => TEST_NOW + 7_200_000,
      platform: 'linux',
      stderr,
      stdout
    })

    expect(stdout.value(), stderr.value()).not.toBe('')
    expect(JSON.parse(stdout.value())).toMatchObject({
      accountId: 'account_123',
      email: 'ada@example.test'
    })
    const diagnostics = JSON.parse(stderr.value()) as {
      debug: {
        http: {
          exchanges: Array<{
            request: { body: unknown; url: string }
            response: { body: unknown }
          }>
        }
      }
    }
    expect(diagnostics.debug.http.exchanges).toHaveLength(2)
    expect(diagnostics.debug.http.exchanges[0]).toMatchObject({
      request: {
        body: {
          kind: 'json',
          value: {
            grant_type: 'refresh_token',
            refresh_token: '[REDACTED]'
          }
        },
        url: `${baseUrl}/v1/auth/device/token`
      },
      response: {
        body: {
          kind: 'json',
          value: {
            access_token: '[REDACTED]',
            refresh_token: '[REDACTED]',
            user: {
              email: '[REDACTED]',
              first_name: '[REDACTED]',
              id: 'user_ada',
              last_name: '[REDACTED]'
            }
          }
        }
      }
    })
    expect(diagnostics.debug.http.exchanges.at(1)?.request.url).toBe(
      `${baseUrl}/v1/account`
    )
    expect(stderr.value()).not.toMatch(AUTHORIZATION_PATTERN)
    expect(stderr.value()).not.toContain('project-access-token')
    expect(stderr.value()).not.toContain('project-refresh-token')
    expect(stderr.value()).not.toContain(refreshedAccessToken)
    expect(stderr.value()).not.toContain(refreshedRefreshToken)
  })

  test.each([
    ['OAuth Secret Already Configured', 'create', 'OAUTH_SECRET_CONFIGURED'],
    ['OAuth Secret Not Configured', 'rotate', 'OAUTH_SECRET_NOT_CONFIGURED']
  ] as const)(
    'prints the API problem title "%s" in full in the debug response body and cause chain',
    async (title, command, code) => {
      const problem = {
        code,
        requestId: 'request_oauth_secret',
        status: 409,
        title,
        type: 'https://photon.codes/docs/problems/oauth-secret'
      }
      const baseUrl = await listen((_request, response) => {
        writeJson(response, problem, 409, {
          'content-type': 'application/problem+json',
          'x-request-id': 'request_oauth_secret'
        })
      })
      const { configDirectory } = await createAuthenticatedConfig(
        'user_ada',
        baseUrl
      )
      const args = [
        'org',
        'oauth-client',
        'secret',
        command,
        'client_123',
        '--org',
        'pho_org_00000000000000000000000001',
        ...(command === 'rotate' ? ['--yes'] : []),
        '--debug'
      ]
      const run = async (asJson: boolean): Promise<string> => {
        const stderr = collector()
        const stdout = collector()
        await runCli(asJson ? [...args, '--json'] : args, {
          baseUrl,
          configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          setExitCode: () => undefined,
          stderr,
          stdout
        })
        return (asJson ? stdout : stderr).value()
      }

      const lines = (await run(false)).split('\n')
      expect(lines).toContain(`      Response body: ${JSON.stringify(problem)}`)
      expect(lines).toContain(`    CliError: ${title}`)
      expect(lines).toContain(
        'Check the docs page for this error and correct the request before retrying.'
      )
      const causeChain = lines.slice(lines.indexOf('  Cause chain:'))
      expect(causeChain.join('\n')).not.toContain('[REDACTED]')

      const payload: unknown = JSON.parse(await run(true))
      expect(payload).toMatchObject({
        error: {
          debug: {
            causes: expect.arrayContaining([
              expect.objectContaining({ message: title, name: 'CliError' })
            ]),
            http: {
              exchanges: [
                { response: { body: { kind: 'json', value: problem } } }
              ]
            }
          },
          message: title
        }
      })
    }
  )

  test('redacts every form of a secret in the debug response body and cause chain', async () => {
    const secrets = {
      bearer: 'opaque-bearer-credential',
      colon: 'Colonword',
      equals: 'Equalsword',
      field: 'field-client-secret',
      jwt: [
        base64url('{"alg":"HS256"}'),
        base64url('{"sub":"user_ada"}'),
        base64url('signature-sentinel')
      ].join('.'),
      privateKey: base64url('private-key-sentinel'),
      quoted: 'Quotedword',
      serviceKey: base64url('AccountServiceKey'),
      single: 'Singleword',
      spaced: 'pho_cs_live_9f8e7d6c5b4a3f2e'
    }
    const detail = [
      `secret=${secrets.equals}`,
      `secret: ${secrets.colon}`,
      `"secret":"${secrets.quoted}"`,
      `'client_secret': '${secrets.single}'`,
      `client secret ${secrets.spaced}`,
      `Bearer ${secrets.bearer}`,
      secrets.jwt,
      `${photonKey('ask', '01h455vb4pex5vsknk084sn02s')}_${secrets.serviceKey}`,
      pemBlock('PRIVATE KEY', secrets.privateKey)
    ].join(' ')
    const redactedDetail = [
      'secret=[REDACTED]',
      'secret: [REDACTED]',
      '"secret":"[REDACTED]"',
      "'client_secret': '[REDACTED]'",
      'client secret [REDACTED]',
      'Bearer [REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]'
    ].join(' ')
    const problem = {
      client_secret: secrets.field,
      code: 'OAUTH_SECRET_CONFIGURED',
      detail,
      status: 409,
      title: 'OAuth Secret Already Configured'
    }
    const baseUrl = await listen((_request, response) => {
      writeJson(response, problem, 409, {
        'content-type': 'application/problem+json'
      })
    })
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      baseUrl
    )
    const args = [
      'org',
      'oauth-client',
      'secret',
      'create',
      'client_123',
      '--org',
      'pho_org_00000000000000000000000001',
      '--debug'
    ]
    const run = async (asJson: boolean): Promise<string> => {
      const stderr = collector()
      const stdout = collector()
      await runCli(asJson ? [...args, '--json'] : args, {
        baseUrl,
        configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: () => undefined,
        stderr,
        stdout
      })
      return (asJson ? stdout : stderr).value()
    }

    const text = await run(false)
    const lines = text.split('\n')
    expect(lines).toContain(
      `      Response body: ${JSON.stringify({ ...problem, client_secret: '[REDACTED]', detail: redactedDetail })}`
    )
    expect(lines).toContain(`    CliError: ${redactedDetail}`)
    expect(lines).toContain(
      'Review the error detail and correct the request before retrying.'
    )
    const json = await run(true)
    expect(JSON.parse(json)).toMatchObject({
      error: {
        debug: {
          causes: expect.arrayContaining([
            expect.objectContaining({
              message: redactedDetail,
              name: 'CliError'
            })
          ])
        },
        message: redactedDetail
      }
    })
    for (const secret of Object.values(secrets)) {
      expect(text).not.toContain(secret)
      expect(json).not.toContain(secret)
    }
  })
})
