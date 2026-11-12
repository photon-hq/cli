import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../args.ts'
import { beta } from '../beta.ts'
import { runs, skip, tested } from '../production-test.ts'
import type { PhotonCommandParams } from '../types.ts'
import { orgBillingCommand } from './billing/definition.ts'
import { orgInvitationCommand } from './invitation/definition.ts'
import { orgMemberCommand } from './member/definition.ts'
import { oauthClientCommand } from './oauth-client/definition.ts'

type OrgParams = PhotonCommandParams
type OrgListParams = PhotonCommandParams
type OrgShowParams = PhotonCommandParams
type OrgClearParams = PhotonCommandParams

const useArgs = {
  'organization-id': {
    description: 'Organization ID to make active',
    parse: idArgument('organization', 'Organization ID'),
    type: 'positional'
  }
} as const
const leaveArgs = {
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const

export type OrgUseParams = PhotonCommandParams<typeof useArgs>
export type OrgLeaveParams = PhotonCommandParams<typeof leaveArgs>

const listDefinition = defineWithTypes<OrgListParams>()({
  description: 'List your organizations',
  name: 'list'
})
const useDefinition = defineWithTypes<OrgUseParams>()({
  args: useArgs,
  description: 'Validate and store an active organization',
  name: 'use'
})
const showDefinition = defineWithTypes<OrgShowParams>()({
  description: 'Show the current organization and how it was selected',
  name: 'show'
})
const clearDefinition = defineWithTypes<OrgClearParams>()({
  description: 'Clear the stored active organization',
  name: 'clear'
})
const leaveDefinition = defineWithTypes<OrgLeaveParams>()({
  args: leaveArgs,
  description: 'Leave the current organization',
  name: 'leave',
  toKebab: true
})

export const orgCommand = defineWithTypes<OrgParams>()({
  description: 'Manage Photon organizations',
  name: 'org',
  subCommands: {
    billing: orgBillingCommand,
    clear: tested(
      runs,
      lazyWithTypes<OrgClearParams>()(
        async () => (await import('./run.ts')).runClear,
        clearDefinition
      )
    ),
    invitation: orgInvitationCommand,
    leave: tested(
      skip(
        'removes the test account from the test organization, which only another member can undo'
      ),
      beta(
        lazyWithTypes<OrgLeaveParams>()(
          async () => (await import('./run.ts')).runLeave,
          leaveDefinition
        )
      )
    ),
    list: tested(
      runs,
      beta(
        lazyWithTypes<OrgListParams>()(
          async () => (await import('./run.ts')).runList,
          listDefinition
        )
      )
    ),
    member: orgMemberCommand,
    'oauth-client': oauthClientCommand,
    show: tested(
      runs,
      beta(
        lazyWithTypes<OrgShowParams>()(
          async () => (await import('./run.ts')).runShow,
          showDefinition
        )
      )
    ),
    use: tested(
      runs,
      beta(
        lazyWithTypes<OrgUseParams>()(
          async () => (await import('./run.ts')).runUse,
          useDefinition
        )
      )
    )
  },
  toKebab: true
})
