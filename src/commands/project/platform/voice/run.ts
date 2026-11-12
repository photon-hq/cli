import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../../app/services.ts'
import { CliError } from '../../../../core/errors.ts'
import { ID_FORMATS } from '../../../../core/photon-id.ts'
import { inert, presentList } from '../../../../core/presenter.ts'
import { CLI_NAME } from '../../../../meta.ts'
import type { OperationIntent } from '../../../../operation/types.ts'
import { resolveProjectId } from '../../../../project/command-helpers.ts'
import { validatePagination } from '../../../../project/validation.ts'
import {
  VOICE_OUTBOUND_PASSWORD_WARNING,
  VOICE_OUTBOUND_SECRET_UNAVAILABLE_WARNING,
  voiceAssignmentDetails,
  voiceAssignmentTable,
  voiceProfileDetails,
  voiceProfileInboundDetails,
  voiceProfileOutboundAuthenticationDetails,
  voiceProfileOutboundRevocationDetails,
  voiceProfileOutboundRotationDetails,
  voiceProfileOutboundSetupDetails,
  voiceProfileTable,
  withSafeOutboundPassword
} from '../../../../project/voice-presenter.ts'
import type {
  VoiceLineProfileAssignment,
  VoiceProfile,
  VoiceProfileInboundChanges,
  VoiceProfileInboundReplaceInput,
  VoiceProfileOutboundRotationMode,
  VoiceProfileOutboundRotationResult,
  VoiceProfileOutboundSetupResult,
  VoiceProfileReference,
  VoiceSipCredentialsInput
} from '../../../../project/voice-service.ts'
import {
  MAXIMUM_VOICE_SIP_PASSWORD_BYTES,
  type VoiceCredentialChange,
  type VoiceCredentialSource,
  validateVoiceAssignmentResources,
  validateVoiceProfileChanges,
  validateVoiceProfileCreate,
  validateVoiceProfileInboundChanges,
  validateVoiceProfileInboundSet,
  validateVoiceProfileOutboundDigestAlgorithm,
  voiceCredentials
} from '../../../../project/voice-validation.ts'
import {
  type ConfirmingCommand,
  cancelled,
  confirmRiskyAction
} from '../../../helpers.ts'
import type {
  VoiceAssignmentClearParams,
  VoiceAssignmentSetParams,
  VoiceAssignmentViewParams,
  VoiceProfileCreateParams,
  VoiceProfileDeleteParams,
  VoiceProfileEditParams,
  VoiceProfileInboundClearParams,
  VoiceProfileInboundEditParams,
  VoiceProfileInboundSetParams,
  VoiceProfileListParams,
  VoiceProfileOutboundEditParams,
  VoiceProfileOutboundEnableParams,
  VoiceProfileOutboundRevokeParams,
  VoiceProfileOutboundRotateParams,
  VoiceProfileViewParams
} from './definition.ts'

const readVoiceCredentials = async (
  photon: PhotonCommandServices,
  source: VoiceCredentialSource | undefined
): Promise<VoiceSipCredentialsInput | undefined> => {
  if (source === undefined) {
    return
  }
  const password = await photon.input.readExactSecret(source.passwordFile, {
    fileDescription: 'SIP password file',
    label: 'SIP password',
    maximumBytes: MAXIMUM_VOICE_SIP_PASSWORD_BYTES,
    option: '--sip-password-file'
  })
  return voiceCredentials(source, password)
}

const profileAssignedError = (profileId: string, lineCount: number): CliError =>
  new CliError(
    'VOICE_PROFILE_ASSIGNED',
    `Voice profile ${profileId} is used by ${lineCount.toString()} line${lineCount === 1 ? '' : 's'}.`,
    {
      exitCode: 2,
      next: [
        {
          description:
            'Re-run with --unassign-lines to atomically return those lines to the project default before deleting the profile.'
        }
      ]
    }
  )

const defaultProfileDeletionError = (): CliError =>
  new CliError(
    'VOICE_DEFAULT_PROFILE_DELETION_FORBIDDEN',
    'The project default Voice profile cannot be deleted.',
    {
      exitCode: 2,
      next: [
        {
          description: 'Inspect the default profile',
          run: `${CLI_NAME} project platform voice profile view default`
        },
        {
          description: `Change its delivery with "${CLI_NAME} project platform voice profile inbound" or "${CLI_NAME} project platform voice profile outbound".`
        }
      ]
    }
  )

