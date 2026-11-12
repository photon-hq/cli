import type { CommandRunner } from 'gunshi'
import { detail, inert, presentList, table } from '../../../core/presenter.ts'
import { secretFingerprint } from '../../../operation/types.ts'
import { resolveOrganizationId } from '../../../organization/command-helpers.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type {
  OrgInvitationAcceptParams,
  OrgInvitationListParams,
  OrgInvitationPreviewParams,
  OrgInvitationRevokeParams
} from './definition.ts'

export const runList: CommandRunner<OrgInvitationListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const result = await photon.organizations.listInvitations(
    await resolveOrganizationId(photon)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No organization invitations found.',
    items: result.invitations,
    lines: table(
      photon.output,
      ['EMAIL', 'ROLE', 'STATUS', 'INVITATION ID', 'EXPIRES'],
      result.invitations.map((invitation) => [
        invitation.email,
        invitation.role,
        invitation.status,
        { style: 'cyan', text: invitation.invitationId },
        { style: 'dim', text: invitation.expiresAt }
      ])
    )
  })
}

export const runPreview: CommandRunner<OrgInvitationPreviewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const token = await photon.input.readToken(context.values.tokenFile)
  const invitation = await photon.organizations.previewInvitation(token)
  photon.output.success(
    invitation,
    detail(photon.output, 'Invitation', [
      { label: 'Organization', value: invitation.organizationName },
      { label: 'Role', value: invitation.role },
      { label: 'Email', value: invitation.maskedEmail },
      { label: 'Email matches', value: invitation.emailMatches },
      { label: 'Invited by', value: invitation.inviter?.name ?? null },
      { label: 'SSO required', value: invitation.ssoRequired },
      { label: 'Expires', value: invitation.expiresAt }
    ])
  )
}

export const runAccept: CommandRunner<OrgInvitationAcceptParams> = async (
  context
) => {
  const { photon } = context.extensions
  const token = await photon.input.readToken(context.values.tokenFile)
  const { result: invitation } = await photon.operations.execute(
    {
      kind: 'organization-invitation.accept',
      token,
      tokenDigest: secretFingerprint('invitation-token', token)
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.acceptInvitation(token, idempotencyKey)
  )
  photon.output.success(
    invitation,
    photon.output.style(
      'green',
      inert(
        `Accepted invitation to organization ${invitation.organizationName} (${invitation.organizationId}).`
      )
    )
  )
}

export const runRevoke: CommandRunner<OrgInvitationRevokeParams> = async (
  context
) => {
  const { photon } = context.extensions
  const organizationId = await resolveOrganizationId(photon)
  const invitationId = context.values['invitation-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke invitation ${invitationId} from organization ${organizationId}`,
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const { result: invitation } = await photon.operations.execute(
    {
      invitationId,
      kind: 'organization-invitation.revoke',
      organizationId
    },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.revokeInvitation(
        organizationId,
        invitationId,
        idempotencyKey
      )
  )
  photon.output.success(
    invitation,
    photon.output.style('green', `Revoked invitation ${invitationId}.`)
  )
}
