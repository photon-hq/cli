import {
  type CancelOperationOutput,
  CancelOperationOutputSchema,
  type CreateSharedLineAssignmentOutput,
  CreateSharedLineAssignmentOutputSchema,
  type GetOperationOutput,
  GetOperationOutputSchema,
  type GetProjectImessagePlatformOutput,
  GetProjectImessagePlatformOutputSchema,
  type GetResourceOutput,
  GetResourceOutputSchema,
  type GetSharedLineAssignmentOutput,
  GetSharedLineAssignmentOutputSchema,
  type ListProjectPlatformsOutput,
  ListProjectPlatformsOutputSchema,
  type ListSharedLineAssignmentsOutput,
  ListSharedLineAssignmentsOutputSchema,
  type ReleaseSharedLineAssignmentOutput,
  ReleaseSharedLineAssignmentOutputSchema
} from '@photon-ai/api-public'
import { selectEmailDomainOperationDetail } from '../../src/project/email-domain.ts'
import {
  type Declared,
  type GoldenCase,
  NEW_API_FIELD,
  printsResponse,
  withNewField
} from './support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const PLATFORMS = `/v1/projects/${PROJECT_ID}/platforms`
const CANCELLED_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const EMAIL_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02r'
const ASSIGNMENT_ID = 'pho_asg_01h455vb4pex5vsknk084sn02q'
const ASSIGNMENTS = `${PLATFORMS}/imessage/assignments`
const TELEGRAM_BOT_ID = 'pho_res_01h455vb4pex5vsknk084sn02q'
const EMAIL_DOMAIN_ID = 'pho_res_01h455vb4pex5vsknk084sn02r'
const DOMAIN = 'mail.example.test'
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'

const platforms = {
  platforms: [
    withNewField({
      description: 'Text messages over a project-owned phone number.',
      displayName: 'SMS',
      type: 'sms'
    }),
    {
      description: 'iMessage on a dedicated or shared line.',
      displayName: 'iMessage',
      type: 'imessage'
    }
  ]
} satisfies Declared<ListProjectPlatformsOutput>

const cancelledOperation = {
  cancellable: false,
  createdAt,
  endedAt: updatedAt,
  error: withNewField({
    code: 'CHARGE_REFUSED',
    detail: 'The payment method was declined.'
  }),
  operationId: CANCELLED_OPERATION_ID,
  projectId: PROJECT_ID,
  reason: 'charge_refused',
  resourceType: 'cosmos_line',
  startedAt: createdAt,
  state: 'cancelled',
  type: 'resource.provision',
  updatedAt
} satisfies Declared<CancelOperationOutput>

const emailDomainOperation = {
  cancellable: false,
  createdAt,
  detail: {
    automaticSetup: {
      applyUrl: `https://connect.provider.example/v2/domainTemplates/providers/photon.codes/services/email-sending/apply?domain=${DOMAIN}`,
      dnsProviderId: 'provider.example',
      providerDisplayName: 'Example DNS'
    },
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
    ],
    verification: {
      dkimReady: true,
      dnsReady: true,
      identityReady: true,
      lastCheckedAt: updatedAt,
      mailFromReady: true
    }
  },
  endedAt: updatedAt,
  operationId: EMAIL_OPERATION_ID,
  projectId: PROJECT_ID,
  resourceId: EMAIL_DOMAIN_ID,
  resourceType: 'email_domain',
  startedAt: createdAt,
  state: 'succeeded',
  type: 'resource.provision',
  updatedAt
} satisfies Declared<GetOperationOutput['operation']>

const emailDomain = {
  abilities: ['email'],
  createdAt,
  detail: { domain: DOMAIN, healthy: true },
  projectId: PROJECT_ID,
  resourceId: EMAIL_DOMAIN_ID,
  state: 'active',
  type: 'email_domain',
  updatedAt
} satisfies Declared<NonNullable<GetOperationOutput['resource']>>

const emailDomainSetup = {
  operation: withNewField(emailDomainOperation),
  resource: withNewField(emailDomain)
} satisfies Declared<GetOperationOutput>

// The CLI checks that the operation set up an email domain in the project and
// that its detail holds valid DNS instructions, and rejects any other response
// before anything prints. A string those checks constrain can't carry planted
// characters.
const EmailDomainDnsOutputSchema = GetOperationOutputSchema.refine(
  ({ operation }) =>
    operation.projectId === PROJECT_ID &&
    operation.resourceType === 'email_domain' &&
    operation.type === 'resource.provision' &&
    selectEmailDomainOperationDetail(operation.detail).status === 'present'
)

const imessagePlatform = {
  dedicatedLineAvailableNow: true,
  maxUserAssignments: 10,
  mode: 'shared'
} satisfies Declared<GetProjectImessagePlatformOutput>

const assignment = {
  assignedPhoneNumber: '+14155550124',
  assignmentId: ASSIGNMENT_ID,
  createdAt,
  email: 'ada@example.test',
  firstName: 'Ada',
  handle: '+14155550123',
  lastName: 'Lovelace',
  platform: 'imessage',
  projectId: PROJECT_ID,
  updatedAt: createdAt
} satisfies Declared<GetSharedLineAssignmentOutput>

