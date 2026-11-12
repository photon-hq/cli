import { randomUUID } from 'node:crypto'
import type {
  CancelOperationOutput,
  ChangePlanOutput,
  CommitAgentProfileAvatarOutput,
  CountProjectsOutput,
  CreateProjectApiKeyOutput,
  CreateProjectOutput,
  CreateSharedLineAssignmentOutput,
  CreateWebhookDestinationOutput,
  DeleteProjectOutput,
  DeleteWebhookDestinationOutput,
  GetAgentProfileOutput,
  GetBillingOperationOutput,
  GetBillingOverviewOutput,
  GetEffectiveTermsOutput,
  GetOperationOutput,
  GetProjectImessagePlatformOutput,
  GetProjectOutput,
  GetResourceOutput,
  GetSharedLineAssignmentOutput,
  GetWebhookDestinationOutput,
  GetWhatsappBusinessAccountOutput,
  ListBillingPlansOutput,
  ListInvoicesOutput,
  ListOperationsOutput,
  ListProjectApiKeysOutput,
  ListProjectPlatformsOutput,
  ListProjectsOutput,
  ListResourcesOutput,
  ListSharedLineAssignmentsOutput,
  ListWebhookApiVersionsOutput,
  ListWebhookDestinationsOutput,
  ListWebhookEventTypesOutput,
  PhotonNamespaces,
  PhotonRawNamespaces,
  RawResponse,
  RequestOptions,
  ResetAgentProfileAvatarOutput,
  RevokeProjectApiKeyOutput,
  RotateWebhookSigningSecretOutput,
  UpdateAgentProfileOutput,
  UpdateProjectOutput,
  UpdateWebhookDestinationOutput
} from '@photon-ai/api'
import { ApiError } from '@photon-ai/api'
import type { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { type PollClock, systemPollClock } from '../auth/device-flow.ts'
import {
  type AvatarFile,
  prepareAvatarFile,
  uploadAvatarFile
} from '../core/avatar.ts'
import {
  argumentValidationError,
  CliError,
  copyCliError,
  normalizeCliError
} from '../core/errors.ts'
import { ID_FORMATS } from '../core/photon-id.ts'
import { pollUntilSettled } from '../core/poll.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../core/request.ts'
import { normalizeSdkError } from '../core/sdk-error.ts'
import { CLI_NAME } from '../meta.ts'
import type { ApiKeyPermission, SmsPurchaseInput } from './api-contract.ts'
import {
  type EmailDomainAutomaticSetup,
  type EmailDomainDnsRecord,
  type EmailDomainVerificationSnapshot,
  selectEmailDomainOperationDetail
} from './email-domain.ts'
import {
  selectTelegramProvisionInProgress,
  selectTelegramSetupUrl,
  TELEGRAM_ABILITY,
  TELEGRAM_BOT_RESOURCE_TYPE,
  TELEGRAM_PROVISION_IN_PROGRESS_CODE
} from './telegram.ts'

export type ProjectScope = PhotonNamespaces['projects']
export type ProjectRawScope = PhotonRawNamespaces['projects']
// Project collections and project billing mutations live under the project's
// organization.
export type ProjectOrganizationScope = Pick<
  PhotonNamespaces['organizations'],
  'billing' | 'projects'
>

export interface ProjectFilters {
  createdAfter?: string
  createdBefore?: string
  search?: string
}

export interface PaginationOptions {
  limit: number
  pageToken?: string
}

export interface AgentProfileChanges {
  firstName?: string
  lastName?: null | string
}

export interface SharedLineAssignmentInput {
  email?: string
  firstName?: string
  lastName?: string
  phoneNumber: string
}

export interface ProjectApiKeyInput {
  expiresAt?: string
  name: string
  permissions: ApiKeyPermission[]
}

export type WebhookDestinationStatus = 'disabled' | 'enabled'
export type WebhookEnabledEvents = ['*'] | string[]

export interface WebhookDestinationCreateInput {
  apiVersion: string
  description?: string
  enabledEvents: WebhookEnabledEvents
  name: string
  status: WebhookDestinationStatus
  url: string
}

export interface WebhookDestinationChanges {
  description?: null | string
  enabledEvents?: WebhookEnabledEvents
  name?: string
  status?: WebhookDestinationStatus
  url?: string
}

interface ProjectServiceOptions {
  clock?: PollClock
  fetch?: typeof globalThis.fetch
  organizationScope: ProjectOrganizationScope
  random?: () => number
  rawScope?: ProjectRawScope
  request: AuthenticatedRequest
  scope: ProjectScope
  signal?: AbortSignal
  timeoutMs?: number
}

interface Page<Result> {
  items: Result[]
  nextPageToken?: string
}

interface PaginationRequest<Result> extends PaginationOptions {
  maximumPageSize: number
  request: (
    pageSize: number,
    pageToken: string | undefined
  ) => Promise<Page<Result>>
}

type PaginatedEnvelope<ItemKey extends string, Result> = {
  [Key in ItemKey]: Result[]
} & { nextPageToken?: string | undefined }

interface PaginatedEnvelopeRequest<ItemKey extends string, Result>
  extends PaginationOptions {
  itemKey: ItemKey
  maximumPageSize: number
  request: (
    pageSize: number,
    pageToken: string | undefined
  ) => Promise<PaginatedEnvelope<ItemKey, Result>>
}

const MAXIMUM_PAGINATION_PAGES = 100
const PROJECT_RESOURCE_PAGE_SIZE_LIMIT = 100
const INVOICE_PAGE_SIZE_LIMIT = 100
const RESOURCE_OPERATION_PAGE_SIZE_LIMIT = 200
const RESOURCE_PAGE_SIZE_LIMIT = 200
const SHARED_LINE_ASSIGNMENT_PAGE_SIZE_LIMIT = 200
const DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS = 5
const WHATSAPP_SENDER_POLL_INTERVAL_MS = 5000
const WHATSAPP_SENDER_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const WHATSAPP_VERIFICATION_DEADLINE_MS = 2 * 60 * 1000
const WHATSAPP_VERIFICATION_DELAYS_MS = [2000, 4000, 8000, 10_000] as const
const E164_PHONE_NUMBER_FORMATTING_PATTERN = /[\s().-]/gu
const E164_PHONE_NUMBER_PATTERN = /^\+[1-9]\d{1,14}$/u
const META_PHONE_NUMBER_ID_PATTERN = /^\d+$/u
const META_WABA_ID_PATTERN = ID_FORMATS.metaWaba.pattern
const EMAIL_DOMAIN_OPERATION_RETRY_AFTER_SECONDS = 10
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/u
const WHATSAPP_QUALITY_RATINGS = ['GREEN', 'RED', 'UNKNOWN', 'YELLOW'] as const
const WHATSAPP_QUALITY_RATING_SET: ReadonlySet<string> = new Set(
  WHATSAPP_QUALITY_RATINGS
)

export type WhatsappBusinessQualityRating =
  (typeof WHATSAPP_QUALITY_RATINGS)[number]

export const MAXIMUM_PAGINATION_LIMIT = 1000

export const isBillingOperationInProgress = (status: string): boolean => {
  const normalized = status.toUpperCase()
  return normalized === 'PENDING' || normalized === 'RUNNING'
}

type PendingBillingOperation = Extract<
  GetBillingOperationOutput,
  { status: 'pending' }
>
const isPendingBillingOperation = (
  operation: GetBillingOperationOutput
): operation is PendingBillingOperation =>
  isBillingOperationInProgress(operation.status)

export interface WhatsappBusinessNumberDetail {
  account: { wabaId: string }
  displayName?: string
  displayNameStatus?: string
  phoneNumber: string
  phoneNumberId: string
  qualityRating: WhatsappBusinessQualityRating
  voipResourceId?: string
}

export interface WhatsappBusinessNumber {
  abilities: string[]
  createdAt: string
  detail: WhatsappBusinessNumberDetail
  projectId: string
  resourceId: string
  retiredAt?: string
  state: string
  type: string
  updatedAt: string
}

export type WhatsappBusinessAccount = GetWhatsappBusinessAccountOutput

export interface WhatsappBusinessAccountList {
  accounts: WhatsappBusinessAccount[]
  nextPageToken?: string
}

// A sender as Photon sends it, and the same sender checked, with its phone
// number normalized, for text.
export interface WhatsappBusinessSender {
  resource: PlatformResource
  sender: WhatsappBusinessNumber
}

// Photon's page of active senders as it sends it, and the same senders
// checked.
export interface WhatsappBusinessNumberList {
  response: ListResourcesOutput
  senders: WhatsappBusinessSender[]
}

export interface WhatsappBusinessSenderProvisioning {
  response: OperationWithResource
  sender: WhatsappBusinessNumber
}

export interface WhatsappVoipNumber {
  displayPhoneNumber: string
  resource: PlatformResource
}

export interface WhatsappBusinessVerificationCode {
  code: string
  receivedAt: string
}

export interface WhatsappSenderConnectionResult extends WhatsappBusinessSender {
  matchesExpectedNumber: boolean
}

export interface EmailDomainConnection {
  automaticSetup?: EmailDomainAutomaticSetup
  dnsRecords: EmailDomainDnsRecord[]
  response: GetOperationOutput
}

export type OperationWithResource = GetOperationOutput & {
  resource: PlatformResource
}

export interface TelegramBotConnection {
  response: GetOperationOutput
  // True when the project already had an unfinished setup and this call
  // continued it instead of starting another.
  resumed: boolean
  setupUrl?: string
}

export interface EmailDomainDnsInspection {
  automaticSetup?: EmailDomainAutomaticSetup
  dnsRecords: EmailDomainDnsRecord[]
  response: GetOperationOutput
  verification?: EmailDomainVerificationSnapshot
}

const automaticEmailDomainSetupResult = (
  automaticSetup: EmailDomainAutomaticSetup | undefined
): { automaticSetup?: EmailDomainAutomaticSetup } =>
  automaticSetup === undefined ? {} : { automaticSetup }

export type PlatformAbility =
  | 'email'
  | 'imessage'
  | 'pstn_voice'
  | 'sms'
  | 'telegram'
  | 'whatsapp_business'
export type PlatformResource = ListResourcesOutput['resources'][number]
export type ProvisioningOperation = ListOperationsOutput['operations'][number]
export type ResourceOperation = GetOperationOutput['operation']

export type PlatformResourceList = ListResourcesOutput & {
  provisioning: ProvisioningOperation[]
}

export type AcceptedOperationCallback = (operationId: string) => Promise<void>

interface AcceptedOperation {
  operation: ResourceOperation
  retryAfterSeconds: number
  status: number
}

const RESOURCE_OPERATION_PENDING_STATES = new Set(['pending', 'running'])

export const isResourceOperationInProgress = (state: string): boolean =>
  RESOURCE_OPERATION_PENDING_STATES.has(state.toLowerCase())

const telegramBotConnection = (
  result: GetOperationOutput,
  resumed: boolean
): TelegramBotConnection => {
  const setupUrl = isResourceOperationInProgress(result.operation.state)
    ? selectTelegramSetupUrl(result.operation.detail)
    : undefined
  return {
    response: result,
    resumed,
    ...(setupUrl === undefined ? {} : { setupUrl })
  }
}

const namesAnotherResource = (
  { resource }: GetOperationOutput,
  projectId: string,
  resourceId: string
): boolean =>
  resource !== undefined &&
  (resource.projectId !== projectId || resource.resourceId !== resourceId)

const validateTelegramBotReleaseOperation = (
  result: GetOperationOutput,
  projectId: string,
  resourceId: string,
  expectedOperationId = result.operation.operationId
): void => {
  const { operation } = result
  if (
    operation.operationId !== expectedOperationId ||
    operation.projectId !== projectId ||
    operation.resourceId !== resourceId ||
    operation.resourceType !== TELEGRAM_BOT_RESOURCE_TYPE ||
    operation.type !== 'resource.release' ||
    namesAnotherResource(result, projectId, resourceId)
  ) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail:
          'The Telegram release operation did not match the requested bot.',
        remoteOperationId: expectedOperationId
      }
    )
  }
}

