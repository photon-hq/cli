import { randomUUID } from 'node:crypto'
import type { GetBillingOperationOutput } from '@photon-ai/api'
import {
  assertCurrentInternalContract,
  dispatchInternalOperation,
  type InternalCommandServices,
  internalSafeInput,
  isInternalIntent
} from '#internal'
import type { AccountService } from '../account/service.ts'
import { type AvatarFile, prepareAvatarFile } from '../core/avatar.ts'
import {
  CliError,
  copyCliError,
  type NextStep,
  normalizeCliError
} from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'
import type { OrganizationContextService } from '../organization/context-service.ts'
import type { OrganizationService } from '../organization/service.ts'
import type { ProjectContextService } from '../project/context-service.ts'
import {
  withSafeApiKeySecret,
  withSafeWebhookSigningSecret
} from '../project/presenter.ts'
import type { ProjectService } from '../project/service.ts'
import { withSafeOutboundPassword } from '../project/voice-presenter.ts'
import type { VoiceService } from '../project/voice-service.ts'
import { legacyContractError, requiredIdempotencyKey } from './record-checks.ts'
import type { OperationJournal } from './repository.ts'
import {
  ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS,
  effectiveIdempotencyKey,
  OPERATION_DEFINITIONS,
  OPERATION_ID_PATTERN,
  type OperationFailureSnapshot,
  type OperationIntent,
  type OperationKind,
  type OperationRecord,
  type OperationReplayPolicy,
  type OperationStatus,
  OUTPUT_ACKNOWLEDGEMENT_KINDS,
  requestFingerprint,
  validateIdempotencyKey
} from './types.ts'

const MAXIMUM_OPERATION_LIST_LIMIT = 1000
const UNSAFE_FILE_NAME_PATTERN = /[\p{Cc}\p{Cf}]/gu
const UNSAFE_SNAPSHOT_TEXT_PATTERN = /[\p{Cc}\p{Cf}]/gu
const WHITESPACE_SEQUENCE_PATTERN = /\s+/gu

interface OperationServiceOptions {
  account: AccountService
  beforeWrite?: (intent: OperationIntent) => void
  internal: InternalCommandServices
  now?: () => number
  organizationContext: OrganizationContextService
  organizations: OrganizationService
  projectContext: ProjectContextService
  projects: ProjectService
  repository: OperationJournal
  voice: VoiceService
  warning?: (message: string) => void
}

export interface OperationExecutionContext {
  idempotencyKey?: string
  updateIntent: (intent: OperationIntent) => Promise<void>
  updateRemoteOperationId: (operationId: string) => Promise<void>
}

export interface OperationExecution<Result> {
  result: Result
}

export interface OperationExecuteOptions {
  /**
   * The step that retries the write when no journal outlives the run, for a
   * command that can't take `--idempotency-key`, such as a wizard. Without
   * it, the step is the same command with `--idempotency-key`.
   */
  retry?: (idempotencyKey: string) => NextStep
}

export interface DeferredOperationExecution<Result>
  extends OperationExecution<Result> {
  operationId: string
}

export interface OperationListOptions {
  limit?: number
  pageToken?: string
  statuses?: OperationStatus[]
}

export interface OperationSummary {
  kind: OperationKind
  operationId: string
  replayable: boolean
  status: OperationStatus
  updatedAt: string
}

export interface OperationView extends OperationSummary {
  attemptCount: number
  command: string
  createdAt: string
  expiresAt: string
  failure?: OperationFailureSnapshot
  idempotencyKey?: string
  input: Record<string, unknown>
  remoteOperationId?: string
  replayExpiresAt?: string
}

export interface ReplayedOperation {
  kind: OperationKind
  operationId: string
  status: 'awaiting-output-ack' | 'resolved'
}

interface PageCursor {
  operationId: string
  updatedAt: string
}

const bounded = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return
  }
  const sanitized = value
    .replace(UNSAFE_SNAPSHOT_TEXT_PATTERN, ' ')
    .replace(WHITESPACE_SEQUENCE_PATTERN, ' ')
    .trim()
  return sanitized.length === 0 ? undefined : sanitized.slice(0, 4096)
}

const boundedIdentifier = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return
  }
  const sanitized = value
    .replace(UNSAFE_SNAPSHOT_TEXT_PATTERN, '')
    .replace(WHITESPACE_SEQUENCE_PATTERN, '')
    .slice(0, 512)
  return sanitized.length === 0 ? undefined : sanitized
}

const safeFileName = (value: string): string => {
  const sanitized = value.replace(UNSAFE_FILE_NAME_PATTERN, '_').slice(0, 1024)
  return sanitized.length === 0 ? 'avatar' : sanitized
}

const storedAvatarFile = (
  intent: Extract<
    OperationIntent,
    { kind: 'account-avatar.upload' | 'agent-avatar.upload' }
  >
): AvatarFile => {
  if (intent.fileContents === undefined) {
    throw new CliError(
      'OPERATION_JOURNAL_CORRUPT',
      'An upload-phase avatar operation is missing its stored file contents.'
    )
  }
  return {
    blob: new Blob([Buffer.from(intent.fileContents, 'base64')], {
      type: intent.contentType
    }),
    contentType: intent.contentType,
    digest: intent.fileDigest,
    fileName: intent.fileName
  }
}

