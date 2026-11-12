import {
  type ConfigureVoiceProfileOutboundOutput,
  ConfigureVoiceProfileOutboundOutputSchema,
  type CreateAccountServiceKeyOutput,
  CreateAccountServiceKeyOutputSchema,
  type CreateOrganizationInvitationOutput,
  CreateOrganizationInvitationOutputSchema,
  type CreateProjectApiKeyOutput,
  CreateProjectApiKeyOutputSchema,
  type CreateProjectOutput,
  CreateProjectOutputSchema,
  type CreateWebhookDestinationOutput,
  CreateWebhookDestinationOutputSchema,
  type GetBillingOperationOutput,
  GetBillingOperationOutputSchema,
  type GetOperationOutput,
  GetOperationOutputSchema,
  type GetProjectOutput,
  type GetResourceOutput,
  GetResourceOutputSchema,
  type RevokeAccountServiceKeyOutput,
  RevokeAccountServiceKeyOutputSchema,
  type RotateVoiceProfileOutboundCredentialOutput,
  RotateVoiceProfileOutboundCredentialOutputSchema,
  type RotateWebhookSigningSecretOutput,
  RotateWebhookSigningSecretOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import { identifier } from '../../src/operation/intent-fields.ts'
import {
  OPERATION_DEFINITIONS,
  type OperationIntent,
  requestFingerprint
} from '../../src/operation/types.ts'
import { selectEmailDomainOperationDetail } from '../../src/project/email-domain.ts'
import { isResourceOperationInProgress } from '../../src/project/service.ts'
import { isVoiceProfileOutboundDigestAlgorithm } from '../../src/project/voice-outbound-authentication.ts'
import { photonKey } from '../key-support.ts'
import { TEST_NOW } from '../project-test-support.ts'
import {
  buildsDocument,
  type Declared,
  type FakeRoute,
  type GoldenCase,
  type JournalRecord,
  withNewField
} from './support.ts'

const OPERATION_ID = 'op_00000000-0000-4000-8000-000000000001'
const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const ACCOUNT_ID = 'pho_acc_00000000000000000000000002'
const PROJECT_PATH = `/v1/projects/${PROJECT_ID}`
const PLATFORMS = `${PROJECT_PATH}/platforms`
const RESOURCES = `${PLATFORMS}/resources`
const DESTINATION_ID = 'pho_whd_01h455vb4pex5vsknk084sn02q'
const DESTINATION = `${PROJECT_PATH}/webhooks/destinations/${DESTINATION_ID}`
const ASSIGNMENT_ID = 'pho_asg_01h455vb4pex5vsknk084sn02q'
const SMS_NUMBER_ID = 'pho_res_01h455vb4pex5vsknk084sn03a'
const SENDER_ID = 'pho_res_01h455vb4pex5vsknk084sn03e'
const TELEGRAM_BOT_ID = 'pho_res_01h455vb4pex5vsknk084sn03d'
const EMAIL_CONNECT_ID = 'pho_opr_01h455vb4pex5vsknk084sn03c'
const TELEGRAM_CONNECT_ID = 'pho_opr_01h455vb4pex5vsknk084sn03d'
const SMS_RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03f'
const BILLING_OPERATION_ID = `pho_bop_${'0123456789abcdef'.repeat(4)}`
const VOICE_PROFILE_ID = 'pho_vpf_01h455vb4pex5vsknk084sn02r'
const SERVICE_KEY_ID = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const SERVICE_KEY_SECRET = `${SERVICE_KEY_ID}_golden-secret`
const API_KEY_ID = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
const API_KEY_SECRET = photonKey(
  'sk',
  '01h455vb4pex5vsknk084sn02q_golden-secret'
)
const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const ROTATED_SIGNING_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
const OUTBOUND_PASSWORD = 'golden-outbound-password'
const ROTATED_OUTBOUND_PASSWORD = 'golden-rotated-outbound-password'
const DOMAIN = 'mail.example.test'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=golden_setup'
const REPLAYED = `Replayed operation ${OPERATION_ID}.`
const createdAt = new Date(TEST_NOW).toISOString()
const updatedAt = '2026-08-01T18:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

// A mutation the API answered with a 503, as the journal keeps it.
const failed = (
  intent: OperationIntent,
  record: Partial<JournalRecord> = {}
): JournalRecord =>
  ({
    attemptCount: 1,
    createdAt,
    expiresAt: new Date(TEST_NOW + 30 * DAY_MS).toISOString(),
    failure: {
      code: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
      message: 'Photon is unavailable.',
      remediation: ['Retry the operation.'],
      requestId: 'req_golden',
      retryable: true
    },
    intent,
    operationId: OPERATION_ID,
    replayable: true,
    replayPolicy: OPERATION_DEFINITIONS[intent.kind].replayPolicy,
    requestFingerprint: requestFingerprint(intent),
    status: 'failed',
    updatedAt: createdAt,
    ...record
  }) as JournalRecord

const keyed = (key: string): Partial<JournalRecord> => ({
  idempotencyKey: `golden-${key}`
})

// A schema for the result: the CLI's own, or the public SDK's.
type ResultSchema = GoldenCase['schema']

// The envelope operation replay prints: the local operation it resolved, and
// under result what the replayed command prints.
const replayed = (
  kind: OperationIntent['kind'],
  result: ResultSchema
): ResultSchema => ({
  parse: (value) => {
    const replay = z
      .strictObject({
        operation: z.strictObject({
          kind: z.literal(kind),
          operationId: z.string().regex(ID_FORMATS.localOperation.pattern),
          status: z.literal('resolved')
        }),
        result: z.looseObject({})
      })
      .parse(value)
    return { ...replay, result: result.parse(replay.result) }
  }
})

const envelope = (kind: OperationIntent['kind'], result: object) => ({
  operation: { kind, operationId: OPERATION_ID, status: 'resolved' },
  result
})

type ReplayCase = Omit<
  GoldenCase,
  'args' | 'command' | 'document' | 'journal' | 'routes' | 'schema' | 'shows'
> & {
  readonly record: JournalRecord
  readonly schema: ResultSchema
  readonly shows?: string
}

// A replay whose result is the response of one of its routes, exactly as the
// API sent it: route is that one, and routes, every request the replay
// sends, is route alone unless the case says otherwise.
const replaysResponse = ({
  record,
  route,
  routes = [route],
  schema,
  shows = REPLAYED,
  ...golden
}: ReplayCase & {
  readonly route: FakeRoute & { readonly body: object }
  readonly routes?: readonly FakeRoute[]
}): GoldenCase => ({
  ...golden,
  args: [OPERATION_ID, '--yes'],
  command: 'operation replay',
  document: envelope(record.intent.kind, route.body),
  embeds: 'result',
  journal: [record],
  routes,
  schema: replayed(record.intent.kind, schema),
  shows
})

// A replay whose result the CLI defines, from the journal alone: text shows
// only the operation's ID.
const replaysDefined = ({
  record,
  result,
  routes,
  schema,
  shows = REPLAYED,
  ...golden
}: ReplayCase & {
  readonly result: object
  readonly routes: readonly FakeRoute[]
}): GoldenCase => ({
  ...golden,
  args: [OPERATION_ID, '--yes'],
  command: 'operation replay',
  document: envelope(record.intent.kind, result),
  journal: [record],
  routes,
  schema: replayed(record.intent.kind, schema),
  shows,
  showsNoApiText: true
})

// Photon's answer to a request for something that's gone. Text never shows
// it.
const gone = (method: FakeRoute['method'], path: string) =>
  ({
    body: { code: 'NOT_FOUND', status: 404 },
    method,
    path,
    status: 404,
    unshown: true
  }) as const satisfies FakeRoute

const invitation = {
  acceptedAt: null,
  acceptedByAccountId: null,
  allProjects: true,
  createdAt,
  email: 'grace@example.test',
  expiresAt: '2026-08-07T18:00:00.000Z',
  invitationId: 'pho_oinv_00000000000000000000000001',
  invitedByAccountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  role: 'member',
  status: 'pending',
  updatedAt
} satisfies Declared<CreateOrganizationInvitationOutput>

const project = {
  agentProfile: {
    avatarUrl: 'https://images.example.test/agents/ada.png',
    firstName: 'Ada',
    lastName: 'Lovelace'
  },
  billingInitialization: 'completed',
  createdAt,
  createdByAccountId: ACCOUNT_ID,
  createdByActorId: ACCOUNT_ID,
  createdByActorKind: 'account',
  deletedAt: null,
  name: 'Acme Support',
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: 'acme-support',
  updatedAt
} satisfies Declared<CreateProjectOutput>

const retiredNumber = {
  abilities: ['sms', 'pstn_voice'],
  createdAt,
  detail: { phoneNumber: '+14155550125' },
  projectId: PROJECT_ID,
  resourceId: SMS_NUMBER_ID,
  retiredAt: updatedAt,
  state: 'retired',
  type: 'voip_line',
  updatedAt
} satisfies Declared<GetResourceOutput>

type Operation = Declared<GetOperationOutput['operation']>

const setup = (
  operationId: string,
  resourceType: string,
  state: string,
  detail: Operation['detail']
) =>
  ({
    cancellable: false,
    createdAt,
    detail,
    operationId,
    projectId: PROJECT_ID,
    resourceType,
    startedAt: createdAt,
    state,
    type: 'resource.provision',
    updatedAt
  }) satisfies Operation

const emailSetup = setup(EMAIL_CONNECT_ID, 'email_domain', 'running', {
  dnsRecords: [
    ...[1, 2, 3].map((key) => ({
      name: `dkim-${key}._domainkey.${DOMAIN}`,
      type: 'CNAME',
      value: `dkim-${key}.dkim.amazonses.com`
    })),
    {
      name: `bounce.${DOMAIN}`,
      priority: 10,
      type: 'MX',
      value: 'feedback-smtp.us-west-2.amazonses.com'
    },
    {
      name: `bounce.${DOMAIN}`,
      type: 'TXT',
      value: 'v=spf1 include:amazonses.com ~all'
    },
    {
      name: DOMAIN,
      priority: 10,
      type: 'MX',
      value: 'inbound-smtp.us-west-2.amazonaws.com'
    }
  ]
})

const telegramSetup = setup(TELEGRAM_CONNECT_ID, 'telegram_bot', 'pending', {
  setupUrl: SETUP_URL
})

const EMAIL_DOMAIN_ID = 'pho_res_01h455vb4pex5vsknk084sn03c'

const connectedDomain = {
  abilities: ['email'],
  createdAt,
  detail: { domain: DOMAIN, healthy: true },
  projectId: PROJECT_ID,
  resourceId: EMAIL_DOMAIN_ID,
  state: 'active',
  type: 'email_domain',
  updatedAt
} satisfies Declared<GetResourceOutput>

const finishedEmailSetup = {
  ...emailSetup,
  endedAt: updatedAt,
  resourceId: EMAIL_DOMAIN_ID,
  state: 'succeeded'
} satisfies Operation

const emailConnectRoute = {
  body: withNewField(emailSetup),
  method: 'POST',
  path: `${PLATFORMS}/email/domains`,
  requestBody: { domain: DOMAIN },
  status: 202
} as const satisfies FakeRoute

// Photon answers the request with the setup it already finished. Its answer
// carries no resource beside the setup, so the CLI reads the setup again.
const finishedEmailConnectRoute = {
  ...emailConnectRoute,
  body: finishedEmailSetup,
  unshown: true
} as const satisfies FakeRoute

const finishedEmailRead = {
  operation: finishedEmailSetup,
  resource: connectedDomain
} satisfies Declared<GetOperationOutput>

const finishedEmailSetupRoute = {
  body: withNewField({
    operation: withNewField(finishedEmailRead.operation),
    resource: withNewField(finishedEmailRead.resource)
  }),
  method: 'GET',
  path: `${PLATFORMS}/operations/${EMAIL_CONNECT_ID}`
} as const satisfies FakeRoute

const telegramConnectRoute = {
  body: withNewField(telegramSetup),
  method: 'POST',
  path: `${PLATFORMS}/telegram/bots`,
  requestBody: {},
  status: 202
} as const satisfies FakeRoute

const projectCreateRoute = {
  body: withNewField(project),
  method: 'POST',
  path: `/v1/organizations/${ORGANIZATION_ID}/projects`,
  requestBody: { name: project.name, slug: project.slug },
  status: 201
} as const satisfies FakeRoute

const retiredNumberRoute = {
  body: withNewField(retiredNumber),
  method: 'GET',
  path: `${RESOURCES}/${SMS_NUMBER_ID}`
} as const satisfies FakeRoute

const retiredSender = {
  abilities: [],
  createdAt,
  detail: {
    account: { wabaId: '112233445566778' },
    displayName: 'Acme Support',
    displayNameStatus: 'APPROVED',
    phoneNumber: '+1 415-555-0127',
    phoneNumberId: '123456789012345',
    qualityRating: 'GREEN',
    qualityRatingObservedAt: createdAt
  },
  projectId: PROJECT_ID,
  resourceId: SENDER_ID,
  retiredAt: updatedAt,
  state: 'retired',
  type: 'whatsapp_sender',
  updatedAt
} satisfies Declared<GetResourceOutput>

const retiredSenderRoute = {
  body: withNewField(retiredSender),
  method: 'GET',
  path: `${RESOURCES}/${SENDER_ID}`
} as const satisfies FakeRoute

const OperationSchema = GetOperationOutputSchema.shape.operation

// The answer to email connect while the setup runs, which the CLI prints
// under operation. The CLI checks the setup and its DNS instructions, and the
// journal records its ID.
const EmailSetupAnswerSchema = z.strictObject({
  operation: OperationSchema.refine(
    (answer) =>
      identifier.safeParse(answer.operationId).success &&
      isResourceOperationInProgress(answer.state) &&
      answer.projectId === PROJECT_ID &&
      answer.resourceType === 'email_domain' &&
      answer.type === 'resource.provision' &&
      selectEmailDomainOperationDetail(answer.detail).status === 'present'
  )
})

// The read of an email setup that finished, which the CLI prints with the
// domain beside it.
const FinishedEmailSetupSchema = GetOperationOutputSchema.extend({
  operation: OperationSchema.refine(
    (answer) =>
      answer.operationId === EMAIL_CONNECT_ID &&
      answer.projectId === PROJECT_ID &&
      answer.resourceType === 'email_domain' &&
      answer.state === 'succeeded' &&
      answer.type === 'resource.provision' &&
      selectEmailDomainOperationDetail(answer.detail).status === 'present'
  ),
  resource: GetResourceOutputSchema.refine(
    (resource) =>
      resource.type === 'email_domain' && resource.abilities.includes('email')
  )
})

// The answer to telegram connect while the setup waits for a bot, which the
// CLI prints under operation. The CLI checks that it sets up a Telegram bot in
// the project, and the journal records its ID.
const TelegramSetupAnswerSchema = z.strictObject({
  operation: OperationSchema.refine(
    (answer) =>
      identifier.safeParse(answer.operationId).success &&
      answer.projectId === PROJECT_ID &&
      answer.resourceType === 'telegram_bot' &&
      answer.type === 'resource.provision' &&
      isResourceOperationInProgress(answer.state)
  )
})

const billingOperation = {
  failure: null,
  kind: 'change_plan',
  operationId: BILLING_OPERATION_ID,
  paymentAction: null,
  resolvedAt: null,
  result: null,
  status: 'pending',
  submittedAt: createdAt
} satisfies Declared<GetBillingOperationOutput>

const settledBillingOperation = {
  ...billingOperation,
  resolvedAt: updatedAt,
  result: { effectiveAt: updatedAt, type: 'version', version: 'version_8' },
  status: 'succeeded'
} satisfies Declared<GetBillingOperationOutput>

const settledBillingRoute = {
  body: withNewField(settledBillingOperation),
  method: 'GET',
  path: `${PROJECT_PATH}/billing/operations/${BILLING_OPERATION_ID}`
} as const satisfies FakeRoute

const serviceKey = {
  accountId: 'pho_acc_00000000000000000000000001',
  createdAt,
  expiresAt: null,
  name: 'Deploy key',
  revokedAt: null,
  serviceKeyId: SERVICE_KEY_ID
} satisfies Declared<CreateAccountServiceKeyOutput['serviceKey']>

const serviceKeyCreation = {
  secret: SERVICE_KEY_SECRET,
  serviceKey: withNewField(serviceKey)
} satisfies Declared<CreateAccountServiceKeyOutput>

const revokedServiceKey = {
  ...serviceKey,
  revokedAt: updatedAt
} satisfies Declared<RevokeAccountServiceKeyOutput['serviceKey']>

const serviceKeyRevocation = {
  serviceKey: withNewField(revokedServiceKey)
} satisfies Declared<RevokeAccountServiceKeyOutput>

// Before it prints a service key, the CLI checks its IDs and timestamps, as
// this schema does.
const TIMESTAMP = z.iso.datetime({ offset: true })
const CheckedServiceKeySchema =
  RevokeAccountServiceKeyOutputSchema.shape.serviceKey.extend({
    accountId: z.string().regex(ID_FORMATS.account.pattern),
    createdAt: TIMESTAMP,
    expiresAt: TIMESTAMP.nullable(),
    revokedAt: TIMESTAMP.nullable(),
    serviceKeyId: z.string().regex(ID_FORMATS.accountServiceKey.pattern)
  })

const ServiceKeyCreationSchema = CreateAccountServiceKeyOutputSchema.extend({
  serviceKey: CheckedServiceKeySchema
})

const ServiceKeyRevocationSchema = RevokeAccountServiceKeyOutputSchema.extend({
  serviceKey: CheckedServiceKeySchema.extend({ revokedAt: TIMESTAMP })
})

const apiKey = {
  apiKeyId: API_KEY_ID,
  createdAt,
  createdByAccountId: ACCOUNT_ID,
  expiresAt: null,
  name: 'Deploy key',
  permissions: ['project:read'],
  permissionsUpdatedAt: null,
  projectId: PROJECT_ID,
  revokedAt: null
} satisfies Declared<CreateProjectApiKeyOutput['apiKey']>

const apiKeyCreation = {
  apiKey: withNewField(apiKey),
  secret: API_KEY_SECRET
} satisfies Declared<CreateProjectApiKeyOutput>

const destination = {
  apiVersion: '2026-07-01',
  createdAt,
  deletedAt: null,
  description: 'Production messages',
  destinationId: DESTINATION_ID,
  enabledEvents: ['message.created'],
  name: 'Production hook',
  projectId: PROJECT_ID,
  status: 'enabled',
  updatedAt,
  url: 'https://hooks.example.test/deliver'
} satisfies Declared<CreateWebhookDestinationOutput['destination']>

const destinationCreation = {
  destination: withNewField(destination),
  signingSecret: SIGNING_SECRET
} satisfies Declared<CreateWebhookDestinationOutput>

const rotatedSecret = {
  previousSecretExpiresAt: '2026-08-01T19:00:00.000Z',
  signingSecret: ROTATED_SIGNING_SECRET
} satisfies Declared<RotateWebhookSigningSecretOutput>

type Outbound = Declared<ConfigureVoiceProfileOutboundOutput>['outbound']

const outboundAuthentication = {
  algorithm: 'sha-256',
  previousPasswordValidUntil: null,
  username: 'outbound-user-0001',
  validFrom: updatedAt
} satisfies Outbound['authentication']

const tlsEndpoint = {
  host: 'sip.voice.example',
  port: 5061,
  transport: 'tls'
} satisfies Outbound['connection']['endpoints'][number]

const enabledOutbound = {
  outbound: {
    authentication: withNewField(outboundAuthentication),
    connection: {
      endpoints: [
        withNewField(tlsEndpoint),
        { host: 'sip.voice.example', port: 5060, transport: 'udp' }
      ],
      realm: 'sip.voice.example'
    }
  },
  password: OUTBOUND_PASSWORD,
  profileVersion: 6
} satisfies Declared<ConfigureVoiceProfileOutboundOutput>

const rotatedOutbound = {
  password: ROTATED_OUTBOUND_PASSWORD,
  previousPasswordValidUntil: '2026-08-01T19:00:00.000Z',
  profileVersion: 7
} satisfies Declared<RotateVoiceProfileOutboundCredentialOutput>

// Photon answers a rotation sent again with its idempotency key without the
// password once it no longer holds it.
const rotatedOutboundWithoutPassword = {
  ...rotatedOutbound,
  password: null
} satisfies Declared<RotateVoiceProfileOutboundCredentialOutput>

const outboundRotation = (key: string) =>
  failed(
    {
      expectedVersion: 6,
      kind: 'voice-profile-outbound.rotate',
      mode: 'normal',
      profileId: VOICE_PROFILE_ID,
      profileReference: 'default',
      projectId: PROJECT_ID
    },
    keyed(key)
  )

const outboundRotationRoute = (body: object) => ({
  body: withNewField(body),
  method: 'POST' as const,
  path: `${PLATFORMS}/voice/profiles/${VOICE_PROFILE_ID}/outbound/rotate`,
  requestBody: { expectedVersion: 6, mode: 'normal' }
})

// The CLI accepts only the digest algorithms it knows.
const OutboundSetupSchema = ConfigureVoiceProfileOutboundOutputSchema.refine(
  ({ outbound }) =>
    outbound === null ||
    isVoiceProfileOutboundDigestAlgorithm(outbound.authentication.algorithm)
)

const releasedResource = (key: 'deleted' | 'disconnected') =>
  z.strictObject({
    [key]: z.literal(true),
    resourceId: z.string().regex(ID_FORMATS.resource.pattern)
  })

/** Golden tests for operation replay, one for each result it prints. */
export const OPERATION_REPLAY_GOLDENS: readonly GoldenCase[] = [
  // Its result is what the replayed command prints: here the invitation
  // Photon returns.
  replaysResponse({
    record: failed(
      {
        email: invitation.email,
        kind: 'organization-member.invite',
        organizationId: ORGANIZATION_ID,
        role: 'member'
      },
      keyed('member-invite')
    ),
    route: {
      body: withNewField(invitation),
      method: 'POST',
      path: `/v1/organizations/${ORGANIZATION_ID}/invitations`,
      requestBody: { email: invitation.email, role: invitation.role },
      status: 201
    },
    schema: CreateOrganizationInvitationOutputSchema,
    showsNoApiText: true
  }),
  // A plan purchase reads the project for its organization, buys the plan
  // and polls the billing operation until it settles, as the command does.
  replaysResponse({
    record: failed(
      {
        category: 'platforms',
        kind: 'billing.plan.purchase',
        planCode: 'business',
        projectId: PROJECT_ID
      },
      keyed('plan-purchase')
    ),
    route: settledBillingRoute,
    routes: [
      {
        body: { ...project } satisfies Declared<GetProjectOutput>,
        method: 'GET',
        path: PROJECT_PATH,
        unshown: true
      },
      {
        body: billingOperation,
        method: 'POST',
        path: `/v1/organizations/${ORGANIZATION_ID}/billing/projects/${PROJECT_ID}/purchase`,
        requestBody: { category: 'platforms', planCode: 'business' },
        status: 202,
        unshown: true
      },
      settledBillingRoute
    ],
    schema: GetBillingOperationOutputSchema,
    showsNoApiText: true
  }),
  // A replayed email connect finishes the request and prints what the
  // command prints with --no-wait: the answer that holds the DNS
  // instructions, under operation. It doesn't wait for verification.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (answer: typeof emailConnectRoute.body) =>
      envelope('email-domain.connect', { operation: answer }),
    command: 'operation replay',
    from: [emailConnectRoute],
    journal: [
      failed(
        { domain: DOMAIN, kind: 'email-domain.connect', projectId: PROJECT_ID },
        keyed('email-connect')
      )
    ],
    routes: [emailConnectRoute],
    schema: replayed('email-domain.connect', EmailSetupAnswerSchema),
    shows: REPLAYED,
    showsNoApiText: true
  }),
  // When the setup has already finished, the result is its read, with the
  // domain under resource.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (read: typeof finishedEmailSetupRoute.body) =>
      envelope('email-domain.connect', read),
    command: 'operation replay',
    from: [finishedEmailSetupRoute],
    journal: [
      failed(
        { domain: DOMAIN, kind: 'email-domain.connect', projectId: PROJECT_ID },
        keyed('email-connect-finished')
      )
    ],
    routes: [finishedEmailConnectRoute, finishedEmailSetupRoute],
    schema: replayed('email-domain.connect', FinishedEmailSetupSchema),
    shows: REPLAYED,
    showsNoApiText: true
  }),
  // So does a replayed telegram connect: the answer that holds the setup
  // link, under operation. It doesn't wait for the bot.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (answer: typeof telegramConnectRoute.body) =>
      envelope('telegram-bot.connect', { operation: answer }),
    command: 'operation replay',
    from: [telegramConnectRoute],
    journal: [
      failed(
        { kind: 'telegram-bot.connect', projectId: PROJECT_ID },
        keyed('telegram-connect')
      )
    ],
    routes: [telegramConnectRoute],
    schema: replayed('telegram-bot.connect', TelegramSetupAnswerSchema),
    shows: REPLAYED,
    showsNoApiText: true
  }),
  // The journal doesn't record the folder a project create --link ran in, so
  // its replay saves no folder file: the result is the API's project under
  // project, and text prints the link step that saves the file.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (created: typeof projectCreateRoute.body) =>
      envelope('project.create', { project: created }),
    command: 'operation replay',
    from: [projectCreateRoute],
    journal: [
      failed(
        {
          activate: true,
          kind: 'project.create',
          name: project.name,
          organizationId: ORGANIZATION_ID,
          slug: project.slug
        },
        keyed('project-create-link')
      )
    ],
    routes: [projectCreateRoute],
    schema: replayed(
      'project.create',
      z.strictObject({ project: CreateProjectOutputSchema })
    ),
    shows: `link --project ${PROJECT_ID}`
  }),
  // A number the replay finds already retired has no release operation to
  // read, so the result is the number as Photon sends it, under resource.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (resource: typeof retiredNumberRoute.body) =>
      envelope('sms-number.delete', { resource }),
    command: 'operation replay',
    from: [retiredNumberRoute],
    journal: [
      failed({
        kind: 'sms-number.delete',
        projectId: PROJECT_ID,
        resourceId: SMS_NUMBER_ID
      })
    ],
    routes: [retiredNumberRoute],
    schema: replayed(
      'sms-number.delete',
      // The CLI reads a number of the project as retired.
      z.strictObject({
        resource: GetResourceOutputSchema.refine(
          (resource) =>
            resource.projectId === PROJECT_ID &&
            resource.state.toLowerCase() === 'retired'
        )
      })
    ),
    shows: REPLAYED,
    showsNoApiText: true
  }),
  // So does a WhatsApp Business sender the replay finds already retired.
  buildsDocument({
    args: [OPERATION_ID, '--yes'],
    build: (resource: typeof retiredSenderRoute.body) =>
      envelope('whatsapp-business-number.delete', { resource }),
    command: 'operation replay',
    from: [retiredSenderRoute],
    journal: [
      failed({
        kind: 'whatsapp-business-number.delete',
        projectId: PROJECT_ID,
        resourceId: SENDER_ID
      })
    ],
    routes: [retiredSenderRoute],
    schema: replayed(
      'whatsapp-business-number.delete',
      // The CLI reads a WhatsApp sender of the project as retired.
      z.strictObject({
        resource: GetResourceOutputSchema.refine(
          (resource) =>
            resource.projectId === PROJECT_ID &&
            resource.type === 'whatsapp_sender' &&
            resource.state.toLowerCase() === 'retired'
        )
      })
    ),
    shows: `Deleted WhatsApp Business number resource ${SENDER_ID}.`
  }),
  // A delete that already went through: Photon answers 404 and sends nothing
  // to print, so the result names what's gone.
  replaysDefined({
    record: failed({ kind: 'project.delete', projectId: PROJECT_ID }),
    result: { deleted: true, projectId: PROJECT_ID },
    routes: [gone('DELETE', PROJECT_PATH)],
    schema: z.strictObject({
      deleted: z.literal(true),
      projectId: z.string().regex(ID_FORMATS.project.pattern)
    })
  }),
  replaysDefined({
    record: failed({
      destinationId: DESTINATION_ID,
      kind: 'webhook-destination.delete',
      projectId: PROJECT_ID
    }),
    result: { deleted: true, destinationId: DESTINATION_ID },
    routes: [gone('DELETE', DESTINATION)],
    schema: z.strictObject({
      deleted: z.literal(true),
      destinationId: z.string().regex(ID_FORMATS.webhookDestination.pattern)
    })
  }),
  replaysDefined({
    record: failed({
      assignmentId: ASSIGNMENT_ID,
      kind: 'assignment.release',
      projectId: PROJECT_ID
    }),
    result: { assignmentId: ASSIGNMENT_ID, released: true },
    routes: [
      gone('DELETE', `${PLATFORMS}/imessage/assignments/${ASSIGNMENT_ID}`)
    ],
    schema: z.strictObject({
      assignmentId: z.string().regex(ID_FORMATS.assignment.pattern),
      released: z.literal(true)
    })
  }),
  replaysDefined({
    record: failed({
      kind: 'sms-number.delete',
      projectId: PROJECT_ID,
      resourceId: SMS_NUMBER_ID
    }),
    result: { deleted: true, resourceId: SMS_NUMBER_ID },
    routes: [gone('GET', `${RESOURCES}/${SMS_NUMBER_ID}`)],
    schema: releasedResource('deleted')
  }),
  // A release Photon accepted, whose operation it no longer has: the replay
  // reads the number, and it's gone too.
  replaysDefined({
    record: failed(
      {
        kind: 'sms-number.delete',
        projectId: PROJECT_ID,
        resourceId: SMS_NUMBER_ID
      },
      { remoteOperationId: SMS_RELEASE_ID }
    ),
    result: { deleted: true, resourceId: SMS_NUMBER_ID },
    routes: [
      gone('GET', `${PLATFORMS}/operations/${SMS_RELEASE_ID}`),
      gone('GET', `${RESOURCES}/${SMS_NUMBER_ID}`)
    ],
    schema: releasedResource('deleted')
  }),
  replaysDefined({
    record: failed({
      kind: 'whatsapp-business-number.delete',
      projectId: PROJECT_ID,
      resourceId: SENDER_ID
    }),
    result: { deleted: true, resourceId: SENDER_ID },
    routes: [gone('GET', `${RESOURCES}/${SENDER_ID}`)],
    schema: releasedResource('deleted'),
    shows: `Deleted WhatsApp Business number resource ${SENDER_ID}.`
  }),
  replaysDefined({
    record: failed({
      kind: 'telegram-bot.disconnect',
      projectId: PROJECT_ID,
      resourceId: TELEGRAM_BOT_ID
    }),
    result: { disconnected: true, resourceId: TELEGRAM_BOT_ID },
    routes: [gone('GET', `${RESOURCES}/${TELEGRAM_BOT_ID}`)],
    schema: releasedResource('disconnected')
  }),
  replaysDefined({
    record: failed({
      kind: 'email-domain.disconnect',
      projectId: PROJECT_ID,
      resourceId: EMAIL_DOMAIN_ID
    }),
    result: { disconnected: true, resourceId: EMAIL_DOMAIN_ID },
    routes: [gone('GET', `${RESOURCES}/${EMAIL_DOMAIN_ID}`)],
    schema: releasedResource('disconnected')
  }),
  // A service key revoke whose answer the CLI never got is sent again, and
  // its result is the key Photon returns.
  replaysResponse({
    record: failed(
      { kind: 'account-service-key.revoke', serviceKeyId: SERVICE_KEY_ID },
      keyed('service-key-revoke-sent')
    ),
    route: {
      body: withNewField(serviceKeyRevocation),
      method: 'DELETE',
      path: `/v1/account/service-keys/${SERVICE_KEY_ID}`
    },
    schema: ServiceKeyRevocationSchema,
    showsNoApiText: true
  }),
  // A service key revoke that went through, but whose output the CLI didn't
  // finish printing, isn't sent again. The journal doesn't keep Photon's
  // response, so the result names the key.
  replaysDefined({
    record: {
      ...failed(
        { kind: 'account-service-key.revoke', serviceKeyId: SERVICE_KEY_ID },
        keyed('service-key-revoke')
      ),
      failure: undefined,
      status: 'awaiting-output-ack'
    },
    result: { revoked: true, serviceKeyId: SERVICE_KEY_ID },
    routes: [],
    schema: z.strictObject({
      revoked: z.literal(true),
      serviceKeyId: z.string().regex(ID_FORMATS.accountServiceKey.pattern)
    })
  }),
  // The replays that recover a one-time secret print it as the command does,
  // after the CLI checks it.
  replaysResponse({
    checkedSecret: 'result.secret',
    record: failed(
      { kind: 'account-service-key.create', name: 'Deploy key' },
      {
        ...keyed('service-key-create'),
        replayExpiresAt: new Date(TEST_NOW + DAY_MS / 2).toISOString()
      }
    ),
    route: {
      body: withNewField(serviceKeyCreation),
      method: 'POST',
      path: '/v1/account/service-keys',
      requestBody: { name: 'Deploy key' },
      status: 201
    },
    schema: ServiceKeyCreationSchema,
    shows: SERVICE_KEY_SECRET
  }),
  replaysResponse({
    checkedSecret: 'result.secret',
    record: failed(
      {
        kind: 'api-key.create',
        name: 'Deploy key',
        permissions: ['project:read'],
        projectId: PROJECT_ID
      },
      keyed('api-key-create')
    ),
    route: {
      body: withNewField(apiKeyCreation),
      method: 'POST',
      path: `${PROJECT_PATH}/api-keys`,
      requestBody: { name: 'Deploy key', permissions: ['project:read'] },
      status: 201
    },
    schema: CreateProjectApiKeyOutputSchema,
    shows: API_KEY_SECRET
  }),
  replaysResponse({
    checkedSecret: 'result.signingSecret',
    record: failed(
      {
        apiVersion: destination.apiVersion,
        description: destination.description,
        enabledEvents: ['message.created'],
        kind: 'webhook-destination.create',
        name: destination.name,
        projectId: PROJECT_ID,
        status: 'enabled',
        url: destination.url
      },
      keyed('webhook-create')
    ),
    route: {
      body: withNewField(destinationCreation),
      method: 'POST',
      path: `${PROJECT_PATH}/webhooks/destinations`,
      requestBody: {
        apiVersion: destination.apiVersion,
        description: destination.description,
        enabledEvents: ['message.created'],
        name: destination.name,
        status: 'enabled',
        url: destination.url
      },
      status: 201
    },
    schema: CreateWebhookDestinationOutputSchema,
    shows: SIGNING_SECRET
  }),
  replaysResponse({
    checkedSecret: 'result.signingSecret',
    record: failed(
      {
        destinationId: DESTINATION_ID,
        kind: 'webhook-signing-secret.rotate',
        overlapSeconds: 3600,
        projectId: PROJECT_ID
      },
      keyed('webhook-rotate')
    ),
    route: {
      body: withNewField(rotatedSecret),
      method: 'POST',
      path: `${DESTINATION}/secret-rotations`,
      requestBody: { overlapSeconds: 3600 }
    },
    schema: RotateWebhookSigningSecretOutputSchema,
    shows: ROTATED_SIGNING_SECRET
  }),
  // The replay uses the profile ID the journal holds, so it reads no profile.
  replaysResponse({
    checkedSecret: 'result.password',
    record: failed(
      {
        digestAlgorithm: 'sha-256',
        expectedVersion: 5,
        kind: 'voice-profile-outbound.enable',
        profileId: VOICE_PROFILE_ID,
        profileReference: 'default',
        projectId: PROJECT_ID
      },
      keyed('outbound-enable')
    ),
    route: {
      body: withNewField(enabledOutbound),
      method: 'PUT',
      path: `${PLATFORMS}/voice/profiles/${VOICE_PROFILE_ID}/outbound`,
      requestBody: {
        authentication: { algorithm: 'sha-256' },
        expectedVersion: 5
      }
    },
    schema: OutboundSetupSchema,
    shows: OUTBOUND_PASSWORD,
    showsNoApiText: true
  }),
  replaysResponse({
    checkedSecret: 'result.password',
    record: outboundRotation('outbound-rotate'),
    route: outboundRotationRoute(rotatedOutbound),
    schema: RotateVoiceProfileOutboundCredentialOutputSchema,
    shows: ROTATED_OUTBOUND_PASSWORD,
    showsNoApiText: true
  }),
  // Without the password, text says it's unavailable.
  replaysResponse({
    record: outboundRotation('outbound-rotate-without-password'),
    route: outboundRotationRoute(rotatedOutboundWithoutPassword),
    schema: RotateVoiceProfileOutboundCredentialOutputSchema,
    shows: 'Unavailable; rotate to issue a new password',
    showsNoApiText: true
  })
]
