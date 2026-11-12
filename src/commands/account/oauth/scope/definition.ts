import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { runs, tested } from '../../../production-test.ts'
import type { PhotonCommandParams } from '../../../types.ts'

type OauthScopeListParams = PhotonCommandParams

const listDefinition = defineWithTypes<OauthScopeListParams>()({
  description: 'List scopes advertised by the OAuth authorization server',
  name: 'list'
})

export const oauthScopeCommand = defineWithTypes<PhotonCommandParams>()({
  description: 'Inspect OAuth scopes advertised by Photon',
  name: 'scope',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<OauthScopeListParams>()(
        async () => (await import('./run.ts')).runList,
        listDefinition
      )
    )
  }
})
