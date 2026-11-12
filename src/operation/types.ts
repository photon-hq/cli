import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  INTERNAL_OPERATION_DEFINITIONS,
  internalIntentSchemas
} from '#internal'
import { MAXIMUM_AVATAR_BYTES } from '../core/avatar.ts'
import { CliError } from '../core/errors.ts'
import { ID_FORMATS } from '../core/photon-id.ts'
import {
  apiKeyPermissionsSchema,
  projectSlugSchema,
  smsPurchaseInputSchema
} from '../project/api-contract.ts'
import { VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS } from '../project/voice-outbound-authentication.ts'
import {
  identifier,
  legacyOrganizationId,
  SHA256_PATTERN,
  safeText
} from './intent-fields.ts'

export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Account keeps the idempotent Create workflow for 24 hours. Stop replaying
// before that server-side boundary so clock skew and scheduling cannot turn an
// old logical request into a second key.
export const ACCOUNT_SERVICE_KEY_REPLAY_WINDOW_MS =
  24 * 60 * 60 * 1000 - 15 * 60 * 1000

const BILLING_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u
const BILLING_PLAN_CODE_PATTERN = /^(?!\s)(?!.*\s$)[^\p{Cc}\p{Cf}]{1,64}$/u
const LEGACY_BILLING_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u
const E164_PATTERN = /^\+[1-9]\d{1,14}$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/u
const VOICE_PROFILE_ID_PATTERN = ID_FORMATS.voiceProfile.pattern
const WEBHOOK_DESTINATION_ID_PATTERN = ID_FORMATS.webhookDestination.pattern
const WEBHOOK_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/u
export const OPERATION_ID_PATTERN = ID_FORMATS.localOperation.pattern
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const KEYLESS_REPLAY_POLICIES: ReadonlySet<string> = new Set([
  'natural',
  'none'
])

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

// Version 1 records may contain billing values accepted by older CLI builds.
// Keep them readable so one retained record cannot block unrelated keyed work.
const storedBillingCategory = z.union([
  z.string().regex(BILLING_CATEGORY_PATTERN),
  z.string().regex(LEGACY_BILLING_VALUE_PATTERN)
])
const storedBillingPlanCode = z.union([
  z.string().regex(BILLING_PLAN_CODE_PATTERN),
  z.string().regex(LEGACY_BILLING_VALUE_PATTERN)
])
const text = safeText(4096)
const personName = safeText(256)
const projectName = safeText(256)
const assignableRole = z.enum(['member', 'viewer'])

const maximumAvatarBase64Characters = Math.ceil(MAXIMUM_AVATAR_BYTES / 3) * 4
const avatarContents = z
  .string()
  .min(1)
  .max(maximumAvatarBase64Characters)
  .regex(BASE64_PATTERN)

const validateStoredAvatar = (
  intent: {
    fileContents?: string | undefined
    fileDigest: string
    phase: 'commit' | 'upload'
    uploadId?: string | undefined
  },
  context: z.core.$RefinementCtx
): void => {
  if (intent.phase === 'commit' && intent.uploadId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A commit-phase avatar operation requires an upload ID.',
      path: ['uploadId']
    })
  }
  if (intent.phase === 'commit' && intent.fileContents !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A commit-phase avatar operation cannot retain file contents.',
      path: ['fileContents']
    })
  }
  if (intent.phase === 'upload' && intent.uploadId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'An upload-phase avatar operation cannot have an upload ID.',
      path: ['uploadId']
    })
  }
  if (intent.phase === 'upload' && intent.fileContents === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'An upload-phase avatar operation requires file contents.',
      path: ['fileContents']
    })
    return
  }
  if (
    intent.fileContents !== undefined &&
    Buffer.from(intent.fileContents, 'base64').byteLength > MAXIMUM_AVATAR_BYTES
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Stored avatar contents exceed the maximum size.',
      path: ['fileContents']
    })
  }
  if (
    intent.fileContents !== undefined &&
    createHash('sha256')
      .update(Buffer.from(intent.fileContents, 'base64'))
      .digest('hex') !== intent.fileDigest
  ) {
    context.addIssue({
      code: 'custom',
      message: 'The avatar digest does not match the stored file contents.',
      path: ['fileDigest']
    })
  }
}