const failureSnapshot = (error: CliError): OperationFailureSnapshot => {
  const detail = bounded(error.detail)
  const problemType = bounded(error.problemType)
  const reason = bounded(error.reason)
  const remoteOperationId = boundedIdentifier(error.remoteOperationId)
  const requestId = boundedIdentifier(error.requestId)
  const transportCode = boundedIdentifier(error.transportCode)
  const remediation = error.next
    .slice(0, 10)
    .map((step) => {
      const target = step.run ?? step.url
      return bounded(
        target === undefined
          ? step.description
          : `${step.description}: ${target}`
      )
    })
    .filter((item): item is string => item !== undefined)
  return {
    code: error.code.slice(0, 128),
    message: bounded(error.message) ?? 'The operation failed.',
    remediation,
    retryable: error.retryable,
    ...(detail === undefined ? {} : { detail }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(problemType === undefined ? {} : { problemType }),
    ...(reason === undefined ? {} : { reason }),
    ...(remoteOperationId === undefined ? {} : { remoteOperationId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(transportCode === undefined ? {} : { transportCode })
  }
}

const statusForFailure = (error: CliError): OperationStatus =>
  [
    'ACCOUNT_PROTOCOL_ERROR',
    'API_CONNECTION_ERROR',
    'API_PROTOCOL_ERROR',
    'CALL_REGISTRY_PROTOCOL_ERROR',
    'COMMAND_INTERRUPTED',
    'COMMAND_TIMED_OUT',
    'PROJECT_OPERATION_OUTCOME_UNKNOWN',
    'PROJECT_PROTOCOL_ERROR',
    'TEN_DLC_PROTOCOL_ERROR',
    'UNEXPECTED_ERROR'
  ].includes(error.code)
    ? 'outcome-unknown'
    : 'failed'

const isTerminalClientFailure = (error: CliError): boolean =>
  error.httpStatus !== undefined &&
  error.httpStatus >= 400 &&
  error.httpStatus < 500 &&
  ![401, 408, 409, 425, 429].includes(error.httpStatus)

const canReplayFailure = (
  policy: OperationReplayPolicy,
  status: OperationStatus,
  error: CliError
): boolean => {
  if (policy === 'natural' && error.httpStatus === 404) {
    return true
  }
  if (
    policy === 'none' ||
    error.code.startsWith('OPERATION_') ||
    isTerminalClientFailure(error)
  ) {
    return false
  }
  return (
    status === 'outcome-unknown' ||
    error.retryable ||
    error.httpStatus === 401 ||
    error.code === 'UPSTREAM_UNAVAILABLE'
  )
}

const shouldRetainFailure = (
  error: CliError,
  status: OperationStatus,
  replayable: boolean
): boolean =>
  replayable ||
  status === 'outcome-unknown' ||
  error.retryable ||
  error.code.startsWith('OPERATION_') ||
  error.code === 'UPSTREAM_UNAVAILABLE' ||
  error.httpStatus === 401 ||
  (error.httpStatus !== undefined && error.httpStatus >= 500)

// A journal that outlives the run replays the operation. Without one, as
// with a key from the environment, the retry is the same command, with the
// same idempotency key when the write has one, or the caller's `retry` step
// when its command can't take the key.
const replayStep = (
  record: OperationRecord,
  persistent: boolean,
  retry: OperationExecuteOptions['retry']
): NextStep => {
  if (persistent) {
    return {
      description: 'Replay the operation',
      run: `${CLI_NAME} operation replay ${record.operationId}`
    }
  }
  if (record.idempotencyKey === undefined) {
    return { description: 'Retry the same command' }
  }
  return (
    retry?.(record.idempotencyKey) ?? {
      description: `Retry the same command with --idempotency-key ${record.idempotencyKey}`
    }
  )
}

const replayNext = (
  error: CliError,
  record: OperationRecord,
  replayable: boolean,
  persistent: boolean,
  retry?: OperationExecuteOptions['retry']
): readonly NextStep[] =>
  replayable
    ? [...error.next, replayStep(record, persistent, retry)]
    : error.next

const organizationInput = (
  organizationId: string | undefined
): { organizationId?: string } =>
  organizationId === undefined ? {} : { organizationId }

const safeInput = (intent: OperationIntent): Record<string, unknown> => {
  if (isInternalIntent(intent)) {
    return internalSafeInput(intent)
  }
  switch (intent.kind) {
    case 'account-service-key.create':
      return {
        expiresAt: intent.expiresAt ?? null,
        name: intent.name
      }
    case 'account-service-key.revoke':
      return { serviceKeyId: intent.serviceKeyId }
    case 'account-avatar.reset':
      return {}
    case 'account-avatar.upload':
      return {
        contentType: intent.contentType,
        fileName: intent.fileName,
        phase: intent.phase
      }
    case 'account.update':
      return { changes: intent.changes }
    case 'agent-avatar.reset':
      return { projectId: intent.projectId }
    case 'agent-avatar.upload':
      return {
        contentType: intent.contentType,
        fileName: intent.fileName,
        phase: intent.phase,
        projectId: intent.projectId
      }
    case 'agent-profile.update':
      return { changes: intent.changes, projectId: intent.projectId }
    case 'api-key.create':
      return {
        expiresAt: intent.expiresAt ?? null,
        ...(intent.permissions === undefined
          ? {}
          : { permissions: intent.permissions }),
        name: intent.name,
        projectId: intent.projectId
      }
    case 'api-key.revoke':
      return { apiKeyId: intent.apiKeyId, projectId: intent.projectId }
    case 'webhook-destination.create':
      return {
        apiVersion: intent.apiVersion,
        description: intent.description ?? null,
        enabledEvents: intent.enabledEvents,
        name: intent.name,
        projectId: intent.projectId,
        status: intent.status,
        url: intent.url
      }
    case 'webhook-destination.delete':
      return {
        destinationId: intent.destinationId,
        projectId: intent.projectId
      }
    case 'webhook-destination.update':
      return {
        changes: intent.changes,
        destinationId: intent.destinationId,
        projectId: intent.projectId
      }
    case 'webhook-signing-secret.rotate':
      return {
        destinationId: intent.destinationId,
        overlapSeconds: intent.overlapSeconds,
        projectId: intent.projectId
      }
    case 'assignment.create':
      return { input: intent.input, projectId: intent.projectId }
    case 'assignment.release':
      return {
        assignmentId: intent.assignmentId,
        projectId: intent.projectId
      }
    case 'billing.plan.purchase':
      return {
        category: intent.category,
        planCode: intent.planCode,
        projectId: intent.projectId
      }
    case 'billing.subscription.cancel':
    case 'billing.subscription.resume':
      return { category: intent.category, projectId: intent.projectId }
    case 'email-domain.connect':
      return { domain: intent.domain, projectId: intent.projectId }
    case 'email-domain.disconnect':
    case 'telegram-bot.disconnect':
      return { projectId: intent.projectId, resourceId: intent.resourceId }
    case 'telegram-bot.connect':
      return { projectId: intent.projectId }
    case 'invitation.accept':
      return { tokenStored: true }
    case 'invitation.revoke':
      return {
        invitationId: intent.invitationId,
        projectId: intent.projectId
      }
    case 'imessage-dedicated-line.purchase':
      return { projectId: intent.projectId }
    case 'organization-invitation.accept':
      return { tokenStored: true }
    case 'organization-invitation.revoke':
      return {
        invitationId: intent.invitationId,
        organizationId: intent.organizationId
      }
    case 'organization-member.invite':
      return {
        email: intent.email,
        organizationId: intent.organizationId,
        role: intent.role
      }
    case 'organization-member.remove':
      return {
        accountId: intent.accountId,
        expectedVersion: intent.expectedVersion,
        organizationId: intent.organizationId
      }
    case 'organization-member.update':
      return {
        accountId: intent.accountId,
        expectedVersion: intent.expectedVersion,
        organizationId: intent.organizationId,
        role: intent.role
      }
    case 'organization.leave':
      return {
        expectedVersion: intent.expectedVersion,
        organizationId: intent.organizationId
      }
    case 'member.invite':
      return {
        email: intent.email,
        projectId: intent.projectId,
        role: intent.role
      }
    case 'member.remove':
      return { accountId: intent.accountId, projectId: intent.projectId }
    case 'member.update':
      return {
        accountId: intent.accountId,
        projectId: intent.projectId,
        role: intent.role
      }
    case 'project.create':
      return {
        activate: intent.activate,
        name: intent.name,
        ...organizationInput(intent.organizationId),
        ...(intent.slug === undefined ? {} : { slug: intent.slug })
      }
    case 'project.delete':
    case 'project.leave':
      return { projectId: intent.projectId }
    case 'project.update':
      return { name: intent.name, projectId: intent.projectId }
    case 'sms-number.delete':
    case 'whatsapp-business-number.delete':
      return { projectId: intent.projectId, resourceId: intent.resourceId }
    case 'voice-profile-outbound.enable':
      return {
        digestAlgorithm: intent.digestAlgorithm,
        expectedVersion: intent.expectedVersion,
        profileId: intent.profileId,
        profileReference: intent.profileReference,
        projectId: intent.projectId
      }
    case 'voice-profile-outbound.rotate':
      return {
        expectedVersion: intent.expectedVersion,
        mode: intent.mode,
        profileId: intent.profileId,
        profileReference: intent.profileReference,
        projectId: intent.projectId
      }
    case 'whatsapp-business-number.provision':
      return {
        displayName: intent.displayName ?? null,
        projectId: intent.projectId,
        voipResourceId: intent.voipResourceId,
        wabaId: intent.wabaId
      }
    case 'sms-number.purchase':
      return {
        projectId: intent.projectId,
        ...(intent.input === undefined ? {} : { input: intent.input })
      }
    default:
      throw new CliError(
        'OPERATION_JOURNAL_CORRUPT',
        'The local operation has an unsupported kind.'
      )
  }
}

type RemoteReleaseIntent = Extract<
  OperationIntent,
  {
    kind:
      | 'email-domain.disconnect'
      | 'sms-number.delete'
      | 'telegram-bot.disconnect'
      | 'whatsapp-business-number.delete'
  }
>

const isRemoteReleaseIntent = (
  intent: OperationIntent
): intent is RemoteReleaseIntent =>
  intent.kind === 'email-domain.disconnect' ||
  intent.kind === 'sms-number.delete' ||
  intent.kind === 'telegram-bot.disconnect' ||
  intent.kind === 'whatsapp-business-number.delete'

const REMOTE_OPERATION_RELEASES: ReadonlySet<OperationKind> = new Set([
  'email-domain.disconnect',
  'sms-number.delete',
  'telegram-bot.disconnect',
  'whatsapp-business-number.delete'
])

const naturalNotFoundResult = (intent: OperationIntent): object => {
  switch (intent.kind) {
    case 'assignment.release':
      return { assignmentId: intent.assignmentId, released: true }
    case 'email-domain.disconnect':
    case 'telegram-bot.disconnect':
      return { disconnected: true, resourceId: intent.resourceId }
    case 'project.delete':
      return { deleted: true, projectId: intent.projectId }
    case 'sms-number.delete':
      return { deleted: true, resourceId: intent.resourceId }
    case 'whatsapp-business-number.delete':
      return { deleted: true, resourceId: intent.resourceId }
    case 'webhook-destination.delete':
      return { deleted: true, destinationId: intent.destinationId }
    default:
      throw new CliError(
        'OPERATION_JOURNAL_CORRUPT',
        'The local operation cannot converge from a not-found response.'
      )
  }
}

// The journal doesn't record the folder "project create --link" ran in, so
// its replay saves no folder file and gives the step that does.
const linkStep = (
  intent: OperationIntent,
  result: object
): { next?: readonly NextStep[] } =>
  intent.kind === 'project.create' &&
  intent.activate === true &&
  'project' in result &&
  typeof result.project === 'object' &&
  result.project !== null &&
  'projectId' in result.project &&
  typeof result.project.projectId === 'string'
    ? {
        next: [
          {
            description: 'Save the project for this folder',
            run: `${CLI_NAME} link --project ${result.project.projectId}`
          }
        ]
      }
    : {}

const replayableAt = (record: OperationRecord, now: number): boolean =>
  record.replayable &&
  (record.replayExpiresAt === undefined ||
    Date.parse(record.replayExpiresAt) > now)

const summary = (record: OperationRecord, now: number): OperationSummary => ({
  kind: record.intent.kind,
  operationId: record.operationId,
  replayable: replayableAt(record, now),
  status: record.status,
  updatedAt: record.updatedAt
})

const view = (record: OperationRecord, now: number): OperationView => ({
  ...summary(record, now),
  attemptCount: record.attemptCount,
  command: OPERATION_DEFINITIONS[record.intent.kind].command,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  ...(record.idempotencyKey === undefined
    ? {}
    : { idempotencyKey: record.idempotencyKey }),
  input: safeInput(record.intent),
  ...(record.failure === undefined ? {} : { failure: record.failure }),
  ...(record.remoteOperationId === undefined
    ? {}
    : { remoteOperationId: record.remoteOperationId }),
  ...(record.replayExpiresAt === undefined
    ? {}
    : { replayExpiresAt: record.replayExpiresAt })
})

const encodeCursor = (record: OperationRecord): string =>
  Buffer.from(
    JSON.stringify({
      operationId: record.operationId,
      updatedAt: record.updatedAt
    } satisfies PageCursor)
  ).toString('base64url')

const decodeCursor = (value: string): PageCursor => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString()
    ) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'operationId' in parsed &&
      typeof parsed.operationId === 'string' &&
      OPERATION_ID_PATTERN.test(parsed.operationId) &&
      'updatedAt' in parsed &&
      typeof parsed.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.updatedAt))
    ) {
      return {
        operationId: parsed.operationId,
        updatedAt: parsed.updatedAt
      }
    }
  } catch {
    // The stable argument error below intentionally omits parser internals.
  }
  throw new CliError(
    'ARGUMENT_VALIDATION',
    'The command contains invalid input.',
    { detail: 'Page token is invalid.', exitCode: 2 }
  )
}

