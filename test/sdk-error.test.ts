import { ApiError, TransportError } from '@photon-ai/api'
import { describe, expect, test } from 'vitest'
import { CliError, copyCliError, type NextStep } from '../src/core/errors.ts'
import { CLI_ERROR_REFERENCE_URL, CliOutput } from '../src/core/output.ts'
import { normalizeSdkError } from '../src/core/sdk-error.ts'
import { CLI_NAME } from '../src/meta.ts'
import { photonKey } from './key-support.ts'
import { collector } from './project-test-support.ts'

const PROBLEMS = 'https://photon.codes/docs/problems'

const apiError = (
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): ApiError =>
  new ApiError(`HTTP ${status.toString()}`, {
    body: { status, ...body },
    headers: new Headers(headers),
    requestId: 'req_01example',
    status
  })

const mapped = (error: unknown): CliError => {
  const result = normalizeSdkError(error)
  if (!(result instanceof CliError)) {
    throw new Error('Expected a CLI error.')
  }
  return result
}

const STEP_KEYS = new Set(['description', 'person', 'run', 'url'])

const parseStep = (step: NextStep): void => {
  const valid =
    Object.keys(step).every((key) => STEP_KEYS.has(key)) &&
    step.description.length > 0 &&
    !(step.run !== undefined && step.url !== undefined) &&
    (step.person === undefined || step.person === true)
  if (!valid) {
    throw new Error(`Invalid next step: ${JSON.stringify(step)}`)
  }
}

const json = (error: CliError): Record<string, unknown> => {
  const stdout = collector()
  new CliOutput({ json: true, stdout }).error(error)
  const { error: payload } = JSON.parse(stdout.value()) as {
    error: Record<string, unknown> & { next?: NextStep[] }
  }
  for (const step of payload.next ?? []) {
    parseStep(step)
  }
  return payload
}

const text = (error: CliError, debug = false): string => {
  const stderr = collector()
  new CliOutput({ debug, json: false, stderr }).error(error)
  return stderr.value()
}

const lastLine = (value: string): string | undefined =>
  value.trimEnd().split('\n').at(-1)