const validateReleaseOperation = (
  result: GetOperationOutput,
  expected: {
    detail: string
    operationId?: string
    projectId: string
    resourceId: string
    resourceType?: string
  }
): void => {
  const { operation } = result
  const operationId = expected.operationId ?? operation.operationId
  if (
    operation.operationId !== operationId ||
    operation.projectId !== expected.projectId ||
    operation.resourceId !== expected.resourceId ||
    (expected.resourceType !== undefined &&
      operation.resourceType !== expected.resourceType) ||
    operation.type !== 'resource.release' ||
    namesAnotherResource(result, expected.projectId, expected.resourceId)
  ) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail: expected.detail,
        remoteOperationId: operationId
      }
    )
  }
}

const SMS_RELEASE_MISMATCH =
  'The SMS release operation did not match the requested number.'

const EMAIL_DOMAIN_RELEASE_MISMATCH =
  'The email-domain release operation did not match the requested domain.'

const RESOURCE_TYPE_NAMES = new Map([
  ['cosmos_line', 'an iMessage line'],
  ['email_domain', 'an email-domain'],
  [TELEGRAM_BOT_RESOURCE_TYPE, 'a Telegram bot'],
  ['voip_line', 'an SMS number'],
  ['whatsapp_sender', 'a WhatsApp Business number']
])

const notEmailDomainSetupDetail = (
  operation: ResourceOperation
): string | undefined => {
  const name = RESOURCE_TYPE_NAMES.get(operation.resourceType)
  const subject = `Operation ${operation.operationId}`
  if (operation.type === 'resource.release') {
    const removal = name === undefined ? 'a removal' : `${name} removal`
    return `${subject} is ${removal}, not an email-domain setup.`
  }
  if (operation.type !== 'resource.provision') {
    return
  }
  return name === undefined
    ? `${subject} is not an email-domain setup.`
    : `${subject} is ${name} operation, not an email-domain setup.`
}

const telegramProvisionInProgress = (error: unknown): string | undefined =>
  error instanceof CliError &&
  error.code === TELEGRAM_PROVISION_IN_PROGRESS_CODE &&
  error.cause instanceof ApiError
    ? selectTelegramProvisionInProgress(error.cause.body)
    : undefined

const whatsappArgumentError = (detail: string, step: string): CliError =>
  new CliError('ARGUMENT_VALIDATION', 'The command contains invalid input.', {
    detail,
    exitCode: 2,
    next: [{ description: step }]
  })

const whatsappProtocolError = (detail: string): CliError =>
  new CliError(
    'PROJECT_PROTOCOL_ERROR',
    'Photon returned an invalid project response.',
    { detail }
  )

const isWhatsappBusinessQualityRating = (
  value: unknown
): value is WhatsappBusinessQualityRating =>
  typeof value === 'string' && WHATSAPP_QUALITY_RATING_SET.has(value)

const normalizeE164PhoneNumber = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return
  }
  const normalized = value.replace(E164_PHONE_NUMBER_FORMATTING_PATTERN, '')
  return E164_PHONE_NUMBER_PATTERN.test(normalized) ? normalized : undefined
}

const whatsappAccountWabaId = (account: unknown): string | undefined => {
  if (
    typeof account !== 'object' ||
    account === null ||
    !('wabaId' in account)
  ) {
    return
  }
  const { wabaId } = account
  return typeof wabaId === 'string' && META_WABA_ID_PATTERN.test(wabaId)
    ? wabaId
    : undefined
}

interface WhatsappBusinessResourceCandidate {
  abilities: string[]
  createdAt: string
  detail: {
    account?: unknown
    displayName?: unknown
    displayNameStatus?: unknown
    phoneNumber?: unknown
    phoneNumberId?: unknown
    qualityRating?: unknown
    voipResourceId?: unknown
  }
  projectId: string
  resourceId: string
  retiredAt?: string | undefined
  state: string
  type: string
  updatedAt: string
}

const validateWhatsappBusinessNumberResource = (
  resource: WhatsappBusinessResourceCandidate,
  projectId: string,
  options: {
    requireAbility: boolean
    requireActive: boolean
    wrongTypeIsProtocol: boolean
  }
): WhatsappBusinessNumber => {
  if (resource.projectId !== projectId) {
    throw whatsappProtocolError(
      `Resource ${resource.resourceId} belongs to a different project.`
    )
  }
  if (resource.type !== 'whatsapp_sender') {
    if (options.wrongTypeIsProtocol) {
      throw whatsappProtocolError(
        `Resource ${resource.resourceId} is not a WhatsApp sender.`
      )
    }
    throw whatsappArgumentError(
      `Resource ${resource.resourceId} is not a WhatsApp Business sender.`,
      'Pass the resource ID of a WhatsApp Business sender.'
    )
  }
  if (options.requireActive && resource.state.toLowerCase() !== 'active') {
    throw whatsappArgumentError(
      `Resource ${resource.resourceId} is not an active WhatsApp Business sender.`,
      'Pass the resource ID of an active WhatsApp Business sender.'
    )
  }
  if (
    options.requireAbility &&
    !resource.abilities.includes('whatsapp_business')
  ) {
    throw whatsappArgumentError(
      `Resource ${resource.resourceId} does not have the WhatsApp Business ability.`,
      'Pass the resource ID of an active WhatsApp Business sender.'
    )
  }

  const {
    account,
    displayName,
    displayNameStatus,
    phoneNumber,
    phoneNumberId,
    qualityRating,
    voipResourceId
  } = resource.detail
  const normalizedPhoneNumber = normalizeE164PhoneNumber(phoneNumber)
  const wabaId = whatsappAccountWabaId(account)
  const validDisplayName =
    displayName === undefined ||
    (typeof displayName === 'string' && displayName.length > 0)
  const validDisplayNameStatus =
    displayNameStatus === undefined ||
    (typeof displayNameStatus === 'string' && displayNameStatus.length > 0)
  const validVoipResourceId =
    voipResourceId === undefined ||
    (typeof voipResourceId === 'string' && voipResourceId.length > 0)
  if (
    normalizedPhoneNumber === undefined ||
    typeof phoneNumberId !== 'string' ||
    !META_PHONE_NUMBER_ID_PATTERN.test(phoneNumberId) ||
    wabaId === undefined ||
    !isWhatsappBusinessQualityRating(qualityRating) ||
    !validDisplayName ||
    !validDisplayNameStatus ||
    !validVoipResourceId
  ) {
    throw whatsappProtocolError(
      `Resource ${resource.resourceId} has malformed WhatsApp Business detail.`
    )
  }

  return {
    abilities: [...resource.abilities],
    createdAt: resource.createdAt,
    detail: {
      account: { wabaId },
      ...(displayName === undefined ? {} : { displayName }),
      ...(displayNameStatus === undefined ? {} : { displayNameStatus }),
      phoneNumber: normalizedPhoneNumber,
      phoneNumberId,
      qualityRating,
      ...(voipResourceId === undefined ? {} : { voipResourceId })
    },
    projectId: resource.projectId,
    resourceId: resource.resourceId,
    ...(resource.retiredAt === undefined
      ? {}
      : { retiredAt: resource.retiredAt }),
    state: resource.state,
    type: resource.type,
    updatedAt: resource.updatedAt
  }
}

const isRetiredResource = (
  resource: PlatformResource,
  projectId: string
): boolean =>
  resource.projectId === projectId && resource.state.toLowerCase() === 'retired'

const isRetiredWhatsappBusinessNumber = (
  resource: PlatformResource,
  projectId: string
): boolean =>
  resource.type === 'whatsapp_sender' && isRetiredResource(resource, projectId)

const validateWhatsappBusinessReleaseOperation = (
  result: GetOperationOutput,
  projectId: string,
  resourceId: string,
  expectedOperationId = result.operation.operationId
): void => {
  const { operation } = result
  if (
    operation.operationId !== expectedOperationId ||
    operation.projectId !== projectId ||
    operation.resourceId !== resourceId ||
    operation.resourceType !== 'whatsapp_sender' ||
    operation.type !== 'resource.release' ||
    namesAnotherResource(result, projectId, resourceId)
  ) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail:
          'The WhatsApp Business release operation did not match the requested sender.',
        remoteOperationId: expectedOperationId
      }
    )
  }
}

const validateWhatsappBusinessProvisionOperation = (
  operation: ResourceOperation,
  projectId: string,
  expectedOperationId = operation.operationId
): void => {
  if (
    operation.operationId !== expectedOperationId ||
    operation.projectId !== projectId ||
    operation.resourceType !== 'whatsapp_sender' ||
    operation.type !== 'resource.provision'
  ) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail:
          'The WhatsApp Business provisioning operation did not match the requested sender.',
        remoteOperationId: expectedOperationId
      }
    )
  }
}

