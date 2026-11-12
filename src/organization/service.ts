import { randomUUID } from 'node:crypto'
import type {
  AcceptOrganizationInvitationOutput,
  CreateOrganizationInvitationInput,
  CreateOrganizationInvitationOutput,
  CreateOrganizationPaymentMethodCheckoutOutput,
  GetOrganizationOutput,
  GetOrganizationPaymentMethodOutput,
  LeaveOrganizationOutput,
  ListOrganizationInvitationsOutput,
  ListOrganizationMembersOutput,
  ListOrganizationsOutput,
  PhotonNamespaces,
  PreviewOrganizationInvitationOutput,
  RemoveOrganizationMemberOutput,
  RequestOptions,
  RevokeOrganizationInvitationOutput,
  UpdateOrganizationMemberRoleInput,
  UpdateOrganizationMemberRoleOutput
} from '@photon-ai/api'
import type { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { CliError } from '../core/errors.ts'
import { normalizeSdkError } from '../core/sdk-error.ts'
import type { KnownEnumValue } from '../core/validation.ts'
import { CLI_NAME } from '../meta.ts'

export type OrganizationScope = PhotonNamespaces['organizations']

export type OrganizationMember =
  ListOrganizationMembersOutput['members'][number]
export type OrganizationInvitationRole = KnownEnumValue<
  CreateOrganizationInvitationInput['body']['role']
>
export type AssignableOrganizationRole = KnownEnumValue<
  UpdateOrganizationMemberRoleInput['body']['role']
>

type RpcPaymentMethod = NonNullable<
  GetOrganizationPaymentMethodOutput['paymentMethod']
>

type PaymentMethodField = 'brand' | 'expiresMonth' | 'expiresYear' | 'last4'

export type OrganizationPaymentMethod = {
  [Field in PaymentMethodField]: NonNullable<RpcPaymentMethod[Field]>
}

export interface OrganizationPaymentStatus {
  cardOnFile: boolean
  paymentMethod: OrganizationPaymentMethod | null
  response: GetOrganizationPaymentMethodOutput
}

interface OrganizationServiceOptions {
  request: AuthenticatedRequest
  scope: OrganizationScope
  signal?: AbortSignal
}

type OrganizationRequest<Result> = (options?: RequestOptions) => Promise<Result>

const PAYMENT_BRAND_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,31}$/iu
const PAYMENT_LAST_FOUR_PATTERN = /^\d{4}$/u
const MINIMUM_EXPIRATION_YEAR = 2000
const MAXIMUM_EXPIRATION_YEAR = 9999

const checkoutUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0
    ) {
      return value
    }
  } catch {
    // The stable protocol error below intentionally omits the capability URL.
  }
  throw new CliError(
    'ORGANIZATION_PROTOCOL_ERROR',
    'Photon returned an invalid payment checkout URL.',
    {
      debugSafe: false,
      retryable: true
    }
  )
}

const paymentProtocolError = (): CliError =>
  new CliError(
    'ORGANIZATION_PROTOCOL_ERROR',
    'Photon returned invalid payment-method details.',
    {
      debugSafe: false,
      detail:
        'The response did not match the expected safe payment display schema.',
      retryable: true
    }
  )

const selectPaymentMethod = (
  paymentMethod: GetOrganizationPaymentMethodOutput['paymentMethod']
): OrganizationPaymentMethod | null => {
  if (paymentMethod === null) {
    return null
  }

  const { brand, expiresMonth, expiresYear, last4 } = paymentMethod
  const validBrand = brand !== null && PAYMENT_BRAND_PATTERN.test(brand)
  const validLastFour = last4 !== null && PAYMENT_LAST_FOUR_PATTERN.test(last4)
  const validExpirationMonth =
    expiresMonth !== null &&
    Number.isInteger(expiresMonth) &&
    expiresMonth >= 1 &&
    expiresMonth <= 12
  const validExpirationYear =
    expiresYear !== null &&
    Number.isInteger(expiresYear) &&
    expiresYear >= MINIMUM_EXPIRATION_YEAR &&
    expiresYear <= MAXIMUM_EXPIRATION_YEAR

  if (
    !(
      validBrand &&
      validLastFour &&
      validExpirationMonth &&
      validExpirationYear
    )
  ) {
    throw paymentProtocolError()
  }

  return { brand, expiresMonth, expiresYear, last4 }
}

const selectPaymentStatus = (
  result: GetOrganizationPaymentMethodOutput
): OrganizationPaymentStatus => ({
  cardOnFile: result.cardOnFile,
  paymentMethod: result.cardOnFile
    ? selectPaymentMethod(result.paymentMethod)
    : null,
  response: result
})

const memberNotFound = (organizationId: string, accountId: string): CliError =>
  new CliError(
    'ORGANIZATION_MEMBER_NOT_FOUND',
    `Account ${accountId} is not an active member of organization ${organizationId}.`,
    {
      exitCode: 2,
      next: [
        {
          description: 'List active members',
          run: `${CLI_NAME} org member list`
        }
      ]
    }
  )

export class OrganizationService {
  readonly #request: AuthenticatedRequest
  readonly #scope: OrganizationScope
  readonly #signal: AbortSignal | undefined

