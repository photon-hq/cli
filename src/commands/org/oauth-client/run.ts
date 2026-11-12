import type { CommandRunner } from 'gunshi'
import type { CliOutput } from '../../../core/output.ts'
import { inert, presentList, table } from '../../../core/presenter.ts'
import { createOauthAuthorization } from '../../../oauth/authorization.ts'
import { oauthClientDetails } from '../../../oauth/presenter.ts'
import {
  validateOauthClientCreateInput,
  validateOauthClientUpdateInput,
  validateOauthIdempotencyKey
} from '../../../oauth/validation.ts'
import { resolveOrganizationId } from '../../../organization/command-helpers.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type { PhotonCommandParams } from '../../types.ts'
import type {
  OauthClientAuthorizeParams,
  OauthClientCreateParams,
  OauthClientDeleteParams,
  OauthClientUpdateParams,
  OauthClientViewParams
} from './definition.ts'

type OauthClientListParams = PhotonCommandParams

const authorizationResult = (
  authorization: ReturnType<typeof createOauthAuthorization>,
  opened: boolean
) => ({ authorization: { ...authorization, opened } })

const printAuthorizationUrl = (
  output: CliOutput,
  authorization: ReturnType<typeof createOauthAuthorization>
): void => {
  output.success(
    authorizationResult(authorization, false),
    inert(`Authorization URL: ${authorization.authorizationUrl}`)
  )
}

export const runAuthorize: CommandRunner<OauthClientAuthorizeParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const organizationId = await resolveOrganizationId(photon)
  const [client, server, scopeCatalog] = await Promise.all([
    photon.oauth.getClient(organizationId, clientId),
    photon.oauth.discoverAuthorizationServer(),
    photon.oauth.listScopes()
  ])
  const authorization = createOauthAuthorization({
    client,
    randomBytes: photon.randomBytes,
    ...(context.values.redirectUri === undefined
      ? {}
      : { redirectUri: context.values.redirectUri }),
    ...(context.values.scope === undefined
      ? {}
      : { scopes: context.values.scope }),
    scopesSupported: scopeCatalog.scopes,
    server
  })

  if (context.values.noBrowser ?? false) {
    printAuthorizationUrl(photon.output, authorization)
    return
  }

  try {
    await photon.browser.open(authorization.authorizationUrl)
    photon.output.success(
      authorizationResult(authorization, true),
      photon.output.style(
        'green',
        'Opened OAuth authorization in your browser.'
      )
    )
  } catch {
    photon.output.warning(
      'The browser could not be opened. Open the authorization URL manually.'
    )
    printAuthorizationUrl(photon.output, authorization)
  }
}

export const runList: CommandRunner<OauthClientListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const result = await photon.oauth.listClients(
    await resolveOrganizationId(photon)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No OAuth clients found.',
    items: result.oauthClients,
    lines: table(
      photon.output,
      ['NAME', 'CLIENT ID', 'SCOPES', 'REDIRECTS', 'UPDATED'],
      result.oauthClients.map((client) => [
        client.name,
        { style: 'cyan', text: client.clientId },
        client.scopes.length.toString(),
        client.redirectUris.length.toString(),
        { style: 'dim', text: client.updatedAt }
      ])
    )
  })
}

export const runView: CommandRunner<OauthClientViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const client = await photon.oauth.getClient(
    await resolveOrganizationId(photon),
    clientId
  )
  photon.output.success(client, oauthClientDetails(photon.output, client))
}

export const runCreate: CommandRunner<OauthClientCreateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const input = validateOauthClientCreateInput({
    defaultRedirectUri: context.values.defaultRedirectUri,
    ...(context.values.description === undefined
      ? {}
      : { description: context.values.description }),
    name: context.values.name,
    redirectUris: context.values.redirectUri,
    ...(context.values.scope === undefined
      ? {}
      : { scopes: context.values.scope })
  })
  const client = await photon.oauth.createClient(
    await resolveOrganizationId(photon),
    input,
    validateOauthIdempotencyKey(context.values.idempotencyKey)
  )
  photon.output.success(
    client,
    oauthClientDetails(photon.output, client, 'Created OAuth client')
  )
}

export const runUpdate: CommandRunner<OauthClientUpdateParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const input = validateOauthClientUpdateInput({
    clearDescription: context.values.clearDescription ?? false,
    clearScopes: context.values.clearScopes ?? false,
    ...(context.values.defaultRedirectUri === undefined
      ? {}
      : { defaultRedirectUri: context.values.defaultRedirectUri }),
    ...(context.values.description === undefined
      ? {}
      : { description: context.values.description }),
    ...(context.values.name === undefined ? {} : { name: context.values.name }),
    ...(context.values.redirectUri === undefined
      ? {}
      : { redirectUris: context.values.redirectUri }),
    ...(context.values.scope === undefined
      ? {}
      : { scopes: context.values.scope })
  })
  const client = await photon.oauth.updateClient(
    await resolveOrganizationId(photon),
    clientId,
    input
  )
  photon.output.success(
    client,
    oauthClientDetails(photon.output, client, 'Updated OAuth client')
  )
}

export const runDelete: CommandRunner<OauthClientDeleteParams> = async (
  context
) => {
  const { photon } = context.extensions
  const clientId = context.values['client-id']
  const organizationId = await resolveOrganizationId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `delete OAuth client ${clientId}`,
    consequence: 'Existing authorizations and secrets will stop working.',
    scope: { org: organizationId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const result = await photon.oauth.deleteClient(organizationId, clientId)
  // Only a "deleted" status is complete; otherwise provider cleanup is pending.
  const deleted = result.status === 'deleted'
  if (!deleted) {
    photon.output.warning(
      'Photon accepted the deletion, but provider cleanup is still pending. Existing tokens may keep working until it completes.'
    )
  }
  photon.output.success(
    result,
    photon.output.style(
      'green',
      inert(
        deleted
          ? `Deleted OAuth client ${clientId}.`
          : `Deletion of OAuth client ${clientId} is pending (${result.status}).`
      )
    )
  )
}
