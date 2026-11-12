import { describe, expect, test } from 'vitest'
import { CLI_NAME } from '../src/meta.ts'
import {
  validateAgentProfileChanges,
  validateApiKeyId,
  validateBillingCategory,
  validateBillingOperationId,
  validateBillingPlanCode,
  validateEmailDomain,
  validateIdentifier,
  validatePagination,
  validatePlatformOperationId
} from '../src/project/validation.ts'
import { photonKey } from './key-support.ts'

describe('project validation', () => {
  test('rejects limits above the service pagination maximum', () => {
    expect(() => validatePagination(1001, undefined)).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail: 'Limit cannot exceed 1000.',
        message: 'The command contains invalid input.'
      })
    )
  })

  test('rejects conflicting last-name updates', () => {
    expect(() =>
      validateAgentProfileChanges({
        clearLastName: true,
        lastName: 'Agent'
      })
    ).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail: 'Pass either --last-name or --clear-last-name, not both.',
        message: 'The command contains invalid input.'
      })
    )
  })

  test.each([
    [
      'project_\u0085',
      'Project ID cannot contain control or format characters.'
    ],
    [
      'project_\u202E',
      'Project ID cannot contain control or format characters.'
    ],
    ['project with space', 'Project ID cannot contain whitespace.']
  ])('rejects unsafe ID %j', (value, detail) => {
    expect(() => validateIdentifier(value, 'Project ID')).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail
      })
    )
  })

  test('refuses a full API key credential and accepts its ID', () => {
    const apiKeyId = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
    const credential = `${apiKeyId}_private-key-material`
    const args = ['project', 'api-key', 'revoke', credential, '--json']

    expect(validateApiKeyId(apiKeyId, args)).toBe(apiKeyId)
    expect(() => validateApiKeyId(credential, args)).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail: 'The value is a full API key. Only its ID is accepted.',
        exitCode: 2,
        next: [
          {
            description: 'Revoke the key by its ID',
            run: `${CLI_NAME} project api-key revoke ${apiKeyId} --json`
          },
          {
            description: 'List the API key IDs',
            run: `${CLI_NAME} project api-key list`
          }
        ]
      })
    )
  })

  test('rejects malformed API key credentials without echoing them', () => {
    const malformed = photonKey('sk', 'invalid_private-key-material')

    expect(() => validateApiKeyId(malformed, [])).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail: 'API key ID must be a canonical pho_sk_ identifier.'
      })
    )
  })

  test('matches the generated billing category contract', () => {
    expect(validateBillingCategory('platforms')).toBe('platforms')
    expect(validateBillingCategory('platforms_v2')).toBe('platforms_v2')
    expect(() => validateBillingCategory('Platforms')).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
    expect(() => validateBillingCategory('platforms-v2')).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
    expect(() => validateBillingCategory(`p${'a'.repeat(64)}`)).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
  })

  test('matches the generated billing plan code contract', () => {
    expect(validateBillingPlanCode(' Business + Annual ')).toBe(
      'Business + Annual'
    )
    expect(validateBillingPlanCode('a'.repeat(64))).toBe('a'.repeat(64))
    expect(() => validateBillingPlanCode('a'.repeat(65))).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
  })

  test('requires the generated billing operation ID prefix', () => {
    const operationId =
      'pho_bop_0000000000000000000000000000000000000000000000000000000000000001'

    expect(validateBillingOperationId(operationId)).toBe(operationId)
    expect(() => validateBillingOperationId('operation_1')).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail:
          'Operation ID must be pho_bop_ followed by 64 lowercase hexadecimal characters.'
      })
    )
    expect(() => validateBillingOperationId('pho_bop_operation')).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
    )
  })

  test('requires a canonical platform operation ID', () => {
    const operationId = 'pho_opr_01h455vb4pex5vsknk084sn02q'

    expect(validatePlatformOperationId(operationId)).toBe(operationId)
    expect(() => validatePlatformOperationId('op_local')).toThrow(
      expect.objectContaining({
        code: 'ARGUMENT_VALIDATION',
        detail: 'Platform operation ID must be a canonical pho_opr_ identifier.'
      })
    )
    expect(() => validatePlatformOperationId('pho_opr_not-a-ulid')).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
    )
  })

  test('canonicalizes email domains for idempotent operations', () => {
    expect(validateEmailDomain(' BÜCHER.Example. ')).toBe(
      'xn--bcher-kva.example'
    )
  })

  test.each(['https://example.com', '*.example.com', '127.0.0.1', 'two..dots'])(
    'rejects invalid email domain %s',
    (domain) => {
      expect(() => validateEmailDomain(domain)).toThrow(
        expect.objectContaining({ code: 'ARGUMENT_VALIDATION' })
      )
    }
  )
})