const assignments = {
  assignments: [
    withNewField(assignment),
    {
      assignedPhoneNumber: '+14155550124',
      assignmentId: 'pho_asg_01h455vb4pex5vsknk084sn02r',
      createdAt,
      handle: '+14155550125',
      platform: 'imessage',
      projectId: PROJECT_ID,
      updatedAt: createdAt
    }
  ],
  nextPageToken: 'page-2'
} satisfies Declared<ListSharedLineAssignmentsOutput>

const createdAssignment =
  assignment satisfies Declared<CreateSharedLineAssignmentOutput>

const releasedAssignment = {
  ...assignment,
  releasedAt: updatedAt,
  updatedAt
} satisfies Declared<ReleaseSharedLineAssignmentOutput>

const telegramBot = {
  abilities: ['telegram'],
  createdAt,
  detail: {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot',
    ...NEW_API_FIELD
  },
  projectId: PROJECT_ID,
  resourceId: TELEGRAM_BOT_ID,
  state: 'active',
  type: 'telegram_bot',
  updatedAt
} satisfies Declared<GetResourceOutput>

// telegram view rejects a resource that isn't a Telegram bot before anything
// prints, so its type can't carry planted characters.
const TelegramBotOutputSchema = GetResourceOutputSchema.refine(
  ({ type }) => type === 'telegram_bot'
)

/** Golden tests for the project platform commands that read one response. */
export const PLATFORM_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: PROJECT,
    command: 'project platform list',
    route: { body: withNewField(platforms), method: 'GET', path: PLATFORMS },
    schema: ListProjectPlatformsOutputSchema,
    shows: 'iMessage on a dedicated or shared line.'
  }),
  printsResponse({
    args: [CANCELLED_OPERATION_ID, ...PROJECT, '--yes'],
    command: 'project platform operation cancel',
    route: {
      body: withNewField(cancelledOperation),
      method: 'POST',
      path: `${PLATFORMS}/operations/${CANCELLED_OPERATION_ID}/cancel`
    },
    schema: CancelOperationOutputSchema,
    shows: 'cosmos_line'
  }),
  printsResponse({
    args: [EMAIL_OPERATION_ID, ...PROJECT],
    command: 'project platform email dns',
    route: {
      body: withNewField(emailDomainSetup),
      method: 'GET',
      path: `${PLATFORMS}/operations/${EMAIL_OPERATION_ID}`
    },
    schema: EmailDomainDnsOutputSchema,
    shows: 'feedback-smtp.us-west-2.amazonses.com'
  }),
  printsResponse({
    args: PROJECT,
    command: 'project platform imessage view',
    route: {
      body: withNewField(imessagePlatform),
      method: 'GET',
      path: `${PLATFORMS}/imessage`
    },
    schema: GetProjectImessagePlatformOutputSchema,
    shows: 'shared',
    showsNoApiText: true
  }),
  printsResponse({
    args: [
      '--phone-number',
      assignment.handle,
      '--email',
      assignment.email,
      '--first-name',
      assignment.firstName,
      '--last-name',
      assignment.lastName,
      ...PROJECT,
      '--idempotency-key',
      'golden-assignment-create'
    ],
    command: 'project platform imessage assignment create',
    route: {
      body: withNewField(createdAssignment),
      method: 'POST',
      path: ASSIGNMENTS,
      requestBody: {
        email: assignment.email,
        firstName: assignment.firstName,
        handle: assignment.handle,
        lastName: assignment.lastName
      },
      status: 201
    },
    schema: CreateSharedLineAssignmentOutputSchema,
    shows: assignment.assignedPhoneNumber
  }),
  printsResponse({
    args: [...PROJECT, '--limit', '2'],
    command: 'project platform imessage assignment list',
    route: {
      body: withNewField(assignments),
      method: 'GET',
      path: `${ASSIGNMENTS}?pageSize=2`
    },
    schema: ListSharedLineAssignmentsOutputSchema,
    shows: '+14155550125'
  }),
  printsResponse({
    args: [ASSIGNMENT_ID, ...PROJECT],
    command: 'project platform imessage assignment view',
    route: {
      body: withNewField(assignment),
      method: 'GET',
      path: `${ASSIGNMENTS}/${ASSIGNMENT_ID}`
    },
    schema: GetSharedLineAssignmentOutputSchema,
    shows: assignment.assignedPhoneNumber
  }),
  printsResponse({
    args: [ASSIGNMENT_ID, ...PROJECT, '--yes'],
    command: 'project platform imessage assignment release',
    route: {
      body: withNewField(releasedAssignment),
      method: 'DELETE',
      path: `${ASSIGNMENTS}/${ASSIGNMENT_ID}`
    },
    schema: ReleaseSharedLineAssignmentOutputSchema,
    shows: `Released iMessage assignment ${ASSIGNMENT_ID}.`,
    showsNoApiText: true
  }),
  printsResponse({
    args: [TELEGRAM_BOT_ID, ...PROJECT],
    command: 'project platform telegram view',
    route: {
      body: withNewField(telegramBot),
      method: 'GET',
      path: `${PLATFORMS}/resources/${TELEGRAM_BOT_ID}`
    },
    schema: TelegramBotOutputSchema,
    shows: '@AlexSupportBot'
  })
]
