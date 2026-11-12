import {
  type GetOperationOutput,
  GetOperationOutputSchema,
  type ListOperationsOutput,
  ListOperationsOutputSchema,
  type ListResourcesOutput,
  ListResourcesOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { identifier } from '../../src/operation/intent-fields.ts'
import { selectEmailDomainOperationDetail } from '../../src/project/email-domain.ts'
import { isResourceOperationInProgress } from '../../src/project/service.ts'
import {
  buildsDocument,
  type Declared,
  type FakeRoute,
  type GoldenCase,
  PLANTED,
  withNewField
} from './support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const PLATFORMS = `/v1/projects/${PROJECT_ID}/platforms`
const RESOURCES = `${PLATFORMS}/resources`
const OPERATIONS = `${PLATFORMS}/operations`
const PROVISIONING_QUERY = `${OPERATIONS}?pageSize=200&state=pending%2Crunning&type=resource.provision`
const SMS_NUMBER_ID = 'pho_res_01h455vb4pex5vsknk084sn03a'
const IMESSAGE_LINE_ID = 'pho_res_01h455vb4pex5vsknk084sn03b'
const EMAIL_DOMAIN_ID = 'pho_res_01h455vb4pex5vsknk084sn03c'
const TELEGRAM_BOT_ID = 'pho_res_01h455vb4pex5vsknk084sn03d'
const SMS_PURCHASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03a'
const IMESSAGE_PURCHASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03b'
const EMAIL_CONNECT_ID = 'pho_opr_01h455vb4pex5vsknk084sn03c'
const TELEGRAM_CONNECT_ID = 'pho_opr_01h455vb4pex5vsknk084sn03d'
const SMS_RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03e'
const EMAIL_RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03f'
const TELEGRAM_RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn03g'
const SMS_PROVISIONING_ID = 'pho_opr_01h455vb4pex5vsknk084sn03h'
const IMESSAGE_PROVISIONING_ID = 'pho_opr_01h455vb4pex5vsknk084sn03j'
const EMAIL_PROVISIONING_ID = 'pho_opr_01h455vb4pex5vsknk084sn03k'
const TELEGRAM_PROVISIONING_ID = 'pho_opr_01h455vb4pex5vsknk084sn03m'
const DOMAIN = 'mail.example.test'
const PHONE_NUMBER = '+14155550125'
const IMESSAGE_PHONE_NUMBER = '+14155550126'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=golden_setup'
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'

type Operation = Declared<GetOperationOutput['operation']>
type Resource = Declared<ListResourcesOutput['resources'][number]>

const operation = (
  operationId: string,
  resourceType: string,
  state: string,
  fields: Partial<Operation> = {}
) =>
  ({
    cancellable: false,
    createdAt,
    operationId,
    projectId: PROJECT_ID,
    resourceType,
    startedAt: createdAt,
    state,
    type: 'resource.provision',
    updatedAt,
    ...fields
  }) satisfies Operation

const operationRoute = (
  operationId: string,
  body: Declared<GetOperationOutput>
) =>
  ({
    body,
    method: 'GET',
    path: `${OPERATIONS}/${operationId}`
  }) as const satisfies FakeRoute

// The command reads the resource to check its type before it releases it.
const resourceRoute = (resource: Resource) =>
  ({
    body: resource,
    method: 'GET',
    path: `${RESOURCES}/${resource.resourceId}`,
    unshown: true
  }) as const satisfies FakeRoute

const releaseRoute = (resourceId: string, body: Operation) =>
  ({
    body,
    method: 'DELETE',
    path: `${RESOURCES}/${resourceId}`,
    status: 202,
    unshown: true
  }) as const satisfies FakeRoute

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

const imessageLine = {
  abilities: ['imessage', 'pstn_voice'],
  createdAt,
  detail: { healthy: true, phoneNumber: IMESSAGE_PHONE_NUMBER },
  projectId: PROJECT_ID,
  resourceId: IMESSAGE_LINE_ID,
  state: 'active',
  type: 'cosmos_line',
  updatedAt
} satisfies Resource

const emailDomain = {
  abilities: ['email'],
  createdAt,
  detail: { domain: DOMAIN, healthy: true },
  projectId: PROJECT_ID,
  resourceId: EMAIL_DOMAIN_ID,
  state: 'active',
  type: 'email_domain',
  updatedAt
} satisfies Resource

const telegramBot = {
  abilities: ['telegram'],
  createdAt,
  detail: {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  },
  projectId: PROJECT_ID,
  resourceId: TELEGRAM_BOT_ID,
  state: 'active',
  type: 'telegram_bot',
  updatedAt
} satisfies Resource

const dnsRecords = [
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

const automaticSetup = {
  applyUrl: `https://connect.provider.example/v2/domainTemplates/providers/photon.codes/services/email-sending/apply?domain=${DOMAIN}`,
  dnsProviderId: 'provider.example',
  providerDisplayName: 'Example DNS'
}

const OperationSchema = GetOperationOutputSchema.shape.operation

// A list prints the resource page as Photon sends it, with the provisioning
// operations still in progress for the listed resource type beside it. The
// CLI leaves out any other operation the operations page holds.
const listSchema = (resourceType: string) =>
  ListResourcesOutputSchema.extend({
    provisioning: ListOperationsOutputSchema.shape.operations.element
      .refine(
        (listed) =>
          listed.resourceType === resourceType &&
          listed.type === 'resource.provision' &&
          isResourceOperationInProgress(listed.state)
      )
      .array()
  })

// It reads the resource page and the provisioning operations at once, and
// prints the page with the operations still in progress for the listed
// resource type beside it, under provisioning.
const listCase = ({
  ability,
  command,
  provisioningId,
  resource,
  shows
}: {
  readonly ability: string
  readonly command: string
  readonly provisioningId: string
  readonly resource: Resource
  readonly shows: string
}): GoldenCase => {
  const pageRoute = {
    body: withNewField({
      nextPageToken: 'page-2',
      resources: [withNewField(resource)]
    }) satisfies Declared<ListResourcesOutput>,
    method: 'GET',
    path: `${RESOURCES}?ability=${ability}&pageSize=1`
  } as const satisfies FakeRoute
  const provisioningRoute = {
    body: {
      operations: [
        withNewField(operation(provisioningId, resource.type, 'running'))
      ]
    } satisfies Declared<ListOperationsOutput>,
    method: 'GET',
    path: PROVISIONING_QUERY
  } as const satisfies FakeRoute
  return buildsDocument({
    args: [...PROJECT, '--limit', '1'],
    build: (
      page: typeof pageRoute.body,
      provisioning: typeof provisioningRoute.body
    ) => ({ ...page, provisioning: provisioning.operations }),
    command,
    concurrent: 2,
    from: [pageRoute, provisioningRoute],
    routes: [pageRoute, provisioningRoute],
    schema: listSchema(resource.type),
    shows
  })
}

// A purchase polls the operation it started until it ends. The CLI rejects
// a poll that names another operation, an operation that doesn't succeed and
// a resource without the ability it bought, before anything prints.
const provisionedSchema = (operationId: string, ability: string) =>
  GetOperationOutputSchema.refine(
    (read) =>
      read.operation.operationId === operationId &&
      read.operation.state === 'succeeded' &&
      read.resource?.abilities.includes(ability) === true
  )

// The operation read again after it succeeded without its resource. The CLI
// checks that it names the same operation, that it succeeded and that the
// resource has the ability.
const reReadSchema = (operationId: string, ability: string) =>
  GetOperationOutputSchema.refine(
    (read) =>
      read.operation.operationId === operationId &&
      read.operation.state === 'succeeded' &&
      read.resource?.abilities.includes(ability) === true
  )

// A release polls the operation it started until it ends. The CLI rejects an
// operation that names another operation, project or resource, that isn't a
// release, or that doesn't succeed. An email domain's release also names its
// resource type.
const releasedSchema = (
  operationId: string,
  resourceId: string,
  resourceType?: string
) =>
  GetOperationOutputSchema.refine(
    (read) =>
      read.operation.operationId === operationId &&
      read.operation.projectId === PROJECT_ID &&
      read.operation.resourceId === resourceId &&
      (resourceType === undefined ||
        read.operation.resourceType === resourceType) &&
      read.operation.type === 'resource.release' &&
      read.operation.state === 'succeeded'
  )

// The answer to a release that has already ended, which the CLI prints under
// operation, as an operation read holds it. The CLI rejects one for another
// project or resource, or that isn't a release. The local journal records the
// operation's ID, and rejects one with control characters.
const releaseAnswerSchema = (resourceId: string) =>
  z.strictObject({
    operation: OperationSchema.refine(
      (answer) =>
        identifier.safeParse(answer.operationId).success &&
        answer.projectId === PROJECT_ID &&
        answer.resourceId === resourceId &&
        answer.type === 'resource.release' &&
        answer.state === 'succeeded'
    )
  })

const isEmailDomainSetup = (setup: z.infer<typeof OperationSchema>) =>
  setup.projectId === PROJECT_ID &&
  setup.resourceType === 'email_domain' &&
  setup.type === 'resource.provision' &&
  selectEmailDomainOperationDetail(setup.detail).status === 'present'

// The answer to email connect, with the DNS instructions, while the setup
// runs. The CLI checks the setup and its DNS instructions, and the journal
// records its ID.
const EmailSetupAnswerSchema = z.strictObject({
  operation: OperationSchema.refine(
    (answer) =>
      identifier.safeParse(answer.operationId).success &&
      isResourceOperationInProgress(answer.state) &&
      isEmailDomainSetup(answer)
  )
})

const EmailConnectedSchema = GetOperationOutputSchema.refine(
  (read) =>
    read.operation.operationId === EMAIL_CONNECT_ID &&
    read.operation.state === 'succeeded' &&
    isEmailDomainSetup(read.operation) &&
    read.resource?.type === 'email_domain' &&
    read.resource.abilities.includes('email')
)

// The answer to telegram connect while the setup waits for a bot. The CLI
// checks that it sets up a Telegram bot in the project, and the journal
// records its ID.
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

const TelegramConnectedSchema = GetOperationOutputSchema.refine(
  (read) =>
    read.operation.operationId === TELEGRAM_CONNECT_ID &&
    read.operation.state === 'succeeded' &&
    read.resource?.type === 'telegram_bot'
)

// The CLI checks that the release is the bot's, in the project.
const TelegramReleasedSchema = GetOperationOutputSchema.refine(
  ({ operation: release }) =>
    release.operationId === TELEGRAM_RELEASE_ID &&
    release.projectId === PROJECT_ID &&
    release.resourceId === TELEGRAM_BOT_ID &&
    release.resourceType === 'telegram_bot' &&
    release.type === 'resource.release' &&
    release.state === 'succeeded'
)

const smsPurchaseRoute = {
  body: operation(SMS_PURCHASE_ID, 'voip_line', 'pending'),
  method: 'POST',
  path: `${PLATFORMS}/sms/numbers`,
  requestBody: { countryCode: 'US' },
  status: 202
} as const satisfies FakeRoute

const smsPurchased = operationRoute(SMS_PURCHASE_ID, {
  operation: withNewField(
    operation(SMS_PURCHASE_ID, 'voip_line', 'succeeded', {
      endedAt: updatedAt,
      resourceId: SMS_NUMBER_ID
    })
  ),
  resource: withNewField(smsNumber)
})

const imessagePurchased = operationRoute(IMESSAGE_PURCHASE_ID, {
  operation: withNewField(
    operation(IMESSAGE_PURCHASE_ID, 'cosmos_line', 'succeeded', {
      endedAt: updatedAt,
      resourceId: IMESSAGE_LINE_ID
    })
  ),
  resource: withNewField(imessageLine)
})

const smsReleased = operationRoute(SMS_RELEASE_ID, {
  operation: withNewField(
    operation(SMS_RELEASE_ID, 'voip_line', 'succeeded', {
      endedAt: updatedAt,
      resourceId: SMS_NUMBER_ID,
      type: 'resource.release'
    })
  )
})

const smsReleaseAnswer = {
  body: withNewField(
    operation(SMS_RELEASE_ID, 'voip_line', 'succeeded', {
      endedAt: updatedAt,
      resourceId: SMS_NUMBER_ID,
      type: 'resource.release'
    })
  ),
  method: 'DELETE',
  path: `${RESOURCES}/${SMS_NUMBER_ID}`
} as const satisfies FakeRoute

const emailSetupAnswer = operation(
  EMAIL_CONNECT_ID,
  'email_domain',
  'running',
  {
    detail: { automaticSetup, dnsRecords }
  }
)

const emailSetupAnswerRoute = {
  body: withNewField(emailSetupAnswer),
  method: 'POST',
  path: `${PLATFORMS}/email/domains`,
  requestBody: { domain: DOMAIN },
  status: 202
} as const satisfies FakeRoute

const emailConnected = operationRoute(EMAIL_CONNECT_ID, {
  operation: withNewField(
    operation(EMAIL_CONNECT_ID, 'email_domain', 'succeeded', {
      detail: {
        dnsRecords,
        verification: {
          dkimReady: true,
          dnsReady: true,
          identityReady: true,
          lastCheckedAt: updatedAt,
          mailFromReady: true
        }
      },
      endedAt: updatedAt,
      resourceId: EMAIL_DOMAIN_ID
    })
  ),
  resource: withNewField(emailDomain)
})

const emailReleased = operationRoute(EMAIL_RELEASE_ID, {
  operation: withNewField(
    operation(EMAIL_RELEASE_ID, 'email_domain', 'succeeded', {
      endedAt: updatedAt,
      resourceId: EMAIL_DOMAIN_ID,
      type: 'resource.release'
    })
  )
})

const telegramSetupAnswer = (detail: Record<string, string> = {}) =>
  operation(TELEGRAM_CONNECT_ID, 'telegram_bot', 'pending', {
    detail: { setupUrl: SETUP_URL, ...detail }
  })

const telegramSetupAnswerRoute = (detail: Record<string, string> = {}) =>
  ({
    body: withNewField(telegramSetupAnswer(detail)),
    method: 'POST',
    path: `${PLATFORMS}/telegram/bots`,
    requestBody: {},
    status: 202
  }) as const satisfies FakeRoute

const telegramNoWaitAnswer = telegramSetupAnswerRoute()

const telegramConnected = operationRoute(TELEGRAM_CONNECT_ID, {
  operation: withNewField(
    operation(TELEGRAM_CONNECT_ID, 'telegram_bot', 'succeeded', {
      endedAt: updatedAt,
      resourceId: TELEGRAM_BOT_ID
    })
  ),
  resource: withNewField(telegramBot)
})

const telegramReleased = operationRoute(TELEGRAM_RELEASE_ID, {
  operation: withNewField(
    operation(TELEGRAM_RELEASE_ID, 'telegram_bot', 'succeeded', {
      endedAt: updatedAt,
      resourceId: TELEGRAM_BOT_ID,
      type: 'resource.release'
    })
  )
})

// telegram connect reads the project's bots and setups at once first, to say
// which bots it already has. Text shows only their checked usernames.
const telegramStateRoutes = (resources: Resource[]): readonly FakeRoute[] => [
  {
    body: { resources } satisfies Declared<ListResourcesOutput>,
    method: 'GET',
    path: `${RESOURCES}?ability=telegram&pageSize=30`
  },
  {
    body: { operations: [] } satisfies Declared<ListOperationsOutput>,
    method: 'GET',
    path: PROVISIONING_QUERY
  }
]

/** Golden tests for the project platform commands that start and wait. */
export const PLATFORM_OPERATION_GOLDENS: readonly GoldenCase[] = [
  listCase({
    ability: 'email',
    command: 'project platform email list',
    provisioningId: EMAIL_PROVISIONING_ID,
    resource: emailDomain,
    shows: DOMAIN
  }),
  listCase({
    ability: 'imessage',
    command: 'project platform imessage list',
    provisioningId: IMESSAGE_PROVISIONING_ID,
    resource: imessageLine,
    shows: IMESSAGE_PHONE_NUMBER
  }),
  listCase({
    ability: 'sms',
    command: 'project platform sms list',
    provisioningId: SMS_PROVISIONING_ID,
    resource: smsNumber,
    shows: PHONE_NUMBER
  }),
  listCase({
    ability: 'telegram',
    command: 'project platform telegram list',
    provisioningId: TELEGRAM_PROVISIONING_ID,
    resource: telegramBot,
    shows: '@AlexSupportBot'
  }),
  // It polls the purchase until it ends, and prints the operation read that
  // holds the number.
  {
    args: [...PROJECT, '--idempotency-key', 'golden-sms-purchase', '--yes'],
    command: 'project platform sms purchase',
    document: smsPurchased.body,
    routes: [
      smsPurchaseRoute,
      operationRoute(SMS_PURCHASE_ID, {
        operation: operation(SMS_PURCHASE_ID, 'voip_line', 'running')
      }),
      smsPurchased
    ],
    schema: provisionedSchema(SMS_PURCHASE_ID, 'sms'),
    shows: `Provisioned SMS number ${PHONE_NUMBER}.`
  },
  // An operation read that succeeds without the number is read once more,
  // and the CLI prints that second read.
  {
    args: [...PROJECT, '--idempotency-key', 'golden-sms-purchase', '--yes'],
    command: 'project platform sms purchase',
    document: smsPurchased.body,
    routes: [
      smsPurchaseRoute,
      operationRoute(SMS_PURCHASE_ID, {
        operation: operation(SMS_PURCHASE_ID, 'voip_line', 'succeeded', {
          endedAt: updatedAt
        })
      }),
      smsPurchased
    ],
    schema: reReadSchema(SMS_PURCHASE_ID, 'sms'),
    shows: `Provisioned SMS number ${PHONE_NUMBER}.`
  },
  {
    args: [
      ...PROJECT,
      '--idempotency-key',
      'golden-imessage-purchase',
      '--yes'
    ],
    command: 'project platform imessage purchase',
    document: imessagePurchased.body,
    routes: [
      {
        body: operation(IMESSAGE_PURCHASE_ID, 'cosmos_line', 'pending'),
        method: 'POST',
        path: `${PLATFORMS}/imessage/dedicated`,
        status: 202
      },
      imessagePurchased
    ],
    schema: provisionedSchema(IMESSAGE_PURCHASE_ID, 'imessage'),
    shows: `Provisioned iMessage line ${IMESSAGE_PHONE_NUMBER}.`
  },
  // It reads the number to check it can send SMS, releases it, polls the
  // release until it ends, and prints the last operation read.
  {
    args: [SMS_NUMBER_ID, ...PROJECT, '--yes'],
    command: 'project platform sms delete',
    document: smsReleased.body,
    routes: [
      resourceRoute(smsNumber),
      releaseRoute(
        SMS_NUMBER_ID,
        operation(SMS_RELEASE_ID, 'voip_line', 'pending', {
          resourceId: SMS_NUMBER_ID,
          type: 'resource.release'
        })
      ),
      smsReleased
    ],
    schema: releasedSchema(SMS_RELEASE_ID, SMS_NUMBER_ID),
    shows: `Deleted SMS number ${SMS_NUMBER_ID}.`,
    showsNoApiText: true
  },
  // A release Photon answers as already ended has nothing to poll. The CLI
  // prints the answer under operation, as an operation read holds it.
  {
    args: [SMS_NUMBER_ID, ...PROJECT, '--yes'],
    command: 'project platform sms delete',
    document: { operation: smsReleaseAnswer.body },
    embeds: 'operation',
    routes: [resourceRoute(smsNumber), smsReleaseAnswer],
    schema: releaseAnswerSchema(SMS_NUMBER_ID),
    shows: `Deleted SMS number ${SMS_NUMBER_ID}.`,
    showsNoApiText: true
  },
  // With --no-wait it prints the answer that holds the DNS instructions,
  // under operation, as an operation read holds it.
  {
    args: [
      DOMAIN,
      ...PROJECT,
      '--idempotency-key',
      'golden-email-connect',
      '--no-browser',
      '--no-wait'
    ],
    command: 'project platform email connect',
    document: { operation: emailSetupAnswerRoute.body },
    embeds: 'operation',
    routes: [emailSetupAnswerRoute],
    schema: EmailSetupAnswerSchema,
    shows: 'feedback-smtp.us-west-2.amazonses.com'
  },
  // Otherwise it shows the DNS instructions from the answer, polls the setup
  // until Photon verifies the records, and prints the last operation read.
  {
    args: [
      DOMAIN,
      ...PROJECT,
      '--idempotency-key',
      'golden-email-connect',
      '--no-browser'
    ],
    command: 'project platform email connect',
    document: emailConnected.body,
    routes: [
      {
        ...emailSetupAnswerRoute,
        planted: {
          ...emailSetupAnswerRoute.body,
          detail: {
            automaticSetup,
            dnsRecords: dnsRecords.map((record) =>
              record.type === 'TXT'
                ? { ...record, value: `a${PLANTED}${record.value}` }
                : record
            )
          }
        },
        plantedOn: 'stdout'
      },
      operationRoute(EMAIL_CONNECT_ID, { operation: emailSetupAnswer }),
      emailConnected
    ],
    schema: EmailConnectedSchema,
    shows: `Connected ${DOMAIN}.`
  },
  // When the answer doesn't hold the DNS instructions yet, it reads the setup
  // until a read does. It shows them and waits as above, even when that read
  // already holds the email domain while the setup runs.
  {
    args: [
      DOMAIN,
      ...PROJECT,
      '--idempotency-key',
      'golden-email-connect',
      '--no-browser'
    ],
    command: 'project platform email connect',
    document: emailConnected.body,
    routes: [
      {
        ...emailSetupAnswerRoute,
        body: operation(EMAIL_CONNECT_ID, 'email_domain', 'running'),
        unshown: true
      },
      {
        ...operationRoute(EMAIL_CONNECT_ID, {
          operation: emailSetupAnswer,
          resource: emailDomain
        }),
        planted: {
          operation: {
            ...emailSetupAnswer,
            detail: {
              automaticSetup,
              dnsRecords: dnsRecords.map((record) =>
                record.type === 'TXT'
                  ? { ...record, value: `a${PLANTED}${record.value}` }
                  : record
              )
            }
          },
          resource: emailDomain
        },
        plantedOn: 'stdout'
      },
      emailConnected
    ],
    schema: EmailConnectedSchema,
    shows: `Started connecting ${DOMAIN}.`
  },
  // It reads the domain to check its type, releases it, polls the release
  // until it ends, and prints the last operation read.
  {
    args: [EMAIL_DOMAIN_ID, ...PROJECT, '--yes'],
    command: 'project platform email disconnect',
    document: emailReleased.body,
    routes: [
      resourceRoute(emailDomain),
      releaseRoute(
        EMAIL_DOMAIN_ID,
        operation(EMAIL_RELEASE_ID, 'email_domain', 'pending', {
          resourceId: EMAIL_DOMAIN_ID,
          type: 'resource.release'
        })
      ),
      emailReleased
    ],
    schema: releasedSchema(EMAIL_RELEASE_ID, EMAIL_DOMAIN_ID, 'email_domain'),
    shows: `Disconnected email domain resource ${EMAIL_DOMAIN_ID}.`,
    showsNoApiText: true
  },
  // With --no-wait it prints the answer that holds the setup link, under
  // operation, as an operation read holds it. Text shows the link only after
  // the CLI checks it, so a link with control characters stays in JSON as
  // Photon sent it, and text leaves it out.
  {
    args: [
      ...PROJECT,
      '--idempotency-key',
      'golden-telegram-connect',
      '--no-browser',
      '--no-wait',
      '--yes'
    ],
    command: 'project platform telegram connect',
    concurrent: 2,
    document: { operation: telegramNoWaitAnswer.body },
    embeds: 'operation',
    routes: [
      ...telegramStateRoutes([]).map((route) => ({
        ...route,
        unshown: true as const
      })),
      telegramNoWaitAnswer
    ],
    schema: TelegramSetupAnswerSchema,
    shows: SETUP_URL,
    showsNoApiText: true
  },
  // Otherwise it shows the setup from the answer, polls the setup until the
  // bot is connected, and prints the last operation read.
  {
    args: [
      ...PROJECT,
      '--idempotency-key',
      'golden-telegram-connect',
      '--no-browser',
      '--yes'
    ],
    command: 'project platform telegram connect',
    concurrent: 2,
    document: telegramConnected.body,
    routes: [
      ...telegramStateRoutes([telegramBot]),
      {
        ...telegramSetupAnswerRoute({ displayName: 'Alex Support' }),
        planted: telegramSetupAnswer({
          displayName: `a${PLANTED}Alex Support`
        }),
        plantedOn: 'stdout'
      },
      operationRoute(TELEGRAM_CONNECT_ID, { operation: telegramSetupAnswer() }),
      telegramConnected
    ],
    schema: TelegramConnectedSchema,
    shows: 'Connected @AlexSupportBot.'
  },
  // It reads the bot to check its type, releases it, polls the release until
  // it ends, and prints the last operation read.
  {
    args: [TELEGRAM_BOT_ID, ...PROJECT, '--yes'],
    command: 'project platform telegram disconnect',
    document: telegramReleased.body,
    routes: [
      resourceRoute(telegramBot),
      releaseRoute(
        TELEGRAM_BOT_ID,
        operation(TELEGRAM_RELEASE_ID, 'telegram_bot', 'pending', {
          resourceId: TELEGRAM_BOT_ID,
          type: 'resource.release'
        })
      ),
      telegramReleased
    ],
    schema: TelegramReleasedSchema,
    shows: `Disconnected Telegram bot resource ${TELEGRAM_BOT_ID}.`,
    showsNoApiText: true
  }
]
