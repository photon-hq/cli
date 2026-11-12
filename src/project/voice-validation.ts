import { validateId } from '../core/photon-id.ts'
import {
  boundedText,
  invalidInput,
  validateFilePath
} from '../core/validation.ts'
import {
  DEFAULT_VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHM,
  isVoiceProfileOutboundDigestAlgorithm,
  type VoiceProfileOutboundDigestAlgorithm
} from './voice-outbound-authentication.ts'
import type {
  VoiceDefaultProfileCreateInput,
  VoiceProfileChanges,
  VoiceProfileCreateInput,
  VoiceProfileInboundChanges,
  VoiceProfileInboundReplaceInput,
  VoiceProfileReference,
  VoiceSipCredentialsInput
} from './voice-service.ts'

const SIP_SCHEME_PATTERN = /^sips?:/iu
const WHITESPACE_PATTERN = /\s/u

const MAXIMUM_PROFILE_NAME_LENGTH = 100
const MAXIMUM_SIP_DESTINATION_LENGTH = 2048
const MAXIMUM_SIP_USERNAME_LENGTH = 256

export const MAXIMUM_VOICE_PROFILE_ASSIGNMENT_BATCH_SIZE = 100
export const MAXIMUM_VOICE_SIP_PASSWORD_BYTES = 1024

export const validateVoiceProfileOutboundDigestAlgorithm = (
  value: string | undefined
): VoiceProfileOutboundDigestAlgorithm => {
  if (value === undefined) {
    return DEFAULT_VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHM
  }
  if (isVoiceProfileOutboundDigestAlgorithm(value)) {
    return value
  }
  throw invalidInput(
    '--digest-algorithm must be sha-256 or md5. Use sha-256 unless a legacy SIP endpoint only supports MD5.'
  )
}

export interface VoiceCredentialSource {
  passwordFile?: string
  username: string
}

export type ValidatedVoiceProfileCreate =
  | { isDefault: false; profile: VoiceProfileCreateInput }
  | { isDefault: true; profile: VoiceDefaultProfileCreateInput }

export type VoiceCredentialChange =
  | { action: 'clear' }
  | { action: 'replace'; source: VoiceCredentialSource }

export interface ValidatedVoiceProfileInboundSet {
  credentialChange?: VoiceCredentialChange
  input: Omit<VoiceProfileInboundReplaceInput, 'credentials'>
}

export interface ValidatedVoiceProfileInboundChanges {
  changes: Omit<VoiceProfileInboundChanges, 'credentials'>
  credentialChange?: VoiceCredentialChange
}

const validateSipDestination = (value: string): string => {
  const destination = boundedText(
    value,
    'SIP URI',
    MAXIMUM_SIP_DESTINATION_LENGTH
  )
  if (!SIP_SCHEME_PATTERN.test(destination)) {
    throw invalidInput('SIP URI must begin with sip: or sips:.')
  }
  if (WHITESPACE_PATTERN.test(destination)) {
    throw invalidInput('SIP URI cannot contain whitespace.')
  }
  return destination
}

const validateCredentialSource = (
  username: string | undefined,
  passwordFile: string | undefined
): VoiceCredentialSource | undefined => {
  if (username === undefined) {
    if (passwordFile !== undefined) {
      throw invalidInput('--sip-password-file requires --sip-username.')
    }
    return
  }
  return {
    ...(passwordFile === undefined
      ? {}
      : {
          passwordFile: validateFilePath(passwordFile, 'SIP password file path')
        }),
    username: boundedText(
      username,
      'SIP username',
      MAXIMUM_SIP_USERNAME_LENGTH,
      'To remove the SIP credentials, pass --clear-sip-credentials.'
    )
  }
}

export const validateVoiceProfileCreate = (input: {
  isDefault: boolean
  mediaEncryption?: 'auto' | 'srtp'
  name?: string
}): ValidatedVoiceProfileCreate => {
  if (input.isDefault) {
    if (input.name !== undefined) {
      throw invalidInput('--name cannot be used with --default.')
    }
    return {
      isDefault: true,
      profile: {
        protocol: 'sip',
        ...(input.mediaEncryption === undefined
          ? {}
          : { mediaEncryption: input.mediaEncryption })
      }
    }
  }
  if (input.name === undefined) {
    throw invalidInput('Pass --name when creating an additional Voice profile.')
  }
  return {
    isDefault: false,
    profile: {
      name: boundedText(
        input.name,
        'Voice profile name',
        MAXIMUM_PROFILE_NAME_LENGTH
      ),
      ...(input.mediaEncryption === undefined
        ? {}
        : { mediaEncryption: input.mediaEncryption }),
      protocol: 'sip'
    }
  }
}

