/**
 * Confirms what a command would otherwise ask about: something that costs
 * money or can't be undone.
 */
export const yesArg = {
  default: false,
  description: 'Confirm without being asked',
  short: 'y',
  type: 'boolean'
} as const

export const idempotencyKeyArg = {
  description: 'Identify or continue the same logical request',
  toKebab: true,
  type: 'string'
} as const

export const tokenFileArg = {
  description: 'Read the invitation token from a file, or - for standard input',
  toKebab: true,
  type: 'string'
} as const