const defaultProfileRenameError = (): CliError =>
  new CliError(
    'VOICE_DEFAULT_PROFILE_NAME_IMMUTABLE',
    'The project default Voice profile cannot be renamed.',
    {
      exitCode: 2,
      next: [{ description: 'Rename an additional profile instead.' }]
    }
  )

const getProfileByReference = async (
  photon: PhotonCommandServices,
  projectId: string,
  reference: VoiceProfileReference
): Promise<VoiceProfile> => {
  if (reference === 'default') {
    return await photon.voice.getDefaultProfile(projectId)
  }
  return await photon.voice.getProfile(projectId, reference)
}

const confirmProfileInboundChange = async (
  command: ConfirmingCommand,
  profile: VoiceProfile,
  projectId: string,
  credentialChange?: VoiceCredentialChange
): Promise<boolean> => {
  if (profile.lineCount === 0) {
    return true
  }
  if (credentialChange?.action === 'replace') {
    command.extensions.photon.input.requireSource(
      credentialChange.source.passwordFile,
      '--sip-password-file'
    )
  }
  return await confirmRiskyAction(command, {
    action: `update inbound delivery used immediately by ${profile.lineCount.toString()} line${profile.lineCount === 1 ? '' : 's'}`,
    scope: { project: projectId }
  })
}

const changedVoiceCredentials = async (
  photon: PhotonCommandServices,
  current: VoiceProfile,
  credentialChange: VoiceCredentialChange | undefined,
  destinationIncluded: boolean
): Promise<VoiceSipCredentialsInput | null | undefined> => {
  if (credentialChange?.action === 'clear') {
    return null
  }
  if (credentialChange?.action === 'replace') {
    if (current.configuration.inbound === null && !destinationIncluded) {
      throw new CliError(
        'INVALID_INPUT',
        'Pass --sip-uri when adding inbound SIP credentials to an unconfigured profile.'
      )
    }
    const credentials = await readVoiceCredentials(
      photon,
      credentialChange.source
    )
    if (credentials === undefined) {
      throw new TypeError('Replacement Voice credentials are required.')
    }
    return credentials
  }
}

type VoiceProfileOutboundEnableIntent = Extract<
  OperationIntent,
  { kind: 'voice-profile-outbound.enable' }
>
type VoiceProfileOutboundRotateIntent = Extract<
  OperationIntent,
  { kind: 'voice-profile-outbound.rotate' }
>

const requiredOutboundIdempotencyKey = (
  idempotencyKey: string | undefined
): string => {
  if (idempotencyKey === undefined) {
    throw new CliError(
      'OPERATION_JOURNAL_CORRUPT',
      'A journaled Voice outbound operation is missing its idempotency key.'
    )
  }
  return idempotencyKey
}

const canonicalProfileId = (
  profile: VoiceProfile,
  reference: VoiceProfileReference
): string => {
  if (!ID_FORMATS.voiceProfile.pattern.test(profile.profileId)) {
    throw new CliError(
      'VOICE_PROTOCOL_ERROR',
      'Photon returned an invalid Voice response.',
      { detail: 'The Voice profile did not contain a canonical profile ID.' }
    )
  }
  if (reference !== 'default' && profile.profileId !== reference) {
    throw new CliError(
      'VOICE_PROTOCOL_ERROR',
      `Photon returned another Voice profile for ${reference}. No change was made.`
    )
  }
  return profile.profileId
}

const voiceProfileOutboundEnableIntent = async (
  photon: PhotonCommandServices,
  projectId: string,
  profileReference: VoiceProfileReference,
  digestAlgorithm: VoiceProfileOutboundEnableIntent['digestAlgorithm'],
  suppliedIdempotencyKey: string | undefined
): Promise<VoiceProfileOutboundEnableIntent> => {
  const continued = await photon.operations.continuationIntent(
    'voice-profile-outbound.enable',
    suppliedIdempotencyKey,
    (intent) =>
      intent.projectId === projectId &&
      intent.profileReference === profileReference &&
      intent.digestAlgorithm === digestAlgorithm
  )
  if (continued !== undefined) {
    return continued
  }
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  return {
    digestAlgorithm,
    expectedVersion: current.version,
    kind: 'voice-profile-outbound.enable',
    profileId: canonicalProfileId(current, profileReference),
    profileReference,
    projectId
  }
}

