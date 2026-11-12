import { describe, expect, test } from 'vitest'
import {
  validateVoiceAssignmentResources,
  validateVoiceProfileChanges,
  validateVoiceProfileCreate,
  validateVoiceProfileId,
  validateVoiceProfileInboundChanges,
  validateVoiceProfileInboundSet,
  validateVoiceProfileOutboundDigestAlgorithm,
  validateVoiceProfileReference
} from '../src/project/voice-validation.ts'

const profileId = 'pho_vpf_01h455vb4pex5vsknk084sn02q'
const resourceId = 'pho_res_01h455vb4pex5vsknk084sn02q'

describe('Voice CLI validation', () => {
  test('defaults outbound digest authentication safely and rejects internal values', () => {
    expect(validateVoiceProfileOutboundDigestAlgorithm(undefined)).toBe(
      'sha-256'
    )
    expect(validateVoiceProfileOutboundDigestAlgorithm('sha-256')).toBe(
      'sha-256'
    )
    expect(validateVoiceProfileOutboundDigestAlgorithm('md5')).toBe('md5')
    expect(() =>
      validateVoiceProfileOutboundDigestAlgorithm('unspecified')
    ).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining(
          '--digest-algorithm must be sha-256 or md5'
        )
      })
    )
  })

  test('creates the default without client-owned metadata', () => {
    expect(validateVoiceProfileCreate({ isDefault: true })).toEqual({
      isDefault: true,
      profile: { protocol: 'sip' }
    })
    expect(() =>
      validateVoiceProfileCreate({ isDefault: true, name: 'Default agent' })
    ).toThrow(
      expect.objectContaining({
        detail: '--name cannot be used with --default.'
      })
    )
  })

  test('supports creating an unconfigured additional profile', () => {
    expect(
      validateVoiceProfileCreate({
        isDefault: false,
        name: 'Reserved agent'
      })
    ).toEqual({
      isDefault: false,
      profile: { name: 'Reserved agent', protocol: 'sip' }
    })
    expect(() => validateVoiceProfileCreate({ isDefault: false })).toThrow(
      expect.objectContaining({
        detail: 'Pass --name when creating an additional Voice profile.'
      })
    )
  })

  test('requires SIP username and password source to be supplied safely', () => {
    expect(() =>
      validateVoiceProfileInboundSet({
        clearSipCredentials: false,
        sipPasswordFile: './secret',
        sipUri: 'sip:agent@customer.example'
      })
    ).toThrow(
      expect.objectContaining({
        detail: '--sip-password-file requires --sip-username.'
      })
    )

    expect(
      validateVoiceProfileInboundSet({
        clearSipCredentials: false,
        sipPasswordFile: './secret',
        sipUri: 'sip:agent@customer.example',
        sipUsername: ' alice '
      }).credentialChange
    ).toEqual({
      action: 'replace',
      source: { passwordFile: './secret', username: 'alice' }
    })
  })

  test('keeps profile metadata separate from inbound changes', () => {
    expect(
      validateVoiceProfileChanges({
        name: 'Renamed'
      })
    ).toEqual({ name: 'Renamed' })
    expect(
      validateVoiceProfileInboundSet({
        clearSipCredentials: true,
        sipUri: 'sips:agent@customer.example:5061'
      })
    ).toEqual({
      credentialChange: { action: 'clear' },
      input: {
        destinationUri: 'sips:agent@customer.example:5061'
      }
    })
  })

  test('validates write-only inbound credential tri-state changes', () => {
    expect(
      validateVoiceProfileInboundChanges({
        clearSipCredentials: true
      })
    ).toEqual({
      changes: {},
      credentialChange: { action: 'clear' }
    })
    expect(
      validateVoiceProfileInboundChanges({
        clearSipCredentials: false,
        sipPasswordFile: './secret',
        sipUsername: ' alice '
      })
    ).toEqual({
      changes: {},
      credentialChange: {
        action: 'replace',
        source: { passwordFile: './secret', username: 'alice' }
      }
    })
  })

  test('rejects empty metadata or inbound edits and conflicting credentials', () => {
    expect(() => validateVoiceProfileChanges({})).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining('Pass --name')
      })
    )
    expect(() =>
      validateVoiceProfileInboundChanges({
        clearSipCredentials: true,
        sipUsername: 'alice'
      })
    ).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining('either replacement SIP credentials')
      })
    )
    expect(() =>
      validateVoiceProfileInboundChanges({ clearSipCredentials: false })
    ).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining('Pass --sip-uri')
      })
    )
  })

  test('validates canonical IDs, uniqueness, and the 100-line batch limit', () => {
    expect(validateVoiceProfileId(profileId)).toBe(profileId)
    expect(validateVoiceProfileReference('default')).toBe('default')
    expect(validateVoiceProfileReference(profileId)).toBe(profileId)
    expect(validateVoiceAssignmentResources([resourceId])).toEqual([resourceId])
    expect(() =>
      validateVoiceAssignmentResources([resourceId, resourceId])
    ).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining('cannot be repeated')
      })
    )
    expect(() =>
      validateVoiceAssignmentResources(
        Array.from(
          { length: 101 },
          (_, index) =>
            `pho_res_01h455vb4pex5vsknk084${index.toString().padStart(5, '0')}`
        )
      )
    ).toThrow(
      expect.objectContaining({
        detail: expect.stringContaining('At most 100')
      })
    )
  })
})
