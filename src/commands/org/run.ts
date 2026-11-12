import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../app/services.ts'
import { contextSourceLabel } from '../../app/target-notice.ts'
import { inert, presentList, table } from '../../core/presenter.ts'
import { organizationDetails } from '../../organization/presenter.ts'
import { cancelled, confirmRiskyAction } from '../helpers.ts'
import type { PhotonCommandParams } from '../types.ts'
import type { OrgLeaveParams, OrgUseParams } from './definition.ts'

type OrgListParams = PhotonCommandParams
type OrgShowParams = PhotonCommandParams
type OrgClearParams = PhotonCommandParams

export const runList: CommandRunner<OrgListParams> = async (context) => {
  const { photon } = context.extensions
  const result = await photon.organizations.list()
  const active = await photon.organizationContext.resolveAmong(
    result.organizations.map(({ organizationId }) => organizationId)
  )
  const owned = new Set(result.ownedOrganizationIds)
  presentList(photon.output, {
    document: { ...result, activeOrganizationId: active?.organizationId },
    emptyMessage: 'No organizations found.',
    items: result.organizations,
    lines: table(
      photon.output,
      ['NAME', 'ID', 'OWNER', 'ACTIVE', 'UPDATED'],
      result.organizations.map((organization) => [
        organization.name,
        { style: 'cyan', text: organization.organizationId },
        owned.has(organization.organizationId) ? 'yes' : 'no',
        active?.organizationId === organization.organizationId
          ? { style: 'yellow', text: '*' }
          : '',
        { style: 'dim', text: organization.updatedAt }
      ])
    )
  })
}

// "org use" saves the account's organization, which PHOTON_ORGANIZATION_ID
// and the folder's project outrank.
const warnIfOutranked = async (
  photon: PhotonCommandServices,
  organizationId?: string
): Promise<void> => {
  const outranking = await photon.organizationContext
    .outranking()
    .catch(() => undefined)
  if (
    outranking === undefined ||
    outranking.organizationId === organizationId
  ) {
    return
  }
  photon.output.warning(
    `${contextSourceLabel({ kind: 'organization', ...outranking })} still selects organization ${outranking.organizationId}.`
  )
}

export const runShow: CommandRunner<OrgShowParams> = async (context) => {
  const { photon } = context.extensions
  const selected = await photon.organizationContext.resolve()
  const organization = await photon.organizations.get(selected.organizationId)
  photon.output.success(
    {
      organization,
      source: selected.source,
      ...(selected.source === 'folder' ? { path: selected.path } : {})
    },
    organizationDetails(photon.output, organization, selected)
  )
}

export const runUse: CommandRunner<OrgUseParams> = async (context) => {
  const { photon } = context.extensions
  const organizationId = context.values['organization-id']
  const organization = await photon.organizations.get(organizationId)
  await photon.organizationContext.activate(organization.organizationId)
  await warnIfOutranked(photon, organization.organizationId)
  photon.output.success(
    { organization, source: 'stored' },
    photon.output.style(
      'green',
      inert(
        `Using organization ${organization.name} (${organization.organizationId}).`
      )
    )
  )
}

const leaveIntent = async (
  photon: PhotonCommandServices,
  organizationId: string,
  suppliedIdempotencyKey: string | undefined
) => {
  const continued = await photon.operations.continuationIntent(
    'organization.leave',
    suppliedIdempotencyKey,
    (intent) => intent.organizationId === organizationId
  )
  if (continued !== undefined) {
    return continued
  }
  const { accountId } = await photon.account.get()
  const member = await photon.organizations.getActiveMember(
    organizationId,
    accountId
  )
  return {
    expectedVersion: member.version,
    kind: 'organization.leave' as const,
    organizationId
  }
}

export const runLeave: CommandRunner<OrgLeaveParams> = async (context) => {
  const { photon } = context.extensions
  const { organizationId } = await photon.organizationContext.resolve()
  const confirmed = await confirmRiskyAction(context, {
    action: `leave organization ${organizationId}`,
    consequence: 'You lose access to its projects.',
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const intent = await leaveIntent(
    photon,
    organizationId,
    context.values.idempotencyKey
  )
  const { result: member } = await photon.operations.execute(
    intent,
    context.values.idempotencyKey,
    async ({ idempotencyKey }) =>
      await photon.organizations.leave(
        organizationId,
        intent.expectedVersion,
        idempotencyKey
      )
  )
  try {
    await photon.organizationContext.clearIfActive(organizationId)
  } catch {
    photon.output.warning(
      'You left the organization, but Photon could not clear the stored active organization.'
    )
  }
  photon.output.success(
    member,
    photon.output.style('green', `Left organization ${organizationId}.`)
  )
}

export const runClear: CommandRunner<OrgClearParams> = async (context) => {
  const { photon } = context.extensions
  const cleared = await photon.organizationContext.clear()
  await warnIfOutranked(photon)
  photon.output.success(
    { cleared },
    cleared
      ? 'Cleared the stored organization.'
      : 'No stored organization was selected.'
  )
}
