import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { z } from 'zod'
import { argumentValidationError } from '../core/errors.ts'
import { API_KEY_CREDENTIAL_PATTERN, validateId } from '../core/photon-id.ts'
import { shellArgument } from '../core/presenter.ts'
import {
  boundedText,
  invalidInput,
  validateOpaqueToken,
  validatePersonName
} from '../core/validation.ts'
import { CLI_NAME } from '../meta.ts'
import {
  type ApiKeyPermission,
  validateApiKeyPermissions
} from './api-contract.ts'
import {
  type AgentProfileChanges,
  MAXIMUM_PAGINATION_LIMIT,
  type ProjectFilters,
  type SharedLineAssignmentInput,
  type WebhookDestinationChanges,
  type WebhookDestinationCreateInput,
  type WebhookDestinationStatus,
  type WebhookEnabledEvents
} from './service.ts'

const BILLING_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const EMAIL_DOMAIN_FORBIDDEN_INPUT_PATTERN = /[/:@*?#\\]/u
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u
const E164_PATTERN = /^\+[1-9]\d{1,14}$/u
const API_KEY_SECRET_TAIL_PATTERN = /(pho_sk_[^\s_]*)_\S*/gu
const WEBHOOK_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u
const MAX_IDENTIFIER_LENGTH = 512
const MAX_NAME_LENGTH = 256
const MAX_API_KEY_NAME_LENGTH = 128
const MAX_PAGE_TOKEN_LENGTH = 4096
const MAX_WEBHOOK_DESCRIPTION_LENGTH = 1000
const MAX_WEBHOOK_EVENTS = 256
const MAX_WEBHOOK_URL_LENGTH = 2048
const MAX_WEBHOOK_ROTATION_OVERLAP_SECONDS = 7 * 24 * 60 * 60
const RFC3339_TIMESTAMP = z.iso.datetime({ offset: true })
const WEBHOOK_API_VERSION = z.iso.date()
const WHITESPACE_PATTERN = /\s/u

export const isValidIdentifierText = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      WHITESPACE_PATTERN.test(character) ||
      codePoint < 32 ||
      codePoint === 127 ||
      (codePoint >= 128 && codePoint <= 159) ||
      FORMAT_CHARACTER_PATTERN.test(character)
    ) {
      return false
    }
  }
  return true
}

export const validateIdentifier = (value: string, label: string): string => {
  const identifier = boundedText(value, label, MAX_IDENTIFIER_LENGTH)
  if (!isValidIdentifierText(identifier)) {
    throw invalidInput(`${label} cannot contain whitespace.`)
  }
  return identifier
}

export const withoutApiKeySecrets = (value: string): string =>
  value.replaceAll(API_KEY_SECRET_TAIL_PATTERN, '$1')

export const validateApiKeyId = (
  value: string,
  args: readonly string[]
): string => {
  const normalized = validateIdentifier(value, 'API key ID')
  if (API_KEY_CREDENTIAL_PATTERN.test(normalized)) {
    throw argumentValidationError(
      'The value is a full API key. Only its ID is accepted.',
      {
        next: [
          {
            description: 'Revoke the key by its ID',
            run: [
              CLI_NAME,
              ...args.map((arg) => shellArgument(withoutApiKeySecrets(arg)))
            ].join(' ')
          },
          {
            description: 'List the API key IDs',
            run: `${CLI_NAME} project api-key list`
          }
        ]
      }
    )
  }
  return validateId('apiKey', normalized, 'API key ID')
}

export const validateWebhookDestinationId = (value: string): string =>
  validateId('webhookDestination', value, 'Webhook destination ID')

export const validateWebhookApiVersion = (value: string): string => {
  const apiVersion = boundedText(value, 'Webhook API version', 10)
  if (!WEBHOOK_API_VERSION.safeParse(apiVersion).success) {
    throw invalidInput(
      'Webhook API version must be a valid calendar date in YYYY-MM-DD format.'
    )
  }
  return apiVersion
}