export const validateWhatsappVoipNumber = (
  resource: PlatformResource,
  projectId: string
): WhatsappVoipNumber => {
  if (resource.projectId !== projectId) {
    throw whatsappArgumentError(
      `Resource ${resource.resourceId} belongs to a different project.`,
      'Pass an SMS number from the selected project.'
    )
  }
  if (
    resource.type !== 'voip_line' ||
    resource.state.toLowerCase() !== 'active' ||
    resource.retiredAt !== undefined ||
    !resource.abilities.includes('sms')
  ) {
    throw whatsappArgumentError(
      `Resource ${resource.resourceId} is not an active Photon SMS number.`,
      'Pass the resource ID of an active SMS-capable Photon VoIP line.'
    )
  }
  const { phoneNumber } = resource.detail
  if (
    typeof phoneNumber !== 'string' ||
    !E164_PHONE_NUMBER_PATTERN.test(phoneNumber)
  ) {
    throw whatsappProtocolError(
      `Resource ${resource.resourceId} has a malformed Photon phone number.`
    )
  }
  return { displayPhoneNumber: phoneNumber, resource }
}

const provisioningResourceType = (
  ability: PlatformAbility
): string | undefined => {
  if (ability === 'sms') {
    return 'voip_line'
  }
  if (ability === 'imessage') {
    return 'cosmos_line'
  }
  if (ability === 'email') {
    return 'email_domain'
  }
  if (ability === 'whatsapp_business') {
    return 'whatsapp_sender'
  }
  if (ability === TELEGRAM_ABILITY) {
    return TELEGRAM_BOT_RESOURCE_TYPE
  }
}

const retryAfterSeconds = (
  headers: Headers,
  fallbackSeconds = DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS
): number => {
  const value = headers.get('retry-after')
  if (value === null || !RETRY_AFTER_SECONDS_PATTERN.test(value)) {
    return fallbackSeconds
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallbackSeconds
}

const normalizeWhatsappVerificationError = (
  error: unknown,
  signal: AbortSignal | undefined
): CliError =>
  normalizeCliError(
    normalizeSdkError(error, {
      // A newer code can still arrive, so the same request can succeed later.
      override: (mapped) =>
        mapped.code === 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND'
          ? copyCliError(mapped, { retryable: true })
          : mapped,
      sensitive: true,
      ...(signal === undefined ? {} : { signal })
    })
  )

export type WebhookApiVersionCatalog = NonNullable<ListWebhookApiVersionsOutput>
export type WebhookEventCatalog = NonNullable<ListWebhookEventTypesOutput>

// A 304 is only returned for a conditional request, which this CLI never sends.
const notModifiedUnexpected = <Result>(result: Result | undefined): Result => {
  if (result === undefined) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail: 'Photon answered Not Modified to an unconditional request.'
      }
    )
  }
  return result
}

const paginationError = (message: string): CliError =>
  new CliError('PROJECT_PROTOCOL_ERROR', message)

const assertLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CliError(
      'ARGUMENT_VALIDATION',
      'The command contains invalid input.',
      { detail: 'Limit must be a positive integer.', exitCode: 2 }
    )
  }
  if (limit > MAXIMUM_PAGINATION_LIMIT) {
    throw new CliError(
      'ARGUMENT_VALIDATION',
      'The command contains invalid input.',
      {
        detail: `Limit cannot exceed ${MAXIMUM_PAGINATION_LIMIT.toString()}.`,
        exitCode: 2
      }
    )
  }
}

export class ProjectService {
  readonly #clock: PollClock
  readonly #fetch: typeof globalThis.fetch
  readonly #loaded = new Map<string, GetProjectOutput>()
  readonly #organizationScope: ProjectOrganizationScope
  readonly #rawScope: ProjectRawScope | undefined
  readonly #random: () => number
  readonly #request: AuthenticatedRequest
  readonly #scope: ProjectScope
  readonly #signal: AbortSignal | undefined
  readonly #timeoutMs: number