const apiKeyCreateIntentSchema = z.strictObject({
  expiresAt: z.iso.datetime().optional(),
  kind: z.literal('api-key.create'),
  name: safeText(128),
  permissions: apiKeyPermissionsSchema.optional(),
  projectId: identifier
})

const apiKeyRevokeIntentSchema = z.strictObject({
  apiKeyId: identifier,
  kind: z.literal('api-key.revoke'),
  projectId: identifier
})

const webhookEnabledEventsSchema = z.union([
  z.tuple([z.literal('*')]),
  z
    .array(z.string().regex(WEBHOOK_EVENT_TYPE_PATTERN).max(512))
    .min(1)
    .max(256)
    .refine((events) => new Set(events).size === events.length)
])
const webhookStatusSchema = z.enum(['enabled', 'disabled'])
const webhookUrlSchema = z
  .url()
  .max(2048)
  .refine((url) => {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0
    )
  })

const webhookDestinationCreateIntentSchema = z.strictObject({
  apiVersion: z.iso.date(),
  description: safeText(1000).optional(),
  enabledEvents: webhookEnabledEventsSchema,
  kind: z.literal('webhook-destination.create'),
  name: safeText(256),
  projectId: identifier,
  status: webhookStatusSchema,
  url: webhookUrlSchema
})

const webhookDestinationChangesSchema = z
  .strictObject({
    description: safeText(1000).nullable().optional(),
    enabledEvents: webhookEnabledEventsSchema.optional(),
    name: safeText(256).optional(),
    status: webhookStatusSchema.optional(),
    url: webhookUrlSchema.optional()
  })
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'Webhook destination changes cannot be empty.'
  })

const webhookDestinationUpdateIntentSchema = z.strictObject({
  changes: webhookDestinationChangesSchema,
  destinationId: z.string().regex(WEBHOOK_DESTINATION_ID_PATTERN),
  kind: z.literal('webhook-destination.update'),
  projectId: identifier
})

const webhookDestinationDeleteIntentSchema = z.strictObject({
  destinationId: z.string().regex(WEBHOOK_DESTINATION_ID_PATTERN),
  kind: z.literal('webhook-destination.delete'),
  projectId: identifier
})

const webhookSigningSecretRotateIntentSchema = z.strictObject({
  destinationId: z.string().regex(WEBHOOK_DESTINATION_ID_PATTERN),
  kind: z.literal('webhook-signing-secret.rotate'),
  overlapSeconds: z.number().int().min(0).max(604_800),
  projectId: identifier
})

const accountServiceKeyCreateIntentSchema = z.strictObject({
  expiresAt: z.iso.datetime().optional(),
  kind: z.literal('account-service-key.create'),
  name: safeText(128)
})

const accountServiceKeyRevokeIntentSchema = z.strictObject({
  kind: z.literal('account-service-key.revoke'),
  serviceKeyId: identifier
})

const projectCreateIntentSchema = z.strictObject({
  activate: z.boolean(),
  kind: z.literal('project.create'),
  name: projectName,
  organizationId: legacyOrganizationId,
  slug: projectSlugSchema.optional()
})

const projectUpdateIntentSchema = z.strictObject({
  kind: z.literal('project.update'),
  name: projectName,
  projectId: identifier
})

const projectDeleteIntentSchema = z.strictObject({
  kind: z.literal('project.delete'),
  projectId: identifier
})

const projectLeaveIntentSchema = z.strictObject({
  kind: z.literal('project.leave'),
  projectId: identifier
})

const agentProfileChangesSchema = z
  .strictObject({
    firstName: personName.optional(),
    lastName: personName.nullable().optional()
  })
  .refine(
    (changes) =>
      changes.firstName !== undefined || changes.lastName !== undefined,
    { message: 'Agent-profile changes cannot be empty.' }
  )

const agentProfileUpdateIntentSchema = z.strictObject({
  changes: agentProfileChangesSchema,
  kind: z.literal('agent-profile.update'),
  projectId: identifier
})

