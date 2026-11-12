import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, tokenFileArg, yesArg } from '../../args.ts'
import { beta } from '../../beta.ts'
import { runs, skip, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

type InvitationParams = PhotonCommandParams
export type OrgInvitationListParams = PhotonCommandParams

const previewArgs = { tokenFile: tokenFileArg } as const
const acceptArgs = {
  idempotencyKey: idempotencyKeyArg,
  tokenFile: tokenFileArg
} as const
const revokeArgs = {
  idempotencyKey: idempotencyKeyArg,
  'invitation-id': {
    description: 'Invitation ID to revoke',
    parse: idArgument('invitation', 'Invitation ID'),
    type: 'positional'
  },
  yes: yesArg
} as const

export type OrgInvitationPreviewParams = PhotonCommandParams<typeof previewArgs>
export type OrgInvitationAcceptParams = PhotonCommandParams<typeof acceptArgs>
export type OrgInvitationRevokeParams = PhotonCommandParams<typeof revokeArgs>

const listDefinition = defineWithTypes<OrgInvitationListParams>()({
  description: 'List organization invitations',
  name: 'list'
})
const previewDefinition = defineWithTypes<OrgInvitationPreviewParams>()({
  args: previewArgs,
  description: 'Preview an invitation token from a file, or from stdin with -',
  name: 'preview',
  toKebab: true
})
const acceptDefinition = defineWithTypes<OrgInvitationAcceptParams>()({
  args: acceptArgs,
  description: 'Accept an invitation token from a file, or from stdin with -',
  name: 'accept',
  toKebab: true
})
const revokeDefinition = defineWithTypes<OrgInvitationRevokeParams>()({
  args: revokeArgs,
  description: 'Revoke an organization invitation',
  name: 'revoke'
})

export const orgInvitationCommand = defineWithTypes<InvitationParams>()({
  description: 'Manage organization invitations',
  name: 'invitation',
  subCommands: {
    accept: tested(
      skip('needs an invitation token, which is emailed to the person invited'),
      beta(
        lazyWithTypes<OrgInvitationAcceptParams>()(
          async () => (await import('./run.ts')).runAccept,
          acceptDefinition
        )
      )
    ),
    list: tested(
      runs,
      beta(
        lazyWithTypes<OrgInvitationListParams>()(
          async () => (await import('./run.ts')).runList,
          listDefinition
        )
      )
    ),
    preview: tested(
      skip('needs an invitation token, which is emailed to the person invited'),
      beta(
        lazyWithTypes<OrgInvitationPreviewParams>()(
          async () => (await import('./run.ts')).runPreview,
          previewDefinition
        )
      )
    ),
    revoke: tested(
      skip('needs an invitation, and making one emails the person invited'),
      beta(
        lazyWithTypes<OrgInvitationRevokeParams>()(
          async () => (await import('./run.ts')).runRevoke,
          revokeDefinition
        )
      )
    )
  }
})