  constructor(options: ProjectServiceOptions) {
    this.#clock = options.clock ?? systemPollClock
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#organizationScope = options.organizationScope
    this.#rawScope = options.rawScope
    this.#random = options.random ?? Math.random
    this.#request = options.request
    this.#scope = options.scope
    this.#signal = options.signal
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async cancelOperation(
    projectId: string,
    operationId: string
  ): Promise<CancelOperationOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.cancelOperation(
        { path: { id: projectId, operationId } },
        options
      )
    )
  }

  async commitAgentAvatar(
    projectId: string,
    uploadId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<CommitAgentProfileAvatarOutput> {
    return await this.#execute((options) =>
      this.#scope.agentProfile.commitAvatar(
        {
          body: { uploadId },
          headers: { idempotencyKey },
          path: { projectId }
        },
        options
      )
    )
  }

  async count(
    organizationId: string,
    filters: ProjectFilters
  ): Promise<CountProjectsOutput> {
    return await this.#execute((options) =>
      this.#organizationScope.projects.count(
        { path: { organizationId }, query: this.#projectFilterQuery(filters) },
        options
      )
    )
  }

  async create(
    organizationId: string,
    name: string,
    slug: string,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateProjectOutput> {
    return await this.#execute((options) =>
      this.#organizationScope.projects.create(
        {
          body: { name, slug },
          headers: { idempotencyKey },
          path: { organizationId }
        },
        options
      )
    )
  }

  async createApiKey(
    projectId: string,
    input: ProjectApiKeyInput,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateProjectApiKeyOutput> {
    return await this.#execute(
      (options) =>
        this.#scope.createProjectApiKey(
          {
            body: {
              name: input.name,
              permissions: input.permissions,
              ...(input.expiresAt === undefined
                ? {}
                : { expiresAt: input.expiresAt })
            },
            headers: { idempotencyKey },
            path: { projectId }
          },
          options
        ),
      true
    )
  }

  async createWebhookDestination(
    projectId: string,
    input: WebhookDestinationCreateInput,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateWebhookDestinationOutput> {
    return await this.#execute(
      (options) =>
        this.#scope.createWebhookDestination(
          {
            body: {
              apiVersion: input.apiVersion,
              ...(input.description === undefined
                ? {}
                : { description: input.description }),
              enabledEvents: input.enabledEvents,
              name: input.name,
              status: input.status,
              url: input.url
            },
            headers: { idempotencyKey },
            path: { projectId }
          },
          options
        ),
      true
    )
  }

  async createSharedLineAssignment(
    projectId: string,
    input: SharedLineAssignmentInput,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateSharedLineAssignmentOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.imessage.assignments.create(
        {
          body: {
            handle: input.phoneNumber,
            ...(input.email === undefined ? {} : { email: input.email }),
            ...(input.firstName === undefined
              ? {}
              : { firstName: input.firstName }),
            ...(input.lastName === undefined
              ? {}
              : { lastName: input.lastName })
          },
          headers: { idempotencyKey },
          path: { id: projectId }
        },
        options
      )
    )
  }

  async connectEmailDomain(
    projectId: string,
    domain: string,
    idempotencyKey: string = randomUUID(),
    accepted?: AcceptedOperationCallback
  ): Promise<EmailDomainConnection> {
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.connectEmailDomain(
          {
            body: { domain },
            headers: { idempotencyKey },
            path: { id: projectId }
          },
          options
        ),
      accepted
    )
    return await this.#waitForEmailDomainConnection(
      projectId,
      { operation: initial.operation },
      initial.retryAfterSeconds
    )
  }

  async connectTelegramBot(
    projectId: string,
    idempotencyKey: string = randomUUID(),
    accepted?: AcceptedOperationCallback
  ): Promise<TelegramBotConnection> {
    try {
      return await this.#startTelegramBotConnection(
        projectId,
        idempotencyKey,
        accepted
      )
    } catch (error) {
      const operationId = telegramProvisionInProgress(error)
      if (operationId === undefined) {
        throw error
      }
      // A project holds one unfinished Telegram setup, and its link stays
      // usable until it finishes, so that setup is continued.
      const unfinished = await this.#telegramBotConnection(
        projectId,
        operationId,
        true
      )
      if (isResourceOperationInProgress(unfinished.response.operation.state)) {
        try {
          await accepted?.(operationId)
        } catch (acceptedError) {
          throw copyCliError(normalizeCliError(acceptedError), {
            remoteOperationId: operationId
          })
        }
        return unfinished
      }
    }
    // The setup that held the slot finished between the refusal and the read.
    return await this.#startTelegramBotConnection(
      projectId,
      idempotencyKey,
      accepted
    )
  }

  async resumeTelegramBotConnection(
    projectId: string,
    operationId: string
  ): Promise<TelegramBotConnection> {
    return await this.#telegramBotConnection(projectId, operationId, false)
  }

  async waitForTelegramBotConnection(
    projectId: string,
    operationId: string
  ): Promise<OperationWithResource> {
    const initial = await this.#refreshOperation(projectId, operationId)
    this.#assertTelegramBotConnectionOperation(initial.operation, projectId)
    let terminal = await this.#waitForResourceOperation(
      projectId,
      initial,
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS
    )
    if (terminal.resource === undefined) {
      terminal = await this.#refreshOperation(projectId, operationId)
    }
    const { resource } = terminal
    if (resource?.type !== TELEGRAM_BOT_RESOURCE_TYPE) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid Telegram bot connection response.',
        {
          detail:
            'A successful Telegram bot operation did not include its bot.',
          remoteOperationId: operationId
        }
      )
    }
    return { ...terminal, resource }
  }

  // Deletion is replayed naturally (by project ID), so each attempt sends a
  // fresh Idempotency-Key.
  async delete(projectId: string): Promise<DeleteProjectOutput> {
    return await this.#execute((options) =>
      this.#scope.delete(
        { headers: { idempotencyKey: randomUUID() }, path: { projectId } },
        options
      )
    )
  }

  async deleteWebhookDestination(
    projectId: string,
    destinationId: string
  ): Promise<DeleteWebhookDestinationOutput> {
    return await this.#execute((options) =>
      this.#scope.deleteWebhookDestination(
        { path: { destinationId, projectId } },
        options
      )
    )
  }

  async get(projectId: string): Promise<GetProjectOutput> {
    const project = await this.#execute((options) =>
      this.#scope.get({ path: { projectId } }, options)
    )
    this.#loaded.set(projectId, project)
    return project
  }

  // A project this command already read, so naming it costs no request.
  loaded(projectId: string): GetProjectOutput | undefined {
    return this.#loaded.get(projectId)
  }

  async organizationIdOf(projectId: string): Promise<string> {
    return (await this.get(projectId)).organizationId
  }

  async getWebhookDestination(
    projectId: string,
    destinationId: string
  ): Promise<GetWebhookDestinationOutput> {
    return await this.#execute((options) =>
      this.#scope.getWebhookDestination(
        { path: { destinationId, projectId } },
        options
      )
    )
  }

  async getAgentProfile(projectId: string): Promise<GetAgentProfileOutput> {
    return await this.#execute((options) =>
      this.#scope.agentProfile.get({ path: { projectId } }, options)
    )
  }

  async getBillingOperation(
    projectId: string,
    operationId: string
  ): Promise<GetBillingOperationOutput> {
    return await this.#execute((options) =>
      this.#scope.billing.getOperation(
        { path: { operationId, projectId } },
        options
      )
    )
  }

  async getOperation(
    projectId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.getOperation(
        { path: { id: projectId, operationId } },
        options
      )
    )
  }

  async getEmailDomainDnsRecords(
    projectId: string,
    operationId: string
  ): Promise<EmailDomainDnsInspection> {
    const response = await this.getOperation(projectId, operationId)
    const { operation } = response
    this.#assertEmailDomainConnectionOperation(operation, projectId, 'person')
    const selection = selectEmailDomainOperationDetail(operation.detail)
    if (selection.status === 'invalid') {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned invalid email-domain setup instructions.',
        {
          next: [
            {
              description:
                'Contact Photon support if the response remains invalid.'
            }
          ],
          remoteOperationId: operation.operationId
        }
      )
    }
    return {
      ...(selection.status === 'present' &&
      selection.automaticSetup !== undefined
        ? { automaticSetup: selection.automaticSetup }
        : {}),
      dnsRecords: selection.status === 'present' ? selection.records : [],
      response,
      ...(selection.status === 'present' && selection.verification !== undefined
        ? { verification: selection.verification }
        : {})
    }
  }

  async getResource(
    projectId: string,
    resourceId: string
  ): Promise<GetResourceOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.getResource(
        { path: { id: projectId, resourceId } },
        options
      )
    )
  }

  async getWhatsappBusinessNumber(
    projectId: string,
    resourceId: string
  ): Promise<WhatsappBusinessSender> {
    const resource = await this.getResource(projectId, resourceId)
    return {
      resource,
      sender: validateWhatsappBusinessNumberResource(resource, projectId, {
        requireAbility: false,
        requireActive: false,
        wrongTypeIsProtocol: false
      })
    }
  }

  async getActiveWhatsappBusinessNumber(
    projectId: string,
    resourceId: string
  ): Promise<WhatsappBusinessNumber> {
    return validateWhatsappBusinessNumberResource(
      await this.getResource(projectId, resourceId),
      projectId,
      {
        requireAbility: true,
        requireActive: true,
        wrongTypeIsProtocol: false
      }
    )
  }

  async getWhatsappVoipNumber(
    projectId: string,
    resourceId: string
  ): Promise<WhatsappVoipNumber> {
    return validateWhatsappVoipNumber(
      await this.getResource(projectId, resourceId),
      projectId
    )
  }

  async getAvailableWhatsappVoipNumber(
    projectId: string,
    resourceId: string
  ): Promise<WhatsappVoipNumber> {
    const number = await this.getWhatsappVoipNumber(projectId, resourceId)
    const { senders } = await this.listWhatsappBusinessNumbers(projectId, {
      limit: MAXIMUM_PAGINATION_LIMIT
    })
    const linkedSender = senders.find(
      ({ sender }) =>
        sender.detail.voipResourceId === resourceId ||
        sender.detail.phoneNumber === number.displayPhoneNumber
    )?.sender
    if (linkedSender !== undefined) {
      throw new CliError(
        'WHATSAPP_NUMBER_ALREADY_CONNECTED',
        'The selected Photon number is already connected to WhatsApp Business.',
        {
          detail: `${number.displayPhoneNumber} is linked to sender ${linkedSender.resourceId}.`,
          next: [
            { description: 'Choose another active Photon SMS number.' },
            {
              description: 'Or inspect the existing sender',
              run: `${CLI_NAME} project platform whatsapp-business number view ${linkedSender.resourceId}`
            }
          ]
        }
      )
    }
    return number
  }

  async listEligibleWhatsappVoipNumbers(
    projectId: string
  ): Promise<WhatsappVoipNumber[]> {
    const [smsResources, { senders }] = await Promise.all([
      this.#paginateEnvelope<'resources', PlatformResource>({
        itemKey: 'resources',
        limit: MAXIMUM_PAGINATION_LIMIT,
        maximumPageSize: RESOURCE_PAGE_SIZE_LIMIT,
        request: async (pageSize, pageToken) =>
          await this.#execute((options) =>
            this.#scope.platforms.listResources(
              {
                path: { id: projectId },
                query: {
                  ability: 'sms',
                  pageSize,
                  ...(pageToken === undefined ? {} : { pageToken })
                }
              },
              options
            )
          )
      }),
      this.listWhatsappBusinessNumbers(projectId, {
        limit: MAXIMUM_PAGINATION_LIMIT
      })
    ])
    const linkedResourceIds = new Set(
      senders.flatMap(({ sender }) =>
        sender.detail.voipResourceId === undefined
          ? []
          : [sender.detail.voipResourceId]
      )
    )
    const linkedPhoneNumbers = new Set(
      senders.map(({ sender }) => sender.detail.phoneNumber)
    )
    const eligible: WhatsappVoipNumber[] = []
    for (const resource of smsResources.resources) {
      if (
        resource.type !== 'voip_line' ||
        resource.state.toLowerCase() !== 'active' ||
        resource.retiredAt !== undefined ||
        !resource.abilities.includes('sms')
      ) {
        continue
      }
      let number: WhatsappVoipNumber
      try {
        number = validateWhatsappVoipNumber(resource, projectId)
      } catch (error) {
        if (
          error instanceof CliError &&
          error.code === 'PROJECT_PROTOCOL_ERROR'
        ) {
          continue
        }
        throw error
      }
      if (
        linkedResourceIds.has(resource.resourceId) ||
        linkedPhoneNumbers.has(number.displayPhoneNumber)
      ) {
        continue
      }
      eligible.push(number)
    }
    return eligible
  }

  async assertWhatsappBusinessAccountConnected(
    projectId: string,
    wabaId: string
  ): Promise<void> {
    const result = await this.listWhatsappBusinessAccounts(projectId, {
      limit: MAXIMUM_PAGINATION_LIMIT
    })
    if (result.accounts.some((account) => account.wabaId === wabaId)) {
      return
    }
    throw new CliError(
      'WHATSAPP_WABA_NOT_CONNECTED',
      'The requested WhatsApp Business Account is not connected to this project.',
      {
        next: [
          {
            description:
              'Use --new-waba to continue through the Photon dashboard.'
          },
          {
            description:
              'Or run number add interactively and choose Connect another WABA.'
          }
        ]
      }
    )
  }

  async createWhatsappVoipSender(
    projectId: string,
    wabaId: string,
    input: { displayName?: string; voipResourceId: string },
    idempotencyKey: string,
    accepted?: AcceptedOperationCallback
  ): Promise<WhatsappBusinessSenderProvisioning> {
    await this.assertWhatsappBusinessAccountConnected(projectId, wabaId)
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.createWhatsappVoipSender(
          {
            body: {
              ...(input.displayName === undefined
                ? {}
                : { displayName: input.displayName }),
              voipResourceId: input.voipResourceId
            },
            headers: { idempotencyKey },
            path: { id: projectId }
          },
          options
        ),
      accepted
    )
    validateWhatsappBusinessProvisionOperation(initial.operation, projectId)
    if (initial.status !== 202) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail: `WhatsApp Business provisioning returned unexpected HTTP status ${initial.status.toString()}.`,
          next: [{ description: 'Retry with the same idempotency key.' }],
          remoteOperationId: initial.operation.operationId
        }
      )
    }
    const response = await this.#waitForProvisionedResource(
      projectId,
      { operation: initial.operation },
      'whatsapp_business',
      initial.retryAfterSeconds
    )
    return {
      response,
      sender: validateWhatsappBusinessNumberResource(
        response.resource,
        projectId,
        {
          requireAbility: true,
          requireActive: true,
          wrongTypeIsProtocol: true
        }
      )
    }
  }

  async resumeWhatsappVoipSenderProvisioning(
    projectId: string,
    operationId: string
  ): Promise<WhatsappBusinessSenderProvisioning> {
    const result = await this.getOperation(projectId, operationId)
    validateWhatsappBusinessProvisionOperation(
      result.operation,
      projectId,
      operationId
    )
    const response = await this.#waitForProvisionedResource(
      projectId,
      result,
      'whatsapp_business',
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS
    )
    return {
      response,
      sender: validateWhatsappBusinessNumberResource(
        response.resource,
        projectId,
        {
          requireAbility: true,
          requireActive: true,
          wrongTypeIsProtocol: true
        }
      )
    }
  }

  async getWhatsappBusinessVerificationCode(
    projectId: string,
    resourceId: string,
    receivedAfter: string
  ): Promise<WhatsappBusinessVerificationCode> {
    try {
      return await this.#request.run((options) =>
        this.#scope.platforms.getWhatsappBusinessVerificationCode(
          {
            path: { id: projectId, resourceId },
            query: { receivedAfter }
          },
          options
        )
      )
    } catch (error) {
      throw normalizeWhatsappVerificationError(error, this.#signal)
    }
  }

  async waitForWhatsappBusinessVerificationCode(
    projectId: string,
    resourceId: string,
    receivedAfter: string
  ): Promise<WhatsappBusinessVerificationCode> {
    const startedAt = this.#clock.now()
    const deadline = startedAt + WHATSAPP_VERIFICATION_DEADLINE_MS
    let retryAfterMs = 0
    for (let attempt = 0; this.#clock.now() < deadline; attempt += 1) {
      const baseDelay =
        WHATSAPP_VERIFICATION_DELAYS_MS[
          Math.min(attempt, WHATSAPP_VERIFICATION_DELAYS_MS.length - 1)
        ] ??
        WHATSAPP_VERIFICATION_DELAYS_MS.at(-1) ??
        10_000
      const boundedRandom = Math.min(1, Math.max(0, this.#random()))
      const jitteredDelay = Math.round(baseDelay * (0.8 + boundedRandom * 0.4))
      const delay = Math.max(jitteredDelay, retryAfterMs)
      if (this.#clock.now() + delay >= deadline) {
        break
      }
      // biome-ignore lint/performance/noAwaitInLoops: OTP polling is intentionally sequential.
      await this.#clock.sleep(delay, this.#signal)
      try {
        return await this.getWhatsappBusinessVerificationCode(
          projectId,
          resourceId,
          receivedAfter
        )
      } catch (error) {
        const normalized = normalizeCliError(error)
        const retryablePoll =
          normalized.code === 'WHATSAPP_VERIFICATION_CODE_NOT_FOUND' ||
          normalized.httpStatus === 429
        if (!retryablePoll) {
          throw normalized
        }
        retryAfterMs = (normalized.retryAfterSeconds ?? 0) * 1000
      }
    }
    throw new CliError(
      'WHATSAPP_VERIFICATION_CODE_TIMEOUT',
      'Photon did not receive a WhatsApp verification code in time.',
      {
        next: [
          {
            description:
              'Return to the readiness step and request a new code from Meta.'
          }
        ],
        retryable: true
      }
    )
  }

  async waitForWhatsappBusinessSender(
    projectId: string,
    voipResourceId: string,
    displayPhoneNumber: string,
    knownSenderIds: ReadonlySet<string>
  ): Promise<WhatsappSenderConnectionResult> {
    const deadline = this.#clock.now() + WHATSAPP_SENDER_WAIT_TIMEOUT_MS
    while (this.#clock.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: sender completion polling is sequential.
      const { senders } = await this.listWhatsappBusinessNumbers(projectId, {
        limit: MAXIMUM_PAGINATION_LIMIT
      })
      const expected = senders.find(
        ({ sender }) =>
          sender.detail.voipResourceId === voipResourceId ||
          sender.detail.phoneNumber === displayPhoneNumber
      )
      if (expected !== undefined) {
        return { ...expected, matchesExpectedNumber: true }
      }
      const unexpected = senders.find(
        ({ sender }) => !knownSenderIds.has(sender.resourceId)
      )
      if (unexpected !== undefined) {
        return { ...unexpected, matchesExpectedNumber: false }
      }
      if (this.#clock.now() + WHATSAPP_SENDER_POLL_INTERVAL_MS >= deadline) {
        break
      }
      await this.#clock.sleep(WHATSAPP_SENDER_POLL_INTERVAL_MS, this.#signal)
    }
    throw new CliError(
      'WHATSAPP_SENDER_CONNECTION_TIMEOUT',
      'Photon did not observe the connected WhatsApp sender in time.',
      {
        next: [
          {
            description:
              'Check the Photon dashboard for the final onboarding status.'
          },
          {
            description: 'Inspect connected senders',
            run: `${CLI_NAME} project platform whatsapp-business number list`
          }
        ],
        retryable: true
      }
    )
  }

  async pollBillingOperation(
    projectId: string,
    initial: GetBillingOperationOutput
  ): Promise<Exclude<GetBillingOperationOutput, PendingBillingOperation>> {
    return await pollUntilSettled({
      clock: this.#clock,
      initial,
      isPending: isPendingBillingOperation,
      poll: async (operation) =>
        await this.getBillingOperation(projectId, operation.operationId),
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    })
  }

  async getBillingOverview(
    projectId: string
  ): Promise<GetBillingOverviewOutput> {
    return await this.#execute((options) =>
      this.#scope.billing.getOverview({ path: { projectId } }, options)
    )
  }

  async getEffectiveTerms(projectId: string): Promise<GetEffectiveTermsOutput> {
    const organizationId = await this.organizationIdOf(projectId)
    return await this.#execute((options) =>
      this.#organizationScope.billing.getEffectiveTerms(
        { path: { organizationId, projectId } },
        options
      )
    )
  }

  async listBillingPlans(projectId: string): Promise<ListBillingPlansOutput> {
    return await this.#execute((options) =>
      this.#scope.billing.listBillingPlans({ path: { projectId } }, options)
    )
  }

  async getImessagePlatform(
    projectId: string
  ): Promise<GetProjectImessagePlatformOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.getImessage({ path: { id: projectId } }, options)
    )
  }

  async listProjectPlatforms(
    projectId: string
  ): Promise<ListProjectPlatformsOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.listProjectPlatforms(
        { path: { id: projectId } },
        options
      )
    )
  }

  async getSharedLineAssignment(
    projectId: string,
    assignmentId: string
  ): Promise<GetSharedLineAssignmentOutput> {
    return await this.#execute((options) =>
      this.#scope.platforms.imessage.assignments.get(
        { path: { assignmentId, id: projectId } },
        options
      )
    )
  }

  async list(
    organizationId: string,
    filters: ProjectFilters,
    pagination: PaginationOptions
  ): Promise<ListProjectsOutput> {
    return await this.#paginateEnvelope<
      'projects',
      ListProjectsOutput['projects'][number]
    >({
      ...pagination,
      itemKey: 'projects',
      maximumPageSize: PROJECT_RESOURCE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) =>
        await this.#execute((options) =>
          this.#organizationScope.projects.list(
            {
              path: { organizationId },
              query: {
                ...this.#projectFilterQuery(filters),
                pageSize,
                ...(pageToken === undefined ? {} : { pageToken })
              }
            },
            options
          )
        )
    })
  }

  async listApiKeys(projectId: string): Promise<ListProjectApiKeysOutput> {
    return await this.#execute((options) =>
      this.#scope.listProjectApiKeys({ path: { projectId } }, options)
    )
  }

  async listWebhookApiVersions(
    projectId: string
  ): Promise<WebhookApiVersionCatalog> {
    return notModifiedUnexpected(
      await this.#execute((options) =>
        this.#scope.listWebhookApiVersions({ path: { projectId } }, options)
      )
    )
  }

  async listWebhookDestinations(
    projectId: string,
    pagination: PaginationOptions
  ): Promise<ListWebhookDestinationsOutput> {
    return await this.#paginateEnvelope<
      'destinations',
      ListWebhookDestinationsOutput['destinations'][number]
    >({
      ...pagination,
      itemKey: 'destinations',
      maximumPageSize: PROJECT_RESOURCE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) =>
        await this.#execute((options) =>
          this.#scope.listWebhookDestinations(
            {
              path: { projectId },
              query: {
                pageSize,
                ...(pageToken === undefined ? {} : { pageToken })
              }
            },
            options
          )
        )
    })
  }

  async listWebhookEventTypes(
    projectId: string,
    apiVersion: string
  ): Promise<WebhookEventCatalog> {
    return notModifiedUnexpected(
      await this.#execute((options) =>
        this.#scope.listWebhookEventTypes(
          { path: { projectId }, query: { apiVersion } },
          options
        )
      )
    )
  }

  // Invoices belong to the project's organization. The API's envelope, with
  // the invoices of every page fetched and the cursor for the page after
  // them. Its other fields come from the last page.
  async listInvoices(
    projectId: string,
    pagination: PaginationOptions
  ): Promise<ListInvoicesOutput> {
    const organizationId = await this.organizationIdOf(projectId)
    let lastPage: ListInvoicesOutput = { invoices: [], nextCursor: null }
    const result = await this.#paginate({
      ...pagination,
      maximumPageSize: INVOICE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) => {
        const page = await this.#execute((options) =>
          this.#organizationScope.billing.listInvoices(
            {
              path: { organizationId },
              query: {
                limit: pageSize,
                ...(pageToken === undefined ? {} : { cursor: pageToken })
              }
            },
            options
          )
        )
        lastPage = page
        return {
          items: page.invoices,
          ...(page.nextCursor === null
            ? {}
            : { nextPageToken: page.nextCursor })
        }
      }
    })
    return {
      ...lastPage,
      invoices: result.items,
      nextCursor: result.nextPageToken ?? null
    }
  }

  async listSharedLineAssignments(
    projectId: string,
    pagination: PaginationOptions,
    includeReleased: boolean
  ): Promise<ListSharedLineAssignmentsOutput> {
    return await this.#paginateEnvelope<
      'assignments',
      ListSharedLineAssignmentsOutput['assignments'][number]
    >({
      ...pagination,
      itemKey: 'assignments',
      maximumPageSize: SHARED_LINE_ASSIGNMENT_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) =>
        await this.#execute((options) =>
          this.#scope.platforms.imessage.assignments.list(
            {
              path: { id: projectId },
              query: {
                pageSize,
                ...(includeReleased ? { includeReleased: 'true' } : {}),
                ...(pageToken === undefined ? {} : { pageToken })
              }
            },
            options
          )
        )
    })
  }

  async listWhatsappBusinessAccounts(
    projectId: string,
    pagination: PaginationOptions
  ): Promise<WhatsappBusinessAccountList> {
    if (pagination.pageToken !== undefined) {
      throw new CliError(
        'INVALID_ARGUMENT',
        'WhatsApp accounts no longer support pagination. Each project has one connected account.'
      )
    }
    try {
      const account = await this.#execute((options) =>
        this.#scope.platforms.getWhatsappBusinessAccount(
          { path: { id: projectId } },
          options
        )
      )
      return { accounts: [account] }
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === 'WHATSAPP_WABA_NOT_CONNECTED'
      ) {
        return { accounts: [] }
      }
      throw error
    }
  }

  async listWhatsappBusinessNumbers(
    projectId: string,
    pagination: PaginationOptions
  ): Promise<WhatsappBusinessNumberList> {
    const page = await this.#paginateEnvelope<'resources', PlatformResource>({
      ...pagination,
      itemKey: 'resources',
      maximumPageSize: RESOURCE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) =>
        await this.#execute((options) =>
          this.#scope.platforms.listResources(
            {
              path: { id: projectId },
              query: {
                ability: 'whatsapp_business',
                pageSize,
                state: 'active',
                ...(pageToken === undefined ? {} : { pageToken })
              }
            },
            options
          )
        )
    })
    const senders = page.resources.map((resource) => {
      if (resource.state.toLowerCase() !== 'active') {
        throw whatsappProtocolError(
          `Photon listed resource ${resource.resourceId}, which is not active, when asked for active senders only.`
        )
      }
      return {
        resource,
        sender: validateWhatsappBusinessNumberResource(resource, projectId, {
          requireAbility: true,
          requireActive: false,
          wrongTypeIsProtocol: true
        })
      }
    })
    return {
      response: { ...page, resources: senders.map(({ resource }) => resource) },
      senders
    }
  }

  async listResources(
    projectId: string,
    ability: PlatformAbility,
    pagination: PaginationOptions
  ): Promise<ListResourcesOutput> {
    return await this.#paginateEnvelope<'resources', PlatformResource>({
      ...pagination,
      itemKey: 'resources',
      maximumPageSize: RESOURCE_PAGE_SIZE_LIMIT,
      request: async (pageSize, pageToken) =>
        await this.#execute((options) =>
          this.#scope.platforms.listResources(
            {
              path: { id: projectId },
              query: {
                ability,
                pageSize,
                ...(pageToken === undefined ? {} : { pageToken })
              }
            },
            options
          )
        )
    })
  }

  async listPlatformResources(
    projectId: string,
    ability: PlatformAbility,
    pagination: PaginationOptions
  ): Promise<PlatformResourceList> {
    const resourceType = provisioningResourceType(ability)
    const resourcesPromise = this.listResources(projectId, ability, pagination)
    const provisioningPromise =
      resourceType === undefined
        ? Promise.resolve([])
        : this.#listProvisioningOperations(projectId, resourceType)
    const [resourcePage, provisioning] = await Promise.all([
      resourcesPromise,
      provisioningPromise
    ])
    return { ...resourcePage, provisioning }
  }

  async purchasePlan(
    projectId: string,
    category: string,
    planCode: string,
    idempotencyKey: string = randomUUID()
  ): Promise<Exclude<ChangePlanOutput, PendingBillingOperation>> {
    const organizationId = await this.organizationIdOf(projectId)
    const initial = await this.#execute((options) =>
      this.#organizationScope.billing.changePlan(
        {
          body: { category, planCode },
          headers: { idempotencyKey },
          path: { organizationId, projectId }
        },
        options
      )
    )
    return await this.pollBillingOperation(projectId, initial)
  }

  async provisionImessageDedicatedLine(
    projectId: string,
    idempotencyKey: string = randomUUID(),
    accepted?: AcceptedOperationCallback
  ): Promise<OperationWithResource> {
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.provisionImessageDedicatedLine(
          {
            headers: { idempotencyKey },
            path: { id: projectId }
          },
          options
        ),
      accepted
    )
    return await this.#waitForProvisionedResource(
      projectId,
      { operation: initial.operation },
      'imessage',
      initial.retryAfterSeconds
    )
  }

  async purchaseSmsNumber(
    projectId: string,
    input: SmsPurchaseInput,
    idempotencyKey: string = randomUUID(),
    accepted?: AcceptedOperationCallback
  ): Promise<OperationWithResource> {
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.purchaseSmsNumber(
          {
            body: {
              countryCode: input.countryCode,
              ...(input.areaCode === undefined
                ? {}
                : { areaCode: input.areaCode })
            },
            headers: { idempotencyKey },
            path: { id: projectId }
          },
          options
        ),
      accepted
    )
    return await this.#waitForProvisionedResource(
      projectId,
      { operation: initial.operation },
      'sms',
      initial.retryAfterSeconds
    )
  }

  async resumeResourceProvisioning(
    projectId: string,
    operationId: string,
    ability: Extract<PlatformAbility, 'imessage' | 'sms' | 'whatsapp_business'>
  ): Promise<OperationWithResource> {
    return await this.#waitForProvisionedResource(
      projectId,
      await this.#refreshOperation(projectId, operationId),
      ability,
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS
    )
  }

  async resumeEmailDomainConnection(
    projectId: string,
    operationId: string
  ): Promise<EmailDomainConnection> {
    return await this.#waitForEmailDomainConnection(
      projectId,
      await this.#refreshOperation(projectId, operationId),
      EMAIL_DOMAIN_OPERATION_RETRY_AFTER_SECONDS
    )
  }

  async waitForEmailDomainVerification(
    projectId: string,
    operationId: string
  ): Promise<EmailDomainConnection> {
    return await this.#waitForEmailDomainConnection(
      projectId,
      await this.#refreshOperation(projectId, operationId),
      EMAIL_DOMAIN_OPERATION_RETRY_AFTER_SECONDS,
      false
    )
  }

  async releaseSharedLineAssignment(projectId: string, assignmentId: string) {
    return await this.#execute((options) =>
      this.#scope.platforms.imessage.assignments.release(
        { path: { assignmentId, id: projectId } },
        options
      )
    )
  }

  async disconnectEmailDomain(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback
  ): Promise<GetOperationOutput> {
    const resource = await this.getResource(projectId, resourceId)
    if (resource.type !== 'email_domain') {
      throw new CliError(
        'ARGUMENT_VALIDATION',
        'The command contains invalid input.',
        {
          detail: `Resource ${resourceId} is not an email domain.`,
          exitCode: 2,
          next: [{ description: 'Pass the resource ID of an email domain.' }]
        }
      )
    }
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.releaseResource(
          { path: { id: projectId, resourceId } },
          options
        ),
      accepted,
      (result) =>
        validateReleaseOperation(result, {
          detail: EMAIL_DOMAIN_RELEASE_MISMATCH,
          projectId,
          resourceId,
          resourceType: 'email_domain'
        })
    )
    return await this.#waitForRelease(
      projectId,
      { operation: initial.operation },
      initial.retryAfterSeconds,
      {
        detail: EMAIL_DOMAIN_RELEASE_MISMATCH,
        operationId: initial.operation.operationId,
        resourceId,
        resourceType: 'email_domain'
      }
    )
  }

  async resumeEmailDomainDisconnection(
    projectId: string,
    resourceId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    return await this.#waitForRelease(
      projectId,
      await this.getOperation(projectId, operationId),
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS,
      {
        detail: EMAIL_DOMAIN_RELEASE_MISMATCH,
        operationId,
        resourceId,
        resourceType: 'email_domain'
      }
    )
  }

  async getTelegramBot(
    projectId: string,
    resourceId: string
  ): Promise<PlatformResource> {
    const resource = await this.getResource(projectId, resourceId)
    if (resource.type !== TELEGRAM_BOT_RESOURCE_TYPE) {
      throw new CliError(
        'ARGUMENT_VALIDATION',
        'The command contains invalid input.',
        {
          detail: `Resource ${resourceId} is not a Telegram bot.`,
          exitCode: 2,
          next: [{ description: 'Pass the resource ID of a Telegram bot.' }]
        }
      )
    }
    return resource
  }

  async disconnectTelegramBot(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback
  ): Promise<GetOperationOutput> {
    await this.getTelegramBot(projectId, resourceId)
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.releaseResource(
          { path: { id: projectId, resourceId } },
          options
        ),
      accepted,
      (result) =>
        validateTelegramBotReleaseOperation(result, projectId, resourceId)
    )
    return await this.#waitForTelegramBotRelease(
      projectId,
      resourceId,
      { operation: initial.operation },
      initial.retryAfterSeconds
    )
  }

  async resumeTelegramBotDisconnection(
    projectId: string,
    resourceId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    return await this.#waitForTelegramBotRelease(
      projectId,
      resourceId,
      await this.getOperation(projectId, operationId),
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS,
      operationId
    )
  }

  // The operation is checked before the wait and at every poll. A stored
  // operation ID that names other work must not be reported as this bot's
  // disconnection.
  async #waitForTelegramBotRelease(
    projectId: string,
    resourceId: string,
    initial: GetOperationOutput,
    operationRetryAfterSeconds: number,
    operationId = initial.operation.operationId
  ): Promise<GetOperationOutput> {
    const check = (result: GetOperationOutput) =>
      validateTelegramBotReleaseOperation(
        result,
        projectId,
        resourceId,
        operationId
      )
    check(initial)
    return await this.#waitForResourceOperation(
      projectId,
      initial,
      operationRetryAfterSeconds,
      check
    )
  }

  async releaseSmsNumber(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback,
    knownResource?: PlatformResource
  ): Promise<GetOperationOutput> {
    const resource =
      knownResource ?? (await this.getResource(projectId, resourceId))
    if (!resource.abilities.includes('sms')) {
      throw new CliError(
        'ARGUMENT_VALIDATION',
        'The command contains invalid input.',
        {
          detail: `Resource ${resourceId} does not have the SMS ability.`,
          exitCode: 2,
          next: [
            { description: 'Pass the resource ID of an SMS-capable resource.' }
          ]
        }
      )
    }
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.releaseResource(
          { path: { id: projectId, resourceId } },
          options
        ),
      accepted,
      (result) =>
        validateReleaseOperation(result, {
          detail: SMS_RELEASE_MISMATCH,
          projectId,
          resourceId
        })
    )
    return await this.#waitForRelease(
      projectId,
      { operation: initial.operation },
      initial.retryAfterSeconds,
      {
        detail: SMS_RELEASE_MISMATCH,
        operationId: initial.operation.operationId,
        resourceId
      }
    )
  }

  // A number the replay finds already released has no operation to read, so
  // the replay gives the resource as Photon sends it.
  async replaySmsNumberRelease(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback
  ): Promise<GetOperationOutput | { resource: PlatformResource }> {
    const resource = await this.getResource(projectId, resourceId)
    if (isRetiredResource(resource, projectId)) {
      return { resource }
    }
    return await this.releaseSmsNumber(
      projectId,
      resourceId,
      accepted,
      resource
    )
  }

  async resumeSmsNumberRelease(
    projectId: string,
    resourceId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    return await this.#waitForRelease(
      projectId,
      await this.getOperation(projectId, operationId),
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS,
      { detail: SMS_RELEASE_MISMATCH, operationId, resourceId }
    )
  }

  async releaseWhatsappBusinessNumber(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback,
    validatedResource?: WhatsappBusinessNumber
  ): Promise<GetOperationOutput> {
    const resource = validateWhatsappBusinessNumberResource(
      validatedResource ?? (await this.getResource(projectId, resourceId)),
      projectId,
      {
        requireAbility: true,
        requireActive: true,
        wrongTypeIsProtocol: false
      }
    )
    if (
      resource.projectId !== projectId ||
      resource.resourceId !== resourceId
    ) {
      throw whatsappArgumentError(
        `Resource ${resourceId} does not match the validated WhatsApp Business sender.`,
        'Run the delete command again and confirm the displayed phone number.'
      )
    }
    return await this.#releaseWhatsappBusinessNumber(
      projectId,
      resourceId,
      accepted
    )
  }

  // A sender the replay finds already retired has no operation to read, so
  // the replay gives the sender as Photon sends it.
  async replayWhatsappBusinessNumberRelease(
    projectId: string,
    resourceId: string,
    accepted?: AcceptedOperationCallback
  ): Promise<GetOperationOutput | { resource: PlatformResource }> {
    const resource = await this.getResource(projectId, resourceId)
    if (isRetiredWhatsappBusinessNumber(resource, projectId)) {
      return { resource }
    }
    validateWhatsappBusinessNumberResource(resource, projectId, {
      requireAbility: true,
      requireActive: true,
      wrongTypeIsProtocol: false
    })
    return await this.#releaseWhatsappBusinessNumber(
      projectId,
      resourceId,
      accepted
    )
  }

  async resumeWhatsappBusinessNumberRelease(
    projectId: string,
    resourceId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    const check = (result: GetOperationOutput) =>
      validateWhatsappBusinessReleaseOperation(
        result,
        projectId,
        resourceId,
        operationId
      )
    const initial = await this.getOperation(projectId, operationId)
    check(initial)
    return await this.#waitForResourceOperation(
      projectId,
      initial,
      DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS,
      check
    )
  }

  async isEmailDomainDisconnected(
    projectId: string,
    resourceId: string
  ): Promise<boolean> {
    return await this.#isReleased(projectId, resourceId, isRetiredResource)
  }

  async isSmsNumberReleased(
    projectId: string,
    resourceId: string
  ): Promise<boolean> {
    return await this.#isReleased(projectId, resourceId, isRetiredResource)
  }

  async isTelegramBotDisconnected(
    projectId: string,
    resourceId: string
  ): Promise<boolean> {
    return await this.#isReleased(projectId, resourceId, () => false)
  }

  async isWhatsappBusinessNumberReleased(
    projectId: string,
    resourceId: string
  ): Promise<boolean> {
    return await this.#isReleased(
      projectId,
      resourceId,
      isRetiredWhatsappBusinessNumber
    )
  }

  async resetAgentAvatar(
    projectId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<ResetAgentProfileAvatarOutput> {
    return await this.#execute((options) =>
      this.#scope.agentProfile.resetAvatar(
        { headers: { idempotencyKey }, path: { projectId } },
        options
      )
    )
  }

  async revokeApiKey(
    projectId: string,
    apiKeyId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<RevokeProjectApiKeyOutput> {
    return await this.#execute((options) =>
      this.#scope.revokeProjectApiKey(
        {
          headers: { idempotencyKey },
          path: { apiKeyId, projectId }
        },
        options
      )
    )
  }

  async rotateWebhookSigningSecret(
    projectId: string,
    destinationId: string,
    overlapSeconds: number,
    idempotencyKey: string = randomUUID()
  ): Promise<RotateWebhookSigningSecretOutput> {
    return await this.#execute(
      (options) =>
        this.#scope.rotateWebhookSigningSecret(
          {
            body: { overlapSeconds },
            headers: { idempotencyKey },
            path: { destinationId, projectId }
          },
          options
        ),
      true
    )
  }

  async update(
    projectId: string,
    name: string,
    idempotencyKey: string = randomUUID()
  ): Promise<UpdateProjectOutput> {
    return await this.#execute((options) =>
      this.#scope.update(
        {
          body: { name },
          headers: { idempotencyKey },
          path: { projectId }
        },
        options
      )
    )
  }

  async updateWebhookDestination(
    projectId: string,
    destinationId: string,
    changes: WebhookDestinationChanges,
    idempotencyKey: string = randomUUID()
  ): Promise<UpdateWebhookDestinationOutput> {
    return await this.#execute((options) =>
      this.#scope.updateWebhookDestination(
        {
          body: changes,
          headers: { idempotencyKey },
          path: { destinationId, projectId }
        },
        options
      )
    )
  }

  async updateAgentProfile(
    projectId: string,
    changes: AgentProfileChanges,
    idempotencyKey: string = randomUUID()
  ): Promise<UpdateAgentProfileOutput> {
    return await this.#execute((options) =>
      this.#scope.agentProfile.update(
        {
          body: changes,
          headers: { idempotencyKey },
          path: { projectId }
        },
        options
      )
    )
  }

  async uploadAgentAvatar(
    projectId: string,
    fileOrPath: AvatarFile | string,
    idempotencyKey: string = randomUUID(),
    beforeCommit?: (uploadId: string) => Promise<void>
  ): Promise<CommitAgentProfileAvatarOutput> {
    const file =
      typeof fileOrPath === 'string'
        ? await prepareAvatarFile(fileOrPath)
        : fileOrPath
    const upload = await this.#execute((options) =>
      this.#scope.agentProfile.createAvatarUpload(
        {
          body: { contentType: file.contentType },
          path: { projectId }
        },
        options
      )
    )
    await uploadAvatarFile(upload, file, {
      fetch: this.#fetch,
      protocolErrorCode: 'PROJECT_PROTOCOL_ERROR',
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      timeoutMs: this.#timeoutMs
    })

    await beforeCommit?.(upload.uploadId)
    return await this.commitAgentAvatar(
      projectId,
      upload.uploadId,
      idempotencyKey
    )
  }

  async #releaseWhatsappBusinessNumber(
    projectId: string,
    resourceId: string,
    accepted: AcceptedOperationCallback | undefined
  ): Promise<GetOperationOutput> {
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.releaseResource(
          { path: { id: projectId, resourceId } },
          options
        ),
      accepted,
      (result) =>
        validateWhatsappBusinessReleaseOperation(result, projectId, resourceId)
    )
    if (initial.status !== 200 && initial.status !== 202) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail: `The resource release returned unexpected HTTP status ${initial.status.toString()}.`,
          remoteOperationId: initial.operation.operationId
        }
      )
    }
    if (
      initial.status === 200 &&
      isResourceOperationInProgress(initial.operation.state)
    ) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail: 'A synchronous resource release was not terminal.',
          remoteOperationId: initial.operation.operationId
        }
      )
    }
    return await this.#waitForResourceOperation(
      projectId,
      { operation: initial.operation },
      initial.retryAfterSeconds,
      (result) =>
        validateWhatsappBusinessReleaseOperation(
          result,
          projectId,
          resourceId,
          initial.operation.operationId
        )
    )
  }

  async #isReleased(
    projectId: string,
    resourceId: string,
    isFinal: (resource: PlatformResource, projectId: string) => boolean
  ): Promise<boolean> {
    try {
      return isFinal(await this.getResource(projectId, resourceId), projectId)
    } catch (error) {
      if (error instanceof CliError && error.httpStatus === 404) {
        return true
      }
      throw error
    }
  }

  #resourceRawScope(): ProjectRawScope {
    if (this.#rawScope === undefined) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon could not access the raw project API client.',
        {}
      )
    }
    return this.#rawScope
  }

  async #acceptResourceOperation(
    request: (
      options?: RequestOptions
    ) => Promise<RawResponse<ResourceOperation>>,
    accepted: AcceptedOperationCallback | undefined,
    check?: (result: GetOperationOutput) => void
  ): Promise<AcceptedOperation> {
    const response = await this.#execute(request)
    check?.({ operation: response.data })
    try {
      await accepted?.(response.data.operationId)
    } catch (error) {
      throw copyCliError(normalizeCliError(error), {
        remoteOperationId: response.data.operationId
      })
    }
    const isEmailDomain = response.data.resourceType === 'email_domain'
    const requestedRetryAfterSeconds = retryAfterSeconds(
      response.headers,
      isEmailDomain
        ? EMAIL_DOMAIN_OPERATION_RETRY_AFTER_SECONDS
        : DEFAULT_RESOURCE_OPERATION_RETRY_AFTER_SECONDS
    )
    return {
      operation: response.data,
      retryAfterSeconds: isEmailDomain
        ? Math.min(
            requestedRetryAfterSeconds,
            EMAIL_DOMAIN_OPERATION_RETRY_AFTER_SECONDS
          )
        : requestedRetryAfterSeconds,
      status: response.status
    }
  }

  async #listProvisioningOperations(
    projectId: string,
    resourceType: string
  ): Promise<ProvisioningOperation[]> {
    const operations: ProvisioningOperation[] = []
    const seenTokens = new Set<string>()
    let pageToken: string | undefined
    let pagesFetched = 0

    while (pagesFetched < MAXIMUM_PAGINATION_PAGES) {
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw paginationError(
            'Photon returned a repeated operation pagination token.'
          )
        }
        seenTokens.add(pageToken)
      }
      // biome-ignore lint/performance/noAwaitInLoops: pagination requests are sequential by protocol.
      const page = await this.#execute((options) =>
        this.#scope.platforms.listOperations(
          {
            path: { id: projectId },
            query: {
              pageSize: RESOURCE_OPERATION_PAGE_SIZE_LIMIT,
              ...(pageToken === undefined ? {} : { pageToken }),
              state: 'pending,running',
              type: 'resource.provision'
            }
          },
          options
        )
      )
      pagesFetched += 1
      if (page.operations.length > RESOURCE_OPERATION_PAGE_SIZE_LIMIT) {
        throw paginationError('Photon returned more operations than requested.')
      }
      operations.push(
        ...page.operations.filter(
          (operation) =>
            operation.resourceType === resourceType &&
            operation.type === 'resource.provision' &&
            isResourceOperationInProgress(operation.state)
        )
      )
      if (page.nextPageToken === undefined) {
        return operations
      }
      pageToken = page.nextPageToken
    }
    throw paginationError(
      'Photon returned too many operation pagination pages.'
    )
  }

  async #waitForProvisionedResource(
    projectId: string,
    initial: GetOperationOutput,
    ability: Extract<PlatformAbility, 'imessage' | 'sms' | 'whatsapp_business'>,
    operationRetryAfterSeconds: number
  ): Promise<OperationWithResource> {
    let result = await this.#waitForResourceOperation(
      projectId,
      initial,
      operationRetryAfterSeconds
    )
    if (result.resource === undefined) {
      result = await this.#waitForResourceOperation(
        projectId,
        await this.#refreshOperation(projectId, result.operation.operationId),
        operationRetryAfterSeconds
      )
    }
    const { resource } = result
    if (resource === undefined) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail:
            'A successful resource provisioning operation did not include its resource.',
          remoteOperationId: result.operation.operationId
        }
      )
    }
    if (!resource.abilities.includes(ability)) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail: `The provisioned resource does not have the requested ${ability} ability.`,
          next: [
            { description: 'Contact Photon support before provisioning again.' }
          ],
          remoteOperationId: result.operation.operationId
        }
      )
    }
    return { ...result, resource }
  }

  async #waitForEmailDomainConnection(
    projectId: string,
    initial: GetOperationOutput,
    operationRetryAfterSeconds: number,
    returnWhenDnsRecordsReady = true
  ): Promise<EmailDomainConnection> {
    let result = initial
    this.#assertEmailDomainConnectionOperation(result.operation, projectId)
    while (isResourceOperationInProgress(result.operation.state)) {
      const selection = selectEmailDomainOperationDetail(
        result.operation.detail
      )
      if (selection.status === 'present' && returnWhenDnsRecordsReady) {
        return {
          ...automaticEmailDomainSetupResult(selection.automaticSetup),
          dnsRecords: selection.records,
          response: result
        }
      }
      if (selection.status === 'invalid') {
        throw new CliError(
          'PROJECT_PROTOCOL_ERROR',
          'Photon returned invalid email-domain setup instructions.',
          {
            remoteOperationId: result.operation.operationId
          }
        )
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: remote operations are polled serially.
        await this.#clock.sleep(operationRetryAfterSeconds * 1000, this.#signal)
        const next = await this.getOperation(
          projectId,
          result.operation.operationId
        )
        if (next.operation.operationId !== initial.operation.operationId) {
          throw new CliError(
            'PROJECT_PROTOCOL_ERROR',
            'Photon returned an invalid project response.',
            {
              detail: 'The operation poll returned a different operation ID.',
              remoteOperationId: initial.operation.operationId
            }
          )
        }
        result = next
        this.#assertEmailDomainConnectionOperation(result.operation, projectId)
      } catch (error) {
        throw copyCliError(normalizeCliError(error), {
          remoteOperationId: initial.operation.operationId
        })
      }
    }

    let terminal = await this.#waitForResourceOperation(
      projectId,
      result,
      operationRetryAfterSeconds
    )
    if (terminal.resource === undefined) {
      const refreshed = await this.getOperation(
        projectId,
        terminal.operation.operationId
      )
      this.#assertEmailDomainConnectionOperation(refreshed.operation, projectId)
      if (refreshed.operation.operationId !== initial.operation.operationId) {
        throw new CliError(
          'PROJECT_PROTOCOL_ERROR',
          'Photon returned an invalid project response.',
          {
            detail: 'The operation refresh returned a different operation ID.',
            remoteOperationId: initial.operation.operationId
          }
        )
      }
      terminal = await this.#waitForResourceOperation(
        projectId,
        refreshed,
        operationRetryAfterSeconds
      )
    }
    const selection = selectEmailDomainOperationDetail(
      terminal.operation.detail
    )
    if (selection.status !== 'present' || terminal.resource === undefined) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid email-domain connection response.',
        {
          detail:
            'A successful email-domain operation did not include its DNS instructions and resource.',
          remoteOperationId: terminal.operation.operationId
        }
      )
    }
    if (
      terminal.resource.type !== 'email_domain' ||
      !terminal.resource.abilities.includes('email')
    ) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid email-domain resource.',
        {
          next: [
            { description: 'Contact Photon support before connecting again.' }
          ],
          remoteOperationId: terminal.operation.operationId
        }
      )
    }
    return {
      ...automaticEmailDomainSetupResult(selection.automaticSetup),
      dnsRecords: selection.records,
      response: terminal
    }
  }

  async #startTelegramBotConnection(
    projectId: string,
    idempotencyKey: string,
    accepted: AcceptedOperationCallback | undefined
  ): Promise<TelegramBotConnection> {
    const initial = await this.#acceptResourceOperation(
      (options) =>
        this.#resourceRawScope().platforms.connectTelegramBot(
          { body: {}, headers: { idempotencyKey }, path: { id: projectId } },
          options
        ),
      accepted
    )
    this.#assertTelegramBotConnectionOperation(initial.operation, projectId)
    return telegramBotConnection({ operation: initial.operation }, false)
  }

  async #telegramBotConnection(
    projectId: string,
    operationId: string,
    resumed: boolean
  ): Promise<TelegramBotConnection> {
    const result = await this.#refreshOperation(projectId, operationId)
    this.#assertTelegramBotConnectionOperation(result.operation, projectId)
    return telegramBotConnection(result, resumed)
  }

  #assertTelegramBotConnectionOperation(
    operation: ResourceOperation,
    projectId: string
  ): void {
    if (
      operation.projectId === projectId &&
      operation.resourceType === TELEGRAM_BOT_RESOURCE_TYPE &&
      operation.type === 'resource.provision'
    ) {
      return
    }
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid Telegram bot operation.',
      {
        remoteOperationId: operation.operationId
      }
    )
  }

  #assertEmailDomainConnectionOperation(
    operation: ResourceOperation,
    projectId: string,
    idFrom: 'person' | 'photon' = 'photon'
  ): void {
    if (operation.projectId === projectId) {
      if (
        operation.type === 'resource.provision' &&
        operation.resourceType === 'email_domain'
      ) {
        return
      }
      const detail =
        idFrom === 'person' ? notEmailDomainSetupDetail(operation) : undefined
      if (detail !== undefined) {
        throw argumentValidationError(detail, {
          next: [
            { description: 'Pass the operation ID of an email-domain setup.' }
          ]
        })
      }
    }
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid email-domain operation.',
      {
        remoteOperationId: operation.operationId
      }
    )
  }

  async #waitForRelease(
    projectId: string,
    initial: GetOperationOutput,
    operationRetryAfterSeconds: number,
    release: {
      detail: string
      operationId: string
      resourceId: string
      resourceType?: string
    }
  ): Promise<GetOperationOutput> {
    const expected = { ...release, projectId }
    const check = (result: GetOperationOutput) =>
      validateReleaseOperation(result, expected)
    check(initial)
    return await this.#waitForResourceOperation(
      projectId,
      initial,
      operationRetryAfterSeconds,
      check
    )
  }

  async #refreshOperation(
    projectId: string,
    operationId: string
  ): Promise<GetOperationOutput> {
    const refreshed = await this.getOperation(projectId, operationId)
    if (refreshed.operation.operationId !== operationId) {
      throw new CliError(
        'PROJECT_PROTOCOL_ERROR',
        'Photon returned an invalid project response.',
        {
          detail: 'The operation refresh returned a different operation ID.',
          remoteOperationId: operationId
        }
      )
    }
    return refreshed
  }

  // The operation is given and returned as the response that holds it: an
  // operation read, or a mutation's answer wrapped as { operation }.
  async #waitForResourceOperation(
    projectId: string,
    initial: GetOperationOutput,
    operationRetryAfterSeconds: number,
    check?: (result: GetOperationOutput) => void
  ): Promise<GetOperationOutput> {
    let result = initial
    try {
      while (isResourceOperationInProgress(result.operation.state)) {
        // biome-ignore lint/performance/noAwaitInLoops: remote operations are polled serially.
        await this.#clock.sleep(operationRetryAfterSeconds * 1000, this.#signal)
        const next = await this.getOperation(
          projectId,
          result.operation.operationId
        )
        if (next.operation.operationId !== initial.operation.operationId) {
          throw new CliError(
            'PROJECT_PROTOCOL_ERROR',
            'Photon returned an invalid project response.',
            {
              detail: 'The operation poll returned a different operation ID.',
              remoteOperationId: initial.operation.operationId
            }
          )
        }
        check?.(next)
        result = next
      }
    } catch (error) {
      throw copyCliError(normalizeCliError(error), {
        remoteOperationId: initial.operation.operationId
      })
    }

    const state = result.operation.state.toLowerCase()
    if (state === 'succeeded') {
      return result
    }
    if (state === 'failed') {
      throw new CliError(
        result.operation.error?.code ?? 'PROJECT_OPERATION_FAILED',
        'Photon could not complete the resource operation.',
        {
          detail:
            result.operation.error?.detail ??
            'The remote operation failed without additional detail.',
          next: [
            {
              description:
                'Review the failure detail before starting another resource operation.'
            }
          ],
          reason: result.operation.error?.code ?? 'failed',
          remoteOperationId: result.operation.operationId
        }
      )
    }
    if (state === 'cancelled') {
      throw new CliError(
        'PROJECT_OPERATION_CANCELLED',
        'The resource operation was cancelled.',
        {
          detail:
            result.operation.error?.detail ??
            'Photon cancelled the remote operation before it completed.',
          next: [
            {
              description:
                'Start a new resource operation if it is still needed.'
            }
          ],
          reason: result.operation.error?.code ?? 'cancelled',
          remoteOperationId: result.operation.operationId
        }
      )
    }
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'Photon returned an invalid project response.',
      {
        detail: `The resource operation returned unknown state "${result.operation.state}".`,
        remoteOperationId: result.operation.operationId
      }
    )
  }

  async #execute<Result>(
    request: (options?: RequestOptions) => Promise<Result>,
    sensitive = false
  ): Promise<Result> {
    try {
      return await this.#request.run(request)
    } catch (error) {
      throw normalizeSdkError(error, {
        sensitive,
        ...(this.#signal === undefined ? {} : { signal: this.#signal })
      })
    }
  }

  // The API's envelope, with the items of every page fetched and the token
  // for the page after them. Its other fields come from the last page.
  async #paginateEnvelope<ItemKey extends string, Result>(
    options: PaginatedEnvelopeRequest<ItemKey, Result>
  ): Promise<PaginatedEnvelope<ItemKey, Result>> {
    let lastPage: object = {}
    const result = await this.#paginate({
      limit: options.limit,
      maximumPageSize: options.maximumPageSize,
      ...(options.pageToken === undefined
        ? {}
        : { pageToken: options.pageToken }),
      request: async (pageSize, pageToken) => {
        const response = await options.request(pageSize, pageToken)
        lastPage = response
        return {
          items: response[options.itemKey],
          ...(response.nextPageToken === undefined
            ? {}
            : { nextPageToken: response.nextPageToken })
        }
      }
    })
    const { nextPageToken: _lastPageToken, ...fields } = lastPage as {
      nextPageToken?: string
    }
    return (
      result.nextPageToken === undefined
        ? { ...fields, [options.itemKey]: result.items }
        : {
            ...lastPage,
            [options.itemKey]: result.items,
            nextPageToken: result.nextPageToken
          }
    ) as PaginatedEnvelope<ItemKey, Result>
  }

  async #paginate<Result>(
    options: PaginationRequest<Result>
  ): Promise<Page<Result>> {
    assertLimit(options.limit)
    const items: Result[] = []
    const seenTokens = new Set<string>()
    const { pageToken: initialPageToken } = options
    let pageToken = initialPageToken
    let pagesFetched = 0

    while (items.length < options.limit) {
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) {
          throw paginationError(
            'Photon returned a repeated project pagination token.'
          )
        }
        seenTokens.add(pageToken)
      }
      if (pagesFetched >= MAXIMUM_PAGINATION_PAGES) {
        throw paginationError(
          'Photon returned too many project pagination pages.'
        )
      }
      const pageSize = Math.min(
        options.maximumPageSize,
        options.limit - items.length
      )
      // biome-ignore lint/performance/noAwaitInLoops: pagination requests are sequential by protocol.
      const page = await options.request(pageSize, pageToken)
      pagesFetched += 1
      if (page.items.length > pageSize) {
        throw paginationError(
          'Photon returned more project records than requested.'
        )
      }
      items.push(...page.items)

      if (page.items.length === 0 || page.nextPageToken === undefined) {
        return { items }
      }
      pageToken = page.nextPageToken
    }

    return {
      items,
      ...(pageToken === undefined ? {} : { nextPageToken: pageToken })
    }
  }

  #projectFilterQuery(filters: ProjectFilters): {
    createdAfter?: string
    createdBefore?: string
    query?: string
  } {
    return {
      ...(filters.createdAfter === undefined
        ? {}
        : { createdAfter: filters.createdAfter }),
      ...(filters.createdBefore === undefined
        ? {}
        : { createdBefore: filters.createdBefore }),
      ...(filters.search === undefined ? {} : { query: filters.search })
    }
  }
}