const validateWebhookUrl = (value: string): string => {
  const input = boundedText(value, 'Webhook URL', MAX_WEBHOOK_URL_LENGTH)
  if (!URL.canParse(input)) {
    throw invalidInput('Webhook URL must be a valid absolute HTTPS URL.')
  }
  const url = new URL(input)
  if (url.protocol !== 'https:') {
    throw invalidInput('Webhook URL must use HTTPS.')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalidInput('Webhook URL cannot contain credentials.')
  }
  if (url.hash.length > 0) {
    throw invalidInput('Webhook URL cannot contain a fragment.')
  }
  const canonicalUrl = url.toString()
  if (canonicalUrl.length > MAX_WEBHOOK_URL_LENGTH) {
    throw invalidInput(
      `Webhook URL cannot exceed ${MAX_WEBHOOK_URL_LENGTH.toString()} characters after normalization.`
    )
  }
  return canonicalUrl
}

const validateWebhookEvents = (
  events: string[] | undefined,
  allEvents: boolean,
  required: boolean
): WebhookEnabledEvents | undefined => {
  const hasEvents = events !== undefined && events.length > 0
  if (allEvents && hasEvents) {
    throw invalidInput('Pass either --event or --all-events, not both.')
  }
  if (allEvents) {
    return ['*']
  }
  if (!hasEvents) {
    if (required) {
      throw invalidInput('Pass at least one --event or use --all-events.')
    }
    return
  }
  if (events.length > MAX_WEBHOOK_EVENTS) {
    throw invalidInput(
      `Webhook destinations cannot subscribe to more than ${MAX_WEBHOOK_EVENTS.toString()} events.`
    )
  }
  const normalizedEvents = events.map((event) =>
    boundedText(event, 'Webhook event', MAX_IDENTIFIER_LENGTH)
  )
  if (normalizedEvents.includes('*')) {
    throw invalidInput('Use --all-events instead of passing "*" to --event.')
  }
  const invalidEvent = normalizedEvents.find(
    (event) => !WEBHOOK_EVENT_TYPE_PATTERN.test(event)
  )
  if (invalidEvent !== undefined) {
    throw invalidInput(
      `Webhook event "${invalidEvent}" must use a dotted event type such as message.received.`
    )
  }
  const uniqueEvents = new Set(normalizedEvents)
  if (uniqueEvents.size !== normalizedEvents.length) {
    throw invalidInput('Webhook events must be unique.')
  }
  return [...uniqueEvents].sort()
}

export const validateWebhookDestinationCreateInput = (input: {
  allEvents: boolean
  apiVersion: string
  description?: string
  events?: string[]
  name: string
  status: WebhookDestinationStatus
  url: string
}): WebhookDestinationCreateInput => {
  const enabledEvents = validateWebhookEvents(
    input.events,
    input.allEvents,
    true
  )
  if (enabledEvents === undefined) {
    throw invalidInput('Pass at least one --event or use --all-events.')
  }
  return {
    apiVersion: validateWebhookApiVersion(input.apiVersion),
    ...(input.description === undefined
      ? {}
      : {
          description: boundedText(
            input.description,
            'Webhook description',
            MAX_WEBHOOK_DESCRIPTION_LENGTH
          )
        }),
    enabledEvents,
    name: boundedText(input.name, 'Webhook name', MAX_NAME_LENGTH),
    status: input.status,
    url: validateWebhookUrl(input.url)
  }
}

