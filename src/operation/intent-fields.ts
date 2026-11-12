import { z } from 'zod'

export const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const UNSAFE_STORED_TEXT_PATTERN = /[\p{Cc}\p{Cf}]/u
const WHITESPACE_PATTERN = /\s/u

export const safeText = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => !UNSAFE_STORED_TEXT_PATTERN.test(value))

export const identifier = safeText(512).refine(
  (value) => !WHITESPACE_PATTERN.test(value)
)

// Records written before 10DLC and project creation moved to organizations
// have no organization ID. They stay readable, but cannot be replayed
// (see assertCurrentOperationContract).
export const legacyOrganizationId = identifier.optional()