export const validateVoiceProfileChanges = (input: {
  name?: string
  mediaEncryption?: 'auto' | 'srtp'
}): VoiceProfileChanges => {
  if (input.name === undefined && input.mediaEncryption === undefined) {
    throw invalidInput(
      'Pass --name or --media-encryption to edit the Voice profile.'
    )
  }
  return {
    ...(input.name === undefined
      ? {}
      : {
          name: boundedText(
            input.name,
            'Voice profile name',
            MAXIMUM_PROFILE_NAME_LENGTH
          )
        }),
    ...(input.mediaEncryption === undefined
      ? {}
      : { mediaEncryption: input.mediaEncryption })
  }
}

const validateVoiceCredentialChange = (input: {
  clearSipCredentials: boolean
  sipPasswordFile?: string
  sipUsername?: string
}): VoiceCredentialChange | undefined => {
  if (
    input.clearSipCredentials &&
    (input.sipUsername !== undefined || input.sipPasswordFile !== undefined)
  ) {
    throw invalidInput(
      'Pass either replacement SIP credentials or --clear-sip-credentials, not both.'
    )
  }

  const credentialSource = input.clearSipCredentials
    ? undefined
    : validateCredentialSource(input.sipUsername, input.sipPasswordFile)
  if (input.clearSipCredentials) {
    return { action: 'clear' }
  }
  return credentialSource === undefined
    ? undefined
    : { action: 'replace', source: credentialSource }
}

export const validateVoiceProfileInboundSet = (input: {
  clearSipCredentials: boolean
  sipPasswordFile?: string
  sipUri: string
  sipUsername?: string
}): ValidatedVoiceProfileInboundSet => {
  const credentialChange = validateVoiceCredentialChange(input)
  return {
    ...(credentialChange === undefined ? {} : { credentialChange }),
    input: { destinationUri: validateSipDestination(input.sipUri) }
  }
}

export const validateVoiceProfileInboundChanges = (input: {
  clearSipCredentials: boolean
  sipPasswordFile?: string
  sipUri?: string
  sipUsername?: string
}): ValidatedVoiceProfileInboundChanges => {
  const credentialChange = validateVoiceCredentialChange(input)
  if (input.sipUri === undefined && credentialChange === undefined) {
    throw invalidInput(
      'Pass --sip-uri, replacement SIP credentials, or --clear-sip-credentials.'
    )
  }

  return {
    changes:
      input.sipUri === undefined
        ? {}
        : { destinationUri: validateSipDestination(input.sipUri) },
    ...(credentialChange === undefined ? {} : { credentialChange })
  }
}

export const voiceCredentials = (
  source: VoiceCredentialSource | undefined,
  password: string | undefined
): VoiceSipCredentialsInput | undefined => {
  if (source === undefined) {
    return
  }
  if (password === undefined) {
    throw new TypeError('Voice credential password is required.')
  }
  return { password, username: source.username }
}

export const validateVoiceProfileId = (value: string): string =>
  validateId('voiceProfile', value, 'Voice profile ID')

export const validateVoiceProfileReference = (
  value: string
): VoiceProfileReference =>
  value === 'default' ? 'default' : validateVoiceProfileId(value)

export const validateVoiceResourceId = (value: string): string =>
  validateId('resource', value, 'Voice resource ID')

export const validateVoiceAssignmentResources = (
  values: string[] | undefined
): string[] => {
  if (values === undefined || values.length === 0) {
    throw invalidInput('Pass at least one --resource-id.')
  }
  if (values.length > MAXIMUM_VOICE_PROFILE_ASSIGNMENT_BATCH_SIZE) {
    throw invalidInput(
      `At most ${MAXIMUM_VOICE_PROFILE_ASSIGNMENT_BATCH_SIZE.toString()} Voice resource IDs may be changed at once.`
    )
  }
  const resourceIds = values.map(validateVoiceResourceId)
  if (new Set(resourceIds).size !== resourceIds.length) {
    throw invalidInput('Voice resource IDs cannot be repeated.')
  }
  return resourceIds
}