const voiceProfileOutboundRotateIntent = async (
  photon: PhotonCommandServices,
  projectId: string,
  profileReference: VoiceProfileReference,
  mode: VoiceProfileOutboundRotationMode,
  suppliedIdempotencyKey: string | undefined
): Promise<VoiceProfileOutboundRotateIntent> => {
  const continued = await photon.operations.continuationIntent(
    'voice-profile-outbound.rotate',
    suppliedIdempotencyKey,
    (intent) =>
      intent.projectId === projectId &&
      intent.profileReference === profileReference &&
      intent.mode === mode
  )
  if (continued !== undefined) {
    return continued
  }
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  return {
    expectedVersion: current.version,
    kind: 'voice-profile-outbound.rotate',
    mode,
    profileId: canonicalProfileId(current, profileReference),
    profileReference,
    projectId
  }
}

const outboundPasswordWarning = (password: string | null): string =>
  password === null
    ? VOICE_OUTBOUND_SECRET_UNAVAILABLE_WARNING
    : VOICE_OUTBOUND_PASSWORD_WARNING

const presentOutboundSetup = async (
  photon: PhotonCommandServices,
  operationId: string,
  result: VoiceProfileOutboundSetupResult,
  message: string
): Promise<void> => {
  const setup = withSafeOutboundPassword(result)
  const human = [
    photon.output.style('green', message),
    ...voiceProfileOutboundSetupDetails(photon.output, setup)
  ]
  photon.output.warning(outboundPasswordWarning(setup.password))
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(setup, human)
  )
}

const presentOutboundRotation = async (
  photon: PhotonCommandServices,
  operationId: string,
  result: VoiceProfileOutboundRotationResult,
  message: string
): Promise<void> => {
  const rotation = withSafeOutboundPassword(result)
  const human = [
    photon.output.style('green', message),
    ...voiceProfileOutboundRotationDetails(photon.output, rotation)
  ]
  photon.output.warning(outboundPasswordWarning(rotation.password))
  await photon.operations.deliverOutput(operationId, () =>
    photon.output.successAndFlush(rotation, human)
  )
}

const currentAssignments = async (
  photon: PhotonCommandServices,
  projectId: string,
  resourceIds: string[]
): Promise<VoiceLineProfileAssignment[]> =>
  await Promise.all(
    resourceIds.map(async (resourceId) => {
      const assignment = await photon.voice.getLineProfileAssignment(
        projectId,
        resourceId
      )
      if (assignment.resourceId !== resourceId) {
        throw new CliError(
          'VOICE_PROTOCOL_ERROR',
          `Photon returned another line's Voice assignment for ${resourceId}. No change was made.`
        )
      }
      return assignment
    })
  )

const mergeAssignments = (
  projectId: string,
  current: VoiceLineProfileAssignment[],
  changed: VoiceLineProfileAssignment[],
  answered: VoiceLineProfileAssignment[]
): VoiceLineProfileAssignment[] => {
  const answers = new Map(
    answered.map((assignment) => [assignment.resourceId, assignment])
  )
  return current.map((assignment) => {
    if (!changed.includes(assignment)) {
      return assignment
    }
    const answer = answers.get(assignment.resourceId)
    if (answer === undefined) {
      throw new CliError(
        'VOICE_PROTOCOL_ERROR',
        `Photon did not return the Voice assignment for ${assignment.resourceId}. The change may have been made.`,
        {
          next: [
            {
              description: 'Check the line',
              run: `${CLI_NAME} project platform voice assignment view ${assignment.resourceId} --project ${projectId}`
            }
          ]
        }
      )
    }
    return answer
  })
}

const presentAssignments = (
  photon: PhotonCommandServices,
  assignments: VoiceLineProfileAssignment[],
  message: string
): void => {
  photon.output.success({ assignments }, [
    photon.output.style('green', message),
    ...voiceAssignmentTable(photon.output, assignments)
  ])
}

export const runVoiceProfileList: CommandRunner<
  VoiceProfileListParams
> = async (context) => {
  const { photon } = context.extensions
  let isDefault: boolean | undefined
  if (context.values.default) {
    isDefault = true
  } else if (context.values.additional) {
    isDefault = false
  }
  const projectId = await resolveProjectId(photon)
  const result = await photon.voice.listProfiles(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken),
    isDefault
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No Voice profiles found.',
    items: result.profiles,
    lines: voiceProfileTable(photon.output, result.profiles),
    page: {
      command: context,
      inDocument: true,
      scope: { project: projectId },
      token: result.nextPageToken
    }
  })
}

export const runVoiceProfileView: CommandRunner<
  VoiceProfileViewParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const profile = await getProfileByReference(
    photon,
    projectId,
    context.values['profile-id']
  )
  photon.output.success(profile, voiceProfileDetails(photon.output, profile))
}

