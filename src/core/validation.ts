import { argumentValidationError, type CliError } from './errors.ts'

// SDK enums are open (`"a" | "b" | (string & {})`) so a value added to the API
// later still decodes. Commands accept only the values this CLI knows.
export type KnownEnumValue<Value extends string> = Value extends string
  ? string extends Value
    ? never
    : Value
  : never

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u
const MAX_FILE_PATH_LENGTH = 4096
const MAX_NAME_LENGTH = 256

export const invalidInput = (message: string): CliError =>
  argumentValidationError(message)

export const boundedText = (
  value: string,
  label: string,
  maximumLength: number,
  clearHint?: string
): string => {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw invalidInput(
      clearHint === undefined
        ? `${label} cannot be empty.`
        : `${label} cannot be empty. ${clearHint}`
    )
  }
  if (normalized.length > maximumLength) {
    throw invalidInput(
      `${label} cannot exceed ${maximumLength.toString()} characters.`
    )
  }
  if (
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    FORMAT_CHARACTER_PATTERN.test(normalized)
  ) {
    throw invalidInput(`${label} cannot contain control or format characters.`)
  }
  return normalized
}

// A page token or cursor is opaque, but it can't be "." or "..".
export const validateOpaqueToken = (
  value: string,
  label: string,
  maximumLength: number
): string => {
  const token = boundedText(value, label, maximumLength)
  if (token === '.' || token === '..') {
    throw invalidInput(`${label} cannot be "." or "..".`)
  }
  return token
}

export const validateFilePath = (value: string, label: string): string => {
  if (value.length === 0) {
    throw invalidInput(`${label} cannot be empty.`)
  }
  if (value.length > MAX_FILE_PATH_LENGTH) {
    throw invalidInput(
      `${label} cannot exceed ${MAX_FILE_PATH_LENGTH.toString()} characters.`
    )
  }
  if (value.includes('\0')) {
    throw invalidInput(`${label} cannot contain a null byte.`)
  }
  return value
}

export const validatePersonName = (
  value: string,
  label: string,
  clearHint?: string
): string => boundedText(value, label, MAX_NAME_LENGTH, clearHint)