export const validateWebhookDestinationChanges = (input: {
  allEvents: boolean
  clearDescription: boolean
  description?: string
  events?: string[]
  name?: string
  status?: WebhookDestinationStatus
  url?: string
}): WebhookDestinationChanges => {
  if (input.clearDescription && input.description !== undefined) {
    throw invalidInput(
      'Pass either --description or --clear-description, not both.'
    )
  }
  const enabledEvents = validateWebhookEvents(
    input.events,
    input.allEvents,
    false
  )
  const changes: WebhookDestinationChanges = {}
  if (input.clearDescription) {
    changes.description = null
  } else if (input.description !== undefined) {
    changes.description = boundedText(
      input.description,
      'Webhook description',
      MAX_WEBHOOK_DESCRIPTION_LENGTH,
      'To remove it, pass --clear-description.'
    )
  }
  if (enabledEvents !== undefined) {
    changes.enabledEvents = enabledEvents
  }
  if (input.name !== undefined) {
    changes.name = boundedText(input.name, 'Webhook name', MAX_NAME_LENGTH)
  }
  if (input.status !== undefined) {
    changes.status = input.status
  }
  if (input.url !== undefined) {
    changes.url = validateWebhookUrl(input.url)
  }
  if (Object.keys(changes).length === 0) {
    throw invalidInput(
      'Pass a webhook field to edit, or use --clear-description.'
    )
  }
  return changes
}

export const validateWebhookOverlapSeconds = (
  value: number | undefined
): number => {
  const overlapSeconds = value ?? 86_400
  if (
    !Number.isSafeInteger(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds > MAX_WEBHOOK_ROTATION_OVERLAP_SECONDS
  ) {
    throw invalidInput(
      `Webhook secret overlap must be an integer from 0 to ${MAX_WEBHOOK_ROTATION_OVERLAP_SECONDS.toString()} seconds.`
    )
  }
  return overlapSeconds
}

export const validateProjectName = (value: string): string =>
  boundedText(value, 'Project name', MAX_NAME_LENGTH)

export const validateEmail = (value: string): string => {
  const email = boundedText(value, 'Email', MAX_NAME_LENGTH)
  if (!z.email().safeParse(email).success) {
    throw invalidInput('Email must be a valid address.')
  }
  return email
}

export const validateEmailDomain = (value: string): string => {
  const input = boundedText(value, 'Email domain', 254)
  const withoutRootDot = input.endsWith('.') ? input.slice(0, -1) : input
  if (
    withoutRootDot.length === 0 ||
    EMAIL_DOMAIN_FORBIDDEN_INPUT_PATTERN.test(withoutRootDot)
  ) {
    throw invalidInput(
      'Email domain must be a DNS domain without a scheme, path, port, or wildcard.'
    )
  }
  const domain = domainToASCII(withoutRootDot).toLowerCase()
  if (domain.length === 0 || domain.length > 253) {
    throw invalidInput(
      'Email domain must have a valid IDNA spelling of at most 253 characters.'
    )
  }
  const domainUrl = `http://${domain}`
  if (!URL.canParse(domainUrl)) {
    throw invalidInput('Email domain must be a valid DNS hostname.')
  }
  const { hostname } = new URL(domainUrl)
  if (isIP(domain) !== 0 || isIP(hostname) !== 0) {
    throw invalidInput('Email domain cannot be an IP address.')
  }
  if (
    domain
      .split('.')
      .some((label) => label.length > 63 || !DNS_LABEL_PATTERN.test(label))
  ) {
    throw invalidInput(
      'Email domain contains a malformed or over-length DNS label.'
    )
  }
  return domain
}

export const validatePhoneNumber = (value: string): string => {
  const phoneNumber = boundedText(value, 'Phone number', 16)
  if (!E164_PATTERN.test(phoneNumber)) {
    throw invalidInput(
      'Phone number must use E.164 format, for example +14155550123.'
    )
  }
  return phoneNumber
}

export const validateBillingCategory = (value: string): string => {
  const category = boundedText(value, 'Category', 64)
  if (!BILLING_CATEGORY_PATTERN.test(category)) {
    throw invalidInput(
      'Category must start with a lowercase letter and contain only lowercase letters, numbers, and underscores.'
    )
  }
  return category
}

export const validateBillingOperationId = (value: string): string =>
  validateId('billingOperation', value, 'Operation ID')

export const validatePlatformOperationId = (value: string): string =>
  validateId('platformOperation', value, 'Platform operation ID')

export const validateBillingPlanCode = (value: string): string =>
  boundedText(value, 'Plan code', 64)

export const validatePagination = (
  limit: number | undefined,
  pageToken: string | undefined
): { limit: number; pageToken?: string } => {
  const normalizedLimit = limit ?? 30
  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1) {
    throw invalidInput('Limit must be a positive integer.')
  }
  if (normalizedLimit > MAXIMUM_PAGINATION_LIMIT) {
    throw invalidInput(
      `Limit cannot exceed ${MAXIMUM_PAGINATION_LIMIT.toString()}.`
    )
  }
  if (pageToken === undefined) {
    return { limit: normalizedLimit }
  }
  return {
    limit: normalizedLimit,
    pageToken: validateOpaqueToken(
      pageToken,
      'Page token',
      MAX_PAGE_TOKEN_LENGTH
    )
  }
}

