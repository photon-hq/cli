import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { beta } from '../../beta.ts'
import { runs, skip, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

type MemberParams = PhotonCommandParams
export type OrgMemberListParams = PhotonCommandParams

const inviteArgs = {
  email: {
    description: 'Email address to invite',
    required: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  role: {
    choices: ['member', 'viewer'],
    description: 'Organization role for the invited member',
    required: true,
    type: 'enum'
  }
} as const
const editArgs = {
  'account-id': {
    description: 'Account ID of the member to edit',
    parse: idArgument('account', 'Account ID'),
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg,
  role: {
    choices: ['admin', 'member', 'viewer'],
    description: 'New organization role',
    required: true,
    type: 'enum'
  }
} as const
const removeArgs = {
  'account-id': {
    description: 'Account ID of the member to remove',
    parse: idArgument('account', 'Account ID'),
    type: 'positional'
  },
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const

export type OrgMemberInviteParams = PhotonCommandParams<typeof inviteArgs>
export type OrgMemberEditParams = PhotonCommandParams<typeof editArgs>
export type OrgMemberRemoveParams = PhotonCommandParams<typeof removeArgs>

const listDefinition = defineWithTypes<OrgMemberListParams>()({
  description: 'List organization members',
  name: 'list'
})
const inviteDefinition = defineWithTypes<OrgMemberInviteParams>()({
  args: inviteArgs,
  description: 'Invite a member to the current organization',
  name: 'invite'
})
const editDefinition = defineWithTypes<OrgMemberEditParams>()({
  args: editArgs,
  description: 'Change an organization member role',
  name: 'edit'
})
const removeDefinition = defineWithTypes<OrgMemberRemoveParams>()({
  args: removeArgs,
  description: 'Remove an organization member',
  name: 'remove'
})

export const orgMemberCommand = defineWithTypes<MemberParams>()({
  description: 'Manage organization members',
  name: 'member',
  subCommands: {
    edit: tested(
      skip('needs a second member in the test organization'),
      beta(
        lazyWithTypes<OrgMemberEditParams>()(
          async () => (await import('./run.ts')).runEdit,
          editDefinition
        )
      )
    ),
    invite: tested(
      skip('emails the person invited, so it needs an address a person reads'),
      beta(
        lazyWithTypes<OrgMemberInviteParams>()(
          async () => (await import('./run.ts')).runInvite,
          inviteDefinition
        )
      )
    ),
    list: tested(
      runs,
      beta(
        lazyWithTypes<OrgMemberListParams>()(
          async () => (await import('./run.ts')).runList,
          listDefinition
        )
      )
    ),
    remove: tested(
      skip('needs a second member in the test organization'),
      beta(
        lazyWithTypes<OrgMemberRemoveParams>()(
          async () => (await import('./run.ts')).runRemove,
          removeDefinition
        )
      )
    )
  }
})
