import {
  type AssignVoiceLineProfileOutput,
  BatchUpdateVoiceLineProfileAssignmentsOutputSchema,
  type ConfigureVoiceProfileOutboundOutput,
  ConfigureVoiceProfileOutboundOutputSchema,
  type CreateVoiceProfileOutput,
  type DeleteVoiceProfileInboundOutput,
  DeleteVoiceProfileInboundOutputSchema,
  type DeleteVoiceProfileOutboundOutput,
  DeleteVoiceProfileOutboundOutputSchema,
  type GetVoiceLineProfileAssignmentOutput,
  GetVoiceLineProfileAssignmentOutputSchema,
  type GetVoiceProfileOutput,
  GetVoiceProfileOutputSchema,
  type ListResourcesOutput,
  ListResourcesOutputSchema,
  type ListVoiceProfilesOutput,
  ListVoiceProfilesOutputSchema,
  type ReplaceVoiceProfileInboundOutput,
  ReplaceVoiceProfileInboundOutputSchema,
  type RotateVoiceProfileOutboundCredentialOutput,
  RotateVoiceProfileOutboundCredentialOutputSchema,
  type UpdateVoiceProfileInboundOutput,
  UpdateVoiceProfileInboundOutputSchema,
  type UpdateVoiceProfileOutboundAuthenticationOutput,
  UpdateVoiceProfileOutboundAuthenticationOutputSchema,
  type UpdateVoiceProfileOutput
} from '@photon-ai/api-public'
import { z } from 'zod'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import { isVoiceProfileOutboundDigestAlgorithm } from '../../src/project/voice-outbound-authentication.ts'
import {
  buildsDocument,
  CWD,
  type Declared,
  type GoldenCase,
  NEW_API_FIELD,
  printsResponse,
  withNewField
} from './support.ts'

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const PLATFORMS = `/v1/projects/${PROJECT_ID}/platforms`
const VOICE = `${PLATFORMS}/voice`
const PROFILES = `${VOICE}/profiles`
const PROFILE_ID = 'pho_vpf_01h455vb4pex5vsknk084sn02q'
const DEFAULT_PROFILE_ID = 'pho_vpf_01h455vb4pex5vsknk084sn02r'
const PROFILE = `${PROFILES}/${PROFILE_ID}`
const DEFAULT_PROFILE = `${PROFILES}/${DEFAULT_PROFILE_ID}`
const RESOURCE_ID = 'pho_res_01h455vb4pex5vsknk084sn02q'
const LINE_PROFILE = `${VOICE}/lines/${RESOURCE_ID}/profile`
const SIP_URI = 'sips:agent@customer.example:5061'
const EDITED_SIP_URI = 'sip:agent@customer.example:5061;transport=tcp'
const SIP_USERNAME = 'agent-user'
const SIP_PASSWORD = 'private-password'
const OUTBOUND_PASSWORD = 'golden-outbound-password'
const ROTATED_PASSWORD = 'golden-rotated-password'
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'
const graceEndsAt = '2026-08-01T19:00:00.000Z'

const outbound = {
  authentication: withNewField({
    algorithm: 'sha-256',
    previousPasswordValidUntil: null,
    username: 'outbound-user-0001',
    validFrom: updatedAt
  }),
  connection: {
    endpoints: [
      withNewField({ host: 'sip.voice.example', port: 5061, transport: 'tls' }),
      { host: 'sip.voice.example', port: 5060, transport: 'udp' }
    ],
    realm: 'sip.voice.example'
  }
} satisfies Declared<
  NonNullable<GetVoiceProfileOutput['configuration']['outbound']>
>

const inbound = {
  credentials: withNewField({ username: SIP_USERNAME }),
  destinationUri: SIP_URI
} satisfies Declared<
  NonNullable<GetVoiceProfileOutput['configuration']['inbound']>
>

const profile = {
  configuration: { inbound, outbound: null },
  createdAt,
  isDefault: false,
  lineCount: 2,
  mediaEncryption: 'auto',
  name: 'Support agents',
  profileId: PROFILE_ID,
  projectId: PROJECT_ID,
  protocol: 'sip',
  updatedAt,
  version: 3
} satisfies Declared<GetVoiceProfileOutput>

