import type { CreateProjectApiKeyInput } from '@photon-ai/api'
import { z } from 'zod'
import { invalidInput } from '../core/validation.ts'

export const API_KEY_PERMISSIONS = [
  'events:read',
  'events:write',
  'platforms:read',
  'platforms:write',
  'project:read',
  'project:write'
] as const satisfies readonly CreateProjectApiKeyInput['body']['permissions'][number][]

export const apiKeyPermissionsSchema = z
  .array(z.enum(API_KEY_PERMISSIONS))
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Permissions must be unique.'
  })
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number]
export const projectSlugSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
export const smsPurchaseInputSchema = z.strictObject({
  areaCode: z
    .string()
    .regex(/^[2-9][0-9]{2}$/u)
    .optional(),
  countryCode: z.literal('US')
})
export type SmsPurchaseInput = z.infer<typeof smsPurchaseInputSchema>

export const validateProjectSlug = (value: string): string => {
  const result = projectSlugSchema.safeParse(value)
  if (!result.success) {
    throw invalidInput(
      'Project slug must be 3–63 lowercase letters or digits, with single hyphens between words.'
    )
  }
  return result.data
}
export const validateApiKeyPermissions = (
  values: string[] | undefined
): ApiKeyPermission[] => {
  const result = apiKeyPermissionsSchema.safeParse(values)
  if (!result.success) {
    throw invalidInput(
      `Pass one or more unique --permission values from: ${API_KEY_PERMISSIONS.join(', ')}.`
    )
  }
  return [...result.data].sort()
}
export const validateSmsPurchaseInput = (value: {
  areaCode?: string
  countryCode: string
}): SmsPurchaseInput => {
  const result = smsPurchaseInputSchema.safeParse(value)
  if (!result.success) {
    throw invalidInput(
      'Country must be US. Area code must contain three digits, starting with 2–9.'
    )
  }
  return result.data
}
