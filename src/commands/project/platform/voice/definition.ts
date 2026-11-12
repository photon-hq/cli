import { defineWithTypes, lazyWithTypes } from 'gunshi'
import {
  DEFAULT_VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHM,
  VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS
} from '../../../../project/voice-outbound-authentication.ts'
import {
  validateVoiceProfileId,
  validateVoiceProfileReference,
  validateVoiceResourceId
} from '../../../../project/voice-validation.ts'
import { idempotencyKeyArg, yesArg } from '../../../args.ts'
import { expectError, runs, skip, tested } from '../../../production-test.ts'
import type { PhotonCommandParams } from '../../../types.ts'
import { paginationArgs } from '../../args.ts'

type VoiceParams = PhotonCommandParams

const profileIdArg = {
  description: 'Canonical Voice profile ID',
  parse: validateVoiceProfileId,
  type: 'positional'
} as const

const profileReferenceArg = {
  description: "Canonical Voice profile ID or 'default'",
  parse: validateVoiceProfileReference,
  type: 'positional'
} as const

const resourceIdArg = {
  description: 'Canonical Voice-capable line resource ID',
  parse: validateVoiceResourceId,
  type: 'positional'
} as const

const sipPasswordFileArg = {
  description:
    'Read the SIP password exactly from a file, or - for standard input, instead of asking',
  toKebab: true,
  type: 'string'
} as const

const sipUsernameArg = {
  description: 'SIP authentication username (requires a password)',
  toKebab: true,
  type: 'string'
} as const

const profileViewArgs = { 'profile-id': profileReferenceArg } as const
const mediaEncryptionArg = {
  choices: ['auto', 'srtp'],
  description: 'Media encryption policy: auto or require SRTP',
  toKebab: true,
  type: 'enum'
} as const
const profileCreateArgs = {
  default: {
    conflicts: 'name',
    default: false,
    description: 'Create or idempotently replay the project default profile',
    type: 'boolean'
  },
  mediaEncryption: mediaEncryptionArg,
  name: {
    conflicts: 'default',
    description: 'Voice profile name (required for additional profiles)',
    type: 'string'
  }
} as const
const profileEditArgs = {
  mediaEncryption: mediaEncryptionArg,
  name: {
    description: 'New Voice profile name',
    type: 'string'
  },
  'profile-id': profileReferenceArg
} as const
const inboundCredentialArgs = {
  clearSipCredentials: {
    conflicts: ['sipUsername', 'sipPasswordFile'] as string[],
    default: false,
    description: 'Remove inbound SIP credentials',
    toKebab: true,
    type: 'boolean'
  },
  sipPasswordFile: {
    ...sipPasswordFileArg,
    conflicts: 'clearSipCredentials'
  },
  sipUsername: {
    ...sipUsernameArg,
    conflicts: 'clearSipCredentials'
  }
} as const
const inboundSetArgs = {
  ...inboundCredentialArgs,
  'profile-id': profileReferenceArg,
  sipUri: {
    description: 'Customer SIP destination URI',
    required: true,
    toKebab: true,
    type: 'string'
  },
  yes: yesArg
} as const
const inboundEditArgs = {
  ...inboundCredentialArgs,
  'profile-id': profileReferenceArg,
  sipUri: {
    description: 'New customer SIP destination URI',
    toKebab: true,
    type: 'string'
  },
  yes: yesArg
} as const
const inboundClearArgs = {
  'profile-id': profileReferenceArg,
  yes: yesArg
} as const
const outboundIdempotencyKeyArg = {
  ...idempotencyKeyArg,
  description: 'Identify or continue one unresolved outbound request'
} as const
const outboundEnableArgs = {
  digestAlgorithm: {
    choices: VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS,
    default: DEFAULT_VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHM,
    description: 'Digest algorithm; md5 is weaker legacy compatibility',
    toKebab: true,
    type: 'enum'
  },
  idempotencyKey: outboundIdempotencyKeyArg,
  'profile-id': profileReferenceArg
} as const
const outboundRotateArgs = {
  idempotencyKey: outboundIdempotencyKeyArg,
  mode: {
    choices: ['normal', 'emergency'],
    default: 'normal',
    description: 'Credential rotation grace mode',
    type: 'enum'
  },
  'profile-id': profileReferenceArg,
  yes: yesArg
} as const
const outboundEditArgs = {
  digestAlgorithm: {
    choices: VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS,
    description:
      'Digest algorithm; MD5 is weaker legacy compatibility; SHA-256 requires a compatible PBX',
    required: true,
    toKebab: true,
    type: 'enum'
  },
  'profile-id': profileReferenceArg,
  yes: yesArg
} as const
const outboundRevokeArgs = {
  'profile-id': profileReferenceArg,
  yes: yesArg
} as const
const profileDeleteArgs = {
  'profile-id': profileIdArg,
  unassignLines: {
    default: false,
    description:
      'Atomically clear every override so affected lines follow the default',
    toKebab: true,
    type: 'boolean'
  },
  yes: yesArg
} as const
const assignmentViewArgs = { 'resource-id': resourceIdArg } as const
const assignmentSetArgs = {
  profileId: {
    description: 'Canonical Voice profile ID to assign',
    parse: validateVoiceProfileId,
    required: true,
    toKebab: true,
    type: 'string'
  },
  resourceId: {
    description: 'Voice-capable line resource ID (repeatable, maximum 100)',
    multiple: true,
    parse: validateVoiceResourceId,
    required: true,
    toKebab: true,
    type: 'string'
  },
  yes: yesArg
} as const
const assignmentClearArgs = {
  resourceId: {
    description: 'Voice-capable line resource ID (repeatable, maximum 100)',
    multiple: true,
    parse: validateVoiceResourceId,
    required: true,
    toKebab: true,
    type: 'string'
  },
  yes: yesArg
} as const