const occursAfterCursor = (
  record: OperationRecord,
  cursor: PageCursor
): boolean =>
  record.updatedAt < cursor.updatedAt ||
  (record.updatedAt === cursor.updatedAt &&
    record.operationId < cursor.operationId)

export const billingRejection = (
  operation: GetBillingOperationOutput,
  message = 'The plan purchase failed.'
): CliError | undefined => {
  if (operation.status.toLowerCase() !== 'failed') {
    return
  }
  const { failure } = operation
  return new CliError('BILLING_OPERATION_REJECTED', message, {
    ...(failure?.detail === null || failure?.detail === undefined
      ? {}
      : { detail: failure.detail }),
    next: [
      {
        description:
          'Correct the billing problem, then start a new purchase with a new idempotency key.'
      }
    ],
    reason: failure?.code ?? 'failed',
    remoteOperationId: operation.operationId,
    retryable: failure?.retryable ?? false
  })
}

export class OperationService {
  readonly #account: AccountService
  readonly #beforeWrite: (intent: OperationIntent) => void
  readonly #internal: InternalCommandServices
  readonly #now: () => number
  readonly #organizationContext: OrganizationContextService
  readonly #organizations: OrganizationService
  readonly #projectContext: ProjectContextService
  readonly #projects: ProjectService
  readonly #repository: OperationJournal
  readonly #voice: VoiceService
  readonly #warning: (message: string) => void

  constructor(options: OperationServiceOptions) {
    this.#account = options.account
    this.#beforeWrite = options.beforeWrite ?? (() => undefined)
    this.#internal = options.internal
    this.#now = options.now ?? Date.now
    this.#organizationContext = options.organizationContext
    this.#organizations = options.organizations
    this.#projectContext = options.projectContext
    this.#projects = options.projects
    this.#repository = options.repository
    this.#voice = options.voice
    this.#warning = options.warning ?? (() => undefined)
  }