const agentAvatarUploadIntentSchema = z
  .strictObject({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    fileContents: avatarContents.optional(),
    fileDigest: z.string().regex(SHA256_PATTERN),
    fileName: safeText(1024),
    kind: z.literal('agent-avatar.upload'),
    phase: z.enum(['upload', 'commit']),
    projectId: identifier,
    uploadId: identifier.optional()
  })
  .superRefine(validateStoredAvatar)

const agentAvatarResetIntentSchema = z.strictObject({
  kind: z.literal('agent-avatar.reset'),
  projectId: identifier
})

const accountChangesSchema = z
  .strictObject({
    firstName: personName.optional(),
    lastName: personName.nullable().optional()
  })
  .refine(
    (changes) =>
      changes.firstName !== undefined || changes.lastName !== undefined,
    { message: 'Account changes cannot be empty.' }
  )

const accountUpdateIntentSchema = z.strictObject({
  changes: accountChangesSchema,
  kind: z.literal('account.update')
})

const accountAvatarUploadIntentSchema = z
  .strictObject({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    fileContents: avatarContents.optional(),
    fileDigest: z.string().regex(SHA256_PATTERN),
    fileName: safeText(1024),
    kind: z.literal('account-avatar.upload'),
    phase: z.enum(['upload', 'commit']),
    uploadId: identifier.optional()
  })
  .superRefine(validateStoredAvatar)

const accountAvatarResetIntentSchema = z.strictObject({
  kind: z.literal('account-avatar.reset')
})

// Project membership and invitations were replaced by organization
// membership. These kinds stay readable so retained records can be inspected,
// but they cannot be replayed.
const memberInviteIntentSchema = z.strictObject({
  email: z.email(),
  kind: z.literal('member.invite'),
  projectId: identifier,
  role: assignableRole
})

const memberUpdateIntentSchema = z.strictObject({
  accountId: identifier,
  kind: z.literal('member.update'),
  projectId: identifier,
  role: assignableRole
})

const memberRemoveIntentSchema = z.strictObject({
  accountId: identifier,
  kind: z.literal('member.remove'),
  projectId: identifier
})

const invitationAcceptIntentSchema = z
  .strictObject({
    kind: z.literal('invitation.accept'),
    token: z.string().min(1).max(4096),
    tokenDigest: z.string().regex(SHA256_PATTERN)
  })
  .refine(
    (intent) =>
      sha256(`invitation-token\0${intent.token}`) === intent.tokenDigest,
    {
      message: 'The invitation token digest does not match the stored token.',
      path: ['tokenDigest']
    }
  )

const invitationRevokeIntentSchema = z.strictObject({
  invitationId: identifier,
  kind: z.literal('invitation.revoke'),
  projectId: identifier
})

const organizationAssignableRole = z.enum(['admin', 'member', 'viewer'])
const organizationInvitationRole = z.enum(['member', 'viewer'])
const membershipVersion = safeText(512)

const organizationMemberInviteIntentSchema = z.strictObject({
  email: z.email(),
  kind: z.literal('organization-member.invite'),
  organizationId: identifier,
  role: organizationInvitationRole
})

const organizationMemberUpdateIntentSchema = z.strictObject({
  accountId: identifier,
  expectedVersion: membershipVersion,
  kind: z.literal('organization-member.update'),
  organizationId: identifier,
  role: organizationAssignableRole
})

const organizationMemberRemoveIntentSchema = z.strictObject({
  accountId: identifier,
  expectedVersion: membershipVersion,
  kind: z.literal('organization-member.remove'),
  organizationId: identifier
})

const organizationLeaveIntentSchema = z.strictObject({
  expectedVersion: membershipVersion,
  kind: z.literal('organization.leave'),
  organizationId: identifier
})

const organizationInvitationAcceptIntentSchema = z
  .strictObject({
    kind: z.literal('organization-invitation.accept'),
    token: z.string().min(1).max(4096),
    tokenDigest: z.string().regex(SHA256_PATTERN)
  })
  .refine(
    (intent) =>
      sha256(`invitation-token\0${intent.token}`) === intent.tokenDigest,
    {
      message: 'The invitation token digest does not match the stored token.',
      path: ['tokenDigest']
    }
  )

