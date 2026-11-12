// biome-ignore-all lint/suspicious/noMisplacedAssertion: expectReplayRefused runs inside the test() callbacks that call it.
import { randomUUID } from 'node:crypto'
import { expect, type Mock } from 'vitest'
import { API_ORIGIN } from '../src/auth/constants.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { OperationRepository } from '../src/operation/repository.ts'
import {
  OPERATION_DEFINITIONS,
  type OperationIntent,
  type OperationRecord,
  requestFingerprint
} from '../src/operation/types.ts'
import type { OrganizationScope } from '../src/organization/service.ts'
import {
  asProjectScope,
  cliInvoker,
  createAuthenticatedConfig,
  TEST_NOW
} from './project-test-support.ts'

// Stores an outcome-unknown record of intent, as an earlier CLI left it, and
// checks that the record still lists and that replaying it is refused as a
// changed contract before mutation, or any project API key creation, runs.
export const expectReplayRefused = async ({
  detail,
  intent,
  mutation,
  organizationScope
}: {
  detail: string | undefined
  intent: OperationIntent
  mutation: Mock
  organizationScope: OrganizationScope
}): Promise<void> => {
  const authenticated = await createAuthenticatedConfig()
  try {
    const repository = new OperationRepository({
      apiOrigin: API_ORIGIN,
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      now: () => TEST_NOW
    })
    const identity = await repository.identity()
    const timestamp = new Date(TEST_NOW).toISOString()
    const record: OperationRecord = {
      ...identity,
      attemptCount: 1,
      createdAt: timestamp,
      expiresAt: new Date(TEST_NOW + 86_400_000).toISOString(),
      idempotencyKey: 'legacy-request-key',
      intent,
      operationId: `op_${randomUUID()}`,
      replayable: true,
      replayPolicy: OPERATION_DEFINITIONS[intent.kind].replayPolicy,
      requestFingerprint: requestFingerprint(intent),
      status: 'outcome-unknown',
      updatedAt: timestamp
    }
    await repository.create(record)
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ createProjectApiKey: mutation }),
      { organizationScope }
    )
    const listed = await invoke(['operation', 'list'])
    expect(JSON.parse(listed.stdout).operations).toHaveLength(1)
    const replay = await invoke([
      'operation',
      'replay',
      record.operationId,
      '--yes'
    ])
    expect(JSON.parse(replay.stdout)).toMatchObject({
      error: {
        code: 'OPERATION_CONTRACT_CHANGED',
        ...(detail === undefined
          ? {}
          : { detail: expect.stringContaining(detail) })
      }
    })
    expect(mutation).not.toHaveBeenCalled()
    expect(await repository.get(record.operationId)).toMatchObject({
      attemptCount: 1,
      intent,
      requestFingerprint: record.requestFingerprint
    })
  } finally {
    await authenticated.remove()
  }
}
