import { describe, expect, test, vi } from 'vitest'
import type { OperationIntent } from '../src/operation/types.ts'
import {
  validateApiKeyPermissions,
  validateProjectSlug,
  validateSmsPurchaseInput
} from '../src/project/api-contract.ts'
import { expectReplayRefused } from './operation-replay-support.ts'
import { asOrganizationScope } from './project-test-support.ts'

describe('current API contract migration', () => {
  test('requires an explicit, nonempty permission set and canonicalizes its order', () => {
    for (const input of [
      undefined,
      [],
      ['admin'],
      ['project:read', 'project:read']
    ]) {
      expect(() => validateApiKeyPermissions(input)).toThrow()
    }
    expect(validateApiKeyPermissions(['project:write', 'events:read'])).toEqual(
      ['events:read', 'project:write']
    )
  })

  test('validates project slugs and the supported SMS country and area codes', () => {
    expect(validateProjectSlug('support-123')).toBe('support-123')
    for (const slug of [
      'ab',
      'Support',
      'support--line',
      '-support',
      'x'.repeat(64)
    ]) {
      expect(() => validateProjectSlug(slug)).toThrow()
    }
    expect(
      validateSmsPurchaseInput({ areaCode: '415', countryCode: 'US' })
    ).toEqual({ areaCode: '415', countryCode: 'US' })
    for (const input of [
      { countryCode: 'CA' },
      { areaCode: '123', countryCode: 'US' },
      { areaCode: '41', countryCode: 'US' }
    ]) {
      expect(() => validateSmsPurchaseInput(input)).toThrow()
    }
  })

  const legacyIntents: OperationIntent[] = [
    { activate: false, kind: 'project.create', name: 'Legacy project' },
    {
      activate: false,
      kind: 'project.create',
      name: 'Project before organizations',
      slug: 'legacy-project'
    },
    {
      email: 'member@example.test',
      kind: 'member.invite',
      projectId: 'pho_prj_00000000000000000000000001',
      role: 'member'
    },
    { kind: 'project.leave', projectId: 'pho_prj_00000000000000000000000001' },
    {
      invitationId: 'pho_oinv_00000000000000000000000001',
      kind: 'invitation.revoke',
      projectId: 'pho_prj_00000000000000000000000001'
    },
    {
      kind: 'api-key.create',
      name: 'Legacy key',
      projectId: 'pho_prj_00000000000000000000000001'
    },
    {
      kind: 'sms-number.purchase',
      projectId: 'pho_prj_00000000000000000000000001'
    }
  ]

  const replayCases = legacyIntents.map((intent) => ({
    detail: undefined,
    intent
  }))

  test.each(replayCases)(
    'preserves $intent.kind records and blocks replay before any mutation',
    async ({ detail, intent }) => {
      const mutation = vi.fn()
      await expectReplayRefused({
        detail,
        intent,
        mutation,
        organizationScope: asOrganizationScope({
          createOrganizationInvitation: mutation,
          leaveOrganization: mutation,
          projects: { create: mutation },
          revokeOrganizationInvitation: mutation
        })
      })
    }
  )
})