  async execute<Result>(
    intent: OperationIntent,
    suppliedIdempotencyKey: string | undefined,
    action: (context: OperationExecutionContext) => Promise<Result>,
    options: OperationExecuteOptions = {}
  ): Promise<OperationExecution<Result>> {
    return await this.#execute(
      intent,
      suppliedIdempotencyKey,
      action,
      false,
      options.retry
    )
  }

  async executeAwaitingOutput<Result>(
    intent: OperationIntent,
    suppliedIdempotencyKey: string | undefined,
    action: (context: OperationExecutionContext) => Promise<Result>
  ): Promise<DeferredOperationExecution<Result>> {
    if (!OUTPUT_ACKNOWLEDGEMENT_KINDS.has(intent.kind)) {
      throw new CliError(
        'OPERATION_JOURNAL_CORRUPT',
        'This operation does not support deferred output acknowledgement.'
      )
    }
    return (await this.#execute(
      intent,
      suppliedIdempotencyKey,
      action,
      true
    )) as DeferredOperationExecution<Result>
  }

  async continuationIntent<Kind extends OperationKind>(
    kind: Kind,
    suppliedIdempotencyKey: string | undefined,
    matchesLogicalRequest: (
      intent: Extract<OperationIntent, { kind: Kind }>
    ) => boolean
  ): Promise<Extract<OperationIntent, { kind: Kind }> | undefined> {
    if (suppliedIdempotencyKey === undefined) {
      return
    }
    const idempotencyKey = validateIdempotencyKey(suppliedIdempotencyKey)
    const matched = (await this.#repository.listActive()).find(
      (candidate) => candidate.idempotencyKey === idempotencyKey
    )
    if (matched === undefined) {
      return
    }
    if (matched.intent.kind !== kind) {
      throw this.#idempotencyConflict(matched, idempotencyKey)
    }
    const intent = matched.intent as Extract<OperationIntent, { kind: Kind }>
    if (!matchesLogicalRequest(intent)) {
      throw this.#idempotencyConflict(matched, idempotencyKey)
    }
    this.#assertReplayable(matched)
    return intent
  }

  async #execute<Result>(
    intent: OperationIntent,
    suppliedIdempotencyKey: string | undefined,
    action: (context: OperationExecutionContext) => Promise<Result>,
    awaitOutputAcknowledgement: boolean,
    retry?: OperationExecuteOptions['retry']
  ): Promise<OperationExecution<Result> & { operationId?: string }> {
    const definition = OPERATION_DEFINITIONS[intent.kind]
    const idempotencyKey = effectiveIdempotencyKey(
      definition.replayPolicy,
      suppliedIdempotencyKey
    )
    const now = this.#now()
    const fingerprint = requestFingerprint(intent)
    let existing = false
    let record: OperationRecord
    try {
      const records = await this.#repository.listActive()
      const matched =
        suppliedIdempotencyKey === undefined
          ? undefined
          : records.find(
              (candidate) => candidate.idempotencyKey === idempotencyKey
            )
      if (matched === undefined) {
        record = await this.#newRecord(
          intent,
          definition.replayPolicy,
          idempotencyKey,
          now
        )
        await this.#repository.create(record)
      } else {
        if (matched.requestFingerprint !== fingerprint) {
          throw this.#idempotencyConflict(matched, idempotencyKey)
        }
        existing = true
        record = matched
      }
    } catch (error) {
      if (
        error instanceof CliError &&
        [
          'ARGUMENT_VALIDATION',
          'IDEMPOTENCY_KEY_REUSED',
          'NOT_AUTHENTICATED',
          'OPERATION_JOURNAL_CORRUPT',
          'OPERATION_SCOPE_MISMATCH'
        ].includes(error.code)
      ) {
        throw error
      }
      // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
      throw new CliError(
        'OPERATION_PERSISTENCE_FAILED',
        'Photon could not safely record the operation before sending it.',
        {
          cause: error,
          detail: 'No mutation request was sent.',
          next: [
            {
              description:
                'Check the Photon configuration directory permissions, then retry.'
            }
          ]
        }
      )
    }
    return await this.#repository.withReplayLease(
      record.operationId,
      async () => {
        let activeRecord = record
        if (existing) {
          activeRecord = await this.#repository.get(record.operationId)
          if (activeRecord.requestFingerprint !== fingerprint) {
            throw this.#idempotencyConflict(activeRecord, idempotencyKey)
          }
          this.#assertReplayable(activeRecord)
          activeRecord = await this.#beginAttempt(activeRecord)
        }
        this.#beforeWrite(activeRecord.intent)
        return await this.#runRecord(
          activeRecord,
          action,
          awaitOutputAcknowledgement,
          retry
        )
      }
    )
  }

  async #beginAttempt(record: OperationRecord): Promise<OperationRecord> {
    const startedAt = this.#now()
    const { failure: _failure, ...withoutFailure } = record
    const started: OperationRecord = {
      ...withoutFailure,
      attemptCount: record.attemptCount + 1,
      expiresAt: this.#repository.expiresAt(startedAt),
      replayable: record.replayPolicy !== 'none',
      status: 'outcome-unknown',
      updatedAt: new Date(startedAt).toISOString()
    }
    await this.#repository.update(started)
    return started
  }

  async #recordRemoteOperationId(
    record: OperationRecord,
    remoteOperationId: string
  ): Promise<OperationRecord> {
    if (boundedIdentifier(remoteOperationId) !== remoteOperationId) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid remote operation ID.'
      )
    }
    if (
      record.remoteOperationId !== undefined &&
      record.remoteOperationId !== remoteOperationId
    ) {
      throw new CliError(
        'OPERATION_JOURNAL_CORRUPT',
        'A local operation cannot change its remote operation ID.'
      )
    }
    if (record.remoteOperationId === remoteOperationId) {
      return record
    }
    const updated = {
      ...record,
      remoteOperationId,
      updatedAt: new Date(this.#now()).toISOString()
    }
    await this.#repository.update(updated)
    return updated
  }

  async #runRecord<Result>(
    initialRecord: OperationRecord,
    action: (context: OperationExecutionContext) => Promise<Result>,
    awaitOutputAcknowledgement: boolean,
    retry?: OperationExecuteOptions['retry']
  ): Promise<OperationExecution<Result> & { operationId?: string }> {
    let record = initialRecord
    const updateIntent = async (nextIntent: OperationIntent): Promise<void> => {
      if (nextIntent.kind !== record.intent.kind) {
        throw new CliError(
          'OPERATION_JOURNAL_CORRUPT',
          'An operation cannot change kind while it is running.'
        )
      }
      record = {
        ...record,
        intent: nextIntent,
        requestFingerprint: requestFingerprint(nextIntent),
        updatedAt: new Date(this.#now()).toISOString()
      }
      await this.#repository.update(record)
    }
    const updateRemoteOperationId = async (
      remoteOperationId: string
    ): Promise<void> => {
      record = await this.#recordRemoteOperationId(record, remoteOperationId)
    }

    try {
      const result = await action({
        updateIntent,
        updateRemoteOperationId,
        ...(record.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: record.idempotencyKey })
      })
      if (awaitOutputAcknowledgement) {
        const { failure: _failure, ...withoutFailure } = record
        record = {
          ...withoutFailure,
          replayable: true,
          status: 'awaiting-output-ack',
          updatedAt: new Date(this.#now()).toISOString()
        }
        await this.#repository.update(record)
        return { operationId: record.operationId, result }
      }
      await this.#cleanup(record.operationId)
      return { result }
    } catch (error) {
      throw await this.#recordFailure(record, error, retry)
    }
  }

  async executeAvatarUpload(
    projectId: string,
    filePath: string,
    suppliedIdempotencyKey: string | undefined
  ): Promise<
    OperationExecution<Awaited<ReturnType<ProjectService['uploadAgentAvatar']>>>
  > {
    const file = await prepareAvatarFile(filePath)
    const initialIntent: OperationIntent = {
      contentType: file.contentType,
      fileContents: file.encodedContents,
      fileDigest: file.digest,
      fileName: safeFileName(file.fileName),
      kind: 'agent-avatar.upload',
      phase: 'upload',
      projectId
    }
    return await this.execute(
      initialIntent,
      suppliedIdempotencyKey,
      async ({ idempotencyKey, updateIntent }) =>
        await this.#projects.uploadAgentAvatar(
          projectId,
          file,
          idempotencyKey,
          async (uploadId) => {
            await updateIntent({
              ...initialIntent,
              fileContents: undefined,
              phase: 'commit',
              uploadId
            })
          }
        )
    )
  }

  async executeAccountAvatarUpload(
    filePath: string,
    suppliedIdempotencyKey: string | undefined
  ): Promise<
    OperationExecution<Awaited<ReturnType<AccountService['uploadAvatar']>>>
  > {
    const file = await prepareAvatarFile(filePath)
    const initialIntent: OperationIntent = {
      contentType: file.contentType,
      fileContents: file.encodedContents,
      fileDigest: file.digest,
      fileName: safeFileName(file.fileName),
      kind: 'account-avatar.upload',
      phase: 'upload'
    }
    return await this.execute(
      initialIntent,
      suppliedIdempotencyKey,
      async ({ idempotencyKey, updateIntent }) =>
        await this.#account.uploadAvatar(
          file,
          idempotencyKey,
          async (uploadId) => {
            await updateIntent({
              ...initialIntent,
              fileContents: undefined,
              phase: 'commit',
              uploadId
            })
          }
        )
    )
  }

  async list(options: OperationListOptions = {}): Promise<{
    nextCursor?: string
    operations: OperationSummary[]
  }> {
    const limit = options.limit ?? 30
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAXIMUM_OPERATION_LIST_LIMIT
    ) {
      throw new CliError(
        'ARGUMENT_VALIDATION',
        'The command contains invalid input.',
        {
          detail: `Limit must be an integer from 1 to ${MAXIMUM_OPERATION_LIST_LIMIT.toString()}.`,
          exitCode: 2
        }
      )
    }
    const statuses = new Set(options.statuses ?? [])
    const cursor =
      options.pageToken === undefined
        ? undefined
        : decodeCursor(options.pageToken)
    const records = (await this.#repository.listActive()).filter(
      (record) =>
        (statuses.size === 0 || statuses.has(record.status)) &&
        (cursor === undefined || occursAfterCursor(record, cursor))
    )
    const selected = records.slice(0, limit)
    const hasMore = records.length > selected.length
    const last = selected.at(-1)
    return {
      operations: selected.map((record) => summary(record, this.#now())),
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor(last) }
        : {})
    }
  }

  async view(operationId: string): Promise<OperationView> {
    return view(await this.#repository.get(operationId), this.#now())
  }

  /**
   * Writes a one-time result, then deletes its record. When the write fails,
   * the record stays `awaiting-output-ack`, and the error names the step
   * that prints the same result again.
   */
  async deliverOutput(
    operationId: string,
    write: () => Promise<void>
  ): Promise<void> {
    try {
      await write()
    } catch (error) {
      const record = await this.#repository.get(operationId)
      const { persistent } = this.#repository
      // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
      throw new CliError(
        'OUTPUT_WRITE_FAILED',
        'Photon could not write the result to standard output.',
        {
          cause: error,
          detail:
            'Photon made the change, but its result may not have been written.',
          ...(record.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: record.idempotencyKey }),
          next: [replayStep(record, persistent, undefined)],
          operationId: persistent ? operationId : undefined,
          replayable: persistent ? true : undefined
        }
      )
    }
    await this.acknowledgeOutput(operationId)
  }

  async acknowledgeOutput(operationId: string): Promise<void> {
    await this.#repository.withReplayLease(operationId, async () => {
      const record = await this.#repository.get(operationId)
      if (record.status !== 'awaiting-output-ack') {
        throw new CliError(
          'OPERATION_ACKNOWLEDGEMENT_INVALID',
          'This operation is not waiting for output acknowledgement.',
          {
            next: [
              {
                description:
                  'View the operation before changing the local record',
                run: `${CLI_NAME} operation view ${operationId}`
              }
            ],
            operationId
          }
        )
      }
      if (!(await this.#repository.remove(operationId))) {
        throw new CliError(
          'OPERATION_STORAGE_UNAVAILABLE',
          'Photon could not acknowledge the operation output.',
          { operationId, replayable: true }
        )
      }
    })
  }

  async remove(operationId: string): Promise<boolean> {
    const removed = await this.#repository.remove(operationId)
    if (!removed) {
      throw new CliError(
        'OPERATION_NOT_FOUND',
        'The local operation does not exist.',
        {
          next: [
            {
              description: 'List local operations',
              run: `${CLI_NAME} operation list`
            }
          ],
          operationId
        }
      )
    }
    return true
  }

  assertReplayable(operation: OperationView): void {
    this.#assertReplayableState(operation)
  }

  async replay(operationId: string): Promise<{
    next?: readonly NextStep[]
    operation: ReplayedOperation
    result: object
  }> {
    return await this.#repository.withReplayLease(operationId, async () => {
      let record = await this.#repository.get(operationId)
      this.#assertReplayable(record)
      assertCurrentOperationContract(record)
      if (
        record.status === 'awaiting-output-ack' &&
        record.intent.kind === 'account-service-key.revoke'
      ) {
        return {
          operation: {
            kind: record.intent.kind,
            operationId: record.operationId,
            status: 'awaiting-output-ack'
          },
          result: {
            revoked: true,
            serviceKeyId: record.intent.serviceKeyId
          }
        }
      }
      record = await this.#beginAttempt(record)

      const updateIntent = async (intent: OperationIntent): Promise<void> => {
        record = {
          ...record,
          intent,
          requestFingerprint: requestFingerprint(intent),
          updatedAt: new Date(this.#now()).toISOString()
        }
        await this.#repository.update(record)
      }
      const updateRemoteOperationId = async (
        remoteOperationId: string
      ): Promise<void> => {
        record = await this.#recordRemoteOperationId(record, remoteOperationId)
      }

      try {
        const result = await this.#dispatch(
          record,
          updateIntent,
          updateRemoteOperationId
        )
        if (OUTPUT_ACKNOWLEDGEMENT_KINDS.has(record.intent.kind)) {
          const { failure: _failure, ...withoutFailure } = record
          record = {
            ...withoutFailure,
            replayable: true,
            status: 'awaiting-output-ack',
            updatedAt: new Date(this.#now()).toISOString()
          }
          await this.#repository.update(record)
          return {
            operation: {
              kind: record.intent.kind,
              operationId: record.operationId,
              status: 'awaiting-output-ack'
            },
            result
          }
        }
        await this.#cleanup(record.operationId)
        return {
          ...linkStep(record.intent, result),
          operation: {
            kind: record.intent.kind,
            operationId: record.operationId,
            status: 'resolved'
          },
          result
        }
      } catch (error) {
        if (
          error instanceof CliError &&
          error.httpStatus === 404 &&
          (record.intent.kind === 'project.delete' ||
            record.intent.kind === 'assignment.release' ||
            record.intent.kind === 'email-domain.disconnect' ||
            record.intent.kind === 'sms-number.delete' ||
            record.intent.kind === 'telegram-bot.disconnect' ||
            record.intent.kind === 'whatsapp-business-number.delete' ||
            record.intent.kind === 'webhook-destination.delete')
        ) {
          const { intent } = record
          if (isRemoteReleaseIntent(intent)) {
            await this.#confirmRelease(record, intent)
          }
          if (record.intent.kind === 'project.delete') {
            await this.#projectContext
              .clearIfActive(record.intent.projectId)
              .catch(() => {
                this.#warning(
                  'The project is deleted, but Photon could not remove the .photon/project.json that names it.'
                )
              })
          }
          await this.#cleanup(record.operationId)
          return {
            operation: {
              kind: record.intent.kind,
              operationId: record.operationId,
              status: 'resolved'
            },
            result: naturalNotFoundResult(record.intent)
          }
        }
        throw await this.#recordFailure(record, error)
      }
    })
  }

  // A release records its remote operation ID only after Photon accepts it,
  // so a 404 while the record holds one came from the operation lookup and
  // says nothing about the resource. Other kinds have no remote operation.
  async #confirmRelease(
    record: OperationRecord,
    intent: RemoteReleaseIntent
  ): Promise<void> {
    const { remoteOperationId, ...withoutRemoteOperationId } = record
    if (remoteOperationId === undefined) {
      return
    }
    let released: boolean
    try {
      released = await this.#isReleased(intent)
    } catch (error) {
      throw await this.#recordFailure(record, error)
    }
    if (released) {
      return
    }
    throw await this.#recordFailure(
      withoutRemoteOperationId,
      new CliError(
        'PROJECT_OPERATION_OUTCOME_UNKNOWN',
        'The outcome of the operation is unknown.',
        {
          detail: `Photon has no record of remote operation ${remoteOperationId}, and the resource still exists. Replay sends the release request again.`
        }
      )
    )
  }

  async #isReleased(intent: RemoteReleaseIntent): Promise<boolean> {
    switch (intent.kind) {
      case 'email-domain.disconnect':
        return await this.#projects.isEmailDomainDisconnected(
          intent.projectId,
          intent.resourceId
        )
      case 'sms-number.delete':
        return await this.#projects.isSmsNumberReleased(
          intent.projectId,
          intent.resourceId
        )
      case 'telegram-bot.disconnect':
        return await this.#projects.isTelegramBotDisconnected(
          intent.projectId,
          intent.resourceId
        )
      default:
        return await this.#projects.isWhatsappBusinessNumberReleased(
          intent.projectId,
          intent.resourceId
        )
    }
  }

  async #newRecord(
    intent: OperationIntent,
    replayPolicy: OperationReplayPolicy,
    idempotencyKey: string | undefined,
    now: number
  ): Promise<OperationRecord> {
    const fingerprint = requestFingerprint(intent)
    const timestamp = new Date(now).toISOString()
    const metadata = await this.#repositoryIdentity()
    return {
      apiOrigin: metadata.apiOrigin,
      attemptCount: 1,
      createdAt: timestamp,
      ...(metadata.credentialKind === 'account_service_key'
        ? { credentialKind: metadata.credentialKind }
        : {}),
      expiresAt: this.#repository.expiresAt(now),
      identityId: metadata.identityId,
      intent,
      operationId: `op_${randomUUID()}`,
      replayable: replayPolicy !== 'none',
      replayPolicy,
      requestFingerprint: fingerprint,
      status: 'outcome-unknown',
      updatedAt: timestamp,
      ...(intent.kind === 'account-service-key.create'
        ? {
            replayExpiresAt: new Date(
              now + ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS
            ).toISOString()
          }
        : {}),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey })
    }
  }

  #idempotencyConflict(
    existing: OperationRecord,
    idempotencyKey: string | undefined
  ): CliError {
    return new CliError(
      'IDEMPOTENCY_KEY_REUSED',
      'The idempotency key is already associated with a different request.',
      {
        detail: `Operation ${existing.operationId} has a different payload fingerprint.`,
        exitCode: 2,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        next: [
          {
            description:
              'Use a new idempotency key for a different logical request.'
          }
        ],
        operationId: existing.operationId,
        replayable: existing.replayable
      }
    )
  }

  async #repositoryIdentity(): Promise<{
    apiOrigin: string
    credentialKind: 'account_service_key' | 'device' | 'environment'
    identityId: string
  }> {
    // Repository scope validation is authoritative. A provisional record is
    // populated by asking the repository for its scoped identity fields.
    return await this.#repository.identity()
  }

  async #cleanup(operationId: string): Promise<void> {
    try {
      await this.#repository.remove(operationId)
    } catch {
      this.#warning(
        `Photon could not remove resolved local operation ${operationId}.`
      )
    }
  }

  async #recordFailure(
    record: OperationRecord,
    error: unknown,
    retry?: OperationExecuteOptions['retry']
  ): Promise<CliError> {
    const normalized = normalizeCliError(error)
    const status = statusForFailure(normalized)
    const replayable = canReplayFailure(record.replayPolicy, status, normalized)
    if (!shouldRetainFailure(normalized, status, replayable)) {
      await this.#cleanup(record.operationId)
      return copyCliError(normalized, {
        idempotencyKey: undefined,
        next: replayNext(
          normalized,
          record,
          false,
          this.#repository.persistent
        ),
        operationId: undefined,
        replayable: undefined
      })
    }
    const { persistent } = this.#repository
    const enhanced = copyCliError(normalized, {
      ...(record.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: record.idempotencyKey }),
      next: replayNext(normalized, record, replayable, persistent, retry),
      operationId: persistent ? record.operationId : undefined,
      replayable: persistent ? replayable : undefined
    })
    const failedAt = this.#now()
    const updatedAt = new Date(failedAt).toISOString()
    const remoteOperationId = REMOTE_OPERATION_RELEASES.has(record.intent.kind)
      ? undefined
      : boundedIdentifier(enhanced.remoteOperationId)
    const failedRecord: OperationRecord = {
      ...record,
      expiresAt: this.#repository.expiresAt(failedAt),
      failure: failureSnapshot(enhanced),
      replayable,
      status,
      updatedAt,
      ...(remoteOperationId === undefined ? {} : { remoteOperationId })
    }
    try {
      await this.#repository.update(failedRecord)
    } catch (persistenceCause) {
      return await this.#handleFailurePersistenceError(
        record,
        enhanced,
        failedAt,
        persistenceCause
      )
    }
    return enhanced
  }

  async #handleFailurePersistenceError(
    record: OperationRecord,
    originalError: CliError,
    failedAt: number,
    persistenceCause: unknown
  ): Promise<CliError> {
    const persistenceError = new CliError(
      'OPERATION_PERSISTENCE_FAILED',
      'Photon could not safely persist the operation failure.',
      {
        cause: new AggregateError(
          [originalError, persistenceCause],
          'The operation and its journal update both failed.'
        ),
        debugSafe: originalError.debugSafe,
        detail: `The request failed with ${originalError.code}, but Photon could not persist its failure details.`,
        ...(record.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: record.idempotencyKey }),
        next: [
          {
            description:
              'Check the server-side state before retrying the original command.'
          },
          {
            description:
              'Fix the Photon configuration directory before using operation replay.'
          }
        ],
        operationId: record.operationId,
        replayable: false
      }
    )
    const blockedRecord: OperationRecord = {
      ...record,
      expiresAt: this.#repository.expiresAt(failedAt),
      failure: failureSnapshot(persistenceError),
      remoteOperationId: undefined,
      replayable: false,
      status: 'failed',
      updatedAt: new Date(failedAt).toISOString()
    }
    try {
      await this.#repository.update(blockedRecord)
      return persistenceError
    } catch (blockingCause) {
      try {
        await this.#repository.remove(record.operationId)
        return copyCliError(persistenceError, {
          cause: new AggregateError(
            [originalError, persistenceCause, blockingCause],
            'Photon removed the stale journal record after its failure updates failed.'
          ),
          detail:
            `${persistenceError.detail ?? ''} The stale local record was removed to prevent replay.`.trim(),
          next: [
            {
              description:
                'Check the server-side state before starting the operation again.'
            },
            {
              description:
                'Reuse the displayed idempotency key only for the identical request payload.'
            }
          ]
        })
      } catch (removalCause) {
        this.#warning(
          `Photon could not block or remove stale local operation ${record.operationId}.`
        )
        return copyCliError(persistenceError, {
          cause: new AggregateError(
            [originalError, persistenceCause, blockingCause, removalCause],
            'Photon could not update or remove the stale journal record.'
          ),
          detail:
            `${persistenceError.detail ?? ''} The prior write-ahead record may be stale.`.trim(),
          next: [
            {
              description:
                'Do not replay this operation until you have checked its server-side result.'
            },
            {
              description:
                'After fixing the Photon configuration directory, remove the local record',
              run: `${CLI_NAME} operation remove ${record.operationId} --yes`
            }
          ]
        })
      }
    }
  }

  #assertReplayable(record: OperationRecord): void {
    this.#assertReplayableState(record)
  }

  #assertReplayableState(operation: {
    failure?: OperationFailureSnapshot | undefined
    operationId: string
    replayExpiresAt?: string | undefined
    replayable: boolean
    status: OperationStatus
  }): void {
    if (
      operation.replayExpiresAt !== undefined &&
      Date.parse(operation.replayExpiresAt) <= this.#now()
    ) {
      throw new CliError(
        'OPERATION_REPLAY_EXPIRED',
        'The safe server replay window for this operation has expired.',
        {
          detail:
            'Replaying now could create a second account service key instead of recovering the original result.',
          next: [
            {
              description:
                'Inspect the account service key list and revoke any uncertain key before starting a new create operation.'
            }
          ],
          operationId: operation.operationId,
          replayable: false
        }
      )
    }
    if (operation.replayable) {
      return
    }
    const reason = operation.failure?.reason
    throw new CliError(
      'OPERATION_NOT_REPLAYABLE',
      'This operation does not have a safe replay contract.',
      {
        ...(reason === undefined
          ? {
              detail:
                'The original request has a definitive result or uses an unkeyed mutation.'
            }
          : {
              detail: `The operation failed with reason "${reason}".`
            }),
        next: [
          {
            description:
              'Correct the underlying problem and run the original command as a new operation.'
          }
        ],
        operationId: operation.operationId,
        replayable: false
      }
    )
  }

  async #dispatch(
    record: OperationRecord,
    updateIntent: (intent: OperationIntent) => Promise<void>,
    updateRemoteOperationId: (operationId: string) => Promise<void>
  ): Promise<object> {
    const { intent } = record
    if (isInternalIntent(intent)) {
      return await dispatchInternalOperation(record, intent, this.#internal)
    }
    const accountResult = await this.#dispatchAccountOperation(
      record,
      updateIntent
    )
    if (accountResult !== undefined) {
      return accountResult
    }
    const agentResult = await this.#dispatchAgentOperation(record, updateIntent)
    if (agentResult !== undefined) {
      return agentResult
    }
    const projectResult = await this.#dispatchProjectOperation(record)
    if (projectResult !== undefined) {
      return projectResult
    }
    const membershipResult = await this.#dispatchMembershipOperation(record)
    if (membershipResult !== undefined) {
      return membershipResult
    }
    const webhookResult = await this.#dispatchWebhookOperation(record)
    if (webhookResult !== undefined) {
      return webhookResult
    }
    const resourceResult = await this.#dispatchResourceOperation(
      record,
      updateRemoteOperationId
    )
    if (resourceResult !== undefined) {
      return resourceResult
    }
    switch (intent.kind) {
      case 'api-key.create':
        if (intent.permissions === undefined) {
          throw legacyContractError(
            'API key creation now requires explicit permissions. Inspect existing keys before starting a new create operation.'
          )
        }
        return withSafeApiKeySecret(
          await this.#projects.createApiKey(
            intent.projectId,
            {
              name: intent.name,
              permissions: intent.permissions,
              ...(intent.expiresAt === undefined
                ? {}
                : { expiresAt: intent.expiresAt })
            },
            requiredIdempotencyKey(record)
          )
        )
      case 'api-key.revoke':
        return await this.#projects.revokeApiKey(
          intent.projectId,
          intent.apiKeyId,
          requiredIdempotencyKey(record)
        )
      case 'billing.plan.purchase': {
        const operation = await this.#projects.purchasePlan(
          intent.projectId,
          intent.category,
          intent.planCode,
          requiredIdempotencyKey(record)
        )
        const rejected = billingRejection(operation)
        if (rejected !== undefined) {
          throw rejected
        }
        return operation
      }
      case 'assignment.create':
        return await this.#projects.createSharedLineAssignment(
          intent.projectId,
          {
            phoneNumber: intent.input.phoneNumber,
            ...(intent.input.email === undefined
              ? {}
              : { email: intent.input.email }),
            ...(intent.input.firstName === undefined
              ? {}
              : { firstName: intent.input.firstName }),
            ...(intent.input.lastName === undefined
              ? {}
              : { lastName: intent.input.lastName })
          },
          requiredIdempotencyKey(record)
        )
      case 'assignment.release':
        return await this.#projects.releaseSharedLineAssignment(
          intent.projectId,
          intent.assignmentId
        )
      case 'billing.subscription.cancel':
      case 'billing.subscription.resume':
        throw new CliError(
          'OPERATION_NOT_REPLAYABLE',
          'This unkeyed billing operation cannot be replayed safely.'
        )
      case 'voice-profile-outbound.enable':
        return withSafeOutboundPassword(
          await this.#voice.enableProfileOutbound(
            intent.projectId,
            intent.profileId,
            intent.expectedVersion,
            intent.digestAlgorithm,
            requiredIdempotencyKey(record)
          )
        )
      case 'voice-profile-outbound.rotate':
        return withSafeOutboundPassword(
          await this.#voice.rotateProfileOutbound(
            intent.projectId,
            intent.profileId,
            intent.expectedVersion,
            intent.mode,
            requiredIdempotencyKey(record)
          )
        )
      default:
        throw new CliError(
          'OPERATION_JOURNAL_CORRUPT',
          'The local operation has an unsupported kind.'
        )
    }
  }

  async #dispatchWebhookOperation(
    record: OperationRecord
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'webhook-destination.create':
        return withSafeWebhookSigningSecret(
          await this.#projects.createWebhookDestination(
            intent.projectId,
            {
              apiVersion: intent.apiVersion,
              ...(intent.description === undefined
                ? {}
                : { description: intent.description }),
              enabledEvents: intent.enabledEvents,
              name: intent.name,
              status: intent.status,
              url: intent.url
            },
            requiredIdempotencyKey(record)
          )
        )
      case 'webhook-destination.delete':
        return await this.#projects.deleteWebhookDestination(
          intent.projectId,
          intent.destinationId
        )
      case 'webhook-destination.update':
        return await this.#projects.updateWebhookDestination(
          intent.projectId,
          intent.destinationId,
          {
            ...(intent.changes.description === undefined
              ? {}
              : { description: intent.changes.description }),
            ...(intent.changes.enabledEvents === undefined
              ? {}
              : { enabledEvents: intent.changes.enabledEvents }),
            ...(intent.changes.name === undefined
              ? {}
              : { name: intent.changes.name }),
            ...(intent.changes.status === undefined
              ? {}
              : { status: intent.changes.status }),
            ...(intent.changes.url === undefined
              ? {}
              : { url: intent.changes.url })
          },
          requiredIdempotencyKey(record)
        )
      case 'webhook-signing-secret.rotate':
        return withSafeWebhookSigningSecret(
          await this.#projects.rotateWebhookSigningSecret(
            intent.projectId,
            intent.destinationId,
            intent.overlapSeconds,
            requiredIdempotencyKey(record)
          )
        )
      default:
        return
    }
  }

  async #dispatchTelegramOperation(
    record: OperationRecord,
    updateRemoteOperationId: (operationId: string) => Promise<void>
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'telegram-bot.connect': {
        const connection =
          record.remoteOperationId === undefined
            ? await this.#projects.connectTelegramBot(
                intent.projectId,
                requiredIdempotencyKey(record),
                updateRemoteOperationId
              )
            : await this.#projects.resumeTelegramBotConnection(
                intent.projectId,
                record.remoteOperationId
              )
        return connection.response
      }
      case 'telegram-bot.disconnect': {
        if (record.remoteOperationId !== undefined) {
          return await this.#projects.resumeTelegramBotDisconnection(
            intent.projectId,
            intent.resourceId,
            record.remoteOperationId
          )
        }
        return await this.#projects.disconnectTelegramBot(
          intent.projectId,
          intent.resourceId,
          updateRemoteOperationId
        )
      }
      default:
        return
    }
  }

  async #dispatchResourceOperation(
    record: OperationRecord,
    updateRemoteOperationId: (operationId: string) => Promise<void>
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'email-domain.connect': {
        const connection =
          record.remoteOperationId === undefined
            ? await this.#projects.connectEmailDomain(
                intent.projectId,
                intent.domain,
                requiredIdempotencyKey(record),
                updateRemoteOperationId
              )
            : await this.#projects.resumeEmailDomainConnection(
                intent.projectId,
                record.remoteOperationId
              )
        return connection.response
      }
      case 'email-domain.disconnect': {
        if (record.remoteOperationId !== undefined) {
          return await this.#projects.resumeEmailDomainDisconnection(
            intent.projectId,
            intent.resourceId,
            record.remoteOperationId
          )
        }
        return await this.#projects.disconnectEmailDomain(
          intent.projectId,
          intent.resourceId,
          updateRemoteOperationId
        )
      }
      case 'sms-number.delete': {
        if (record.remoteOperationId !== undefined) {
          return await this.#projects.resumeSmsNumberRelease(
            intent.projectId,
            intent.resourceId,
            record.remoteOperationId
          )
        }
        return await this.#projects.replaySmsNumberRelease(
          intent.projectId,
          intent.resourceId,
          updateRemoteOperationId
        )
      }
      case 'whatsapp-business-number.delete': {
        if (record.remoteOperationId !== undefined) {
          return await this.#projects.resumeWhatsappBusinessNumberRelease(
            intent.projectId,
            intent.resourceId,
            record.remoteOperationId
          )
        }
        return await this.#projects.replayWhatsappBusinessNumberRelease(
          intent.projectId,
          intent.resourceId,
          updateRemoteOperationId
        )
      }
      case 'whatsapp-business-number.provision':
        return await this.#dispatchWhatsappProvision(
          record,
          intent,
          updateRemoteOperationId
        )
      case 'sms-number.purchase':
        return record.remoteOperationId === undefined
          ? await this.#projects.purchaseSmsNumber(
              intent.projectId,
              intent.input ?? { countryCode: 'US' },
              requiredIdempotencyKey(record),
              updateRemoteOperationId
            )
          : await this.#projects.resumeResourceProvisioning(
              intent.projectId,
              record.remoteOperationId,
              'sms'
            )
      case 'imessage-dedicated-line.purchase':
        return record.remoteOperationId === undefined
          ? await this.#projects.provisionImessageDedicatedLine(
              intent.projectId,
              requiredIdempotencyKey(record),
              updateRemoteOperationId
            )
          : await this.#projects.resumeResourceProvisioning(
              intent.projectId,
              record.remoteOperationId,
              'imessage'
            )
      default:
        return await this.#dispatchTelegramOperation(
          record,
          updateRemoteOperationId
        )
    }
  }

  async #dispatchWhatsappProvision(
    record: OperationRecord,
    intent: Extract<
      OperationIntent,
      { kind: 'whatsapp-business-number.provision' }
    >,
    updateRemoteOperationId: (operationId: string) => Promise<void>
  ): Promise<object> {
    const provisioning =
      record.remoteOperationId === undefined
        ? await this.#projects.createWhatsappVoipSender(
            intent.projectId,
            intent.wabaId,
            {
              ...(intent.displayName === undefined
                ? {}
                : { displayName: intent.displayName }),
              voipResourceId: intent.voipResourceId
            },
            requiredIdempotencyKey(record),
            updateRemoteOperationId
          )
        : await this.#projects.resumeWhatsappVoipSenderProvisioning(
            intent.projectId,
            record.remoteOperationId
          )
    return provisioning.response
  }

  async #dispatchMembershipOperation(
    record: OperationRecord
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'member.invite':
      case 'member.update':
      case 'member.remove':
      case 'invitation.accept':
      case 'invitation.revoke':
      case 'project.leave':
        throw legacyMembershipError()
      case 'organization-member.invite':
        return await this.#organizations.createInvitation(
          intent.organizationId,
          intent.email,
          intent.role,
          requiredIdempotencyKey(record)
        )
      case 'organization-member.update':
        return await this.#organizations.updateMemberRole(
          intent.organizationId,
          intent.accountId,
          intent.role,
          intent.expectedVersion,
          requiredIdempotencyKey(record)
        )
      case 'organization-member.remove':
        return await this.#organizations.removeMember(
          intent.organizationId,
          intent.accountId,
          intent.expectedVersion,
          requiredIdempotencyKey(record)
        )
      case 'organization.leave': {
        const member = await this.#organizations.leave(
          intent.organizationId,
          intent.expectedVersion,
          requiredIdempotencyKey(record)
        )
        await this.#organizationContext
          .clearIfActive(intent.organizationId)
          .catch(() => {
            this.#warning(
              'You left the organization, but Photon could not clear the stored active organization.'
            )
          })
        return member
      }
      case 'organization-invitation.accept':
        return await this.#organizations.acceptInvitation(
          intent.token,
          requiredIdempotencyKey(record)
        )
      case 'organization-invitation.revoke':
        return await this.#organizations.revokeInvitation(
          intent.organizationId,
          intent.invitationId,
          requiredIdempotencyKey(record)
        )
      default:
        return
    }
  }

  async #dispatchProjectOperation(
    record: OperationRecord
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'project.create': {
        if (intent.slug === undefined) {
          throw legacyContractError(
            'Project creation now requires a slug. Inspect existing projects before starting a new create operation.'
          )
        }
        if (intent.organizationId === undefined) {
          throw legacyProjectCreateError()
        }
        const project = await this.#projects.create(
          intent.organizationId,
          intent.name,
          intent.slug,
          requiredIdempotencyKey(record)
        )
        return intent.activate ? { project } : project
      }
      case 'project.update':
        return await this.#projects.update(
          intent.projectId,
          intent.name,
          requiredIdempotencyKey(record)
        )
      case 'project.delete': {
        const project = await this.#projects.delete(intent.projectId)
        await this.#projectContext.clearIfActive(intent.projectId).catch(() => {
          this.#warning(
            'The project was deleted, but Photon could not remove the .photon/project.json that names it.'
          )
        })
        return project
      }
      default:
        return
    }
  }

  async #dispatchAccountOperation(
    record: OperationRecord,
    updateIntent: (intent: OperationIntent) => Promise<void>
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'account-service-key.create':
        return await this.#account.createServiceKey(
          {
            name: intent.name,
            ...(intent.expiresAt === undefined
              ? {}
              : { expiresAt: intent.expiresAt })
          },
          requiredIdempotencyKey(record)
        )
      case 'account-service-key.revoke':
        return await this.#account.revokeServiceKey(
          intent.serviceKeyId,
          requiredIdempotencyKey(record)
        )
      case 'account.update':
        return await this.#account.update(
          {
            ...(intent.changes.firstName === undefined
              ? {}
              : { firstName: intent.changes.firstName }),
            ...(intent.changes.lastName === undefined
              ? {}
              : { lastName: intent.changes.lastName })
          },
          requiredIdempotencyKey(record)
        )
      case 'account-avatar.upload':
        return await this.#dispatchAccountAvatar(record, intent, updateIntent)
      case 'account-avatar.reset':
        return await this.#account.resetAvatar(requiredIdempotencyKey(record))
      default:
        return
    }
  }

  async #dispatchAgentOperation(
    record: OperationRecord,
    updateIntent: (intent: OperationIntent) => Promise<void>
  ): Promise<object | undefined> {
    const { intent } = record
    switch (intent.kind) {
      case 'agent-profile.update':
        return await this.#projects.updateAgentProfile(
          intent.projectId,
          {
            ...(intent.changes.firstName === undefined
              ? {}
              : { firstName: intent.changes.firstName }),
            ...(intent.changes.lastName === undefined
              ? {}
              : { lastName: intent.changes.lastName })
          },
          requiredIdempotencyKey(record)
        )
      case 'agent-avatar.upload':
        return await this.#dispatchAvatar(record, intent, updateIntent)
      case 'agent-avatar.reset':
        return await this.#projects.resetAgentAvatar(
          intent.projectId,
          requiredIdempotencyKey(record)
        )
      default:
        return
    }
  }

  async #dispatchAccountAvatar(
    record: OperationRecord,
    intent: Extract<OperationIntent, { kind: 'account-avatar.upload' }>,
    updateIntent: (intent: OperationIntent) => Promise<void>
  ): Promise<object> {
    const key = requiredIdempotencyKey(record)
    if (intent.phase === 'commit') {
      if (intent.uploadId === undefined) {
        throw new CliError(
          'OPERATION_JOURNAL_CORRUPT',
          'A commit-phase avatar operation is missing its upload ID.'
        )
      }
      return await this.#account.commitAvatar(intent.uploadId, key)
    }
    return await this.#account.uploadAvatar(
      storedAvatarFile(intent),
      key,
      async (uploadId) => {
        await updateIntent({
          ...intent,
          fileContents: undefined,
          phase: 'commit',
          uploadId
        })
      }
    )
  }

  async #dispatchAvatar(
    record: OperationRecord,
    intent: Extract<OperationIntent, { kind: 'agent-avatar.upload' }>,
    updateIntent: (intent: OperationIntent) => Promise<void>
  ): Promise<object> {
    const key = requiredIdempotencyKey(record)
    if (intent.phase === 'commit') {
      if (intent.uploadId === undefined) {
        throw new CliError(
          'OPERATION_JOURNAL_CORRUPT',
          'A commit-phase avatar operation is missing its upload ID.'
        )
      }
      return await this.#projects.commitAgentAvatar(
        intent.projectId,
        intent.uploadId,
        key
      )
    }
    return await this.#projects.uploadAgentAvatar(
      intent.projectId,
      storedAvatarFile(intent),
      key,
      async (uploadId) => {
        await updateIntent({
          ...intent,
          fileContents: undefined,
          phase: 'commit',
          uploadId
        })
      }
    )
  }
}

