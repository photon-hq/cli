import { describe, expect, test } from 'vitest'
import { CliError, normalizeCliError } from '../src/core/errors.ts'
import { CliOutput, outputOptionsFromArgs } from '../src/core/output.ts'
import { CLI_ERROR_REFERENCE_URL } from '../src/core/output-basics.ts'
import { collector } from './project-test-support.ts'

describe('actionable CLI error output', () => {
  test('renders the same structured fields in human and JSON modes', () => {
    const error = new CliError(
      'PROJECTS_UNAVAILABLE',
      'Photon could not reach the project service.',
      {
        detail: 'The request failed after automatic retries.',
        httpStatus: 503,
        idempotencyKey: 'stable-key',
        next: [
          {
            description: 'Replay the operation',
            run: 'photon operation replay op_00000000-0000-4000-8000-000000000000'
          }
        ],
        operationId: 'op_00000000-0000-4000-8000-000000000000',
        replayable: true,
        requestId: 'req_123',
        retryAfterSeconds: 3,
        retryable: true
      }
    )
    const humanStderr = collector()
    new CliOutput({ json: false, stderr: humanStderr }).error(error)
    expect(humanStderr.value()).toContain(
      'Error: Photon could not reach the project service. (PROJECTS_UNAVAILABLE)'
    )
    expect(humanStderr.value()).toContain(
      'Detail: The request failed after automatic retries.'
    )
    expect(humanStderr.value()).toContain(
      'Next: Replay the operation: photon operation replay op_00000000-0000-4000-8000-000000000000'
    )
    expect(humanStderr.value()).toContain(`Docs: ${CLI_ERROR_REFERENCE_URL}`)
    expect(humanStderr.value()).toContain('Request ID: req_123')
    expect(humanStderr.value()).toContain('Idempotency key: stable-key')
    expect(humanStderr.value()).toContain('Replayable: yes')

    const jsonStdout = collector()
    new CliOutput({ json: true, stdout: jsonStdout }).error(error)
    expect(JSON.parse(jsonStdout.value())).toEqual({
      error: {
        code: 'PROJECTS_UNAVAILABLE',
        detail: 'The request failed after automatic retries.',
        docsUrl: CLI_ERROR_REFERENCE_URL,
        idempotencyKey: 'stable-key',
        message: 'Photon could not reach the project service.',
        next: [
          {
            description: 'Replay the operation',
            run: 'photon operation replay op_00000000-0000-4000-8000-000000000000'
          }
        ],
        operationId: 'op_00000000-0000-4000-8000-000000000000',
        replayable: true,
        requestId: 'req_123',
        retryAfterSeconds: 3,
        retryable: true
      }
    })
  })

  test('writes a JSON error to stdout, or to stderr once a result is there', () => {
    const error = new CliError('UNEXPECTED_ERROR', 'Request failed.')
    const failed = { stderr: collector(), stdout: collector() }
    new CliOutput({ json: true, ...failed }).error(error)
    expect(JSON.parse(failed.stdout.value())).toMatchObject({
      error: { code: 'UNEXPECTED_ERROR' }
    })
    expect(failed.stderr.value()).toBe('')

    const answered = { stderr: collector(), stdout: collector() }
    const output = new CliOutput({ json: true, ...answered })
    output.success({ removed: true }, [])
    output.error(error)
    expect(JSON.parse(answered.stdout.value())).toEqual({ removed: true })
    expect(JSON.parse(answered.stderr.value())).toMatchObject({
      error: { code: 'UNEXPECTED_ERROR' }
    })
  })

  test('redacts diagnostics and suppresses sensitive cause chains', () => {
    const secret = 'super-secret-access-token'
    const cause = new Error(
      `Bearer ${secret} access_token=${secret} https://storage.example/upload?signature=${secret}`
    )
    const safeError = new CliError('UNEXPECTED_ERROR', 'Request failed.', {
      cause
    })
    const safeStdout = collector()
    new CliOutput({ debug: true, json: true, stdout: safeStdout }).error(
      safeError
    )
    const safePayload = safeStdout.value()
    expect(safePayload).toContain('debug')
    expect(safePayload).toContain('Bearer [REDACTED]')
    expect(safePayload).toContain('[REDACTED]')
    expect(safePayload).not.toContain('$1')
    expect(safePayload).not.toContain(secret)

    const sensitiveStdout = collector()
    new CliOutput({ debug: true, json: true, stdout: sensitiveStdout }).error(
      new CliError('INVITATION_INVALID', 'Invitation failed.', {
        cause,
        debugSafe: false
      })
    )
    expect(JSON.parse(sensitiveStdout.value())).toEqual({
      error: {
        code: 'INVITATION_INVALID',
        docsUrl: CLI_ERROR_REFERENCE_URL,
        message: 'Invitation failed.',
        retryable: false
      }
    })
  })

  test('redacts API key and generic secret fields from diagnostics', () => {
    const secret = 'photon_private_api_key'
    const error = new CliError('UNEXPECTED_ERROR', 'Request failed.', {
      cause: new Error(`apiKey=${secret} secret: ${secret}`)
    })
    const stdout = collector()

    new CliOutput({ debug: true, json: true, stdout }).error(error)

    expect(stdout.value()).toContain('[REDACTED]')
    expect(stdout.value()).not.toContain(secret)
  })

  test('shows unknown cause chains under --debug and maps output flags once', () => {
    const normalized = normalizeCliError(
      new TypeError("Cannot read properties of undefined (reading 'id')")
    )
    expect(normalized.debugSafe).toBe(true)

    const stdout = collector()
    new CliOutput({
      ...outputOptionsFromArgs(['--debug', '--json', '--no-color']),
      stdout
    }).error(normalized)
    expect(JSON.parse(stdout.value())).toEqual({
      error: {
        code: 'UNEXPECTED_ERROR',
        debug: {
          causes: [
            expect.objectContaining({
              message: 'Photon encountered an unexpected error.',
              name: 'CliError'
            }),
            {
              message: "Cannot read properties of undefined (reading 'id')",
              name: 'TypeError',
              stack: expect.stringContaining(
                "TypeError: Cannot read properties of undefined (reading 'id')\n    at "
              )
            }
          ]
        },
        docsUrl: CLI_ERROR_REFERENCE_URL,
        message: 'Photon encountered an unexpected error.',
        next: [
          { description: 'Retry with --debug for diagnostic information.' }
        ],
        retryable: false
      }
    })
    expect(outputOptionsFromArgs(['--debug', '--json', '--no-color'])).toEqual({
      color: false,
      colorExplicit: false,
      debug: true,
      json: true
    })
    expect(
      outputOptionsFromArgs(['--debug=true', '--json=true', '--color=false'])
    ).toEqual({ color: false, colorExplicit: false, debug: true, json: true })
    expect(
      outputOptionsFromArgs(['--json', '--json=false', '--no-color', '--color'])
    ).toEqual({ color: true, colorExplicit: true, debug: false, json: false })
    expect(outputOptionsFromArgs([])).toEqual({
      color: true,
      colorExplicit: false,
      debug: false,
      json: false
    })
  })

  // Everything after the first "--" is an operand, as the parser reads it.
  test('reads output flags only up to the first --', () => {
    expect(
      outputOptionsFromArgs(['--', '--debug', '--json', '--color'])
    ).toEqual({ color: true, colorExplicit: false, debug: false, json: false })
    expect(outputOptionsFromArgs(['--no-color', '--', '--color'])).toEqual({
      color: false,
      colorExplicit: false,
      debug: false,
      json: false
    })
    expect(
      outputOptionsFromArgs([
        '--debug',
        '--json',
        '--color',
        '--',
        '--debug=false',
        '--json=false',
        '--no-color'
      ])
    ).toEqual({ color: true, colorExplicit: true, debug: true, json: true })
    expect(
      outputOptionsFromArgs(['--json', '--', '--', '--json=false'])
    ).toEqual({ color: true, colorExplicit: false, debug: false, json: true })
  })

  test('keeps a sensitive cause chain hidden when an unexpected error wraps it', () => {
    const secret = 'planted-sensitive-detail'
    const normalized = normalizeCliError(
      new TypeError('Session refresh failed.', {
        cause: new CliError(
          'AUTH_REFRESH_FAILED',
          'Photon could not refresh the session.',
          { cause: new Error(secret), debugSafe: false }
        )
      })
    )
    const stderr = collector()

    new CliOutput({ debug: true, json: false, stderr }).error(normalized)

    expect(stderr.value()).toContain('TypeError: Session refresh failed.')
    expect(stderr.value()).not.toContain('AUTH_REFRESH_FAILED')
    expect(stderr.value()).not.toContain(secret)
  })
})
