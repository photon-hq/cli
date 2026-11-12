import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument, wabaIdArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { expectError, runs, skip, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'
import { paginationArgs } from '../args.ts'
import { telegramCommand } from './telegram/definition.ts'
import { voiceCommand } from './voice/definition.ts'

type PlatformParams = PhotonCommandParams
type PlatformListParams = PhotonCommandParams
type ImessageViewParams = PhotonCommandParams

const platformResourceListArgs = { ...paginationArgs } as const
const operationCancelArgs = {
  'operation-id': {
    description: 'Remote platform operation ID',
    parse: idArgument('platformOperation', 'Platform operation ID'),
    type: 'positional'
  },
  yes: yesArg
} as const
const platformPurchaseArgs = {
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const
const emailConnectArgs = {
  domain: {
    description: 'DNS domain to connect for email',
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg,
  noBrowser: {
    default: false,
    description: 'Print automatic DNS setup instead of opening a browser',
    toKebab: true,
    type: 'boolean'
  },
  wait: {
    default: true,
    description: 'Wait for Photon to verify the published DNS records',
    negatable: true,
    type: 'boolean'
  }
} as const
const emailDisconnectArgs = {
  'resource-id': {
    description: 'Email domain resource ID',
    parse: idArgument('resource', 'Email domain resource ID'),
    type: 'positional'
  },
  yes: yesArg
} as const
const emailDnsArgs = {
  'operation-id': {
    description: 'Remote email-domain operation ID',
    parse: idArgument('platformOperation', 'Platform operation ID'),
    type: 'positional'
  }
} as const
const smsDeleteArgs = {
  'resource-id': {
    description: 'SMS number resource ID',
    parse: idArgument('resource', 'SMS number resource ID'),
    type: 'positional'
  },
  yes: yesArg
} as const
const whatsappBusinessNumberAddArgs = {
  displayName: {
    description: 'WhatsApp display name for direct Photon provisioning',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  newWaba: {
    default: false,
    description: 'Connect the Photon number to a new or different WABA',
    toKebab: true,
    type: 'boolean'
  },
  noBrowser: {
    default: false,
    description: 'Print the dashboard URL without opening a browser',
    toKebab: true,
    type: 'boolean'
  },
  source: {
    choices: ['byon', 'photon'],
    description: 'Number source; omit to launch the interactive wizard',
    type: 'string'
  },
  voipResourceId: {
    description: 'Photon SMS number resource ID',
    parse: idArgument('resource', 'Photon SMS resource ID'),
    toKebab: true,
    type: 'string'
  },
  wabaId: {
    description: 'Connected WhatsApp Business Account ID',
    parse: wabaIdArgument,
    toKebab: true,
    type: 'string'
  }
} as const
const whatsappBusinessNumberResourceArgs = {
  'resource-id': {
    description: 'WhatsApp Business number resource ID',
    parse: idArgument('resource', 'WhatsApp Business number resource ID'),
    type: 'positional'
  }
} as const
const whatsappBusinessNumberDeleteArgs = {
  ...whatsappBusinessNumberResourceArgs,
  yes: yesArg
} as const

const assignmentListArgs = {
  includeReleased: {
    default: false,
    description: 'Include released assignments',
    toKebab: true,
    type: 'boolean'
  },
  ...paginationArgs
} as const
const assignmentCreateArgs = {
  email: {
    description: 'User email address',
    type: 'string'
  },
  firstName: {
    description: 'User first name',
    toKebab: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  lastName: {
    description: 'User last name',
    toKebab: true,
    type: 'string'
  },
  phoneNumber: {
    description: 'User phone number in E.164 format',
    required: true,
    toKebab: true,
    type: 'string'
  }
} as const
const assignmentViewArgs = {
  'assignment-id': {
    description: 'Assignment ID',
    parse: idArgument('assignment', 'Assignment ID'),
    type: 'positional'
  }
} as const
const assignmentReleaseArgs = {
  'assignment-id': {
    description: 'Assignment ID',
    parse: idArgument('assignment', 'Assignment ID'),
    type: 'positional'
  },
  yes: yesArg
} as const

export type AssignmentListParams = PhotonCommandParams<
  typeof assignmentListArgs
>
export type AssignmentCreateParams = PhotonCommandParams<
  typeof assignmentCreateArgs
>
export type AssignmentViewParams = PhotonCommandParams<
  typeof assignmentViewArgs
>
export type AssignmentReleaseParams = PhotonCommandParams<
  typeof assignmentReleaseArgs
>
export type ImessageListParams = PhotonCommandParams<
  typeof platformResourceListArgs
>
export type ImessagePurchaseParams = PhotonCommandParams<
  typeof platformPurchaseArgs
>
export type OperationCancelParams = PhotonCommandParams<
  typeof operationCancelArgs
>
export type EmailConnectParams = PhotonCommandParams<typeof emailConnectArgs>
export type EmailDisconnectParams = PhotonCommandParams<
  typeof emailDisconnectArgs
>
export type EmailDnsParams = PhotonCommandParams<typeof emailDnsArgs>
export type EmailListParams = PhotonCommandParams<
  typeof platformResourceListArgs
>
export type SmsListParams = PhotonCommandParams<typeof platformResourceListArgs>
const smsPurchaseArgs = {
  ...platformPurchaseArgs,
  areaCode: {
    description: 'Preferred US area code (three digits)',
    toKebab: true,
    type: 'string'
  },
  country: {
    choices: ['US'],
    default: 'US',
    description: 'Country for the purchased number',
    type: 'enum'
  }
} as const
export type SmsPurchaseParams = PhotonCommandParams<typeof smsPurchaseArgs>
export type SmsDeleteParams = PhotonCommandParams<typeof smsDeleteArgs>
export type WhatsappBusinessAccountListParams = PhotonCommandParams<
  typeof platformResourceListArgs
>
export type WhatsappBusinessNumberAddParams = PhotonCommandParams<
  typeof whatsappBusinessNumberAddArgs
>
export type WhatsappBusinessNumberDeleteParams = PhotonCommandParams<
  typeof whatsappBusinessNumberDeleteArgs
>
export type WhatsappBusinessNumberListParams = PhotonCommandParams<
  typeof platformResourceListArgs
>
export type WhatsappBusinessNumberViewParams = PhotonCommandParams<
  typeof whatsappBusinessNumberResourceArgs
>

const platformListDefinition = defineWithTypes<PlatformListParams>()({
  description: 'List platforms available to the project',
  name: 'list'
})
const imessageViewDefinition = defineWithTypes<ImessageViewParams>()({
  description: 'View project iMessage configuration',
  name: 'view'
})
const imessageListDefinition = defineWithTypes<ImessageListParams>()({
  args: platformResourceListArgs,
  description: 'List project iMessage resources and provisioning',
  name: 'list',
  toKebab: true
})
const imessagePurchaseDefinition = defineWithTypes<ImessagePurchaseParams>()({
  args: platformPurchaseArgs,
  description: 'Purchase a dedicated iMessage line',
  name: 'purchase',
  toKebab: true
})
const operationCancelDefinition = defineWithTypes<OperationCancelParams>()({
  args: operationCancelArgs,
  description: 'Cancel an in-progress platform operation',
  name: 'cancel'
})
const assignmentListDefinition = defineWithTypes<AssignmentListParams>()({
  args: assignmentListArgs,
  description: 'List shared-line assignments',
  name: 'list',
  toKebab: true
})
const assignmentCreateDefinition = defineWithTypes<AssignmentCreateParams>()({
  args: assignmentCreateArgs,
  description: 'Create a shared-line assignment',
  name: 'create',
  toKebab: true
})
const assignmentViewDefinition = defineWithTypes<AssignmentViewParams>()({
  args: assignmentViewArgs,
  description: 'View a shared-line assignment',
  name: 'view'
})
const assignmentReleaseDefinition = defineWithTypes<AssignmentReleaseParams>()({
  args: assignmentReleaseArgs,
  description: 'Release a shared-line assignment',
  name: 'release'
})
const emailConnectDefinition = defineWithTypes<EmailConnectParams>()({
  args: emailConnectArgs,
  description: 'Connect and verify a project email domain',
  name: 'connect'
})
const emailDisconnectDefinition = defineWithTypes<EmailDisconnectParams>()({
  args: emailDisconnectArgs,
  description: 'Disconnect a project email domain',
  name: 'disconnect'
})
const emailDnsDefinition = defineWithTypes<EmailDnsParams>()({
  args: emailDnsArgs,
  description: 'Show DNS records for an email-domain operation',
  name: 'dns'
})
const emailListDefinition = defineWithTypes<EmailListParams>()({
  args: platformResourceListArgs,
  description: 'List project email domains and provisioning',
  name: 'list',
  toKebab: true
})
const smsListDefinition = defineWithTypes<SmsListParams>()({
  args: platformResourceListArgs,
  description: 'List project SMS resources and provisioning',
  name: 'list',
  toKebab: true
})
const smsPurchaseDefinition = defineWithTypes<SmsPurchaseParams>()({
  args: smsPurchaseArgs,
  description: 'Purchase a US local SMS number',
  name: 'purchase',
  toKebab: true
})
const smsDeleteDefinition = defineWithTypes<SmsDeleteParams>()({
  args: smsDeleteArgs,
  description: 'Delete and release a project SMS number',
  name: 'delete'
})
const whatsappBusinessAccountListDefinition =
  defineWithTypes<WhatsappBusinessAccountListParams>()({
    args: platformResourceListArgs,
    description: 'List connected WhatsApp Business accounts',
    name: 'list',
    toKebab: true
  })
const whatsappBusinessNumberAddDefinition =
  defineWithTypes<WhatsappBusinessNumberAddParams>()({
    args: whatsappBusinessNumberAddArgs,
    description: 'Add a BYON or Photon WhatsApp Business phone number',
    name: 'add',
    toKebab: true
  })
const whatsappBusinessNumberDeleteDefinition =
  defineWithTypes<WhatsappBusinessNumberDeleteParams>()({
    args: whatsappBusinessNumberDeleteArgs,
    description: 'Delete and release a WhatsApp Business phone number',
    name: 'delete'
  })
const whatsappBusinessNumberListDefinition =
  defineWithTypes<WhatsappBusinessNumberListParams>()({
    args: platformResourceListArgs,
    description: 'List active WhatsApp Business phone numbers',
    name: 'list',
    toKebab: true
  })
const whatsappBusinessNumberViewDefinition =
  defineWithTypes<WhatsappBusinessNumberViewParams>()({
    args: whatsappBusinessNumberResourceArgs,
    description: 'View a WhatsApp Business phone number',
    name: 'view'
  })

const assignmentCommand = defineWithTypes<PlatformParams>()({
  description: 'Manage iMessage shared-line assignments',
  name: 'assignment',
  subCommands: {
    create: tested(
      skip("assigns a person's phone number to a shared iMessage line"),
      lazyWithTypes<AssignmentCreateParams>()(
        async () => (await import('./run.ts')).runAssignmentCreate,
        assignmentCreateDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<AssignmentListParams>()(
        async () => (await import('./run.ts')).runAssignmentList,
        assignmentListDefinition
      )
    ),
    release: tested(
      skip("needs an iMessage assignment, which needs a person's phone number"),
      lazyWithTypes<AssignmentReleaseParams>()(
        async () => (await import('./run.ts')).runAssignmentRelease,
        assignmentReleaseDefinition
      )
    ),
    view: tested(
      skip("needs an iMessage assignment, which needs a person's phone number"),
      lazyWithTypes<AssignmentViewParams>()(
        async () => (await import('./run.ts')).runAssignmentView,
        assignmentViewDefinition
      )
    )
  }
})

const imessageCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage project iMessage',
  name: 'imessage',
  subCommands: {
    assignment: assignmentCommand,
    list: tested(
      runs,
      lazyWithTypes<ImessageListParams>()(
        async () => (await import('./run.ts')).runImessageList,
        imessageListDefinition
      )
    ),
    purchase: tested(
      expectError('ENTITLEMENT_REQUIRED', 'business_plan_required'),
      lazyWithTypes<ImessagePurchaseParams>()(
        async () => (await import('./run.ts')).runImessagePurchase,
        imessagePurchaseDefinition
      )
    ),
    view: tested(
      runs,
      lazyWithTypes<ImessageViewParams>()(
        async () => (await import('./run.ts')).runImessageView,
        imessageViewDefinition
      )
    )
  }
})

const operationCommand = defineWithTypes<PlatformParams>()({
  description: 'Manage remote platform operations',
  name: 'operation',
  subCommands: {
    cancel: tested(
      skip(
        'needs a platform operation in progress, which only a purchase starts'
      ),
      lazyWithTypes<OperationCancelParams>()(
        async () => (await import('./run.ts')).runOperationCancel,
        operationCancelDefinition
      )
    )
  }
})

const emailCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage project email domains',
  name: 'email',
  subCommands: {
    connect: tested(
      expectError('ENTITLEMENT_REQUIRED', 'card_required'),
      lazyWithTypes<EmailConnectParams>()(
        async () => (await import('./run.ts')).runEmailConnect,
        emailConnectDefinition
      )
    ),
    disconnect: tested(
      skip(
        'needs a connected email domain, which needs a card and a domain whose DNS the test controls'
      ),
      lazyWithTypes<EmailDisconnectParams>()(
        async () => (await import('./run.ts')).runEmailDisconnect,
        emailDisconnectDefinition
      )
    ),
    dns: tested(
      skip(
        'needs a connected email domain, which needs a card and a domain whose DNS the test controls'
      ),
      lazyWithTypes<EmailDnsParams>()(
        async () => (await import('./run.ts')).runEmailDns,
        emailDnsDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<EmailListParams>()(
        async () => (await import('./run.ts')).runEmailList,
        emailListDefinition
      )
    )
  }
})

const smsCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage project SMS resources',
  name: 'sms',
  subCommands: {
    delete: tested(
      skip('needs a purchased SMS number'),
      lazyWithTypes<SmsDeleteParams>()(
        async () => (await import('./run.ts')).runSmsDelete,
        smsDeleteDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<SmsListParams>()(
        async () => (await import('./run.ts')).runSmsList,
        smsListDefinition
      )
    ),
    purchase: tested(
      expectError('ENTITLEMENT_REQUIRED', 'card_required'),
      lazyWithTypes<SmsPurchaseParams>()(
        async () => (await import('./run.ts')).runSmsPurchase,
        smsPurchaseDefinition
      )
    )
  }
})

const whatsappBusinessAccountCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect connected WhatsApp Business accounts',
  name: 'account',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<WhatsappBusinessAccountListParams>()(
        async () => (await import('./run.ts')).runWhatsappBusinessAccountList,
        whatsappBusinessAccountListDefinition
      )
    )
  }
})

const whatsappBusinessNumberCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage WhatsApp Business phone numbers',
  name: 'number',
  subCommands: {
    add: tested(
      skip("needs a person in Meta's signup, or a purchased Photon number"),
      lazyWithTypes<WhatsappBusinessNumberAddParams>()(
        async () => (await import('./run.ts')).runWhatsappBusinessNumberAdd,
        whatsappBusinessNumberAddDefinition
      )
    ),
    delete: tested(
      skip(
        "needs a WhatsApp Business number, which needs Meta's signup or a purchased number"
      ),
      lazyWithTypes<WhatsappBusinessNumberDeleteParams>()(
        async () => (await import('./run.ts')).runWhatsappBusinessNumberDelete,
        whatsappBusinessNumberDeleteDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<WhatsappBusinessNumberListParams>()(
        async () => (await import('./run.ts')).runWhatsappBusinessNumberList,
        whatsappBusinessNumberListDefinition
      )
    ),
    view: tested(
      skip(
        "needs a WhatsApp Business number, which needs Meta's signup or a purchased number"
      ),
      lazyWithTypes<WhatsappBusinessNumberViewParams>()(
        async () => (await import('./run.ts')).runWhatsappBusinessNumberView,
        whatsappBusinessNumberViewDefinition
      )
    )
  }
})

const whatsappBusinessCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage WhatsApp Business',
  name: 'whatsapp-business',
  subCommands: {
    account: whatsappBusinessAccountCommand,
    number: whatsappBusinessNumberCommand
  }
})

export const platformCommand = defineWithTypes<PlatformParams>()({
  description: 'Inspect and manage project platforms',
  name: 'platform',
  subCommands: {
    email: emailCommand,
    imessage: imessageCommand,
    list: tested(
      runs,
      lazyWithTypes<PlatformListParams>()(
        async () => (await import('./run.ts')).runPlatformList,
        platformListDefinition
      )
    ),
    operation: operationCommand,
    sms: smsCommand,
    telegram: telegramCommand,
    voice: voiceCommand,
    'whatsapp-business': whatsappBusinessCommand
  }
})
