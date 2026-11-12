import type { CommandRunner } from 'gunshi'
import { presentList, table } from '../../../../core/presenter.ts'
import { validateOauthConnectionListInput } from '../../../../oauth/validation.ts'
import { cancelled, confirmRiskyAction } from '../../../helpers.ts'
import { renamedWarning } from '../../../moved.ts'
import type {
  OauthConnectionListParams,
  OauthConnectionRevokeParams
} from './definition.ts'

export const runList: CommandRunner<OauthConnectionListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const { after: oldPageToken, before } = context.values
  if (oldPageToken !== undefined) {
    photon.output.warning(
      renamedWarning(
        ['account', 'oauth', 'connection', 'list', '--after'],
        ['account', 'oauth', 'connection', 'list', '--page-token']
      )
    )
  }
  const query = validateOauthConnectionListInput({
    before,
    limit: context.values.limit,
    order: context.values.order,
    pageToken: context.values.pageToken ?? oldPageToken
  })
  const result = await photon.oauth.listConnections(query)
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No connected OAuth applications found.',
    items: result.authorizedApplications,
    lines: table(
      photon.output,
      ['APPLICATION ID', 'NAME', 'CLIENT ID', 'GRANTED SCOPES', 'RESOURCE'],
      result.authorizedApplications.map(
        ({ application, grantedScopes, oauthResource }) => [
          { style: 'cyan', text: application.id },
          application.name,
          application.clientId,
          grantedScopes.join(', '),
          oauthResource ?? 'default'
        ]
      )
    ),
    page: {
      command: context,
      inDocument: true,
      token:
        before === undefined
          ? (result.listMetadata.after ?? undefined)
          : undefined
    }
  })
}

export const runRevoke: CommandRunner<OauthConnectionRevokeParams> = async (
  context
) => {
  const { photon } = context.extensions
  const applicationId = context.values['application-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `revoke OAuth connection for ${applicationId}`,
    consequence:
      'The application will lose access until it is authorized again.'
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  await photon.oauth.revokeConnection(applicationId)
  photon.output.success(
    { applicationId, revoked: true },
    photon.output.style('green', `Revoked OAuth connection ${applicationId}.`)
  )
}