describe('SDK error normalization', () => {
  test('preserves a CLI authentication error wrapped by SDK transport', () => {
    const authError = new CliError(
      'AUTH_SESSION_EXPIRED',
      'Your Photon session expired.',
      {
        next: [
          {
            description: 'Sign in again',
            person: true,
            run: `${CLI_NAME} login`
          }
        ]
      }
    )
    const transportError = new TransportError('Photon request failed', {
      cause: authError
    })

    expect(normalizeSdkError(transportError)).toBe(authError)
  })

  test('keeps the code and reason of a 402 that needs a card, with the billing hint', () => {
    const problem = {
      code: 'ENTITLEMENT_REQUIRED',
      detail: 'Buying a number needs a payment card on file.',
      reason: 'card_required',
      title: 'Entitlement Required',
      type: `${PROBLEMS}/entitlement-required`
    }
    const error = mapped(apiError(402, problem))

    expect(json(error)).toEqual({
      code: 'ENTITLEMENT_REQUIRED',
      docsUrl: `${PROBLEMS}/entitlement-required`,
      message: 'Buying a number needs a payment card on file.',
      problem: { ...problem, status: 402 },
      reason: 'card_required',
      requestId: 'req_01example',
      retryable: false
    })
    const output = text(error)
    expect(output).toContain(
      'Error: Buying a number needs a payment card on file. (ENTITLEMENT_REQUIRED, card_required)'
    )
    expect(output).toContain('Request ID: req_01example')
    expect(output).toContain(`Docs: ${PROBLEMS}/entitlement-required`)
    expect(output).not.toContain('Next:')
    expect(output).not.toContain('Problem:')
    expect(lastLine(output)).toBe(
      "Your organization's billing or plan has to change first. The docs page says how."
    )
    expect(text(error, true)).toContain('Problem: {')
  })

  test("turns the problem's remediation into the only step", () => {
    const error = mapped(
      apiError(402, {
        code: 'ENTITLEMENT_REQUIRED',
        detail: 'Buying a number needs a payment card on file.',
        reason: 'card_required',
        remediation: {
          action: 'Add a payment method',
          documentation: `${PROBLEMS}/entitlement-required`,
          method: 'POST',
          path: '/v1/organizations/{organizationId}/billing/checkout',
          person: true
        },
        type: `${PROBLEMS}/entitlement-required`
      })
    )
    const step = {
      description: 'Add a payment method',
      person: true,
      url: `${PROBLEMS}/entitlement-required`
    }

    expect(json(error)).toMatchObject({ next: [step] })
    const output = text(error)
    expect(output).toContain(
      `Next: Add a payment method (you do this): ${PROBLEMS}/entitlement-required`
    )
    expect(output).not.toContain('billing or plan')
  })

  test('links a fix that only works in a browser', () => {
    const error = mapped(
      apiError(403, {
        code: 'FORBIDDEN',
        detail: 'Only an owner can do this.',
        remediation: {
          action: 'Ask an owner for access.',
          href: 'https://app.photon.codes/settings/members',
          person: true
        }
      })
    )

    expect(json(error).next).toEqual([
      {
        description: 'Ask an owner for access.',
        person: true,
        url: 'https://app.photon.codes/settings/members'
      }
    ])
    expect(text(error)).toContain(
      'Next: Ask an owner for access (you do this): https://app.photon.codes/settings/members'
    )
  })

  test('keeps the query and fragment of a remediation link, and drops one that carries a credential', () => {
    const steps = (href: string) =>
      json(
        mapped(
          apiError(403, {
            code: 'FORBIDDEN',
            detail: 'Only an owner can do this.',
            remediation: {
              action: 'Ask an owner for access.',
              href,
              person: true
            }
          })
        )
      ).next
    const membersLink =
      'https://app.photon.codes/settings/members?role=owner#invite'
    expect(steps(membersLink)).toEqual([
      {
        description: 'Ask an owner for access.',
        person: true,
        url: membersLink
      }
    ])
    for (const withCredential of [
      'https://app.photon.codes/invite?token=s3cr3t',
      'https://app.photon.codes/callback#access_token=s3cr3t',
      'https://app.photon.codes/next?to=%2Fcallback%3Faccess_token%3Ds3cr3t'
    ]) {
      expect(steps(withCredential)).toEqual([
        { description: 'Ask an owner for access.', person: true }
      ])
    }
  })

  test('drops a remediation link whose query names a signature, key or JWT', () => {
    const steps = (href: string) =>
      json(
        mapped(
          apiError(403, {
            code: 'FORBIDDEN',
            detail: 'Only an owner can do this.',
            remediation: { action: 'Ask an owner for access.', href }
          })
        )
      ).next
    for (const withCredential of [
      'https://app.photon.codes/invite?sig=s3cr3t',
      'https://app.photon.codes/invite?key=s3cr3t',
      'https://app.photon.codes/invite?jwt=s3cr3t',
      'https://app.photon.codes/invite?role=owner&Key=s3cr3t'
    ]) {
      expect(steps(withCredential)).toEqual([
        { description: 'Ask an owner for access.' }
      ])
    }
    const keysPage =
      'https://app.photon.codes/settings/keys?view=key&keyword=sig'
    expect(steps(keysPage)).toEqual([
      { description: 'Ask an owner for access.', url: keysPage }
    ])
  })

  test('carries the issues of invalid input', () => {
    const error = mapped(
      apiError(422, {
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid.',
        issues: [{ code: 'TOO_SHORT', message: 'Too short.', path: ['name'] }],
        type: `${PROBLEMS}/validation-failed`
      })
    )

    expect(json(error)).toMatchObject({
      code: 'VALIDATION_FAILED',
      docsUrl: `${PROBLEMS}/validation-failed`,
      issues: [{ code: 'TOO_SHORT', message: 'Too short.', path: ['name'] }],
      message: 'The request is invalid.',
      retryable: false
    })
    const output = text(error)
    expect(output).toContain('  - name: Too short.')
    expect(lastLine(output)).toBe(
      'Review the error detail and correct the request before retrying.'
    )
  })

  test("keeps a conflict's code and points to the CLI reference without a type page", () => {
    const error = mapped(
      apiError(409, { code: 'ALREADY_EXISTS', detail: 'The name is taken.' })
    )

    expect(json(error)).toMatchObject({
      code: 'ALREADY_EXISTS',
      docsUrl: CLI_ERROR_REFERENCE_URL,
      message: 'The name is taken.',
      retryable: false
    })
    expect(json(error)).not.toHaveProperty('next')
  })

  test('makes a 429 retryable after its Retry-After', () => {
    const error = mapped(
      apiError(
        429,
        { code: 'RATE_LIMITED', detail: 'Too many requests.' },
        { 'retry-after': '7' }
      )
    )

    expect(json(error)).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 7,
      retryable: true
    })
    const output = text(error)
    expect(output).toContain('Retry after: 7 seconds')
    expect(lastLine(output)).toBe(`Docs: ${CLI_ERROR_REFERENCE_URL}`)
  })

  test('warns that a recorded write sent without a key is unsafe to repeat', () => {
    const error = copyCliError(
      mapped(apiError(503, { code: 'SERVICE_UNAVAILABLE' })),
      { operationId: 'op_00000000-0000-4000-8000-000000000000' }
    )

    expect(error.retryable).toBe(true)
    expect(lastLine(text(error))).toBe(
      "Trying again can work, but this command isn't safe to repeat: check first whether it took effect."
    )
    expect(json(error)).not.toHaveProperty('next')
  })

  test("says a 5xx failed on Photon's side", () => {
    const error = mapped(apiError(500, { code: 'INTERNAL' }))

    expect(error.message).toBe("Photon's API answered HTTP 500.")
    expect(lastLine(text(error))).toBe(
      "This failed on Photon's side. If it keeps happening, contact support with the request ID."
    )
  })

  test('points the 4xx hint at the detail only when the problem has one', () => {
    const withoutDetail = mapped(
      apiError(409, {
        code: 'OAUTH_SECRET_NOT_CONFIGURED',
        title: 'OAuth Secret Not Configured'
      })
    )
    expect(lastLine(text(withoutDetail))).toBe(
      'Check the docs page for this error and correct the request before retrying.'
    )

    const withDetail = mapped(
      apiError(409, {
        code: 'OAUTH_SECRET_NOT_CONFIGURED',
        detail: 'The OAuth client has no secret to rotate.',
        title: 'OAuth Secret Not Configured'
      })
    )
    expect(lastLine(text(withDetail))).toBe(
      'Review the error detail and correct the request before retrying.'
    )
  })

  test('prints problem titles in full and still redacts a secret value', () => {
    const titles = [
      ['OAUTH_SECRET_CONFIGURED', 'OAuth Secret Already Configured'],
      ['OAUTH_SECRET_NOT_CONFIGURED', 'OAuth Secret Not Configured']
    ] as const
    for (const [code, title] of titles) {
      const error = mapped(apiError(409, { code, title }))
      expect(json(error)).toMatchObject({
        code,
        message: title,
        problem: { code, status: 409, title }
      })
      expect(text(error)).toContain(`Error: ${title} (${code})`)
    }

    const secret = photonKey('cs', 'live_9f8e7d6c5b4a3f2e')
    const error = mapped(
      apiError(409, {
        code: 'OAUTH_SECRET_CONFIGURED',
        detail: `The client secret ${secret} is already set.`,
        title: 'OAuth Secret Already Configured'
      })
    )
    expect(json(error)).toMatchObject({
      message: 'The client secret [REDACTED] is already set.',
      problem: {
        detail: 'The client secret [REDACTED] is already set.',
        title: 'OAuth Secret Already Configured'
      }
    })
    expect(JSON.stringify(json(error))).not.toContain(secret)
    expect(text(error, true)).not.toContain(secret)
  })

  test('redacts a credential in a problem title', () => {
    const error = mapped(
      apiError(409, {
        code: 'TOKEN_REJECTED',
        title: 'Token access_token=s3cr3t-title Rejected'
      })
    )

    expect(json(error)).toMatchObject({
      message: 'Token access_token=[REDACTED] Rejected',
      problem: { title: 'Token access_token=[REDACTED] Rejected' }
    })
    expect(JSON.stringify(json(error))).not.toContain('s3cr3t-title')
    expect(text(error, true)).not.toContain('s3cr3t-title')
  })

  test('signs in again after a 401', () => {
    const error = mapped(
      apiError(401, { code: 'UNAUTHENTICATED', detail: 'The session expired.' })
    )

    expect(json(error)).toMatchObject({
      code: 'UNAUTHENTICATED',
      next: [
        { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
      ]
    })
    expect(text(error)).toContain(
      `Next: Sign in again (you do this): ${CLI_NAME} login`
    )
  })

  test('maps a transport failure without a problem', () => {
    const error = mapped(
      new TransportError('Photon request failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      })
    )

    expect(json(error)).toEqual({
      code: 'API_CONNECTION_ERROR',
      docsUrl: CLI_ERROR_REFERENCE_URL,
      message: "Photon's API could not be reached.",
      retryable: true,
      transportCode: 'ECONNREFUSED'
    })
  })

  test('keeps only the safe problem fields of a sensitive request', () => {
    const error = normalizeSdkError(
      apiError(422, {
        code: 'VALIDATION_FAILED',
        detail: 'Code 123456 is wrong.',
        issues: [{ message: 'Code 123456 is wrong.' }],
        title: 'Validation Failed'
      }),
      { sensitive: true }
    )

    expect(error).toBeInstanceOf(CliError)
    expect(json(error as CliError)).toEqual({
      code: 'VALIDATION_FAILED',
      docsUrl: CLI_ERROR_REFERENCE_URL,
      message: "Photon's API answered HTTP 422.",
      problem: { code: 'VALIDATION_FAILED', status: 422 },
      requestId: 'req_01example',
      retryable: false
    })
  })

  test('applies a service override to the mapped error', () => {
    const error = normalizeSdkError(
      apiError(404, { code: 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND' }),
      { override: (cliError) => copyCliError(cliError, { retryable: true }) }
    )

    expect(error).toMatchObject({
      code: 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND',
      retryable: true
    })
  })
})
