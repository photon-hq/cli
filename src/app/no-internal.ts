import type { OperationRecord } from '../operation/types.ts'
import type { InternalServiceContext } from './services.ts'

// Production builds load this file for '#internal' and have no internal-only
// commands. Internal (staging) builds load src/internal/index.ts instead (the
// "photon-internal" condition in package.json "imports").
export type InternalServiceOptions = Record<never, never>
export type InternalCommandServices = Record<never, never>

export const internalCommands = { account: {}, auth: {}, project: {} }

export const createInternalServices = (
  _context: InternalServiceContext
): InternalCommandServices => ({})

export const internalIntentSchemas = [] as const
export const INTERNAL_OPERATION_DEFINITIONS = {}
export const INTERNAL_SENSITIVE_PATH_PATTERNS: readonly RegExp[] = []
export const isInternalIntent = (_intent: { kind: string }): _intent is never =>
  false

export const internalSafeInput = (
  _intent: never
): Record<string, unknown> => ({})

export const assertCurrentInternalContract = (_intent: never): void => undefined

export const dispatchInternalOperation = async (
  _record: OperationRecord,
  _intent: never,
  _services: InternalCommandServices
): Promise<object> => await Promise.resolve({})