const organizationInvitationRevokeIntentSchema = z.strictObject({
  invitationId: identifier,
  kind: z.literal('organization-invitation.revoke'),
  organizationId: identifier
})

const billingPurchaseIntentSchema = z.strictObject({
  category: storedBillingCategory,
  kind: z.literal('billing.plan.purchase'),
  planCode: storedBillingPlanCode,
  projectId: identifier
})

const subscriptionCancelIntentSchema = z.strictObject({
  category: storedBillingCategory,
  kind: z.literal('billing.subscription.cancel'),
  projectId: identifier
})

const subscriptionResumeIntentSchema = z.strictObject({
  category: storedBillingCategory,
  kind: z.literal('billing.subscription.resume'),
  projectId: identifier
})

const assignmentCreateIntentSchema = z.strictObject({
  input: z.strictObject({
    email: z.email().optional(),
    firstName: personName.optional(),
    lastName: personName.optional(),
    phoneNumber: z.string().regex(E164_PATTERN)
  }),
  kind: z.literal('assignment.create'),
  projectId: identifier
})

const assignmentReleaseIntentSchema = z.strictObject({
  assignmentId: identifier,
  kind: z.literal('assignment.release'),
  projectId: identifier
})

const smsNumberDeleteIntentSchema = z.strictObject({
  kind: z.literal('sms-number.delete'),
  projectId: identifier,
  resourceId: identifier
})

const whatsappBusinessNumberDeleteIntentSchema = z.strictObject({
  kind: z.literal('whatsapp-business-number.delete'),
  projectId: identifier,
  resourceId: identifier
})

const whatsappVoipProvisionIntentSchema = z.strictObject({
  displayName: safeText(256).optional(),
  kind: z.literal('whatsapp-business-number.provision'),
  projectId: identifier,
  voipResourceId: identifier,
  wabaId: identifier
})

const voiceProfileReferenceSchema = z.union([
  z.literal('default'),
  z.string().regex(VOICE_PROFILE_ID_PATTERN)
])

const voiceProfileOutboundEnableIntentSchema = z.strictObject({
  digestAlgorithm: z.enum(VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS),
  expectedVersion: z.number().int().positive(),
  kind: z.literal('voice-profile-outbound.enable'),
  profileId: z.string().regex(VOICE_PROFILE_ID_PATTERN),
  profileReference: voiceProfileReferenceSchema,
  projectId: identifier
})

const voiceProfileOutboundRotateIntentSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  kind: z.literal('voice-profile-outbound.rotate'),
  mode: z.enum(['normal', 'emergency']),
  profileId: z.string().regex(VOICE_PROFILE_ID_PATTERN),
  profileReference: voiceProfileReferenceSchema,
  projectId: identifier
})

const smsNumberPurchaseIntentSchema = z.strictObject({
  input: smsPurchaseInputSchema.optional(),
  kind: z.literal('sms-number.purchase'),
  projectId: identifier
})

const imessageDedicatedLinePurchaseIntentSchema = z.strictObject({
  kind: z.literal('imessage-dedicated-line.purchase'),
  projectId: identifier
})

const emailDomainConnectIntentSchema = z.strictObject({
  domain: z.string().min(1).max(253),
  kind: z.literal('email-domain.connect'),
  projectId: identifier
})

const emailDomainDisconnectIntentSchema = z.strictObject({
  kind: z.literal('email-domain.disconnect'),
  projectId: identifier,
  resourceId: identifier
})

const telegramBotConnectIntentSchema = z.strictObject({
  kind: z.literal('telegram-bot.connect'),
  projectId: identifier
})

const telegramBotDisconnectIntentSchema = z.strictObject({
  kind: z.literal('telegram-bot.disconnect'),
  projectId: identifier,
  resourceId: identifier
})

