import { describe, expect, test } from 'vitest'
import {
  argumentValidationError,
  CliError,
  copyCliError,
  hasOwnNextSteps,
  joinSentences,
  normalizeCliError
} from '../src/core/errors.ts'

describe('CLI error normalization', () => {
  test('classifies command interruption independently of login', () => {
    const error = new DOMException('stopped', 'AbortError')

    expect(normalizeCliError(error)).toMatchObject({
      cause: error,
      code: 'COMMAND_INTERRUPTED',
      exitCode: 130,
      message: 'The command was interrupted.'
    })
  })

  test('does not classify a timeout as user interruption', () => {
    const error = new DOMException('timed out', 'TimeoutError')

    expect(normalizeCliError(error)).toMatchObject({
      cause: error,
      code: 'COMMAND_TIMED_OUT',
      exitCode: 1
    })
  })
})

describe('joining two pieces of error text', () => {
  test.each([
    ['Forbidden', 'Forbidden. Next.'],
    ['Forbidden ', 'Forbidden. Next.'],
    ['It was refused.', 'It was refused. Next.'],
    ['Is it allowed?', 'Is it allowed? Next.'],
    ['It was refused!', 'It was refused! Next.'],
    ['It said "no."', 'It said "no." Next.'],
    ['(It was refused.)', '(It was refused.) Next.']
  ])(
    'closes %j with a full stop only when it ends no sentence',
    (first, joined) => {
      expect(joinSentences(first, 'Next.')).toBe(joined)
    }
  )
})

describe('argument error next steps', () => {
  test('tells the default hint apart from steps an error brings', () => {
    const ownSteps = [{ description: 'List the IDs', run: 'photon list' }]
    const withDefault = argumentValidationError('Bad value.')

    expect(hasOwnNextSteps(withDefault)).toBe(false)
    expect(hasOwnNextSteps(copyCliError(withDefault, {}))).toBe(false)
    expect(
      hasOwnNextSteps(argumentValidationError('Bad value.', { next: [] }))
    ).toBe(false)
    expect(
      hasOwnNextSteps(new CliError('ARGUMENT_VALIDATION', 'Bad value.'))
    ).toBe(false)
    expect(
      hasOwnNextSteps(argumentValidationError('Bad value.', { next: ownSteps }))
    ).toBe(true)
    expect(
      hasOwnNextSteps(
        copyCliError(argumentValidationError('Bad value.'), { next: ownSteps })
      )
    ).toBe(true)
  })
})