export const runVoiceProfileCreate: CommandRunner<
  VoiceProfileCreateParams
> = async (context) => {
  const { photon } = context.extensions
  const input = validateVoiceProfileCreate({
    isDefault: context.values.default ?? false,
    ...(context.values.mediaEncryption === undefined
      ? {}
      : { mediaEncryption: context.values.mediaEncryption }),
    ...(context.values.name === undefined ? {} : { name: context.values.name })
  })
  const projectId = await resolveProjectId(photon)
  const profile = input.isDefault
    ? await photon.voice.createDefaultProfile(projectId, input.profile)
    : await photon.voice.createProfile(projectId, input.profile)
  photon.output.success(profile, [
    photon.output.style(
      'green',
      inert(
        input.isDefault
          ? `Created default Voice profile ${profile.profileId}.`
          : `Created Voice profile ${profile.profileId}.`
      )
    ),
    ...voiceProfileDetails(photon.output, profile)
  ])
}

export const runVoiceProfileEdit: CommandRunner<
  VoiceProfileEditParams
> = async (context) => {
  const { photon } = context.extensions
  const profileId = context.values['profile-id']
  const changes = validateVoiceProfileChanges({
    ...(context.values.name === undefined ? {} : { name: context.values.name }),
    ...(context.values.mediaEncryption === undefined
      ? {}
      : { mediaEncryption: context.values.mediaEncryption })
  })
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(photon, projectId, profileId)
  if (current.isDefault && changes.name !== undefined) {
    throw defaultProfileRenameError()
  }
  const profile = current.isDefault
    ? await photon.voice.updateDefaultProfile(projectId, current.version, {
        ...(changes.mediaEncryption === undefined
          ? {}
          : { mediaEncryption: changes.mediaEncryption })
      })
    : await photon.voice.updateProfile(
        projectId,
        current.profileId,
        current.version,
        changes
      )
  photon.output.success(profile, [
    photon.output.style(
      'green',
      inert(`Updated Voice profile ${current.profileId}.`)
    ),
    ...voiceProfileDetails(photon.output, profile)
  ])
}

export const runVoiceProfileInboundSet: CommandRunner<
  VoiceProfileInboundSetParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const input = validateVoiceProfileInboundSet({
    clearSipCredentials: context.values.clearSipCredentials ?? false,
    ...(context.values.sipPasswordFile === undefined
      ? {}
      : { sipPasswordFile: context.values.sipPasswordFile }),
    sipUri: context.values.sipUri,
    ...(context.values.sipUsername === undefined
      ? {}
      : { sipUsername: context.values.sipUsername })
  })
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  const confirmed = await confirmProfileInboundChange(
    context,
    current,
    projectId,
    input.credentialChange
  )
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const credentials = await changedVoiceCredentials(
    photon,
    current,
    input.credentialChange,
    true
  )
  const replacement: VoiceProfileInboundReplaceInput = {
    ...input.input,
    credentials: credentials ?? null
  }
  const result = await photon.voice.replaceProfileInbound(
    projectId,
    current.profileId,
    current.version,
    replacement
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(`Set inbound SIP delivery for Voice profile ${current.profileId}.`)
    ),
    ...voiceProfileInboundDetails(photon.output, result)
  ])
}

export const runVoiceProfileInboundEdit: CommandRunner<
  VoiceProfileInboundEditParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const input = validateVoiceProfileInboundChanges({
    clearSipCredentials: context.values.clearSipCredentials ?? false,
    ...(context.values.sipPasswordFile === undefined
      ? {}
      : { sipPasswordFile: context.values.sipPasswordFile }),
    ...(context.values.sipUri === undefined
      ? {}
      : { sipUri: context.values.sipUri }),
    ...(context.values.sipUsername === undefined
      ? {}
      : { sipUsername: context.values.sipUsername })
  })
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  const confirmed = await confirmProfileInboundChange(
    context,
    current,
    projectId,
    input.credentialChange
  )
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const credentials = await changedVoiceCredentials(
    photon,
    current,
    input.credentialChange,
    input.changes.destinationUri !== undefined
  )
  const changes: VoiceProfileInboundChanges = {
    ...input.changes,
    ...(credentials === undefined ? {} : { credentials })
  }
  const result = await photon.voice.updateProfileInbound(
    projectId,
    current.profileId,
    current.version,
    changes
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(
        `Updated inbound SIP delivery for Voice profile ${current.profileId}.`
      )
    ),
    ...voiceProfileInboundDetails(photon.output, result)
  ])
}

