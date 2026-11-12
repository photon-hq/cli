import type { CommandRunner } from 'gunshi'
import { presentList, table } from '../../../../core/presenter.ts'
import type { PhotonCommandParams } from '../../../types.ts'

type OauthScopeListParams = PhotonCommandParams

export const runList: CommandRunner<OauthScopeListParams> = async (context) => {
  const { photon } = context.extensions
  const catalog = await photon.oauth.listScopes()
  presentList(photon.output, {
    document: catalog,
    emptyMessage: 'Photon advertises no OAuth scopes.',
    items: catalog.scopes,
    lines: table(
      photon.output,
      ['SCOPE'],
      catalog.scopes.map((scope) => [scope])
    )
  })
}
