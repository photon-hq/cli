import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { runs, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'
import { paginationArgs } from '../args.ts'

type WebhookParams = PhotonCommandParams
export type WebhookApiVersionListParams = PhotonCommandParams

const destinationIdArg = {
  description: 'Canonical webhook destination ID',
  parse: idArgument('webhookDestination', 'Webhook destination ID'),
  type: 'positional'
} as const

const eventArgs = {
  allEvents: {
    conflicts: 'event',
    default: false,
    description: 'Subscribe to every event type',
    toKebab: true,
    type: 'boolean'
  },
  event: {
    conflicts: 'allEvents',
    description: 'Event type to subscribe to (repeatable)',
    multiple: true,
    type: 'string'
  }
} as const

const listArgs = { ...paginationArgs } as const
const viewArgs = { 'destination-id': destinationIdArg } as const
const createArgs = {
  apiVersion: {
    description: 'Webhook payload API version (YYYY-MM-DD)',
    required: true,
    toKebab: true,
    type: 'string'
  },
  description: {
    description: 'Webhook destination description',
    type: 'string'
  },
  ...eventArgs,
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'Webhook destination name',
    required: true,
    type: 'string'
  },
  status: {
    choices: ['enabled', 'disabled'],
    default: 'enabled',
    description: 'Initial webhook destination status',
    type: 'enum'
  },
  url: {
    description: 'HTTPS delivery URL',
    required: true,
    type: 'string'
  }
} as const
const editArgs = {
  clearDescription: {
    conflicts: 'description',
    default: false,
    description: 'Clear the webhook destination description',
    toKebab: true,
    type: 'boolean'
  },
  description: {
    conflicts: 'clearDescription',
    description: 'New webhook destination description',
    type: 'string'
  },
  'destination-id': destinationIdArg,
  ...eventArgs,
  idempotencyKey: idempotencyKeyArg,
  name: {
    description: 'New webhook destination name',
    type: 'string'
  },
  status: {
    choices: ['enabled', 'disabled'],
    description: 'New webhook destination status',
    type: 'enum'
  },
  url: {
    description: 'New HTTPS delivery URL',
    type: 'string'
  }
} as const
const deleteArgs = {
  'destination-id': destinationIdArg,
  yes: yesArg
} as const
const rotateSecretArgs = {
  'destination-id': destinationIdArg,
  idempotencyKey: idempotencyKeyArg,
  overlapSeconds: {
    default: 86_400,
    description: 'Seconds the previous signing secret remains valid',
    toKebab: true,
    type: 'number'
  },
  yes: yesArg
} as const
const eventTypeListArgs = {
  apiVersion: {
    description: 'Webhook payload API version (YYYY-MM-DD)',
    required: true,
    toKebab: true,
    type: 'string'
  }
} as const

export type WebhookListParams = PhotonCommandParams<typeof listArgs>
export type WebhookViewParams = PhotonCommandParams<typeof viewArgs>
export type WebhookCreateParams = PhotonCommandParams<typeof createArgs>
export type WebhookEditParams = PhotonCommandParams<typeof editArgs>
export type WebhookDeleteParams = PhotonCommandParams<typeof deleteArgs>
export type WebhookRotateSecretParams = PhotonCommandParams<
  typeof rotateSecretArgs
>
export type WebhookEventTypeListParams = PhotonCommandParams<
  typeof eventTypeListArgs
>

const listDefinition = defineWithTypes<WebhookListParams>()({
  args: listArgs,
  description: 'List webhook destinations',
  name: 'list',
  toKebab: true
})
const viewDefinition = defineWithTypes<WebhookViewParams>()({
  args: viewArgs,
  description: 'View a webhook destination',
  name: 'view'
})
const createDefinition = defineWithTypes<WebhookCreateParams>()({
  args: createArgs,
  description: 'Create a webhook destination',
  name: 'create',
  toKebab: true
})
const editDefinition = defineWithTypes<WebhookEditParams>()({
  args: editArgs,
  description: 'Edit a webhook destination',
  name: 'edit',
  toKebab: true
})
const deleteDefinition = defineWithTypes<WebhookDeleteParams>()({
  args: deleteArgs,
  description: 'Delete a webhook destination',
  name: 'delete'
})
const rotateSecretDefinition = defineWithTypes<WebhookRotateSecretParams>()({
  args: rotateSecretArgs,
  description: 'Rotate a webhook signing secret',
  name: 'rotate-secret',
  toKebab: true
})
const apiVersionListDefinition = defineWithTypes<WebhookApiVersionListParams>()(
  {
    description: 'List webhook payload API versions',
    name: 'list'
  }
)
const eventTypeListDefinition = defineWithTypes<WebhookEventTypeListParams>()({
  args: eventTypeListArgs,
  description: 'List webhook event types for an API version',
  name: 'list',
  toKebab: true
})

const apiVersionCommand = defineWithTypes<WebhookParams>()({
  description: 'Inspect webhook payload API versions',
  name: 'api-version',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<WebhookApiVersionListParams>()(
        async () => (await import('./run.ts')).runApiVersionList,
        apiVersionListDefinition
      )
    )
  },
  toKebab: true
})

const eventTypeCommand = defineWithTypes<WebhookParams>()({
  description: 'Inspect webhook event types',
  name: 'event-type',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<WebhookEventTypeListParams>()(
        async () => (await import('./run.ts')).runEventTypeList,
        eventTypeListDefinition
      )
    )
  },
  toKebab: true
})

export const webhookCommand = defineWithTypes<WebhookParams>()({
  description: 'Manage project webhook destinations',
  name: 'webhook',
  subCommands: {
    'api-version': apiVersionCommand,
    create: tested(
      runs,
      lazyWithTypes<WebhookCreateParams>()(
        async () => (await import('./run.ts')).runCreate,
        createDefinition
      )
    ),
    delete: tested(
      runs,
      lazyWithTypes<WebhookDeleteParams>()(
        async () => (await import('./run.ts')).runDelete,
        deleteDefinition
      )
    ),
    edit: tested(
      runs,
      lazyWithTypes<WebhookEditParams>()(
        async () => (await import('./run.ts')).runEdit,
        editDefinition
      )
    ),
    'event-type': eventTypeCommand,
    list: tested(
      runs,
      lazyWithTypes<WebhookListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    ),
    'rotate-secret': tested(
      runs,
      lazyWithTypes<WebhookRotateSecretParams>()(
        async () => (await import('./run.ts')).runRotateSecret,
        rotateSecretDefinition
      )
    ),
    view: tested(
      runs,
      lazyWithTypes<WebhookViewParams>()(
        async () => (await import('./run.ts')).runView,
        viewDefinition
      )
    )
  },
  toKebab: true
})
