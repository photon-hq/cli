import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../app/services.ts'
import { inert, presentList, table } from '../../../core/presenter.ts'
import { resolveOrganizationId } from '../../../organization/command-helpers.ts'
import type { AssignableOrganizationRole } from '../../../organization/service.ts'
import { validateEmail } from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type {
  OrgMemberEditParams,
  OrgMemberInviteParams,
  OrgMemberListParams,
  OrgMemberRemoveParams
} from './definition.ts'

export const runInvite: CommandRunner<OrgMemberInviteParams> = async (
  context
) => {
  const { photon } = context.extensions
  const organizationId = await resolveOrganizationId(photon)
  const email = validateEmail(context.values.email)
  const { role } = context.values
  const { result } = await photon.operations.execute(
    { email, kind: 'organization-member.invite', organizationId, role },
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.createInvitation(
        organizationId,
        email,
        role,
        idempotencyKey
      )
  )
  photon.output.success(
    result,
    photon.output.style('green', inert(`Invited ${result.email}.`))
  )
}

export const runList: CommandRunner<OrgMemberListParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.organizations.listMembers(
    await resolveOrganizationId(photon)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No organization members found.',
    items: result.members,
    lines: table(
      photon.output,
      ['ACCOUNT ID', 'EMAIL', 'ROLE', 'STATUS', 'UPDATED'],
      result.members.map((member) => [
        { style: 'cyan', text: member.accountId },
        member.account?.email ?? '—',
        member.role,
        member.status,
        { style: 'dim', text: member.updatedAt }
      ])
    )
  })
}

// Membership changes carry the member's current version. A retry with the
// same --idempotency-key reuses the version recorded by the first attempt.
const memberVersion = async (
  photon: PhotonCommandServices,
  organizationId: string,
  accountId: string
): Promise<string> =>
  (await photon.organizations.getActiveMember(organizationId, accountId))
    .version

const editIntent = async (
  photon: PhotonCommandServices,
  organizationId: string,
  accountId: string,
  role: AssignableOrganizationRole,
  suppliedIdempotencyKey: string | undefined
) =>
  (await photon.operations.continuationIntent(
    'organization-member.update',
    suppliedIdempotencyKey,
    (intent) =>
      intent.organizationId === organizationId &&
      intent.accountId === accountId &&
      intent.role === role
  )) ?? {
    accountId,
    expectedVersion: await memberVersion(photon, organizationId, accountId),
    kind: 'organization-member.update' as const,
    organizationId,
    role
  }

const removeIntent = async (
  photon: PhotonCommandServices,
  organizationId: string,
  accountId: string,
  suppliedIdempotencyKey: string | undefined
) =>
  (await photon.operations.continuationIntent(
    'organization-member.remove',
    suppliedIdempotencyKey,
    (intent) =>
      intent.organizationId === organizationId && intent.accountId === accountId
  )) ?? {
    accountId,
    expectedVersion: await memberVersion(photon, organizationId, accountId),
    kind: 'organization-member.remove' as const,
    organizationId
  }

export const runEdit: CommandRunner<OrgMemberEditParams> = async (context) => {
  const { photon } = context.extensions
  const organizationId = await resolveOrganizationId(photon)
  const accountId = context.values['account-id']
  const { role } = context.values
  const intent = await editIntent(
    photon,
    organizationId,
    accountId,
    role,
    context.values.idempotencyKey
  )
  const { result: member } = await photon.operations.execute(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.updateMemberRole(
        organizationId,
        accountId,
        role,
        intent.expectedVersion,
        idempotencyKey
      )
  )
  photon.output.success(
    member,
    photon.output.style(
      'green',
      inert(`Updated ${member.accountId} to ${member.role}.`)
    )
  )
}

export const runRemove: CommandRunner<OrgMemberRemoveParams> = async (
  context
) => {
  const { photon } = context.extensions
  const organizationId = await resolveOrganizationId(photon)
  const accountId = context.values['account-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `remove account ${accountId} from organization ${organizationId}`,
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const intent = await removeIntent(
    photon,
    organizationId,
    accountId,
    context.values.idempotencyKey
  )
  const { result: member } = await photon.operations.execute(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.removeMember(
        organizationId,
        accountId,
        intent.expectedVersion,
        idempotencyKey
      )
  )
  photon.output.success(
    member,
    photon.output.style('green', `Removed organization member ${accountId}.`)
  )
}