const defaultProfile = {
  ...profile,
  configuration: { inbound: null, outbound: null },
  isDefault: true,
  lineCount: 0,
  name: 'Default Profile',
  profileId: DEFAULT_PROFILE_ID,
  version: 5
} satisfies Declared<GetVoiceProfileOutput>

const defaultProfileWithOutbound = {
  ...defaultProfile,
  configuration: { inbound: null, outbound },
  version: 6
} satisfies Declared<GetVoiceProfileOutput>

const createdProfile = {
  ...profile,
  configuration: { inbound: null, outbound: null },
  lineCount: 0,
  version: 1
} satisfies Declared<CreateVoiceProfileOutput>

const renamedProfile = withNewField({
  ...profile,
  name: 'Tier 2 agents',
  version: 4
}) satisfies Declared<UpdateVoiceProfileOutput>

const profiles = {
  nextPageToken: 'page-2',
  profiles: [withNewField(defaultProfileWithOutbound), profile]
} satisfies Declared<ListVoiceProfilesOutput>

const voiceLines = {
  nextPageToken: 'page-2',
  resources: [
    withNewField({
      abilities: ['pstn_voice', 'sms'],
      createdAt,
      detail: { phoneNumber: '+14155550125', ...NEW_API_FIELD },
      projectId: PROJECT_ID,
      resourceId: RESOURCE_ID,
      state: 'active',
      type: 'voip_line',
      updatedAt
    }),
    {
      abilities: ['imessage', 'pstn_voice'],
      createdAt,
      detail: { phoneNumber: '+14155550126' },
      projectId: PROJECT_ID,
      resourceId: 'pho_res_01h455vb4pex5vsknk084sn02r',
      state: 'active',
      type: 'cosmos_line',
      updatedAt
    }
  ]
} satisfies Declared<ListResourcesOutput>

const replacedInbound = withNewField({
  inbound,
  profileVersion: 4
}) satisfies Declared<ReplaceVoiceProfileInboundOutput>

const clearedInbound = withNewField({
  inbound: null,
  profileVersion: 4
}) satisfies Declared<DeleteVoiceProfileInboundOutput>

const editedInbound = withNewField({
  inbound: { ...inbound, destinationUri: EDITED_SIP_URI },
  profileVersion: 4
}) satisfies Declared<UpdateVoiceProfileInboundOutput>

const enabledOutbound = withNewField({
  outbound,
  password: OUTBOUND_PASSWORD,
  profileVersion: 6
}) satisfies Declared<ConfigureVoiceProfileOutboundOutput>

const editedOutbound = withNewField({
  outbound: {
    ...outbound,
    authentication: { ...outbound.authentication, algorithm: 'md5' }
  },
  profileVersion: 7
}) satisfies Declared<UpdateVoiceProfileOutboundAuthenticationOutput>

const revokedOutbound = withNewField({
  outbound: null,
  profileVersion: 7
}) satisfies Declared<DeleteVoiceProfileOutboundOutput>

const rotatedOutbound = withNewField({
  password: ROTATED_PASSWORD,
  previousPasswordValidUntil: graceEndsAt,
  profileVersion: 7
}) satisfies Declared<RotateVoiceProfileOutboundCredentialOutput>

const defaultAssignment = {
  projectId: PROJECT_ID,
  resourceId: RESOURCE_ID,
  resourceVersion: 2,
  updatedAt: createdAt
} satisfies Declared<GetVoiceLineProfileAssignmentOutput>

const assignment = {
  ...defaultAssignment,
  profileId: PROFILE_ID,
  profileVersion: profile.version,
  resourceVersion: 3,
  updatedAt
} satisfies Declared<AssignVoiceLineProfileOutput>

const clearedAssignment = {
  ...defaultAssignment,
  resourceVersion: 4
} satisfies Declared<GetVoiceLineProfileAssignmentOutput>

