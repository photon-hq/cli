import {
  type CreateWhatsappVoipSenderOutput,
  type GetOperationOutput,
  GetOperationOutputSchema,
  type GetResourceOutput,
  GetResourceOutputSchema,
  type GetWhatsappBusinessAccountOutput,
  GetWhatsappBusinessAccountOutputSchema,
  type ListResourcesOutput,
  ListResourcesOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { APP_ORIGIN } from '../../src/auth/constants.ts'
import { identifier } from '../../src/operation/intent-fields.ts'
import {
  buildsDocument,
  type Declared,
  type FakeRoute,
  type GoldenCase,
  printsResponse,
  withNewField
} from './support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const PLATFORMS = `/v1/projects/${PROJECT_ID}/platforms`
const RESOURCES = `${PLATFORMS}/resources`
const OPERATIONS = `${PLATFORMS}/operations`
const ACCOUNT = `${PLATFORMS}/whatsapp-business/account`
const SENDERS_QUERY = `${RESOURCES}?ability=whatsapp_business&pageSize=200&state=active`
const SENDER_ID = 'pho_res_01h455vb4pex5vsknk084sn04a'
const SECOND_SENDER_ID = 'pho_res_01h455vb4pex5vsknk084sn04b'
const SMS_NUMBER_ID = 'pho_res_01h455vb4pex5vsknk084sn04c'
const PROVISION_ID = 'pho_opr_01h455vb4pex5vsknk084sn04a'
const RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn04b'
const WABA_ID = '112233445566778'
const PHONE_NUMBER = '+14155550127'
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'

type Operation = Declared<GetOperationOutput['operation']>
type Resource = Declared<GetResourceOutput>

const account = {
  accountName: 'Acme Support',
  alerts: [],
  businessId: '887766554433221',
  businessName: 'Acme',
  connectedAt: createdAt,
  outboundCapacity: 'UNKNOWN',
  restriction: null,
  reviewStatus: 'APPROVED',
  senderCount: 1,
  subscribedAt: updatedAt,
  wabaId: WABA_ID
} satisfies Declared<GetWhatsappBusinessAccountOutput>

// Photon sends the sender's phone number with formatting. Text shows it
// normalized, and JSON as Photon sent it.
const sender = {
  abilities: ['whatsapp_business'],
  createdAt,
  detail: {
    account: { wabaId: WABA_ID },
    displayName: 'Acme Support',
    displayNameStatus: 'APPROVED',
    phoneNumber: '+1 415-555-0127',
    phoneNumberId: '123456789012345',
    qualityRating: 'GREEN',
    qualityRatingObservedAt: createdAt,
    voipResourceId: SMS_NUMBER_ID
  },
  projectId: PROJECT_ID,
  resourceId: SENDER_ID,
  state: 'active',
  type: 'whatsapp_sender',
  updatedAt
} satisfies Resource

const secondSender = {
  ...sender,
  detail: { ...sender.detail, phoneNumber: '+14155550128' },
  resourceId: SECOND_SENDER_ID
} satisfies Resource

const smsNumber = {
  abilities: ['sms', 'pstn_voice'],
  createdAt,
  detail: { phoneNumber: PHONE_NUMBER },
  projectId: PROJECT_ID,
  resourceId: SMS_NUMBER_ID,
  state: 'active',
  type: 'voip_line',
  updatedAt
} satisfies Resource

const operation = (
  operationId: string,
  state: string,
  fields: Partial<Operation> = {}
) =>
  ({
    cancellable: false,
    createdAt,
    operationId,
    projectId: PROJECT_ID,
    resourceType: 'whatsapp_sender',
    startedAt: createdAt,
    state,
    type: 'resource.provision',
    updatedAt,
    ...fields
  }) satisfies Operation

const release = (state: string) =>
  operation(RELEASE_ID, state, {
    detail: { numberRemainsInWaba: true, phoneNumber: PHONE_NUMBER },
    resourceId: SENDER_ID,
    type: 'resource.release',
    ...(state === 'succeeded' ? { endedAt: updatedAt } : {})
  })

const operationRoute = (
  operationId: string,
  body: Declared<GetOperationOutput>
) =>
  ({
    body,
    method: 'GET',
    path: `${OPERATIONS}/${operationId}`
  }) as const satisfies FakeRoute

// number add checks the account before its journaled step and again inside
// it. Each read is its own route, since a route answers once.
const accountRoute = () =>
  ({
    body: account,
    method: 'GET',
    path: ACCOUNT,
    unshown: true
  }) as const satisfies FakeRoute

const accountListRoute = {
  body: withNewField(account),
  method: 'GET',
  path: ACCOUNT
} as const satisfies FakeRoute

const numberPageRoute = {
  body: withNewField({
    nextPageToken: 'page-2',
    resources: [
      withNewField({ ...sender, detail: withNewField(sender.detail) }),
      secondSender
    ]
  }) satisfies Declared<ListResourcesOutput>,
  method: 'GET',
  path: `${RESOURCES}?ability=whatsapp_business&pageSize=2&state=active`
} as const satisfies FakeRoute

// The command reads the number first. Text shows only its checked phone
// number.
const smsNumberRoute = {
  body: withNewField(smsNumber),
  method: 'GET',
  path: `${RESOURCES}/${SMS_NUMBER_ID}`
} as const satisfies FakeRoute

// It lists the project's senders to refuse a number a sender already uses.
const noSendersRoute = {
  body: { resources: [] } satisfies Declared<ListResourcesOutput>,
  method: 'GET',
  path: SENDERS_QUERY,
  unshown: true
} as const satisfies FakeRoute

// delete reads the sender to check it before it asks to confirm. Text shows
// only its checked phone number.
const senderRoute = {
  body: sender,
  method: 'GET',
  path: `${RESOURCES}/${SENDER_ID}`,
  unshown: true
} as const satisfies FakeRoute

const provisioned = operationRoute(PROVISION_ID, {
  operation: withNewField(
    operation(PROVISION_ID, 'succeeded', {
      endedAt: updatedAt,
      resourceId: SENDER_ID
    })
  ),
  resource: withNewField({
    ...sender,
    detail: withNewField(sender.detail)
  })
})

const released = operationRoute(RELEASE_ID, {
  operation: withNewField(release('succeeded'))
})

const releaseAnswer = {
  body: withNewField(release('succeeded')),
  method: 'DELETE',
  path: `${RESOURCES}/${SENDER_ID}`
} as const satisfies FakeRoute

// The dashboard page the handoff opens, with its query in the CLI's order.
const dashboardUrl = (query: readonly [string, string][]): string =>
  `${APP_ORIGIN}/${PROJECT_ID}/platforms/whatsapp-business?${new URLSearchParams(
    [['onboarding', 'cli'], ...query]
  ).toString()}`

const PHONE_NUMBER_FORMATTING = /[\s().-]/gu
const E164 = /^\+[1-9]\d{1,14}$/u
const DIGITS = /^\d+$/u

// The CLI checks a sender before anything prints: a WhatsApp sender of the
// project, with a phone number, Meta IDs of digits only, a known quality
// rating and names that aren't empty.
const SenderSchema = GetResourceOutputSchema.extend({
  detail: z.looseObject({
    account: z.looseObject({ wabaId: z.string().regex(DIGITS) }),
    displayName: z.string().min(1).optional(),
    displayNameStatus: z.string().min(1).optional(),
    phoneNumber: z
      .string()
      .refine((phoneNumber) =>
        E164.test(phoneNumber.replace(PHONE_NUMBER_FORMATTING, ''))
      ),
    phoneNumberId: z.string().regex(DIGITS),
    qualityRating: z.enum(['GREEN', 'RED', 'UNKNOWN', 'YELLOW']),
    voipResourceId: z.string().min(1).optional()
  })
}).refine(
  ({ projectId, type }) =>
    projectId === PROJECT_ID && type === 'whatsapp_sender'
)

// A sender the CLI lists, adds or deletes must also be active, with the
// WhatsApp Business ability.
const ActiveSenderSchema = SenderSchema.refine(
  ({ abilities, state }) =>
    state.toLowerCase() === 'active' && abilities.includes('whatsapp_business')
)

// account list prints the project's one account as Photon sends it, in a
// list.
const AccountListSchema = z.strictObject({
  accounts: GetWhatsappBusinessAccountOutputSchema.array()
})

// number list asks Photon for active senders only and prints the page as
// Photon sends it.
const NumberListSchema = ListResourcesOutputSchema.extend({
  resources: ActiveSenderSchema.array()
})

// The CLI checks the SMS number it hands to the dashboard: an active Photon
// SMS number of the project, with a phone number.
const SmsNumberSchema = GetResourceOutputSchema.refine(
  (number) =>
    number.projectId === PROJECT_ID &&
    number.type === 'voip_line' &&
    number.state.toLowerCase() === 'active' &&
    number.retiredAt === undefined &&
    number.abilities.includes('sms') &&
    typeof number.detail.phoneNumber === 'string' &&
    E164.test(number.detail.phoneNumber)
)

// A handoff to the dashboard, which no Photon response describes. With
// --source photon it holds the SMS number as Photon sends it.
const handoffSchema = (source: 'byon' | 'photon') =>
  z.strictObject({
    handoff: z.strictObject({
      browserAttempted: z.literal(false),
      kind: z.literal('whatsapp-embedded-signup'),
      opened: z.literal(false),
      projectId: z.literal(PROJECT_ID),
      requiresHumanInteraction: z.literal(true),
      ...(source === 'photon'
        ? {
            resource: SmsNumberSchema,
            verificationOwner: z.literal('dashboard')
          }
        : {}),
      source: z.literal(source),
      url: z.string()
    })
  })

// It polls the provisioning it started until it ends. The CLI rejects a poll
// that names another operation, an operation that doesn't succeed and a
// sender it can't list.
const ProvisionedSchema = GetOperationOutputSchema.extend({
  resource: ActiveSenderSchema
}).refine(
  ({ operation: read }) =>
    read.operationId === PROVISION_ID && read.state === 'succeeded'
)

const isSenderRelease = (read: Operation) =>
  read.projectId === PROJECT_ID &&
  read.resourceId === SENDER_ID &&
  read.resourceType === 'whatsapp_sender' &&
  read.type === 'resource.release' &&
  read.state === 'succeeded'

// The CLI checks that the release is the sender's, in the project.
const ReleasedSchema = GetOperationOutputSchema.refine(
  ({ operation: read }) =>
    read.operationId === RELEASE_ID && isSenderRelease(read)
)

// The answer to a release that has already ended, which the CLI prints under
// operation, as an operation read holds it. The local journal records the
// operation's ID, and rejects one with control characters.
const ReleaseAnswerSchema = z.strictObject({
  operation: GetOperationOutputSchema.shape.operation.refine(
    (answer) =>
      identifier.safeParse(answer.operationId).success &&
      isSenderRelease(answer)
  )
})

/** Golden tests for the project platform whatsapp-business commands. */
export const WHATSAPP_BUSINESS_GOLDENS: readonly GoldenCase[] = [
  // Photon answers with the project's one account, which the CLI lists.
  buildsDocument({
    args: PROJECT,
    build: (connected: typeof accountListRoute.body) => ({
      accounts: [connected]
    }),
    command: 'project platform whatsapp-business account list',
    from: [accountListRoute],
    routes: [accountListRoute],
    schema: AccountListSchema,
    shows: WABA_ID
  }),
  // --source byon hands off to the dashboard without a request.
  {
    args: [...PROJECT, '--source', 'byon', '--no-browser'],
    command: 'project platform whatsapp-business number add',
    document: {
      handoff: {
        browserAttempted: false,
        kind: 'whatsapp-embedded-signup',
        opened: false,
        projectId: PROJECT_ID,
        requiresHumanInteraction: true,
        source: 'byon',
        url: dashboardUrl([['source', 'byon']])
      }
    },
    routes: [],
    schema: handoffSchema('byon'),
    shows: `Dashboard URL: ${dashboardUrl([['source', 'byon']])}`,
    showsNoApiText: true
  },
  // --new-waba reads the SMS number, checks no sender uses it, and hands it
  // to the dashboard.
  buildsDocument({
    args: [
      ...PROJECT,
      '--source',
      'photon',
      '--new-waba',
      '--voip-resource-id',
      SMS_NUMBER_ID,
      '--no-browser'
    ],
    build: (number: typeof smsNumberRoute.body) => ({
      handoff: {
        browserAttempted: false,
        kind: 'whatsapp-embedded-signup',
        opened: false,
        projectId: PROJECT_ID,
        requiresHumanInteraction: true,
        resource: number,
        source: 'photon',
        url: dashboardUrl([
          ['source', 'photon'],
          ['voipResourceId', number.resourceId],
          ['verification', 'dashboard']
        ]),
        verificationOwner: 'dashboard'
      }
    }),
    command: 'project platform whatsapp-business number add',
    from: [smsNumberRoute],
    routes: [smsNumberRoute, noSendersRoute],
    schema: handoffSchema('photon'),
    shows: `Enter ${PHONE_NUMBER} when Meta asks which number to connect.`,
    showsNoApiText: true
  }),
  // --waba-id reads the SMS number, checks no sender uses it, checks the
  // account before and inside the journaled step, adds the sender, polls
  // the operation until it ends, and prints the last operation read.
  {
    args: [
      ...PROJECT,
      '--source',
      'photon',
      '--waba-id',
      WABA_ID,
      '--voip-resource-id',
      SMS_NUMBER_ID,
      '--display-name',
      'Acme Support',
      '--idempotency-key',
      'golden-whatsapp-add'
    ],
    command: 'project platform whatsapp-business number add',
    document: provisioned.body,
    routes: [
      smsNumberRoute,
      noSendersRoute,
      accountRoute(),
      accountRoute(),
      {
        body: operation(
          PROVISION_ID,
          'pending'
        ) satisfies Declared<CreateWhatsappVoipSenderOutput>,
        headers: { 'retry-after': '3' },
        method: 'POST',
        path: `${ACCOUNT}/senders`,
        requestBody: {
          displayName: 'Acme Support',
          voipResourceId: SMS_NUMBER_ID
        },
        status: 202
      },
      operationRoute(PROVISION_ID, {
        operation: operation(PROVISION_ID, 'running')
      }),
      provisioned
    ],
    schema: ProvisionedSchema,
    shows: `Connected ${PHONE_NUMBER} to WhatsApp Business.`
  },
  printsResponse({
    args: [...PROJECT, '--limit', '2'],
    command: 'project platform whatsapp-business number list',
    route: numberPageRoute,
    schema: NumberListSchema,
    shows: PHONE_NUMBER
  }),
  printsResponse({
    args: [SENDER_ID, ...PROJECT],
    command: 'project platform whatsapp-business number view',
    route: {
      body: withNewField({ ...sender, detail: withNewField(sender.detail) }),
      method: 'GET',
      path: `${RESOURCES}/${SENDER_ID}`
    },
    schema: SenderSchema,
    shows: PHONE_NUMBER
  }),
  // It reads the sender to check it, releases it, polls the release until it
  // ends, and prints the last operation read.
  {
    args: [SENDER_ID, ...PROJECT, '--yes'],
    command: 'project platform whatsapp-business number delete',
    document: released.body,
    routes: [
      senderRoute,
      {
        body: release('pending'),
        headers: { 'retry-after': '3' },
        method: 'DELETE',
        path: `${RESOURCES}/${SENDER_ID}`,
        status: 202,
        unshown: true
      },
      released
    ],
    schema: ReleasedSchema,
    shows: `Deleted WhatsApp Business number ${PHONE_NUMBER} (${SENDER_ID}).`,
    showsNoApiText: true
  },
  // A release Photon answers as already ended has nothing to poll. The CLI
  // prints the answer under operation, as an operation read holds it.
  {
    args: [SENDER_ID, ...PROJECT, '--yes'],
    command: 'project platform whatsapp-business number delete',
    document: { operation: releaseAnswer.body },
    embeds: 'operation',
    routes: [senderRoute, releaseAnswer],
    schema: ReleaseAnswerSchema,
    shows: `Deleted WhatsApp Business number ${PHONE_NUMBER} (${SENDER_ID}).`,
    showsNoApiText: true
  }
]