export const operationIntentSchema = z.discriminatedUnion('kind', [
  accountServiceKeyCreateIntentSchema,
  accountServiceKeyRevokeIntentSchema,
  accountUpdateIntentSchema,
  accountAvatarUploadIntentSchema,
  accountAvatarResetIntentSchema,
  projectCreateIntentSchema,
  projectUpdateIntentSchema,
  projectDeleteIntentSchema,
  projectLeaveIntentSchema,
  agentProfileUpdateIntentSchema,
  agentAvatarUploadIntentSchema,
  agentAvatarResetIntentSchema,
  apiKeyCreateIntentSchema,
  apiKeyRevokeIntentSchema,
  webhookDestinationCreateIntentSchema,
  webhookDestinationUpdateIntentSchema,
  webhookDestinationDeleteIntentSchema,
  webhookSigningSecretRotateIntentSchema,
  memberInviteIntentSchema,
  memberUpdateIntentSchema,
  memberRemoveIntentSchema,
  invitationAcceptIntentSchema,
  invitationRevokeIntentSchema,
  organizationMemberInviteIntentSchema,
  organizationMemberUpdateIntentSchema,
  organizationMemberRemoveIntentSchema,
  organizationLeaveIntentSchema,
  organizationInvitationAcceptIntentSchema,
  organizationInvitationRevokeIntentSchema,
  billingPurchaseIntentSchema,
  subscriptionCancelIntentSchema,
  subscriptionResumeIntentSchema,
  assignmentCreateIntentSchema,
  assignmentReleaseIntentSchema,
  emailDomainConnectIntentSchema,
  emailDomainDisconnectIntentSchema,
  telegramBotConnectIntentSchema,
  telegramBotDisconnectIntentSchema,
  imessageDedicatedLinePurchaseIntentSchema,
  smsNumberDeleteIntentSchema,
  smsNumberPurchaseIntentSchema,
  voiceProfileOutboundEnableIntentSchema,
  voiceProfileOutboundRotateIntentSchema,
  whatsappBusinessNumberDeleteIntentSchema,
  whatsappVoipProvisionIntentSchema,
  ...internalIntentSchemas
])

export type OperationIntent = z.infer<typeof operationIntentSchema>
export type OperationKind = OperationIntent['kind']

export type OperationReplayPolicy =
  | 'avatar'
  | 'keyed'
  | 'natural'
  | 'none'
  | 'secret-keyed'

export interface OperationDefinition {
  command: string
  replayPolicy: OperationReplayPolicy
}