export type VoiceListParams = PhotonCommandParams<typeof paginationArgs>
export type VoiceProfileViewParams = PhotonCommandParams<typeof profileViewArgs>
export type VoiceProfileCreateParams = PhotonCommandParams<
  typeof profileCreateArgs
>
export type VoiceProfileEditParams = PhotonCommandParams<typeof profileEditArgs>
export type VoiceProfileInboundSetParams = PhotonCommandParams<
  typeof inboundSetArgs
>
export type VoiceProfileInboundEditParams = PhotonCommandParams<
  typeof inboundEditArgs
>
export type VoiceProfileInboundClearParams = PhotonCommandParams<
  typeof inboundClearArgs
>
export type VoiceProfileOutboundEnableParams = PhotonCommandParams<
  typeof outboundEnableArgs
>
export type VoiceProfileOutboundEditParams = PhotonCommandParams<
  typeof outboundEditArgs
>
export type VoiceProfileOutboundRotateParams = PhotonCommandParams<
  typeof outboundRotateArgs
>
export type VoiceProfileOutboundRevokeParams = PhotonCommandParams<
  typeof outboundRevokeArgs
>
export type VoiceProfileDeleteParams = PhotonCommandParams<
  typeof profileDeleteArgs
>
export type VoiceAssignmentViewParams = PhotonCommandParams<
  typeof assignmentViewArgs
>
export type VoiceAssignmentSetParams = PhotonCommandParams<
  typeof assignmentSetArgs
>
export type VoiceAssignmentClearParams = PhotonCommandParams<
  typeof assignmentClearArgs
>

const voiceListDefinition = defineWithTypes<VoiceListParams>()({
  args: paginationArgs,
  description: 'List project PSTN voice resources',
  name: 'list',
  toKebab: true
})
const profileListArgs = {
  ...paginationArgs,
  additional: {
    conflicts: 'default',
    default: false,
    description: 'Return only additional profiles',
    type: 'boolean'
  },
  default: {
    conflicts: 'additional',
    default: false,
    description: 'Return only the project default profile',
    type: 'boolean'
  }
} as const

export type VoiceProfileListParams = PhotonCommandParams<typeof profileListArgs>