export const runVoiceProfileInboundClear: CommandRunner<
  VoiceProfileInboundClearParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  const confirmed = await confirmProfileInboundChange(
    context,
    current,
    projectId
  )
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = await photon.voice.clearProfileInbound(
    projectId,
    current.profileId,
    current.version
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(
        `Disabled inbound SIP delivery for Voice profile ${current.profileId}.`
      )
    ),
    ...voiceProfileInboundDetails(photon.output, result)
  ])
}

export const runVoiceProfileOutboundEnable: CommandRunner<
  VoiceProfileOutboundEnableParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const projectId = await resolveProjectId(photon)
  const digestAlgorithm = validateVoiceProfileOutboundDigestAlgorithm(
    context.values.digestAlgorithm
  )
  const intent = await voiceProfileOutboundEnableIntent(
    photon,
    projectId,
    profileReference,
    digestAlgorithm,
    context.values.idempotencyKey
  )
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.voice.enableProfileOutbound(
        intent.projectId,
        intent.profileId,
        intent.expectedVersion,
        intent.digestAlgorithm,
        requiredOutboundIdempotencyKey(idempotencyKey)
      )
  )
  await presentOutboundSetup(
    photon,
    operationId,
    result,
    `Enabled outbound calling for Voice profile ${intent.profileId}.`
  )
}

export const runVoiceProfileOutboundEdit: CommandRunner<
  VoiceProfileOutboundEditParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const digestAlgorithm = validateVoiceProfileOutboundDigestAlgorithm(
    context.values.digestAlgorithm
  )
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  const compatibility =
    digestAlgorithm === 'md5'
      ? 'MD5 is the weaker legacy option; use it only for PBX compatibility.'
      : 'Selecting SHA-256 can stop an incompatible PBX from authenticating.'
  const confirmed = await confirmRiskyAction(context, {
    action: `set the outbound SIP Digest algorithm to ${digestAlgorithm} for Voice profile ${current.profileId}`,
    consequence: `The username and password are preserved. ${compatibility}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = await photon.voice.updateProfileOutboundAuthentication(
    projectId,
    current.profileId,
    current.version,
    digestAlgorithm
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(
        `Updated outbound SIP authentication for Voice profile ${current.profileId}. Username and password are preserved.`
      )
    ),
    ...voiceProfileOutboundAuthenticationDetails(photon.output, result)
  ])
}

export const runVoiceProfileOutboundRotate: CommandRunner<
  VoiceProfileOutboundRotateParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const projectId = await resolveProjectId(photon)
  const intent = await voiceProfileOutboundRotateIntent(
    photon,
    projectId,
    profileReference,
    context.values.mode,
    context.values.idempotencyKey
  )
  const emergency = context.values.mode === 'emergency'
  const confirmed = await confirmRiskyAction(context, {
    action: `${emergency ? 'emergency-rotate' : 'rotate'} the outbound credential for Voice profile ${intent.profileId}`,
    consequence: emergency
      ? 'The previous credential will stop working immediately.'
      : 'The previous credential will remain valid for one hour.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { operationId, result } = await photon.operations.executeAwaitingOutput(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.voice.rotateProfileOutbound(
        intent.projectId,
        intent.profileId,
        intent.expectedVersion,
        intent.mode,
        requiredOutboundIdempotencyKey(idempotencyKey)
      )
  )
  await presentOutboundRotation(
    photon,
    operationId,
    result,
    `Rotated the outbound credential for Voice profile ${intent.profileId}.`
  )
}

export const runVoiceProfileOutboundRevoke: CommandRunner<
  VoiceProfileOutboundRevokeParams
> = async (context) => {
  const { photon } = context.extensions
  const profileReference = context.values['profile-id']
  const projectId = await resolveProjectId(photon)
  const current = await getProfileByReference(
    photon,
    projectId,
    profileReference
  )
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke outbound calling for Voice profile ${current.profileId}`,
    consequence: 'The active credential will stop working.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = await photon.voice.revokeProfileOutbound(
    projectId,
    current.profileId,
    current.version
  )
  photon.output.success(result, [
    photon.output.style(
      'green',
      inert(`Revoked outbound calling for Voice profile ${current.profileId}.`)
    ),
    ...voiceProfileOutboundRevocationDetails(photon.output, result)
  ])
}

export const runVoiceProfileDelete: CommandRunner<
  VoiceProfileDeleteParams