  constructor(options: OrganizationServiceOptions) {
    this.#request = options.request
    this.#scope = options.scope
    this.#signal = options.signal
  }

  async list(): Promise<ListOrganizationsOutput> {
    return await this.#execute((options) =>
      this.#scope.listOrganizations({}, options)
    )
  }

  async get(organizationId: string): Promise<GetOrganizationOutput> {
    return await this.#execute((options) =>
      this.#scope.getOrganization({ path: { organizationId } }, options)
    )
  }

  async listMembers(
    organizationId: string
  ): Promise<ListOrganizationMembersOutput> {
    return await this.#execute((options) =>
      this.#scope.listOrganizationMembers({ path: { organizationId } }, options)
    )
  }

  // Membership changes are guarded by the member's version, so read the
  // current active membership before changing it.
  async getActiveMember(
    organizationId: string,
    accountId: string
  ): Promise<OrganizationMember> {
    const { members } = await this.listMembers(organizationId)
    const member = members.find(
      (candidate) =>
        candidate.accountId === accountId && candidate.status === 'active'
    )
    if (member === undefined) {
      throw memberNotFound(organizationId, accountId)
    }
    return member
  }

  async updateMemberRole(
    organizationId: string,
    accountId: string,
    role: AssignableOrganizationRole,
    expectedVersion: string,
    idempotencyKey: string = randomUUID()
  ): Promise<UpdateOrganizationMemberRoleOutput> {
    return await this.#execute((options) =>
      this.#scope.updateOrganizationMemberRole(
        {
          body: { expectedVersion, role },
          headers: { idempotencyKey },
          path: { memberAccountId: accountId, organizationId }
        },
        options
      )
    )
  }

  async removeMember(
    organizationId: string,
    accountId: string,
    expectedVersion: string,
    idempotencyKey: string = randomUUID()
  ): Promise<RemoveOrganizationMemberOutput> {
    return await this.#execute((options) =>
      this.#scope.removeOrganizationMember(
        {
          body: { expectedVersion },
          headers: { idempotencyKey },
          path: { memberAccountId: accountId, organizationId }
        },
        options
      )
    )
  }

  async leave(
    organizationId: string,
    expectedVersion: string,
    idempotencyKey: string = randomUUID()
  ): Promise<LeaveOrganizationOutput> {
    return await this.#execute((options) =>
      this.#scope.leaveOrganization(
        {
          body: { expectedVersion },
          headers: { idempotencyKey },
          path: { organizationId }
        },
        options
      )
    )
  }

  async createInvitation(
    organizationId: string,
    email: string,
    role: OrganizationInvitationRole,
    idempotencyKey: string = randomUUID()
  ): Promise<CreateOrganizationInvitationOutput> {
    return await this.#execute((options) =>
      this.#scope.createOrganizationInvitation(
        {
          body: { email, role },
          headers: { idempotencyKey },
          path: { organizationId }
        },
        options
      )
    )
  }

  async listInvitations(
    organizationId: string
  ): Promise<ListOrganizationInvitationsOutput> {
    return await this.#execute((options) =>
      this.#scope.listOrganizationInvitations(
        { path: { organizationId } },
        options
      )
    )
  }

  async previewInvitation(
    token: string
  ): Promise<PreviewOrganizationInvitationOutput> {
    return await this.#execute(
      (options) =>
        this.#scope.previewOrganizationInvitation({ body: { token } }, options),
      true
    )
  }

  async acceptInvitation(
    token: string,
    idempotencyKey: string = randomUUID()
  ): Promise<AcceptOrganizationInvitationOutput> {
    return await this.#execute(
      (options) =>
        this.#scope.acceptOrganizationInvitation(
          { body: { token }, headers: { idempotencyKey } },
          options
        ),
      true
    )
  }

  async revokeInvitation(
    organizationId: string,
    invitationId: string,
    idempotencyKey: string = randomUUID()
  ): Promise<RevokeOrganizationInvitationOutput> {
    return await this.#execute((options) =>
      this.#scope.revokeOrganizationInvitation(
        {
          headers: { idempotencyKey },
          path: { invitationId, organizationId }
        },
        options
      )
    )
  }

  async getPaymentStatus(
    organizationId: string
  ): Promise<OrganizationPaymentStatus> {
    const result = await this.#execute((options) =>
      this.#scope.billing.getOrganizationPaymentMethod(
        { path: { organizationId } },
        options
      )
    )
    return selectPaymentStatus(result)
  }

  async createPaymentCheckout(
    organizationId: string
  ): Promise<CreateOrganizationPaymentMethodCheckoutOutput> {
    const result = await this.#execute((options) =>
      this.#scope.billing.createOrganizationPaymentMethodCheckout(
        { path: { organizationId } },
        options
      )
    )
    return { ...result, checkoutUrl: checkoutUrl(result.checkoutUrl) }
  }

  async #execute<Result>(
    request: OrganizationRequest<Result>,
    sensitive = false
  ): Promise<Result> {
    try {
      return await this.#request.run(request)
    } catch (error) {
      throw normalizeSdkError(error, {
        sensitive,
        ...(this.#signal === undefined ? {} : { signal: this.#signal })
      })
    }
  }
}