const profileListDefinition = defineWithTypes<VoiceProfileListParams>()({
  args: profileListArgs,
  description: 'List project Voice profiles',
  name: 'list',
  toKebab: true
})
const profileViewDefinition = defineWithTypes<VoiceProfileViewParams>()({
  args: profileViewArgs,
  description: 'View a Voice profile',
  name: 'view'
})
const profileCreateDefinition = defineWithTypes<VoiceProfileCreateParams>()({
  args: profileCreateArgs,
  description: 'Create a reusable Voice routing profile',
  name: 'create',
  toKebab: true
})
const profileEditDefinition = defineWithTypes<VoiceProfileEditParams>()({
  args: profileEditArgs,
  description: 'Edit Voice profile metadata',
  name: 'edit',
  toKebab: true
})
const inboundSetDefinition = defineWithTypes<VoiceProfileInboundSetParams>()({
  args: inboundSetArgs,
  description: 'Create or replace inbound SIP delivery',
  name: 'set',
  toKebab: true
})
const inboundEditDefinition = defineWithTypes<VoiceProfileInboundEditParams>()({
  args: inboundEditArgs,
  description: 'Update selected inbound SIP fields',
  name: 'edit',
  toKebab: true
})
const inboundClearDefinition =
  defineWithTypes<VoiceProfileInboundClearParams>()({
    args: inboundClearArgs,
    description: 'Disable inbound SIP delivery',
    name: 'clear',
    toKebab: true
  })
const outboundEnableDefinition =
  defineWithTypes<VoiceProfileOutboundEnableParams>()({
    args: outboundEnableArgs,
    description: 'Enable outbound calling and create its first credential',
    name: 'enable',
    toKebab: true
  })
const outboundRotateDefinition =
  defineWithTypes<VoiceProfileOutboundRotateParams>()({
    args: outboundRotateArgs,
    description: 'Rotate an existing outbound credential',
    name: 'rotate',
    toKebab: true
  })
const outboundEditDefinition =
  defineWithTypes<VoiceProfileOutboundEditParams>()({
    args: outboundEditArgs,
    description:
      'Change the outbound Digest algorithm, preserving username and password',
    name: 'edit',
    toKebab: true
  })
const outboundRevokeDefinition =
  defineWithTypes<VoiceProfileOutboundRevokeParams>()({
    args: outboundRevokeArgs,
    description: 'Revoke outbound calling',
    name: 'revoke',
    toKebab: true
  })
const profileDeleteDefinition = defineWithTypes<VoiceProfileDeleteParams>()({
  args: profileDeleteArgs,
  description: 'Delete a Voice routing profile',
  name: 'delete',
  toKebab: true
})
const assignmentViewDefinition = defineWithTypes<VoiceAssignmentViewParams>()({
  args: assignmentViewArgs,
  description: 'View a line Voice profile assignment',
  name: 'view'
})
const assignmentSetDefinition = defineWithTypes<VoiceAssignmentSetParams>()({
  args: assignmentSetArgs,
  description: 'Assign one Voice profile to one or more lines',
  name: 'set',
  toKebab: true
})
const assignmentClearDefinition = defineWithTypes<VoiceAssignmentClearParams>()(
  {
    args: assignmentClearArgs,
    description: 'Unassign Voice profiles from one or more lines',
    name: 'clear',
    toKebab: true
  }
)

const inboundCommand = defineWithTypes<VoiceParams>()({
  description: 'Manage inbound SIP delivery',
  name: 'inbound',
  subCommands: {
    clear: tested(
      runs,
      lazyWithTypes<VoiceProfileInboundClearParams>()(
        async () => (await import('./run.ts')).runVoiceProfileInboundClear,
        inboundClearDefinition
      )
    ),
    edit: tested(
      runs,
      lazyWithTypes<VoiceProfileInboundEditParams>()(
        async () => (await import('./run.ts')).runVoiceProfileInboundEdit,
        inboundEditDefinition
      )
    ),
    set: tested(
      runs,
      lazyWithTypes<VoiceProfileInboundSetParams>()(
        async () => (await import('./run.ts')).runVoiceProfileInboundSet,
        inboundSetDefinition
      )
    )
  }
})