const validateTimestamp = (value: string, label: string): string => {
  const normalized = boundedText(value, label, 128)
  if (!RFC3339_TIMESTAMP.safeParse(normalized).success) {
    throw invalidInput(`${label} must be a valid RFC 3339 timestamp.`)
  }
  return new Date(normalized).toISOString()
}

export const validateApiKeyCreateInput = (input: {
  expiresAt?: string
  name: string
  noExpiry: boolean
  permissions?: string[]
}): { expiresAt?: string; name: string; permissions: ApiKeyPermission[] } => {
  if (input.expiresAt === undefined && !input.noExpiry) {
    throw invalidInput('Pass either --expires-at or --no-expiry.')
  }
  if (input.expiresAt !== undefined && input.noExpiry) {
    throw invalidInput('Pass either --expires-at or --no-expiry, not both.')
  }
  return {
    name: boundedText(input.name, 'API key name', MAX_API_KEY_NAME_LENGTH),
    permissions: validateApiKeyPermissions(input.permissions),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: validateTimestamp(input.expiresAt, 'Expires-at') })
  }
}

export const validateProjectFilters = (input: {
  createdAfter?: string
  createdBefore?: string
  search?: string
}): ProjectFilters => {
  const createdAfter =
    input.createdAfter === undefined
      ? undefined
      : validateTimestamp(input.createdAfter, 'Created-after')
  const createdBefore =
    input.createdBefore === undefined
      ? undefined
      : validateTimestamp(input.createdBefore, 'Created-before')
  if (
    createdAfter !== undefined &&
    createdBefore !== undefined &&
    createdAfter > createdBefore
  ) {
    throw invalidInput('Created-after cannot be later than created-before.')
  }
  return {
    ...(createdAfter === undefined ? {} : { createdAfter }),
    ...(createdBefore === undefined ? {} : { createdBefore }),
    ...(input.search === undefined
      ? {}
      : { search: boundedText(input.search, 'Search', MAX_NAME_LENGTH) })
  }
}

export const validateAgentProfileChanges = (input: {
  clearLastName: boolean
  firstName?: string
  lastName?: string
}): AgentProfileChanges => {
  if (
    input.firstName === undefined &&
    input.lastName === undefined &&
    !input.clearLastName
  ) {
    throw invalidInput(
      'Pass --first-name, --last-name, or --clear-last-name to edit the agent profile.'
    )
  }
  if (input.clearLastName && input.lastName !== undefined) {
    throw invalidInput(
      'Pass either --last-name or --clear-last-name, not both.'
    )
  }
  const changes: AgentProfileChanges = {}
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

export const validateAssignmentInput = (input: {
  email?: string
  firstName?: string
  lastName?: string
  phoneNumber: string
}): SharedLineAssignmentInput => ({
  ...(input.email === undefined ? {} : { email: validateEmail(input.email) }),
  ...(input.firstName === undefined
    ? {}
    : { firstName: validatePersonName(input.firstName, 'First name') }),
  ...(input.lastName === undefined
    ? {}
    : { lastName: validatePersonName(input.lastName, 'Last name') }),
  phoneNumber: validatePhoneNumber(input.phoneNumber)
})
