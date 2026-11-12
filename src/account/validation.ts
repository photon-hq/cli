import { invalidInput, validatePersonName } from '../core/validation.ts'
import type { AccountChanges } from './service.ts'

export const validateAccountChanges = (input: {
  clearLastName: boolean
  firstName?: string
  lastName?: string
}): AccountChanges => {
  if (
    input.firstName === undefined &&
    input.lastName === undefined &&
    !input.clearLastName
  ) {
    throw invalidInput(
      'Pass --first-name, --last-name, or --clear-last-name to edit the account.'
    )
  }
  if (input.clearLastName && input.lastName !== undefined) {
    throw invalidInput(
      'Pass either --last-name or --clear-last-name, not both.'
    )
  }
  const changes: AccountChanges = {}
  if (input.firstName !== undefined) {
    changes.firstName = validatePersonName(input.firstName, 'First name')
  }
  if (input.clearLastName) {
    changes.lastName = null
  } else if (input.lastName !== undefined) {
    changes.lastName = validatePersonName(
      input.lastName,
      'Last name',
      'To remove it, pass --clear-last-name.'
    )
  }
  return changes
}
