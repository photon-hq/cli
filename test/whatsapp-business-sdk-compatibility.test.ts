import { Photon } from '@photon-ai/api'
import { describe, expect, test } from 'vitest'
import { BUILD_CONFIG } from '../src/build-config.ts'
import type { ProjectRawScope, ProjectScope } from '../src/project/service.ts'

const acceptAccountListSignature = (
  _method: ProjectScope['platforms']['getWhatsappBusinessAccount']
): void => undefined

const acceptRawReleaseSignature = (
  _method: ProjectRawScope['platforms']['releaseResource']
): void => undefined

const acceptRawWhatsappProvisionSignature = (
  _method: ProjectRawScope['platforms']['createWhatsappVoipSender']
): void => undefined

const acceptWhatsappVerificationSignature = (
  _method: ProjectScope['platforms']['getWhatsappBusinessVerificationCode']
): void => undefined

describe('WhatsApp Business SDK compatibility', () => {
  test('exposes the required WhatsApp account, provisioning, and OTP methods', () => {
    const photon = new Photon({
      baseUrl: BUILD_CONFIG.apiOrigin,
      retry: false
    })

    acceptAccountListSignature(
      photon.projects.platforms.getWhatsappBusinessAccount
    )
    acceptRawReleaseSignature(photon.raw.projects.platforms.releaseResource)
    acceptRawWhatsappProvisionSignature(
      photon.raw.projects.platforms.createWhatsappVoipSender
    )
    acceptWhatsappVerificationSignature(
      photon.projects.platforms.getWhatsappBusinessVerificationCode
    )
    expect(typeof photon.projects.platforms.getWhatsappBusinessAccount).toBe(
      'function'
    )
    expect(typeof photon.raw.projects.platforms.releaseResource).toBe(
      'function'
    )
    expect(typeof photon.raw.projects.platforms.createWhatsappVoipSender).toBe(
      'function'
    )
    expect(
      typeof photon.projects.platforms.getWhatsappBusinessVerificationCode
    ).toBe('function')
  })
})