const legacyMembershipError = (): CliError =>
  legacyContractError(
    `Project membership and invitations moved to organizations. Check the organization with "${CLI_NAME} org member list" or "${CLI_NAME} org invitation list" before starting a new operation.`
  )

const legacyProjectCreateError = (): CliError =>
  legacyContractError(
    `Projects are now created in an organization. Inspect the organization’s projects with "${CLI_NAME} project list" before creating another.`
  )

// Check before beginning a replay attempt so an obsolete contract cannot send a
// different request or cause the unresolved journal record to be deleted.
const assertCurrentOperationContract = (record: OperationRecord): void => {
  const { intent } = record
  if (isInternalIntent(intent)) {
    assertCurrentInternalContract(intent)
    return
  }
  switch (intent.kind) {
    case 'member.invite':
    case 'member.update':
    case 'member.remove':
    case 'invitation.accept':
    case 'invitation.revoke':
    case 'project.leave':
      throw legacyMembershipError()
    case 'project.create':
      if (intent.slug === undefined) {
        throw legacyContractError(
          'Project creation now requires a slug. Inspect existing projects before creating another.'
        )
      }
      if (intent.organizationId === undefined) {
        throw legacyProjectCreateError()
      }
      return
    case 'api-key.create':
      if (intent.permissions === undefined) {
        throw legacyContractError(
          'API key creation now requires explicit permissions. Inspect existing keys before creating another.'
        )
      }
      return
    case 'sms-number.purchase':
      if (
        intent.input === undefined &&
        record.remoteOperationId === undefined
      ) {
        throw legacyContractError(
          'SMS purchases now require a country. Inspect existing resources and operations before purchasing another.'
        )
      }
      return
    default:
      return
  }
}
