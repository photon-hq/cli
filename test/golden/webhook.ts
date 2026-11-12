import {
  type CreateWebhookDestinationOutput,
  CreateWebhookDestinationOutputSchema,
  type DeleteWebhookDestinationOutput,
  DeleteWebhookDestinationOutputSchema,
  type GetWebhookDestinationOutput,
  GetWebhookDestinationOutputSchema,
  type ListWebhookApiVersionsOutput,
  ListWebhookApiVersionsOutputSchema,
  type ListWebhookDestinationsOutput,
  ListWebhookDestinationsOutputSchema,
  type ListWebhookEventTypesOutput,
  ListWebhookEventTypesOutputSchema,
  type RotateWebhookSigningSecretOutput,
  RotateWebhookSigningSecretOutputSchema,
  type UpdateWebhookDestinationOutput,
  UpdateWebhookDestinationOutputSchema
} from '@photon-ai/api-public'
import {
  type Declared,
  type GoldenCase,
  printsResponse,
  withNewField
} from './support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const DESTINATION_ID = 'pho_whd_01h455vb4pex5vsknk084sn02q'
const PROJECT = ['--project', PROJECT_ID]
const WEBHOOKS = `/v1/projects/${PROJECT_ID}/webhooks`
const DESTINATION = `${WEBHOOKS}/destinations/${DESTINATION_ID}`
const SIGNING_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const ROTATED_SIGNING_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`

const destination = {
  apiVersion: '2026-07-01',
  createdAt: '2026-07-31T18:00:00.000Z',
  deletedAt: null,
  description: 'Production messages',
  destinationId: DESTINATION_ID,
  enabledEvents: ['message.created'],
  name: 'Production hook',
  projectId: PROJECT_ID,
  status: 'enabled',
  updatedAt: '2026-07-31T18:00:00.000Z',
  url: 'https://hooks.example.test/deliver'
} satisfies Declared<GetWebhookDestinationOutput>

const listed = {
  destinations: [
    withNewField(destination),
    {
      ...destination,
      description: null,
      destinationId: 'pho_whd_01h455vb4pex5vsknk084sn02r',
      enabledEvents: ['*'],
      name: 'Staging hook',
      status: 'disabled',
      url: 'https://hooks.example.test/staging'
    }
  ],
  nextPageToken: 'page-2'
} satisfies Declared<ListWebhookDestinationsOutput>

const created = {
  destination: withNewField(destination),
  signingSecret: SIGNING_SECRET
} satisfies Declared<CreateWebhookDestinationOutput>

const updated = {
  ...destination,
  status: 'disabled',
  updatedAt: '2026-08-01T18:00:00.000Z'
} satisfies Declared<UpdateWebhookDestinationOutput>

const deleted = {
  ...destination,
  deletedAt: '2026-08-01T18:00:00.000Z',
  updatedAt: '2026-08-01T18:00:00.000Z'
} satisfies Declared<DeleteWebhookDestinationOutput>

const rotated = {
  previousSecretExpiresAt: '2026-08-01T19:00:00.000Z',
  signingSecret: ROTATED_SIGNING_SECRET
} satisfies Declared<RotateWebhookSigningSecretOutput>

const latestApiVersion = {
  retirement: null,
  selectable: true,
  status: 'latest',
  successor: null,
  version: '2026-07-01'
} satisfies Declared<
  NonNullable<ListWebhookApiVersionsOutput>['apiVersions'][number]
>

const deprecatedApiVersion = {
  retirement: {
    migrationGuide: 'https://photon.codes/docs/webhooks/2026-07-01',
    reason: 'Replaced by 2026-07-01.'
  },
  selectable: false,
  status: 'deprecated',
  successor: '2026-07-01',
  version: '2026-01-01'
} satisfies Declared<
  NonNullable<ListWebhookApiVersionsOutput>['apiVersions'][number]
>

const apiVersions = {
  apiVersions: [withNewField(latestApiVersion), deprecatedApiVersion],
  contractNamespace: '@photon-hq/contracts',
  packageVersion: '1.0.0'
} satisfies Declared<ListWebhookApiVersionsOutput>

const eventType = {
  audience: 'agent',
  description: 'A message was created.',
  schemaProfile: 'reader',
  schemaUrl: `${WEBHOOKS}/event-types/message.created/schema?apiVersion=2026-07-01`,
  type: 'message.created'
} satisfies Declared<NonNullable<ListWebhookEventTypesOutput>['events'][number]>

const eventCatalog = {
  apiVersion: '2026-07-01',
  contractNamespace: '@photon-hq/contracts',
  events: [withNewField(eventType)],
  packageVersion: '1.0.0',
  retirement: null,
  selectable: true,
  status: 'latest',
  successor: null
} satisfies Declared<ListWebhookEventTypesOutput>

export const WEBHOOK_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: [...PROJECT, '--limit', '2'],
    command: 'project webhook list',
    route: {
      body: withNewField(listed),
      method: 'GET',
      path: `${WEBHOOKS}/destinations?pageSize=2`
    },
    schema: ListWebhookDestinationsOutputSchema,
    shows: 'Staging hook'
  }),
  printsResponse({
    args: [DESTINATION_ID, ...PROJECT],
    command: 'project webhook view',
    route: {
      body: withNewField(destination),
      method: 'GET',
      path: DESTINATION
    },
    schema: GetWebhookDestinationOutputSchema,
    shows: destination.url
  }),
  printsResponse({
    args: [
      ...PROJECT,
      '--name',
      destination.name,
      '--url',
      destination.url,
      '--api-version',
      destination.apiVersion,
      '--description',
      destination.description,
      '--event',
      'message.created',
      '--idempotency-key',
      'golden-webhook-create'
    ],
    checkedSecret: 'signingSecret',
    command: 'project webhook create',
    route: {
      body: withNewField(created),
      method: 'POST',
      path: `${WEBHOOKS}/destinations`,
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
  printsResponse({
    args: [
      DESTINATION_ID,
      ...PROJECT,
      '--status',
      'disabled',
      '--idempotency-key',
      'golden-webhook-edit'
    ],
    command: 'project webhook edit',
    route: {
      body: withNewField(updated),
      method: 'PATCH',
      path: DESTINATION,
      requestBody: { status: 'disabled' }
    },
    schema: UpdateWebhookDestinationOutputSchema,
    shows: 'Updated webhook destination'
  }),
  printsResponse({
    args: [DESTINATION_ID, ...PROJECT, '--yes'],
    command: 'project webhook delete',
    route: { body: withNewField(deleted), method: 'DELETE', path: DESTINATION },
    schema: DeleteWebhookDestinationOutputSchema,
    shows: `Deleted webhook destination ${DESTINATION_ID}.`
  }),
  printsResponse({
    args: [
      DESTINATION_ID,
      ...PROJECT,
      '--overlap-seconds',
      '3600',
      '--idempotency-key',
      'golden-webhook-rotate',
      '--yes'
    ],
    checkedSecret: 'signingSecret',
    command: 'project webhook rotate-secret',
    route: {
      body: withNewField(rotated),
      method: 'POST',
      path: `${DESTINATION}/secret-rotations`,
      requestBody: { overlapSeconds: 3600 }
    },
    schema: RotateWebhookSigningSecretOutputSchema,
    shows: ROTATED_SIGNING_SECRET
  }),
  printsResponse({
    args: PROJECT,
    command: 'project webhook api-version list',
    route: {
      body: withNewField(apiVersions),
      method: 'GET',
      path: `${WEBHOOKS}/api-versions`
    },
    schema: ListWebhookApiVersionsOutputSchema,
    shows: deprecatedApiVersion.version
  }),
  printsResponse({
    args: [...PROJECT, '--api-version', '2026-07-01'],
    command: 'project webhook event-type list',
    route: {
      body: withNewField(eventCatalog),
      method: 'GET',
      path: `${WEBHOOKS}/event-types?apiVersion=2026-07-01`
    },
    schema: ListWebhookEventTypesOutputSchema,
    shows: eventType.description
  })
]
