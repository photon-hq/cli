import {
  type AcceptOrganizationInvitationOutput,
  AcceptOrganizationInvitationOutputSchema,
  type CreateOrganizationInvitationOutput,
  CreateOrganizationInvitationOutputSchema,
  type CreateOrganizationPaymentMethodCheckoutOutput,
  CreateOrganizationPaymentMethodCheckoutOutputSchema,
  type GetAccountOutput,
  type GetOrganizationOutput,
  GetOrganizationOutputSchema,
  type GetOrganizationPaymentMethodOutput,
  GetOrganizationPaymentMethodOutputSchema,
  type LeaveOrganizationOutput,
  LeaveOrganizationOutputSchema,
  type ListOrganizationInvitationsOutput,
  ListOrganizationInvitationsOutputSchema,
  type ListOrganizationMembersOutput,
  ListOrganizationMembersOutputSchema,
  type ListOrganizationsOutput,
  ListOrganizationsOutputSchema,
  type PreviewOrganizationInvitationOutput,
  PreviewOrganizationInvitationOutputSchema,
  type RemoveOrganizationMemberOutput,
  RemoveOrganizationMemberOutputSchema,
  type RevokeOrganizationInvitationOutput,
  RevokeOrganizationInvitationOutputSchema,
  type UpdateOrganizationMemberRoleOutput,
  UpdateOrganizationMemberRoleOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import {
  CWD,
  type Declared,
  type GoldenCase,
  printsResponse,
  withNewField
} from './support.ts'

const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const ORGANIZATION = ['--org', ORGANIZATION_ID]
const ORGANIZATION_PATH = `/v1/organizations/${ORGANIZATION_ID}`
const MEMBERS = `${ORGANIZATION_PATH}/members`
const INVITATIONS = `${ORGANIZATION_PATH}/invitations`
const ACCOUNT_ID = 'pho_acc_00000000000000000000000002'
const MEMBER_ID = 'pho_acc_00000000000000000000000003'
const INVITATION_ID = 'pho_oinv_00000000000000000000000001'
const INVITATION_TOKEN = 'golden-invitation-token'
const TOKEN_FILE = ['--token-file', `${CWD}/invitation-token`]
const TOKEN_FILES = {
  'invitation-token': new TextEncoder().encode(`${INVITATION_TOKEN}\n`)
}
const createdAt = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'

const organization = {
  avatarUrl: 'https://images.example.test/organizations/acme.png',
  billingInitialization: 'completed',
  createdAt,
  name: 'Acme',
  organizationId: ORGANIZATION_ID,
  updatedAt,
  version: 'organization-version-7'
} satisfies Declared<GetOrganizationOutput>

const viewedOrganization = withNewField(organization)

const organizations = {
  acquisitionQuestionnaireExempt: false,
  organizations: [
    withNewField(organization),
    {
      ...organization,
      avatarUrl: null,
      name: 'Globex',
      organizationId: 'pho_org_00000000000000000000000002'
    }
  ],
  ownedOrganizationIds: [ORGANIZATION_ID]
} satisfies Declared<ListOrganizationsOutput>

const listedOrganizations = withNewField(organizations)

const member = {
  accountId: MEMBER_ID,
  createdAt,
  joinedVia: 'invitation',
  organizationId: ORGANIZATION_ID,
  removedAt: null,
  role: 'member',
  roleManagedAt: null,
  status: 'active',
  updatedAt,
  version: 'member-version-3'
} satisfies Declared<UpdateOrganizationMemberRoleOutput>

const caller = {
  ...member,
  accountId: ACCOUNT_ID,
  joinedVia: 'creation',
  role: 'admin',
  version: 'member-version-2'
} satisfies Declared<LeaveOrganizationOutput>

const members = {
  members: [
    withNewField({
      ...caller,
      account: withNewField({
        displayName: 'Ada Lovelace',
        email: 'ada@example.test',
        firstName: 'Ada',
        lastName: 'Lovelace',
        pictureUrl: 'https://images.example.test/accounts/ada.png'
      })
    }),
    { ...member, account: null }
  ]
} satisfies Declared<ListOrganizationMembersOutput>

const account = {
  accountId: ACCOUNT_ID,
  createdAt,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/accounts/ada.png',
  updatedAt
} satisfies Declared<GetAccountOutput>

const editedMember = withNewField({
  ...member,
  role: 'admin',
  version: 'member-version-4'
}) satisfies Declared<UpdateOrganizationMemberRoleOutput>

const removedMember = withNewField({
  ...member,
  removedAt: updatedAt,
  status: 'removed',
  version: 'member-version-4'
}) satisfies Declared<RemoveOrganizationMemberOutput>

const leftMember = withNewField({
  ...caller,
  removedAt: updatedAt,
  status: 'removed',
  version: 'member-version-5'
}) satisfies Declared<LeaveOrganizationOutput>

const invitation = {
  acceptedAt: null,
  acceptedByAccountId: null,
  allProjects: true,
  createdAt,
  email: 'grace@example.test',
  expiresAt: '2026-08-07T18:00:00.000Z',
  invitationId: INVITATION_ID,
  invitedByAccountId: ACCOUNT_ID,
  organizationId: ORGANIZATION_ID,
  role: 'member',
  status: 'pending',
  updatedAt
} satisfies Declared<CreateOrganizationInvitationOutput>

const invitations = {
  invitations: [
    withNewField(invitation),
    {
      ...invitation,
      email: 'linus@example.test',
      invitationId: 'pho_oinv_00000000000000000000000002',
      role: 'viewer'
    }
  ]
} satisfies Declared<ListOrganizationInvitationsOutput>

const revokedInvitation = withNewField({
  ...invitation,
  status: 'revoked',
  updatedAt: '2026-08-02T18:00:00.000Z'
}) satisfies Declared<RevokeOrganizationInvitationOutput>

const preview = {
  allProjects: true,
  emailMatches: true,
  expiresAt: invitation.expiresAt,
  inviter: withNewField({
    accountId: ACCOUNT_ID,
    avatarUrl: 'https://images.example.test/accounts/ada.png',
    maskedEmail: 'a***@example.test',
    name: 'Ada Lovelace'
  }),
  maskedEmail: 'g***@example.test',
  memberCount: 2,
  organizationAvatarUrl: organization.avatarUrl,
  organizationId: ORGANIZATION_ID,
  organizationName: organization.name,
  role: 'member',
  ssoRequired: false,
  status: 'pending'
} satisfies Declared<PreviewOrganizationInvitationOutput>

const acceptance = {
  allProjects: true,
  organizationId: ORGANIZATION_ID,
  organizationName: organization.name,
  role: 'member',
  status: 'accepted'
} satisfies Declared<AcceptOrganizationInvitationOutput>

const paymentStatus = {
  cardOnFile: true,
  paymentMethod: withNewField({
    brand: 'visa',
    expiresMonth: 12,
    expiresYear: 2028,
    last4: '4242'
  })
} satisfies Declared<GetOrganizationPaymentMethodOutput>

const checkout = withNewField({
  checkoutUrl: 'https://checkout.example.test/session_golden'
}) satisfies Declared<CreateOrganizationPaymentMethodCheckoutOutput>

// What org list prints: the API's response, with the organization the CLI
// would use beside its fields when it can tell which.
const OrganizationListSchema = ListOrganizationsOutputSchema.extend({
  activeOrganizationId: z.string().optional()
})

// What org show prints: the organization the API returns, and where the CLI
// found it.
const SelectedOrganizationSchema = z.strictObject({
  organization: GetOrganizationOutputSchema,
  path: z.string().optional(),
  source: z.enum(['default', 'environment', 'flag', 'folder', 'stored'])
})

// What org use prints: the organization the API returns, which the CLI saves
// as the selection. The CLI saves only a canonical organization ID.
const UsedOrganizationSchema = z.strictObject({
  organization: GetOrganizationOutputSchema.extend({
    organizationId: z.string().regex(ID_FORMATS.organization.pattern)
  }),
  source: z.literal('stored')
})

// What org clear prints. It makes no API call.
const ClearedOrganizationSchema = z.strictObject({ cleared: z.boolean() })

// The API's response. Before it prints one with a card on file, the CLI checks
// the brand and the last four digits text output shows, as this schema does.
const PaymentStatusSchema = GetOrganizationPaymentMethodOutputSchema.extend({
  paymentMethod: GetOrganizationPaymentMethodOutputSchema.shape.paymentMethod
    .unwrap()
    .extend({
      brand: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,31}$/iu),
      last4: z.string().regex(/^\d{4}$/u)
    })
    .nullable()
})