// The CLI rejects a profile or outbound response whose Digest algorithm it
// doesn't support before anything prints, so the algorithm can't carry
// planted characters.
const supportsAlgorithm = (
  outboundConfiguration: { authentication: { algorithm: string } } | null
): boolean =>
  outboundConfiguration === null ||
  isVoiceProfileOutboundDigestAlgorithm(
    outboundConfiguration.authentication.algorithm
  )

const VoiceProfileSchema = GetVoiceProfileOutputSchema.refine(
  ({ configuration }) => supportsAlgorithm(configuration.outbound)
)

const VoiceProfileListSchema = ListVoiceProfilesOutputSchema.refine(
  ({ profiles: listed }) =>
    listed.every(({ configuration }) =>
      supportsAlgorithm(configuration.outbound)
    )
)

const OutboundSetupSchema = ConfigureVoiceProfileOutboundOutputSchema.refine(
  (result) => supportsAlgorithm(result.outbound)
)

const OutboundAuthenticationSchema =
  UpdateVoiceProfileOutboundAuthenticationOutputSchema.refine((result) =>
    supportsAlgorithm(result.outbound)
  )

// The CLI matches each assignment Photon returns to the line it asked about
// by its resource ID, so the resource ID can't carry planted characters.
const VoiceAssignmentsSchema =
  BatchUpdateVoiceLineProfileAssignmentsOutputSchema.refine(({ assignments }) =>
    assignments.every(({ resourceId }) => resourceId === RESOURCE_ID)
  )

// What profile delete prints: Photon answers the deletion with no body, so
// the CLI names the profile it deleted, from its command line, and how many
// lines went back to the default.
const DeletedProfileSchema = z.strictObject({
  deleted: z.literal(true),
  profileId: z.string().regex(ID_FORMATS.voiceProfile.pattern),
  returnedToDefaultLineCount: z.number().int().nonnegative()
})

const profileRoute = { body: profile, method: 'GET', path: PROFILE } as const

const defaultProfileRoute = {
  body: defaultProfile,
  method: 'GET',
  path: `${PROFILES}/default`
} as const

const defaultProfileWithOutboundRoute = {
  ...defaultProfileRoute,
  body: defaultProfileWithOutbound
} as const

// The CLI sends each change to the profile ID its read of the profile
// returns, and its text names that ID.
const readProfileId = { field: 'profileId', route: profileRoute } as const

const readDefaultProfileWithOutboundId = {
  field: 'profileId',
  route: defaultProfileWithOutboundRoute
} as const

const clearedAssignmentRoute = {
  body: withNewField(clearedAssignment),
  method: 'GET',
  path: LINE_PROFILE
} as const

const assignedRoute = {
  body: withNewField(assignment),
  method: 'PUT',
  path: LINE_PROFILE,
  requestBody: { expectedVersion: 2, profileId: PROFILE_ID }
} as const

