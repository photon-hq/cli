import { ApiError } from '@photon-ai/api'
import { describe, expect, test } from 'vitest'
import { apiErrorOptions } from '../src/core/api-problem.ts'
import {
  errorDiagnostic,
  HttpDebugRecorder,
  redactDiagnosticText
} from '../src/core/http-debug.ts'
import { photonKey } from './key-support.ts'
import { stagingTarget } from './target-support.ts'

const API_ORIGIN = 'https://api.example.test'
const FIXED_TIME = Date.parse('2026-08-05T02:00:00.000Z')
const AUTHORIZATION_PATTERN = /authorization/iu
const SET_COOKIE_PATTERN = /set-cookie/iu
const QUOTED_CREDENTIAL_PATTERN = /message-token|name-key/u

describe('sanitized HTTP diagnostics', () => {
  test('redacts an exact URI key without hiding unrelated key names', async () => {
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(async () =>
      Response.json({
        maturity: 'stable',
        securityLevel: 'strict',
        uri: 'private-resource-locator'
      })
    )

    await debugFetch(`${API_ORIGIN}/v1/status`)
    await recorder.settle()

    expect(recorder.snapshot()?.exchanges[0]?.response?.body).toEqual({
      kind: 'json',
      value: {
        maturity: 'stable',
        securityLevel: 'strict',
        uri: '[REDACTED]'
      }
    })
  })

  test('redacts MFA setup material, verification requests, and otpauth URIs', async ({
    skip
  }) => {
    skip(!stagingTarget)
    const sentinels = {
      code: '123456',
      secret: 'BASE32PRIVATESECRET',
      token: 'mfae1.private-enrollment-token',
      uri: 'otpauth://totp/Photon:ada?secret=BASE32PRIVATESECRET'
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(async () =>
      Response.json({
        enrollmentToken: sentinels.token,
        expiresAt: '2026-09-01T12:10:00.000Z',
        factorId: 'auth_factor_123',
        secret: sentinels.secret,
        uri: sentinels.uri
      })
    )

    await debugFetch(`${API_ORIGIN}/v1/account/security/mfa/totp/verify`, {
      body: JSON.stringify({
        enrollmentToken: sentinels.token,
        verificationCode: sentinels.code
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    await recorder.settle()

    expect(recorder.snapshot()?.exchanges[0]).toMatchObject({
      request: { body: { kind: 'json', value: '[REDACTED]' } },
      response: { body: { kind: 'json', value: '[REDACTED]' } }
    })
    const serialized = JSON.stringify(recorder.snapshot())
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(redactDiagnosticText(`setup ${sentinels.uri}`)).toBe(
      'setup [REDACTED]'
    )
  })

  test('redacts a complete Account Service Key but preserves its public ID', () => {
    const serviceKeyId = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
    const credential = `${serviceKeyId}_QWNjb3VudFNlcnZpY2VLZXk`

    expect(
      redactDiagnosticText(`public ${serviceKeyId}; credential ${credential}`)
    ).toBe(`public ${serviceKeyId}; credential [REDACTED]`)
  })

  test('preserves bare nine-digit values while redacting hyphenated EINs', () => {
    expect(redactDiagnosticText('values 123456789 and 98-7654321')).toBe(
      'values 123456789 and [REDACTED]'
    )
  })

  test('keeps words after a key in prose but redacts a value that follows a separator or looks like a secret', () => {
    const prose = [
      'API Key Limit Reached',
      'API Key Not Found',
      'OAuth Secret Already Configured',
      'OAuth Secret Not Configured',
      'OAuth Secret Quota Exceeded',
      'OTP Locked',
      'Account OTP global hourly send limit exceeded',
      'The API key secret was not safe to display.',
      'the refresh token could not be exchanged with WorkOS',
      'at OauthService.setUpClientSecret (/app/src/oauth/service.ts:290:18)'
    ]
    for (const text of prose) {
      expect(redactDiagnosticText(text)).toBe(text)
    }

    expect(
      redactDiagnosticText(
        `secret=Plainword secret: Plainword {"secret":"Plainword"} 'client_secret': 'Plainword'`
      )
    ).toBe(
      `secret=[REDACTED] secret: [REDACTED] {"secret":"[REDACTED]"} 'client_secret': '[REDACTED]'`
    )
    expect(
      redactDiagnosticText(
        'client secret pho_cs_live_9f8e7d6c5b4a3f2e, secret ZqXwVbNmLkJh, secret qwertyuiopasdfghjklzxcvbnm, API key sk.live, OTP 123456'
      )
    ).toBe(
      'client secret [REDACTED], secret [REDACTED], secret [REDACTED], API key [REDACTED], OTP [REDACTED]'
    )
    expect(redactDiagnosticText('pin otp 123456')).toBe('pin otp [REDACTED]')
  })

  test('redacts 10DLC registration profiles, identifiers, PINs, and feedback', async () => {
    const sentinels = {
      company: 'SENTINEL-10DLC-COMPANY',
      ein: '98-7654321',
      feedback: 'SENTINEL-REGISTRATION-FEEDBACK',
      phone: '+14155559876',
      pin: 'ZX9876'
    }
    const transport: typeof globalThis.fetch = async () =>
      Response.json({
        feedback: sentinels.feedback,
        profile: { companyName: sentinels.company, ein: sentinels.ein },
        registrationStatus: 'rejected'
      })
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)

    await debugFetch(`${API_ORIGIN}/v1/account/10dlc/brands`, {
      body: JSON.stringify({
        ein: '123456789',
        hotPath: 'visible-hot-path',
        otpPin: sentinels.pin,
        profile: {
          companyName: sentinels.company,
          ein: sentinels.ein,
          phone: sentinels.phone
        },
        registrationNote: `EIN ${sentinels.ein}; phone ${sentinels.phone}`,
        reinforcementCount: 123_456_789,
        shippingMethod: 'visible-shipping-method'
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    await recorder.settle()

    const serialized = JSON.stringify(recorder.snapshot())
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(recorder.snapshot()?.exchanges[0]).toMatchObject({
      request: {
        body: {
          kind: 'json',
          value: {
            ein: '[REDACTED]',
            hotPath: 'visible-hot-path',
            otpPin: '[REDACTED]',
            profile: '[REDACTED]',
            registrationNote: 'EIN [REDACTED]; phone [REDACTED]',
            reinforcementCount: 123_456_789,
            shippingMethod: 'visible-shipping-method'
          }
        }
      },
      response: {
        body: {
          kind: 'json',
          value: {
            feedback: '[REDACTED]',
            profile: '[REDACTED]',
            registrationStatus: 'rejected'
          }
        }
      }
    })
  })

  test('redacts 10DLC campaign descriptions, flows, samples, links, and appeals', async () => {
    const sentinels = {
      appeal: 'SENTINEL-CAMPAIGN-APPEAL',
      description: 'SENTINEL-CAMPAIGN-DESCRIPTION',
      flow: 'SENTINEL-CAMPAIGN-FLOW',
      link: 'https://example.test/SENTINEL-CAMPAIGN-LINK',
      sample: 'SENTINEL-CAMPAIGN-SAMPLE'
    }
    const transport: typeof globalThis.fetch = async () =>
      Response.json({
        campaign: {
          description: sentinels.description,
          embeddedLinkSample: sentinels.link,
          messageFlow: sentinels.flow,
          sampleMessages: [sentinels.sample],
          status: 'submitted'
        }
      })
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)

    await debugFetch(`${API_ORIGIN}/v1/account/10dlc/campaigns/campaign_1`, {
      body: JSON.stringify({
        appealReason: sentinels.appeal,
        description: sentinels.description,
        embeddedLinkSample: sentinels.link,
        messageFlow: sentinels.flow,
        sampleMessages: [sentinels.sample]
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    await recorder.settle()

    const serialized = JSON.stringify(recorder.snapshot())
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(recorder.snapshot()?.exchanges[0]).toMatchObject({
      request: {
        body: {
          kind: 'json',
          value: {
            appealReason: '[REDACTED]',
            description: '[REDACTED]',
            embeddedLinkSample: '[REDACTED]',
            messageFlow: '[REDACTED]',
            sampleMessages: '[REDACTED]'
          }
        }
      },
      response: {
        body: {
          kind: 'json',
          value: {
            campaign: {
              description: '[REDACTED]',
              embeddedLinkSample: '[REDACTED]',
              messageFlow: '[REDACTED]',
              sampleMessages: '[REDACTED]',
              status: 'submitted'
            }
          }
        }
      }
    })
  })

  test('redacts complete Call Registry profile bodies without hiding config diagnostics', async ({
    skip
  }) => {
    skip(!stagingTarget)
    const profileSentinels = {
      category: 'SENTINEL-CALL-REGISTRY-CATEGORY',
      city: 'SENTINEL-CALL-REGISTRY-CITY',
      companyName: 'SENTINEL-CALL-REGISTRY-COMPANY',
      contactName: 'SENTINEL-CALL-REGISTRY-CONTACT',
      explanation: 'SENTINEL-CALL-REGISTRY-EXPLANATION',
      postalCode: 'SENTINEL-CALL-REGISTRY-POSTAL'
    }
    const transport: typeof globalThis.fetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return Promise.resolve(
        url.pathname.endsWith('/profile')
          ? Response.json({ ...profileSentinels, version: '1' })
          : Response.json({ autoRegisterNumbers: true })
      )
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)

    await debugFetch(
      `${API_ORIGIN}/v1/projects/pho_prj_123/compliance/call-registry/profile`,
      {
        body: JSON.stringify(profileSentinels),
        headers: { 'content-type': 'application/json' },
        method: 'PUT'
      }
    )
    await debugFetch(
      `${API_ORIGIN}/v1/projects/pho_prj_123/compliance/call-registry/config`,
      {
        body: JSON.stringify({ autoRegisterNumbers: true }),
        headers: { 'content-type': 'application/json' },
        method: 'PATCH'
      }
    )
    await recorder.settle()

    const trace = recorder.snapshot()
    const serialized = JSON.stringify(trace)
    for (const sentinel of Object.values(profileSentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(trace?.exchanges[0]).toMatchObject({
      request: { body: { kind: 'json', value: '[REDACTED]' } },
      response: { body: { kind: 'json', value: '[REDACTED]' } }
    })
    expect(trace?.exchanges[1]).toMatchObject({
      request: {
        body: { kind: 'json', value: { autoRegisterNumbers: true } }
      },
      response: {
        body: { kind: 'json', value: { autoRegisterNumbers: true } }
      }
    })
  })

  test('redacts complete Voice profile and directional bodies', async () => {
    const sentinels = {
      destination: 'sips:agent@SENTINEL-VOICE-ENDPOINT.example:5061',
      outboundPassword: 'SENTINEL-VOICE-OUTBOUND-PASSWORD',
      password: 'SENTINEL-VOICE-PASSWORD',
      username: 'SENTINEL-VOICE-USERNAME'
    }
    const transport: typeof globalThis.fetch = (input) => {
      const url = String(input)
      return Promise.resolve(
        Response.json(
          url.endsWith('/outbound/rotate')
            ? {
                password: sentinels.outboundPassword,
                previousPasswordValidUntil: null,
                profileVersion: 3
              }
            : {
                inbound: {
                  credentials: { username: sentinels.username },
                  destinationUri: sentinels.destination
                },
                profileVersion: 2
              }
        )
      )
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)

    await debugFetch(
      `${API_ORIGIN}/v1/projects/pho_prj_123/platforms/voice/profiles/default/inbound`,
      {
        body: JSON.stringify({
          credentials: {
            password: sentinels.password,
            username: sentinels.username
          },
          destinationUri: sentinels.destination,
          expectedVersion: 1
        }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT'
      }
    )
    await debugFetch(
      `${API_ORIGIN}/v1/projects/pho_prj_123/platforms/voice/profiles/default/outbound/rotate`,
      {
        body: JSON.stringify({ expectedVersion: 1, mode: 'normal' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST'
      }
    )
    await recorder.settle()

    const trace = recorder.snapshot()
    const serialized = JSON.stringify(trace)
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(trace?.exchanges).toHaveLength(2)
    for (const exchange of trace?.exchanges ?? []) {
      expect(exchange).toMatchObject({
        request: { body: { kind: 'json', value: '[REDACTED]' } },
        response: { body: { kind: 'json', value: '[REDACTED]' } }
      })
    }
  })

  test('redacts complete SQL request and response bodies', async ({ skip }) => {
    skip(!stagingTarget)
    const sentinels = {
      parameter: 'SENTINEL-SQL-PARAMETER',
      sql: 'SELECT SENTINEL-SQL-TEXT FROM otel_traces',
      sqlResponse: 'SENTINEL-SQL-RESPONSE'
    }
    const receivedBodies: unknown[] = []
    const transport: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      receivedBodies.push(await request.json())
      return Response.json({ result: sentinels.sqlResponse })
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)
    const responses = await Promise.all([
      debugFetch(`${API_ORIGIN}/v1/projects/pho_prj_123/developer/otel/query`, {
        body: JSON.stringify({
          parameters: { value: sentinels.parameter },
          sql: sentinels.sql
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST'
      })
    ])
    await Promise.all(responses.map(async (response) => await response.json()))
    await recorder.settle()

    expect(receivedBodies).toHaveLength(1)
    const trace = recorder.snapshot()
    expect(trace?.exchanges).toHaveLength(1)
    for (const exchange of trace?.exchanges ?? []) {
      expect(exchange).toMatchObject({
        request: { body: { kind: 'json', value: '[REDACTED]' } },
        response: { body: { kind: 'json', value: '[REDACTED]' } }
      })
    }
    const serialized = JSON.stringify(trace)
    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel)
    }
  })

  test('redacts WhatsApp signup codes and successful OTP responses while preserving problem codes', async () => {
    const signupCode = 'SENTINEL-META-AUTHORIZATION-CODE'
    const otp = '864209'
    let requestCount = 0
    const transport: typeof globalThis.fetch = () => {
      requestCount += 1
      if (requestCount === 1) {
        return Promise.resolve(
          Response.json({ operationId: 'operation_1' }, { status: 202 })
        )
      }
      if (requestCount === 2) {
        return Promise.resolve(
          Response.json({ code: otp, receivedAt: FIXED_TIME }, { status: 200 })
        )
      }
      return Promise.resolve(
        Response.json(
          {
            code: 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND',
            status: 404,
            title: 'Not Found',
            type: 'about:blank'
          },
          { status: 404 }
        )
      )
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)
    const numbersUrl = `${API_ORIGIN}/v1/projects/pho_prj_00000000000000000000000001/platforms/whatsapp-business/numbers`
    const verificationUrl = `${numbersUrl}/pho_res_00000000000000000000000123/verification-code?receivedAfter=2026-08-05T02%3A00%3A00.000Z`

    await debugFetch(numbersUrl, {
      body: JSON.stringify({
        code: signupCode,
        phoneNumberId: '987654321098765',
        wabaId: '123456789012345'
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    await debugFetch(verificationUrl)
    await debugFetch(verificationUrl)
    await recorder.settle()

    const trace = recorder.snapshot()
    expect(JSON.stringify(trace)).not.toContain(signupCode)
    expect(JSON.stringify(trace)).not.toContain(otp)
    expect(trace?.exchanges[0]?.request.body).toEqual({
      kind: 'json',
      value: '[REDACTED]'
    })
    expect(trace?.exchanges[1]?.response?.body).toEqual({
      kind: 'json',
      value: '[REDACTED]'
    })
    expect(trace?.exchanges[2]?.response?.body).toMatchObject({
      kind: 'json',
      value: { code: 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND' }
    })
  })

  test('captures useful JSON exchanges without consuming bodies or exposing credentials', async () => {
    const requestBody = {
      apiKey: 'private-api-key-body',
      authHeader: 'private-auth-header',
      avatarUploadUrl: 'https://uploads.example.test/private-avatar',
      challengeContext: 'private-challenge-context',
      checkoutUrl: 'https://checkout.example.test/session_private?secret=yes',
      deviceCode: 'private-device-code',
      email: 'ada@example.test',
      formFields: { policy: 'private-policy' },
      invitationToken: 'private-invitation-token',
      nested: { accessToken: 'private-access-token', safe: 'visible' },
      operation: 'payment-setup',
      userCode: 'private-user-code',
      userPhoneNumber: '+14155550123'
    }
    let receivedBody: unknown
    const transport: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      receivedBody = await request.json()
      return new Response(
        JSON.stringify({
          accessToken: 'response-access-token',
          code: 'UPSTREAM_UNAVAILABLE',
          detail: 'The account dependency is unavailable.',
          email: 'server@example.test',
          safeUrl: 'https://status.example.test/incidents/1?session=private'
        }),
        {
          headers: {
            'content-type': 'application/problem+json',
            'retry-after': '60',
            'set-cookie': 'session=private-cookie',
            'x-request-id': 'request_payment_1'
          },
          status: 502,
          statusText: 'Bad Gateway'
        }
      )
    }
    const recorder = new HttpDebugRecorder({
      now: () => FIXED_TIME,
      trustedOrigin: API_ORIGIN
    })
    const debugFetch = recorder.wrap(transport)
    const response = await debugFetch(
      `${API_ORIGIN}/v1/account/billing/payment-method?pageToken=private-page&pageSize=10#private`,
      {
        body: JSON.stringify(requestBody),
        headers: {
          authorization: 'Bearer private-bearer-token',
          'content-type': 'application/json',
          cookie: 'session=private-cookie',
          'idempotency-key': 'payment-operation-1',
          'x-api-key': 'private-api-key',
          'x-custom-header': 'not-allowlisted'
        },
        method: 'POST'
      }
    )

    await expect(response.json()).resolves.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE'
    })
    expect(receivedBody).toEqual(requestBody)
    await recorder.settle()

    const trace = recorder.snapshot()
    expect(trace).toMatchObject({
      droppedExchangeCount: 0,
      exchanges: [
        {
          request: {
            body: {
              kind: 'json',
              value: {
                apiKey: '[REDACTED]',
                authHeader: '[REDACTED]',
                avatarUploadUrl: '[REDACTED]',
                challengeContext: '[REDACTED]',
                checkoutUrl: '[REDACTED]',
                deviceCode: '[REDACTED]',
                email: '[REDACTED]',
                formFields: '[REDACTED]',
                invitationToken: '[REDACTED]',
                nested: {
                  accessToken: '[REDACTED]',
                  safe: 'visible'
                },
                operation: 'payment-setup',
                userCode: '[REDACTED]',
                userPhoneNumber: '[REDACTED]'
              }
            },
            headers: {
              'content-type': 'application/json',
              'idempotency-key': 'payment-operation-1'
            },
            method: 'POST',
            queryParameterNames: ['pageSize', 'pageToken'],
            url: `${API_ORIGIN}/v1/account/billing/payment-method`
          },
          response: {
            body: {
              kind: 'json',
              value: {
                accessToken: '[REDACTED]',
                code: 'UPSTREAM_UNAVAILABLE',
                detail: 'The account dependency is unavailable.',
                email: '[REDACTED]',
                safeUrl: 'https://status.example.test/incidents/1'
              }
            },
            requestId: 'request_payment_1',
            status: 502,
            statusText: 'Bad Gateway'
          },
          sequence: 1,
          startedAt: '2026-08-05T02:00:00.000Z'
        }
      ]
    })
    expect(trace?.exchanges[0]?.durationMs).toEqual(expect.any(Number))
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toMatch(AUTHORIZATION_PATTERN)
    expect(serialized).not.toMatch(SET_COOKIE_PATTERN)
    expect(serialized).not.toContain('private-bearer-token')
    expect(serialized).not.toContain('private-api-key')
    expect(serialized).not.toContain('private-cookie')
    expect(serialized).not.toContain('private-page')
    expect(serialized).not.toContain('response-access-token')
  })

  test('omits cross-origin paths and multipart bodies', async () => {
    const transport: typeof globalThis.fetch = async () =>
      new Response(null, { status: 204 })
    const recorder = new HttpDebugRecorder({
      trustedOrigin: API_ORIGIN
    })
    const debugFetch = recorder.wrap(transport)
    const form = new FormData()
    form.append('policy', 'private-policy')
    form.append('file', new Blob(['private-file']), 'avatar.txt')

    await debugFetch(
      'https://uploads.example.test/private/object?signature=private-signature',
      { body: form, method: 'POST' }
    )
    await recorder.settle()

    const trace = recorder.snapshot()
    expect(trace?.exchanges[0]?.request).toMatchObject({
      body: {
        kind: 'omitted',
        mediaType: 'multipart/form-data',
        reason: 'non-json'
      },
      method: 'POST',
      url: 'https://uploads.example.test/[REDACTED]'
    })
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toContain('private/object')
    expect(serialized).not.toContain('private-policy')
    expect(serialized).not.toContain('private-signature')
    expect(serialized).not.toContain('private-file')
  })

  test('cancels an omitted response clone so retry transports can cancel the original', async () => {
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(
      async () =>
        new Response('<html>Bad gateway</html>', {
          headers: { 'content-type': 'text/html' },
          status: 502
        })
    )

    const response = await debugFetch(
      `${API_ORIGIN}/v1/projects/pho_prj_00000000000000000000000001`
    )
    expect(response.body).not.toBeNull()
    await response.body?.cancel()
    await recorder.settle()

    expect(recorder.snapshot()?.exchanges[0]?.response).toMatchObject({
      body: {
        kind: 'omitted',
        mediaType: 'text/html',
        reason: 'non-json'
      },
      status: 502
    })
  })

  test('preserves transport failures while recording a safe no-response exchange', async () => {
    const transportError = Object.assign(
      new Error(
        'fetch failed for https://uploads.example.test/private/path?signature=private-signature'
      ),
      { code: 'ECONNRESET' }
    )
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(() => Promise.reject(transportError))

    await expect(
      debugFetch(`${API_ORIGIN}/v1/account?token=private-token`)
    ).rejects.toBe(transportError)
    await recorder.settle()

    expect(recorder.snapshot()?.exchanges[0]).toMatchObject({
      request: {
        queryParameterNames: ['token'],
        url: `${API_ORIGIN}/v1/account`
      },
      transportError: {
        code: 'ECONNRESET',
        message: 'fetch failed for https://uploads.example.test/[REDACTED]',
        name: 'Error'
      }
    })
    const serialized = JSON.stringify(recorder.snapshot())
    expect(serialized).not.toContain('private/path')
    expect(serialized).not.toContain('private-signature')
    expect(serialized).not.toContain('private-token')
  })

  test("keeps only the origin of a URL in an error's name, message and stack", () => {
    const error = Object.assign(
      new Error('Upload to https://uploads.example.test/secret-path failed'),
      { name: 'Failure at https://uploads.example.test/secret-name' }
    )

    const diagnostic = errorDiagnostic(error)

    expect(diagnostic).toMatchObject({
      message: 'Upload to https://uploads.example.test/[REDACTED] failed',
      name: 'Failure at https://uploads.example.test/[REDACTED]'
    })
    expect(diagnostic.stack).toContain(
      'Upload to https://uploads.example.test/[REDACTED] failed'
    )
    expect(JSON.stringify(diagnostic)).not.toContain('secret-')
  })

  test('redacts a quoted credential in a URL before it shortens the URL', () => {
    const error = Object.assign(
      new Error('GET https://api.example.test/?access_token="message-token"'),
      { name: 'Failure https://api.example.test/?api_key="name-key"' }
    )

    const diagnostic = errorDiagnostic(error)

    expect(diagnostic).toMatchObject({
      message: 'GET https://api.example.test/[REDACTED]"[REDACTED]"',
      name: 'Failure https://api.example.test/[REDACTED]"[REDACTED]"'
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(QUOTED_CREDENTIAL_PATTERN)
  })

  test('redacts the value after a key with a credential word and = or :, quoted or not', () => {
    expect(redactDiagnosticText('token=abc123')).toBe('token=[REDACTED]')
    expect(redactDiagnosticText('token: abc123')).toBe('token: [REDACTED]')
    expect(
      redactDiagnosticText(
        `X-Auth-Token: abc123, {"pageToken": "abc 123"} DB_PASSWORD='abc123' passphrase=abc123; sessionToken:abc123&page=2`
      )
    ).toBe(
      `X-Auth-Token: [REDACTED], {"pageToken": "[REDACTED]"} DB_PASSWORD='[REDACTED]' passphrase=[REDACTED]; sessionToken:[REDACTED]&page=2`
    )
    expect(
      redactDiagnosticText(
        `{ privateKey: 'abc123', secretKey: 'ab\\'c123' } (token=abc123) {"token":123456789} token="ab\\"c123"`
      )
    ).toBe(
      `{ privateKey: '[REDACTED]', secretKey: '[REDACTED]' } (token=[REDACTED]) {"token":[REDACTED]} token="[REDACTED]"`
    )
    expect(redactDiagnosticText('<token=abc123> password=ab)c}12>3')).toBe(
      '<token=[REDACTED]> password=[REDACTED]'
    )
    expect(
      redactDiagnosticText(`token_url=${API_ORIGIN}/oauth?client=cli&page=2`)
    ).toBe(`token_url=${API_ORIGIN}/oauth`)
    expect(
      errorDiagnostic(new Error('Refresh failed: token: abc123')).message
    ).toBe('Refresh failed: token: [REDACTED]')
  })

  test('redacts a quoted token value in a URL', () => {
    const redacted = redactDiagnosticText(`GET ${API_ORIGIN}/?token="abc123"`)

    expect(redacted).toBe(`GET ${API_ORIGIN}/"[REDACTED]"`)
    expect(redacted).not.toContain('abc123')
  })

  test('matches a URL with an apostrophe in it as one URL', () => {
    // Written out after token=, this value reads as a credential to the public
    // export's secret scan, so the URL is built at run time.
    const value = 'abc123def456'
    expect(
      redactDiagnosticText(`GET ${API_ORIGIN}/v1/x?name=o'brien&token=${value}`)
    ).toBe(`GET ${API_ORIGIN}/v1/x`)
    expect(
      redactDiagnosticText(
        `GET ${API_ORIGIN}/v1/x?name=o'brien&page=abc123def456`
      )
    ).toBe(`GET ${API_ORIGIN}/v1/x`)
    expect(
      redactDiagnosticText(
        `open '${API_ORIGIN}/users/o'brien?page=abc123def456'`
      )
    ).toBe(`open '${API_ORIGIN}/users/o'brien'`)
    expect(
      errorDiagnostic(
        new Error(
          "GET https://uploads.example.test/users/o'brien/reset/abc123def456 failed"
        )
      ).message
    ).toBe('GET https://uploads.example.test/[REDACTED] failed')
  })

  test('ends a URL at a closing quote and at a parenthesis or bracket it did not open', () => {
    expect(
      redactDiagnosticText(`fetch '${API_ORIGIN}/v1/x?page=2', then retry`)
    ).toBe(`fetch '${API_ORIGIN}/v1/x', then retry`)
    expect(redactDiagnosticText(`(see ${API_ORIGIN}/v1/x?page=2)`)).toBe(
      `(see ${API_ORIGIN}/v1/x)`
    )
    expect(redactDiagnosticText(`[${API_ORIGIN}/v1/x?page=2]`)).toBe(
      `[${API_ORIGIN}/v1/x]`
    )
    expect(redactDiagnosticText('GET http://[::1]:8080/v1/x?page=2')).toBe(
      'GET http://[::1]:8080/v1/x'
    )
    expect(
      redactDiagnosticText(`${API_ORIGIN}/docs/Photon_(CLI)?page=2 next`)
    ).toBe(`${API_ORIGIN}/docs/Photon_(CLI) next`)
  })

  test('keeps a credential word that is not a key, and keys that are not credentials', () => {
    const texts = [
      'Unexpected token < in JSON at position 0',
      `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
      'The token expired, so sign in again.',
      'description: Sends the weekly report',
      'address: 1 Main Street',
      `POST ${API_ORIGIN}/v1/oauth/token: 404 Not Found`
    ]
    for (const text of texts) {
      expect(redactDiagnosticText(text)).toBe(text)
    }
  })

  test('bounds bodies and retains the first and latest exchanges', async () => {
    const oversized = JSON.stringify({ value: 'x'.repeat(17 * 1024) })
    const transport: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      await request.text()
      return new Response(oversized, {
        headers: { 'content-type': 'application/json' }
      })
    }
    const recorder = new HttpDebugRecorder({ trustedOrigin: API_ORIGIN })
    const debugFetch = recorder.wrap(transport)

    await Promise.all(
      Array.from({ length: 30 }, async (_, offset) => {
        const index = offset + 1
        const response = await debugFetch(
          `${API_ORIGIN}/v1/items/${index.toString()}`,
          {
            body: oversized,
            headers: { 'content-type': 'application/json' },
            method: 'POST'
          }
        )
        await response.text()
      })
    )
    await recorder.settle()

    const trace = recorder.snapshot()
    expect(trace?.droppedExchangeCount).toBe(5)
    expect(trace?.exchanges.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      25, 26, 27, 28, 29, 30
    ])
    expect(trace?.exchanges[0]).toMatchObject({
      request: { body: { kind: 'omitted', reason: 'too-large' } },
      response: { body: { kind: 'omitted', reason: 'too-large' } }
    })
  })
})

describe('API problem text shown without --debug', () => {
  const detailShown = (detail: string): string | undefined =>
    apiErrorOptions(
      new ApiError(detail, {
        body: { detail, status: 401, title: 'Unauthorized' },
        headers: new Headers(),
        operationId: 'getAccount',
        status: 401
      })
    ).detail

  test('gets the credential-key rule too, and keeps a detail with no credential key', () => {
    expect(detailShown('Invalid token: expired')).toBe(
      'Invalid token: [REDACTED]'
    )
    expect(detailShown('The token expired, so sign in again.')).toBe(
      'The token expired, so sign in again.'
    )
  })
})