// What payment-method setup prints: the checkout the API returns, whose URL
// the CLI checks before it opens or prints it, and whether the browser opened.
const CheckoutSchema = z.strictObject({
  checkout: CreateOrganizationPaymentMethodCheckoutOutputSchema.extend({
    checkoutUrl: z.url({ protocol: /^https$/u }).refine((value) => {
      const url = new URL(value)
      return url.username === '' && url.password === ''
    })
  }),
  opened: z.boolean()
})

/** Golden tests for the organization, member, invitation and billing commands. */
export const ORG_GOLDENS: readonly GoldenCase[] = [
  {
    adds: ['activeOrganizationId'],
    args: ORGANIZATION,
    command: 'org list',
    document: { ...listedOrganizations, activeOrganizationId: ORGANIZATION_ID },
    routes: [
      { body: listedOrganizations, method: 'GET', path: '/v1/organizations' }
    ],
    schema: OrganizationListSchema,
    shows: 'Globex'
  },
  {
    args: ORGANIZATION,
    command: 'org show',
    document: { organization: viewedOrganization, source: 'flag' },
    embeds: 'organization',
    routes: [
      { body: viewedOrganization, method: 'GET', path: ORGANIZATION_PATH }
    ],
    schema: SelectedOrganizationSchema,
    shows: '--org flag'
  },
  {
    args: [ORGANIZATION_ID],
    command: 'org use',
    document: { organization: viewedOrganization, source: 'stored' },
    embeds: 'organization',
    routes: [
      { body: viewedOrganization, method: 'GET', path: ORGANIZATION_PATH }
    ],
    schema: UsedOrganizationSchema,
    shows: `Using organization ${organization.name} (${ORGANIZATION_ID}).`
  },
  {
    args: [],
    command: 'org clear',
    document: { cleared: false },
    routes: [],
    schema: ClearedOrganizationSchema,
    shows: 'No stored organization was selected.',
    showsNoApiText: true
  },
  {
    args: [...ORGANIZATION, '--yes', '--idempotency-key', 'golden-org-leave'],
    command: 'org leave',
    document: leftMember,
    routes: [
      {
        body: withNewField(account),
        method: 'GET',
        path: '/v1/account',
        unshown: true
      },
      {
        body: withNewField(members),
        method: 'GET',
        path: MEMBERS,
        unshown: true
      },
      {
        body: leftMember,
        method: 'POST',
        path: `${ORGANIZATION_PATH}/leave`,
        requestBody: { expectedVersion: caller.version }
      }
    ],
    schema: LeaveOrganizationOutputSchema,
    shows: `Left organization ${ORGANIZATION_ID}.`,
    showsNoApiText: true
  },
  printsResponse({
    args: [
      '--email',
      invitation.email,
      '--role',
      invitation.role,
      ...ORGANIZATION,
      '--idempotency-key',
      'golden-member-invite'
    ],
    command: 'org member invite',
    route: {
      body: withNewField(invitation),
      method: 'POST',
      path: INVITATIONS,
      requestBody: { email: invitation.email, role: invitation.role },
      status: 201
    },
    schema: CreateOrganizationInvitationOutputSchema,
    shows: `Invited ${invitation.email}.`
  }),
  printsResponse({
    args: ORGANIZATION,
    command: 'org member list',
    route: { body: withNewField(members), method: 'GET', path: MEMBERS },
    schema: ListOrganizationMembersOutputSchema,
    shows: 'ada@example.test'
  }),
  {
    args: [
      MEMBER_ID,
      '--role',
      editedMember.role,
      ...ORGANIZATION,
      '--idempotency-key',
      'golden-member-edit'
    ],
    command: 'org member edit',
    document: editedMember,
    routes: [
      { body: withNewField(members), method: 'GET', path: MEMBERS },
      {
        body: editedMember,
        method: 'PATCH',
        path: `${MEMBERS}/${MEMBER_ID}`,
        requestBody: {
          expectedVersion: member.version,
          role: editedMember.role
        }
      }
    ],
    schema: UpdateOrganizationMemberRoleOutputSchema,
    shows: `Updated ${MEMBER_ID} to ${editedMember.role}.`
  },
  {
    args: [
      MEMBER_ID,
      ...ORGANIZATION,
      '--yes',
      '--idempotency-key',
      'golden-member-remove'
    ],
    command: 'org member remove',
    document: removedMember,
    routes: [
      {
        body: withNewField(members),
        method: 'GET',
        path: MEMBERS,
        unshown: true
      },
      {
        body: removedMember,
        method: 'DELETE',
        path: `${MEMBERS}/${MEMBER_ID}`,
        requestBody: { expectedVersion: member.version }
      }
    ],
    schema: RemoveOrganizationMemberOutputSchema,
    shows: `Removed organization member ${MEMBER_ID}.`,
    showsNoApiText: true
  },
  printsResponse({
    args: [...TOKEN_FILE, '--idempotency-key', 'golden-invitation-accept'],
    command: 'org invitation accept',
    files: TOKEN_FILES,
    route: {
      body: withNewField(acceptance),
      method: 'POST',
      path: '/v1/organizations/invitations/accept',
      requestBody: { token: INVITATION_TOKEN }
    },
    schema: AcceptOrganizationInvitationOutputSchema,
    shows: `Accepted invitation to organization ${organization.name} (${ORGANIZATION_ID}).`
  }),
  printsResponse({
    args: ORGANIZATION,
    command: 'org invitation list',
    route: {
      body: withNewField(invitations),
      method: 'GET',
      path: INVITATIONS
    },
    schema: ListOrganizationInvitationsOutputSchema,
    shows: 'linus@example.test'
  }),
  printsResponse({
    args: TOKEN_FILE,
    command: 'org invitation preview',
    files: TOKEN_FILES,
    route: {
      body: withNewField(preview),
      method: 'POST',
      path: '/v1/organizations/invitations/preview',
      requestBody: { token: INVITATION_TOKEN }
    },
    schema: PreviewOrganizationInvitationOutputSchema,
    shows: 'Ada Lovelace'
  }),
  printsResponse({
    args: [
      INVITATION_ID,
      ...ORGANIZATION,
      '--yes',
      '--idempotency-key',
      'golden-invitation-revoke'
    ],
    command: 'org invitation revoke',
    route: {
      body: revokedInvitation,
      method: 'POST',
      path: `${INVITATIONS}/${INVITATION_ID}/revoke`
    },
    schema: RevokeOrganizationInvitationOutputSchema,
    shows: `Revoked invitation ${INVITATION_ID}.`,
    showsNoApiText: true
  }),
  {
    args: [...ORGANIZATION, '--no-browser'],
    command: 'org billing payment-method setup',
    document: { checkout, opened: false },
    embeds: 'checkout',
    routes: [
      {
        body: checkout,
        method: 'POST',
        path: `${ORGANIZATION_PATH}/billing/checkout`
      }
    ],
    schema: CheckoutSchema,
    shows: `Checkout URL: ${checkout.checkoutUrl}`,
    showsNoApiText: true
  },
  printsResponse({
    args: ORGANIZATION,
    command: 'org billing payment-method status',
    route: {
      body: withNewField(paymentStatus),
      method: 'GET',
      path: `${ORGANIZATION_PATH}/billing/payment-method`
    },
    schema: PaymentStatusSchema,
    shows: 'Last four     4242',
    showsNoApiText: true
  })
]