export const OPERATION_DEFINITIONS = {
  'account-avatar.reset': {
    command: 'account avatar reset',
    replayPolicy: 'keyed'
  },
  'account-avatar.upload': {
    command: 'account avatar upload',
    replayPolicy: 'avatar'
  },
  'account-service-key.create': {
    command: 'account service-key create',
    replayPolicy: 'keyed'
  },
  'account-service-key.revoke': {
    command: 'account service-key revoke',
    replayPolicy: 'keyed'
  },
  'account.update': {
    command: 'account edit',
    replayPolicy: 'keyed'
  },
  'agent-avatar.reset': {
    command: 'project agent-profile avatar reset',
    replayPolicy: 'keyed'
  },
  'agent-avatar.upload': {
    command: 'project agent-profile avatar upload',
    replayPolicy: 'avatar'
  },
  'agent-profile.update': {
    command: 'project agent-profile edit',
    replayPolicy: 'keyed'
  },
  'api-key.create': {
    command: 'project api-key create',
    replayPolicy: 'keyed'
  },
  'api-key.revoke': {
    command: 'project api-key revoke',
    replayPolicy: 'keyed'
  },
  'assignment.create': {
    command: 'project platform imessage assignment create',
    replayPolicy: 'keyed'
  },
  'assignment.release': {
    command: 'project platform imessage assignment release',
    replayPolicy: 'natural'
  },
  'billing.plan.purchase': {
    command: 'project billing plan purchase',
    replayPolicy: 'keyed'
  },
  'billing.subscription.cancel': {
    command: 'project billing subscription cancel',
    replayPolicy: 'none'
  },
  'billing.subscription.resume': {
    command: 'project billing subscription resume',
    replayPolicy: 'none'
  },
  'email-domain.connect': {
    command: 'project platform email connect',
    replayPolicy: 'keyed'
  },
  'email-domain.disconnect': {
    command: 'project platform email disconnect',
    replayPolicy: 'natural'
  },
  'imessage-dedicated-line.purchase': {
    command: 'project platform imessage purchase',
    replayPolicy: 'keyed'
  },
  'invitation.accept': {
    command: 'project invitation accept',
    replayPolicy: 'secret-keyed'
  },
  'invitation.revoke': {
    command: 'project invitation revoke',
    replayPolicy: 'keyed'
  },
  'member.invite': {
    command: 'project member invite',
    replayPolicy: 'keyed'
  },
  'member.remove': {
    command: 'project member remove',
    replayPolicy: 'keyed'
  },
  'member.update': {
    command: 'project member edit',
    replayPolicy: 'keyed'
  },
  'organization-invitation.accept': {
    command: 'org invitation accept',
    replayPolicy: 'secret-keyed'
  },
  'organization-invitation.revoke': {
    command: 'org invitation revoke',
    replayPolicy: 'keyed'
  },
  'organization-member.invite': {
    command: 'org member invite',
    replayPolicy: 'keyed'
  },
  'organization-member.remove': {
    command: 'org member remove',
    replayPolicy: 'keyed'
  },
  'organization-member.update': {
    command: 'org member edit',
    replayPolicy: 'keyed'
  },
  'organization.leave': {
    command: 'org leave',
    replayPolicy: 'keyed'
  },
  'project.create': {
    command: 'project create',
    replayPolicy: 'keyed'
  },
  'project.delete': {
    command: 'project delete',
    replayPolicy: 'natural'
  },
  'project.leave': {
    command: 'project leave',
    replayPolicy: 'keyed'
  },
  'project.update': {
    command: 'project edit',
    replayPolicy: 'keyed'
  },
  'sms-number.delete': {
    command: 'project platform sms delete',
    replayPolicy: 'natural'
  },
  'sms-number.purchase': {
    command: 'project platform sms purchase',
    replayPolicy: 'keyed'
  },
  'telegram-bot.connect': {
    command: 'project platform telegram connect',
    replayPolicy: 'keyed'
  },
  'telegram-bot.disconnect': {
    command: 'project platform telegram disconnect',
    replayPolicy: 'natural'
  },
  'voice-profile-outbound.enable': {
    command: 'project platform voice profile outbound enable',
    replayPolicy: 'keyed'
  },
  'voice-profile-outbound.rotate': {
    command: 'project platform voice profile outbound rotate',
    replayPolicy: 'keyed'
  },
  'webhook-destination.create': {
    command: 'project webhook create',
    replayPolicy: 'keyed'
  },
  'webhook-destination.delete': {
    command: 'project webhook delete',
    replayPolicy: 'natural'
  },
  'webhook-destination.update': {
    command: 'project webhook edit',
    replayPolicy: 'keyed'
  },
  'webhook-signing-secret.rotate': {
    command: 'project webhook rotate-secret',
    replayPolicy: 'keyed'
  },
  'whatsapp-business-number.delete': {
    command: 'project platform whatsapp-business number delete',
    replayPolicy: 'natural'
  },
  'whatsapp-business-number.provision': {
    command: 'project platform whatsapp-business number add',
    replayPolicy: 'keyed'
  },
  ...INTERNAL_OPERATION_DEFINITIONS
} as const satisfies Record<OperationKind, OperationDefinition>

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(
    entries.map(([key, entryValue]) => [key, canonicalJsonValue(entryValue)])
  )
}

export const requestFingerprint = (intent: OperationIntent): string =>
  sha256(JSON.stringify(canonicalJsonValue(intent)))

export const secretFingerprint = (kind: string, value: string): string =>
  sha256(`${kind}\0${value}`)

export const operationStatusSchema = z.enum([
  'awaiting-output-ack',
  'failed',
  'outcome-unknown'
])
export type OperationStatus = z.infer<typeof operationStatusSchema>

export const OUTPUT_ACKNOWLEDGEMENT_KINDS: ReadonlySet<OperationKind> = new Set(
  [
    'account-service-key.create',
    'account-service-key.revoke',
    'api-key.create',
    'voice-profile-outbound.enable',
    'voice-profile-outbound.rotate',
    'webhook-destination.create',
    'webhook-signing-secret.rotate'
  ]
)