> = async (context) => {
  const { photon } = context.extensions
  const profileId = context.values['profile-id']
  const projectId = await resolveProjectId(photon)
  const profile = await photon.voice.getProfile(projectId, profileId)
  if (profile.isDefault) {
    throw defaultProfileDeletionError()
  }
  const unassignLines = context.values.unassignLines ?? false
  if (profile.lineCount > 0 && !unassignLines) {
    throw profileAssignedError(profileId, profile.lineCount)
  }
  const confirmed = await confirmRiskyAction(context, {
    action:
      unassignLines && profile.lineCount > 0
        ? `delete Voice profile ${profileId} and return its ${profile.lineCount.toString()} lines to the default`
        : `delete Voice profile ${profileId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  await photon.voice.deleteProfile(
    projectId,
    profileId,
    profile.version,
    unassignLines
  )
  photon.output.success(
    {
      deleted: true,
      profileId,
      returnedToDefaultLineCount: unassignLines ? profile.lineCount : 0
    },
    photon.output.style('green', `Deleted Voice profile ${profileId}.`)
  )
}

export const runVoiceAssignmentView: CommandRunner<
  VoiceAssignmentViewParams
> = async (context) => {
  const { photon } = context.extensions
  const assignment = await photon.voice.getLineProfileAssignment(
    await resolveProjectId(photon),
    context.values['resource-id']
  )
  photon.output.success(
    assignment,
    voiceAssignmentDetails(photon.output, assignment)
  )
}

export const runVoiceAssignmentSet: CommandRunner<
  VoiceAssignmentSetParams
> = async (context) => {
  const { photon } = context.extensions
  const { profileId } = context.values
  const resourceIds = validateVoiceAssignmentResources(
    context.values.resourceId
  )
  const projectId = await resolveProjectId(photon)
  const current = await currentAssignments(photon, projectId, resourceIds)
  const changed = current.filter(
    (assignment) => assignment.profileId !== profileId
  )
  if (changed.length === 0) {
    presentAssignments(photon, current, 'Every line already uses that profile.')
    return
  }
  const confirmed = await confirmRiskyAction(context, {
    action: `assign Voice profile ${profileId} to ${changed.length.toString()} line${changed.length === 1 ? '' : 's'}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const updated =
    changed.length === 1 && changed[0] !== undefined
      ? [
          await photon.voice.assignLineProfile(
            projectId,
            changed[0].resourceId,
            profileId,
            changed[0].resourceVersion
          )
        ]
      : await photon.voice.batchUpdateLineProfileAssignments(
          projectId,
          changed.map((assignment) => ({
            expectedVersion: assignment.resourceVersion,
            profileId,
            resourceId: assignment.resourceId
          }))
        )
  presentAssignments(
    photon,
    mergeAssignments(projectId, current, changed, updated),
    `Assigned Voice profile to ${changed.length.toString()} line${changed.length === 1 ? '' : 's'}.`
  )
}

export const runVoiceAssignmentClear: CommandRunner<
  VoiceAssignmentClearParams
> = async (context) => {
  const { photon } = context.extensions
  const resourceIds = validateVoiceAssignmentResources(
    context.values.resourceId
  )
  const projectId = await resolveProjectId(photon)
  const current = await currentAssignments(photon, projectId, resourceIds)
  const changed = current.filter(
    (assignment) => assignment.profileId !== undefined
  )
  if (changed.length === 0) {
    presentAssignments(photon, current, 'Every line is already unassigned.')
    return
  }
  const confirmed = await confirmRiskyAction(context, {
    action: `clear Voice profile overrides from ${changed.length.toString()} line${changed.length === 1 ? '' : 's'}`,
    consequence: 'Those lines will follow the project default.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  let updated: VoiceLineProfileAssignment[]
  if (changed.length === 1 && changed[0] !== undefined) {
    await photon.voice.unassignLineProfile(
      projectId,
      changed[0].resourceId,
      changed[0].resourceVersion
    )
    updated = [
      await photon.voice.getLineProfileAssignment(
        projectId,
        changed[0].resourceId
      )
    ]
  } else {
    updated = await photon.voice.batchUpdateLineProfileAssignments(
      projectId,
      changed.map((assignment) => ({
        expectedVersion: assignment.resourceVersion,
        profileId: null,
        resourceId: assignment.resourceId
      }))
    )
  }
  presentAssignments(
    photon,
    mergeAssignments(projectId, current, changed, updated),
    `Returned ${changed.length.toString()} line${changed.length === 1 ? '' : 's'} to the project default.`
  )
}
