import { CliError } from '../core/errors.ts'
import type { CliOutput } from '../core/output.ts'
import { detail, table } from '../core/presenter.ts'
import type {
  VoiceLineProfileAssignment,
  VoiceProfile,
  VoiceProfileInboundResult,
  VoiceProfileOutboundAuthenticationResult,
  VoiceProfileOutboundRevocationResult,
  VoiceProfileOutboundRotationResult,
  VoiceProfileOutboundSetupResult
} from './voice-service.ts'

const MAXIMUM_OUTBOUND_PASSWORD_LENGTH = 4096
const DISPLAY_SAFE_PASSWORD_PATTERN = /^[\x21-\x7e]+$/u

export const VOICE_OUTBOUND_PASSWORD_WARNING =
  'Save this outbound SIP password now. It cannot be retrieved again.'

export const VOICE_OUTBOUND_SECRET_UNAVAILABLE_WARNING =
  'The outbound action already succeeded, but its display-once SIP password is no longer available. Rotate again with the returned profile version and a new idempotency key; reusing the original key will never rotate again.'

export const assertDisplaySafeOutboundPassword = (value: string): string => {
  if (
    value.length > 0 &&
    value.length <= MAXIMUM_OUTBOUND_PASSWORD_LENGTH &&
    DISPLAY_SAFE_PASSWORD_PATTERN.test(value)
  ) {
    return value
  }
  throw new CliError(
    'VOICE_PROTOCOL_ERROR',
    'Photon returned an invalid Voice response.',
    {
      debugSafe: false,
      detail: 'The display-once outbound SIP password was not safe to display.',
      next: [
        {
          description:
            'Rotate the outbound credential with a new idempotency key to issue a new password.'
        }
      ]
    }
  )
}

/**
 * An outbound enable or rotate response as Photon sent it, once its
 * display-once password is safe to show.
 */
export const withSafeOutboundPassword = <
  Result extends { password: string | null }
>(
  result: Result
): Result => {
  if (result.password !== null) {
    assertDisplaySafeOutboundPassword(result.password)
  }
  return result
}

const credentialsLabel = (profile: VoiceProfile): string => {
  const credentials = profile.configuration.inbound?.credentials
  return credentials === null || credentials === undefined
    ? 'not configured'
    : `${credentials.username} (password configured)`
}

const outboundEndpoints = (profile: VoiceProfile): string | undefined =>
  profile.configuration.outbound?.connection.endpoints
    .map(
      (endpoint) =>
        `${endpoint.transport}://${endpoint.host}:${endpoint.port.toString()}`
    )
    .join(', ')

export const voiceProfileDetails = (
  output: CliOutput,
  profile: VoiceProfile,
  heading = 'Voice profile'
): string[] =>
  detail(output, heading, [
    { label: 'Name', value: profile.name },
    { label: 'Profile ID', value: profile.profileId },
    { label: 'Project', value: profile.projectId },
    { label: 'Default', value: profile.isDefault },
    { label: 'Protocol', value: profile.protocol },
    { label: 'Media encryption', value: profile.mediaEncryption },
    {
      label: 'Inbound configured',
      value: profile.configuration.inbound !== null
    },
    {
      label: 'SIP destination',
      value: profile.configuration.inbound?.destinationUri
    },
    { label: 'Inbound credentials', value: credentialsLabel(profile) },
    {
      label: 'Outbound configured',
      value: profile.configuration.outbound !== null
    },
    {
      label: 'Outbound username',
      value: profile.configuration.outbound?.authentication.username
    },
    {
      label: 'Outbound realm',
      value: profile.configuration.outbound?.connection.realm
    },
    { label: 'Outbound endpoints', value: outboundEndpoints(profile) },
    {
      label: 'Outbound algorithm',
      value: profile.configuration.outbound?.authentication.algorithm
    },
    {
      label: 'Outbound valid from',
      value: profile.configuration.outbound?.authentication.validFrom
    },
    {
      label: 'Previous password valid until',
      value:
        profile.configuration.outbound?.authentication
          .previousPasswordValidUntil
    },
    { label: 'Lines using profile', value: profile.lineCount },
    { label: 'Version', value: profile.version },
    { label: 'Created', value: profile.createdAt },
    { label: 'Updated', value: profile.updatedAt }
  ])