const failureSnapshotSchema = z.strictObject({
  code: z.string().regex(ERROR_CODE_PATTERN),
  detail: text.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  message: text,
  problemType: text.optional(),
  reason: text.optional(),
  remediation: z.array(text).max(10),
  remoteOperationId: identifier.optional(),
  requestId: identifier.optional(),
  retryAfterSeconds: z.number().nonnegative().finite().optional(),
  retryable: z.boolean(),
  transportCode: identifier.optional()
})

export type OperationFailureSnapshot = z.infer<typeof failureSnapshotSchema>

export const operationRecordSchema = z
  .strictObject({
    apiOrigin: z.url(),
    attemptCount: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    credentialKind: z.enum(['account_service_key', 'device']).optional(),
    expiresAt: z.iso.datetime(),
    failure: failureSnapshotSchema.optional(),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN).optional(),
    identityId: identifier,
    intent: operationIntentSchema,
    operationId: z.string().regex(OPERATION_ID_PATTERN),
    remoteOperationId: identifier.optional(),
    replayable: z.boolean(),
    replayExpiresAt: z.iso.datetime().optional(),
    replayPolicy: z.enum([
      'avatar',
      'keyed',
      'natural',
      'none',
      'secret-keyed'
    ]),
    requestFingerprint: z.string().regex(SHA256_PATTERN),
    status: operationStatusSchema,
    updatedAt: z.iso.datetime()
  })
  .superRefine((record, context) => {
    const expectedPolicy =
      OPERATION_DEFINITIONS[record.intent.kind].replayPolicy
    if (record.replayPolicy !== expectedPolicy) {
      context.addIssue({
        code: 'custom',
        message: 'The replay policy does not match the operation kind.',
        path: ['replayPolicy']
      })
    }
    const requiresKey = !KEYLESS_REPLAY_POLICIES.has(record.replayPolicy)
    if (requiresKey !== (record.idempotencyKey !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'The idempotency key does not match the replay policy.',
        path: ['idempotencyKey']
      })
    }
    if (record.requestFingerprint !== requestFingerprint(record.intent)) {
      context.addIssue({
        code: 'custom',
        message: 'The request fingerprint does not match the stored intent.',
        path: ['requestFingerprint']
      })
    }
    if (record.replayPolicy === 'none' && record.replayable) {
      context.addIssue({
        code: 'custom',
        message: 'This operation cannot be marked replayable.',
        path: ['replayable']
      })
    }
    if (record.status === 'failed' && record.failure === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A failed operation requires a failure snapshot.',
        path: ['failure']
      })
    }
    if (
      record.status === 'awaiting-output-ack' &&
      record.failure !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An operation awaiting output acknowledgement cannot contain a failure snapshot.',
        path: ['failure']
      })
    }
    if (
      record.status === 'awaiting-output-ack' &&
      !OUTPUT_ACKNOWLEDGEMENT_KINDS.has(record.intent.kind)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'This operation kind cannot await output acknowledgement.',
        path: ['status']
      })
    }
    if (
      record.createdAt > record.updatedAt ||
      record.updatedAt > record.expiresAt
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Operation timestamps are out of order.',
        path: ['updatedAt']
      })
    }
    const requiresReplayDeadline =
      record.intent.kind === 'account-service-key.create'
    if (requiresReplayDeadline !== (record.replayExpiresAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        message:
          'The replay deadline does not match the operation replay contract.',
        path: ['replayExpiresAt']
      })
    }
  })

export type OperationRecord = z.infer<typeof operationRecordSchema>

export const validateIdempotencyKey = (value: string): string => {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new CliError(
      'ARGUMENT_VALIDATION',
      'The command contains invalid input.',
      {
        detail:
          'Idempotency keys must contain 1–255 printable, non-whitespace ASCII characters.',
        exitCode: 2,
        next: [
          {
            description:
              'Use a stable key for one logical request, or omit --idempotency-key to generate one.'
          }
        ]
      }
    )
  }
  return value
}

export const effectiveIdempotencyKey = (
  replayPolicy: OperationReplayPolicy,
  supplied: string | undefined
): string | undefined => {
  if (replayPolicy === 'natural' || replayPolicy === 'none') {
    return
  }
  return supplied === undefined
    ? randomUUID()
    : validateIdempotencyKey(supplied)
}
