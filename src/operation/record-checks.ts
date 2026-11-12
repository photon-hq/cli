import { CliError } from '../core/errors.ts'
import type { OperationRecord, OperationReplayPolicy } from './types.ts'

export const isKeyedPolicy = (policy: OperationReplayPolicy): boolean =>
  policy === 'avatar' || policy === 'keyed' || policy === 'secret-keyed'

export const requiredIdempotencyKey = (record: OperationRecord): string => {
  if (!isKeyedPolicy(record.replayPolicy)) {
    throw new CliError(
      'OPERATION_JOURNAL_CORRUPT',
      'A keyed local operation is missing its idempotency key.'
    )
  }
  if (record.idempotencyKey === undefined) {
    throw new CliError(
      'OPERATION_JOURNAL_CORRUPT',
      'A keyed local operation is missing its idempotency key.'
    )
  }
  return record.idempotencyKey
}

export const legacyContractError = (detail: string): CliError =>
  new CliError(
    'OPERATION_CONTRACT_CHANGED',
    'This saved operation uses an older API contract and cannot be sent again safely.',
    {
      detail,
      next: [
        {
          description:
            'Check the remote outcome before creating a new operation.'
        }
      ],
      replayable: false
    }
  )