export const voiceProfileTable = (
  output: CliOutput,
  profiles: VoiceProfile[]
): string[] =>
  table(
    output,
    [
      'NAME',
      'PROFILE ID',
      'DEFAULT',
      'SIP DESTINATION',
      'OUTBOUND',
      'LINES',
      'VERSION',
      'UPDATED'
    ],
    profiles.map((profile) => [
      profile.name,
      { style: 'cyan', text: profile.profileId },
      profile.isDefault ? 'yes' : 'no',
      profile.configuration.inbound?.destinationUri ?? 'not configured',
      profile.configuration.outbound?.authentication.username ??
        'not configured',
      profile.lineCount.toString(),
      profile.version.toString(),
      { style: 'dim', text: profile.updatedAt }
    ])
  )

export const voiceProfileInboundDetails = (
  output: CliOutput,
  result: VoiceProfileInboundResult,
  heading = 'Inbound SIP delivery'
): string[] =>
  detail(output, heading, [
    { label: 'Configured', value: result.inbound !== null },
    { label: 'SIP destination', value: result.inbound?.destinationUri },
    {
      label: 'SIP username',
      value: result.inbound?.credentials?.username
    },
    { label: 'Profile version', value: result.profileVersion }
  ])

const outboundEndpointList = (
  result: VoiceProfileOutboundAuthenticationResult
): string =>
  result.outbound.connection.endpoints
    .map(
      (endpoint) =>
        `${endpoint.transport}://${endpoint.host}:${endpoint.port.toString()}`
    )
    .join(', ')

export const voiceProfileOutboundAuthenticationDetails = (
  output: CliOutput,
  result: VoiceProfileOutboundAuthenticationResult
): string[] =>
  detail(output, 'Outbound SIP authentication', [
    { label: 'Realm', value: result.outbound.connection.realm },
    { label: 'Endpoints', value: outboundEndpointList(result) },
    { label: 'Username', value: result.outbound.authentication.username },
    { label: 'Algorithm', value: result.outbound.authentication.algorithm },
    { label: 'Valid from', value: result.outbound.authentication.validFrom },
    {
      label: 'Previous password valid until',
      value: result.outbound.authentication.previousPasswordValidUntil
    },
    { label: 'Profile version', value: result.profileVersion }
  ])

export const voiceProfileOutboundSetupDetails = (
  output: CliOutput,
  result: VoiceProfileOutboundSetupResult
): string[] =>
  detail(output, 'Outbound SIP configuration', [
    { label: 'Realm', value: result.outbound.connection.realm },
    { label: 'Endpoints', value: outboundEndpointList(result) },
    { label: 'Username', value: result.outbound.authentication.username },
    { label: 'Algorithm', value: result.outbound.authentication.algorithm },
    { label: 'Valid from', value: result.outbound.authentication.validFrom },
    {
      label: 'Previous password valid until',
      value: result.outbound.authentication.previousPasswordValidUntil
    },
    { label: 'Display-once password', value: result.password },
    { label: 'Profile version', value: result.profileVersion }
  ])

export const voiceProfileOutboundRotationDetails = (
  output: CliOutput,
  result: VoiceProfileOutboundRotationResult
): string[] =>
  detail(output, 'Rotated outbound SIP password', [
    { label: 'Display-once password', value: result.password },
    {
      label: 'Previous password valid until',
      value: result.previousPasswordValidUntil
    },
    { label: 'Profile version', value: result.profileVersion }
  ])

export const voiceProfileOutboundRevocationDetails = (
  output: CliOutput,
  result: VoiceProfileOutboundRevocationResult
): string[] =>
  detail(output, 'Outbound SIP configuration', [
    { label: 'Configured', value: result.outbound !== null },
    { label: 'Profile version', value: result.profileVersion }
  ])

export const voiceAssignmentDetails = (
  output: CliOutput,
  assignment: VoiceLineProfileAssignment,
  heading = 'Voice profile assignment'
): string[] =>
  detail(output, heading, [
    { label: 'Resource ID', value: assignment.resourceId },
    { label: 'Project', value: assignment.projectId },
    { label: 'Profile ID', value: assignment.profileId },
    { label: 'Resource version', value: assignment.resourceVersion },
    { label: 'Profile version', value: assignment.profileVersion },
    { label: 'Updated', value: assignment.updatedAt }
  ])

export const voiceAssignmentTable = (
  output: CliOutput,
  assignments: VoiceLineProfileAssignment[]
): string[] =>
  table(
    output,
    [
      'RESOURCE ID',
      'PROFILE ID',
      'RESOURCE VERSION',
      'PROFILE VERSION',
      'UPDATED'
    ],
    assignments.map((assignment) => [
      { style: 'cyan', text: assignment.resourceId },
      assignment.profileId ?? 'default',
      assignment.resourceVersion.toString(),
      assignment.profileVersion?.toString() ?? '—',
      { style: 'dim', text: assignment.updatedAt }
    ]),
    'No Voice profile assignments found.'
  )