/** Golden tests for the project platform Voice commands. */
export const VOICE_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: [...PROJECT, '--limit', '2'],
    command: 'project platform voice list',
    route: {
      body: withNewField(voiceLines),
      method: 'GET',
      path: `${PLATFORMS}/resources?ability=pstn_voice&pageSize=2`
    },
    schema: ListResourcesOutputSchema,
    shows: '+14155550125'
  }),
  printsResponse({
    args: [...PROJECT, '--limit', '2'],
    command: 'project platform voice profile list',
    route: {
      body: withNewField(profiles),
      method: 'GET',
      path: `${PROFILES}?pageSize=2`
    },
    schema: VoiceProfileListSchema,
    shows: SIP_URI
  }),
  printsResponse({
    args: [PROFILE_ID, ...PROJECT],
    command: 'project platform voice profile view',
    route: { body: withNewField(profile), method: 'GET', path: PROFILE },
    schema: VoiceProfileSchema,
    shows: `${SIP_USERNAME} (password configured)`
  }),
  printsResponse({
    args: ['--name', profile.name, ...PROJECT],
    command: 'project platform voice profile create',
    route: {
      body: withNewField(createdProfile),
      method: 'POST',
      path: PROFILES,
      requestBody: { name: profile.name, protocol: 'sip' },
      status: 201
    },
    schema: VoiceProfileSchema,
    shows: `Created Voice profile ${PROFILE_ID}.`
  }),
  // It reads the profile for its version, then renames it, and prints the
  // rename's response.
  {
    args: [PROFILE_ID, '--name', renamedProfile.name, ...PROJECT],
    command: 'project platform voice profile edit',
    document: renamedProfile,
    plantedId: readProfileId,
    routes: [
      profileRoute,
      {
        body: renamedProfile,
        method: 'PATCH',
        path: PROFILE,
        requestBody: {
          expectedVersion: profile.version,
          name: renamedProfile.name
        }
      }
    ],
    schema: VoiceProfileSchema,
    shows: renamedProfile.name
  },
  buildsDocument({
    args: [PROFILE_ID, '--unassign-lines', ...PROJECT, '--yes'],
    build: (response: typeof profile) => ({
      deleted: true,
      profileId: PROFILE_ID,
      returnedToDefaultLineCount: response.lineCount
    }),
    command: 'project platform voice profile delete',
    from: [profileRoute],
    routes: [
      profileRoute,
      {
        method: 'DELETE',
        path: `${PROFILE}?expectedVersion=${profile.version.toString()}&force=true`,
        status: 204
      }
    ],
    schema: DeletedProfileSchema,
    shows: `Deleted Voice profile ${PROFILE_ID}.`,
    showsNoApiText: true
  }),
  {
    args: [
      PROFILE_ID,
      '--sip-uri',
      SIP_URI,
      '--sip-username',
      SIP_USERNAME,
      '--sip-password-file',
      `${CWD}/sip-password`,
      ...PROJECT,
      '--yes'
    ],
    command: 'project platform voice profile inbound set',
    document: replacedInbound,
    files: { 'sip-password': SIP_PASSWORD },
    plantedId: readProfileId,
    routes: [
      profileRoute,
      {
        body: replacedInbound,
        method: 'PUT',
        path: `${PROFILE}/inbound`,
        requestBody: {
          credentials: { password: SIP_PASSWORD, username: SIP_USERNAME },
          destinationUri: SIP_URI,
          expectedVersion: profile.version
        }
      }
    ],
    schema: ReplaceVoiceProfileInboundOutputSchema,
    shows: SIP_URI
  },
  {
    args: [PROFILE_ID, '--sip-uri', EDITED_SIP_URI, ...PROJECT, '--yes'],
    command: 'project platform voice profile inbound edit',
    document: editedInbound,
    plantedId: readProfileId,
    routes: [
      profileRoute,
      {
        body: editedInbound,
        method: 'PATCH',
        path: `${PROFILE}/inbound`,
        requestBody: {
          destinationUri: EDITED_SIP_URI,
          expectedVersion: profile.version
        }
      }
    ],
    schema: UpdateVoiceProfileInboundOutputSchema,
    shows: EDITED_SIP_URI
  },
  {
    args: [PROFILE_ID, ...PROJECT, '--yes'],
    command: 'project platform voice profile inbound clear',
    document: clearedInbound,
    plantedId: readProfileId,
    routes: [
      profileRoute,
      {
        body: clearedInbound,
        method: 'DELETE',
        path: `${PROFILE}/inbound?expectedVersion=${profile.version.toString()}`
      }
    ],
    schema: DeleteVoiceProfileInboundOutputSchema,
    shows: `Disabled inbound SIP delivery for Voice profile ${PROFILE_ID}.`
  },
  // outbound enable and rotate record the operation before the change, and
  // the journal takes only a profile ID in Photon's Voice profile ID format,
  // so the CLI stops before the change when the ID its read returns carries
  // planted characters. These two cases plant none there.
  {
    args: [
      'default',
      ...PROJECT,
      '--idempotency-key',
      'golden-outbound-enable'
    ],
    checkedSecret: 'password',
    command: 'project platform voice profile outbound enable',
    document: enabledOutbound,
    routes: [
      defaultProfileRoute,
      {
        body: enabledOutbound,
        method: 'PUT',
        path: `${DEFAULT_PROFILE}/outbound`,
        requestBody: {
          authentication: { algorithm: 'sha-256' },
          expectedVersion: defaultProfile.version
        }
      }
    ],
    schema: OutboundSetupSchema,
    shows: OUTBOUND_PASSWORD
  },
  {
    args: ['default', '--digest-algorithm', 'md5', ...PROJECT, '--yes'],
    command: 'project platform voice profile outbound edit',
    document: editedOutbound,
    plantedId: readDefaultProfileWithOutboundId,
    routes: [
      defaultProfileWithOutboundRoute,
      {
        body: editedOutbound,
        method: 'PATCH',
        path: `${DEFAULT_PROFILE}/outbound`,
        requestBody: {
          authentication: { algorithm: 'md5' },
          expectedVersion: defaultProfileWithOutbound.version
        }
      }
    ],
    schema: OutboundAuthenticationSchema,
    shows: outbound.connection.realm
  },
  {
    args: [
      'default',
      '--mode',
      'normal',
      ...PROJECT,
      '--idempotency-key',
      'golden-outbound-rotate',
      '--yes'
    ],
    checkedSecret: 'password',
    command: 'project platform voice profile outbound rotate',
    document: rotatedOutbound,
    routes: [
      defaultProfileWithOutboundRoute,
      {
        body: rotatedOutbound,
        method: 'POST',
        path: `${DEFAULT_PROFILE}/outbound/rotate`,
        requestBody: {
          expectedVersion: defaultProfileWithOutbound.version,
          mode: 'normal'
        }
      }
    ],
    schema: RotateVoiceProfileOutboundCredentialOutputSchema,
    shows: ROTATED_PASSWORD
  },
  {
    args: ['default', ...PROJECT, '--yes'],
    command: 'project platform voice profile outbound revoke',
    document: revokedOutbound,
    plantedId: readDefaultProfileWithOutboundId,
    routes: [
      defaultProfileWithOutboundRoute,
      {
        body: revokedOutbound,
        method: 'DELETE',
        path: `${DEFAULT_PROFILE}/outbound?expectedVersion=${defaultProfileWithOutbound.version.toString()}`
      }
    ],
    schema: DeleteVoiceProfileOutboundOutputSchema,
    shows: `Revoked outbound calling for Voice profile ${DEFAULT_PROFILE_ID}.`
  },
  printsResponse({
    args: [RESOURCE_ID, ...PROJECT],
    command: 'project platform voice assignment view',
    route: {
      body: withNewField(assignment),
      method: 'GET',
      path: LINE_PROFILE
    },
    schema: GetVoiceLineProfileAssignmentOutputSchema,
    shows: PROFILE_ID
  }),
  // It reads the line's assignment for its version, then assigns the
  // profile, and prints the assignment Photon returns in the batch
  // operation's envelope, as it does for several lines.
  buildsDocument({
    args: [
      '--profile-id',
      PROFILE_ID,
      '--resource-id',
      RESOURCE_ID,
      ...PROJECT,
      '--yes'
    ],
    build: (response: typeof assignedRoute.body) => ({
      assignments: [response]
    }),
    command: 'project platform voice assignment set',
    from: [assignedRoute],
    routes: [
      { body: defaultAssignment, method: 'GET', path: LINE_PROFILE },
      assignedRoute
    ],
    schema: VoiceAssignmentsSchema,
    shows: 'Assigned Voice profile to 1 line.'
  }),
  // Photon answers the line's unassignment with no body, so the CLI reads the
  // assignment again and prints it in the batch operation's envelope.
  buildsDocument({
    args: ['--resource-id', RESOURCE_ID, ...PROJECT, '--yes'],
    build: (response: typeof clearedAssignmentRoute.body) => ({
      assignments: [response]
    }),
    command: 'project platform voice assignment clear',
    from: [clearedAssignmentRoute],
    routes: [
      { body: assignment, method: 'GET', path: LINE_PROFILE },
      {
        method: 'DELETE',
        path: `${LINE_PROFILE}?expectedVersion=${assignment.resourceVersion.toString()}`,
        status: 204
      },
      clearedAssignmentRoute
    ],
    schema: VoiceAssignmentsSchema,
    shows: 'Returned 1 line to the project default.'
  })
]
