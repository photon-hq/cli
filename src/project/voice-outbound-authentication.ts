import type { PhotonNamespaces } from '@photon-ai/api'
import type { KnownEnumValue } from '../core/validation.ts'

type ConfigureVoiceProfileOutboundBody = Parameters<
  PhotonNamespaces['projects']['platforms']['configureVoiceProfileOutbound']
>[0]['body']

export type VoiceProfileOutboundDigestAlgorithm = KnownEnumValue<
  ConfigureVoiceProfileOutboundBody['authentication']['algorithm']
>

export const VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHMS = [
  'sha-256',
  'md5'
] as const satisfies readonly VoiceProfileOutboundDigestAlgorithm[]

const DIGEST_ALGORITHM_CONTRACT = {
  md5: true,
  'sha-256': true
} as const satisfies Record<VoiceProfileOutboundDigestAlgorithm, true>

export const DEFAULT_VOICE_PROFILE_OUTBOUND_DIGEST_ALGORITHM =
  'sha-256' satisfies VoiceProfileOutboundDigestAlgorithm

export const isVoiceProfileOutboundDigestAlgorithm = (
  value: string
): value is VoiceProfileOutboundDigestAlgorithm =>
  Object.hasOwn(DIGEST_ALGORITHM_CONTRACT, value)