const outboundCommand = defineWithTypes<VoiceParams>()({
  description: 'Manage outbound SIP authentication and credentials',
  name: 'outbound',
  subCommands: {
    edit: tested(
      skip('needs outbound calling, which needs a card'),
      lazyWithTypes<VoiceProfileOutboundEditParams>()(
        async () => (await import('./run.ts')).runVoiceProfileOutboundEdit,
        outboundEditDefinition
      )
    ),
    enable: tested(
      expectError('ENTITLEMENT_REQUIRED', 'card_required'),
      lazyWithTypes<VoiceProfileOutboundEnableParams>()(
        async () => (await import('./run.ts')).runVoiceProfileOutboundEnable,
        outboundEnableDefinition
      )
    ),
    revoke: tested(
      skip('needs outbound calling, which needs a card'),
      lazyWithTypes<VoiceProfileOutboundRevokeParams>()(
        async () => (await import('./run.ts')).runVoiceProfileOutboundRevoke,
        outboundRevokeDefinition
      )
    ),
    rotate: tested(
      skip('needs outbound calling, which needs a card'),
      lazyWithTypes<VoiceProfileOutboundRotateParams>()(
        async () => (await import('./run.ts')).runVoiceProfileOutboundRotate,
        outboundRotateDefinition
      )
    )
  }
})

const profileCommand = defineWithTypes<VoiceParams>()({
  description: 'Manage reusable Voice routing profiles',
  name: 'profile',
  subCommands: {
    create: tested(
      runs,
      lazyWithTypes<VoiceProfileCreateParams>()(
        async () => (await import('./run.ts')).runVoiceProfileCreate,
        profileCreateDefinition
      )
    ),
    delete: tested(
      runs,
      lazyWithTypes<VoiceProfileDeleteParams>()(
        async () => (await import('./run.ts')).runVoiceProfileDelete,
        profileDeleteDefinition
      )
    ),
    edit: tested(
      runs,
      lazyWithTypes<VoiceProfileEditParams>()(
        async () => (await import('./run.ts')).runVoiceProfileEdit,
        profileEditDefinition
      )
    ),
    inbound: inboundCommand,
    list: tested(
      runs,
      lazyWithTypes<VoiceProfileListParams>()(
        async () => (await import('./run.ts')).runVoiceProfileList,
        profileListDefinition
      )
    ),
    outbound: outboundCommand,
    view: tested(
      runs,
      lazyWithTypes<VoiceProfileViewParams>()(
        async () => (await import('./run.ts')).runVoiceProfileView,
        profileViewDefinition
      )
    )
  }
})

const assignmentCommand = defineWithTypes<VoiceParams>()({
  description: 'Manage line Voice profile assignments',
  name: 'assignment',
  subCommands: {
    clear: tested(
      skip('needs a Voice line, which needs a purchased number'),
      lazyWithTypes<VoiceAssignmentClearParams>()(
        async () => (await import('./run.ts')).runVoiceAssignmentClear,
        assignmentClearDefinition
      )
    ),
    set: tested(
      skip('needs a Voice line, which needs a purchased number'),
      lazyWithTypes<VoiceAssignmentSetParams>()(
        async () => (await import('./run.ts')).runVoiceAssignmentSet,
        assignmentSetDefinition
      )
    ),
    view: tested(
      skip('needs a Voice line, which needs a purchased number'),
      lazyWithTypes<VoiceAssignmentViewParams>()(
        async () => (await import('./run.ts')).runVoiceAssignmentView,
        assignmentViewDefinition
      )
    )
  }
})

export const voiceCommand = defineWithTypes<VoiceParams>()({
  description: 'Inspect and manage project PSTN voice',
  name: 'voice',
  subCommands: {
    assignment: assignmentCommand,
    list: tested(
      runs,
      lazyWithTypes<VoiceListParams>()(
        async () => (await import('../run.ts')).runVoiceList,
        voiceListDefinition
      )
    ),
    profile: profileCommand
  }
})
