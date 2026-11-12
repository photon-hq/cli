import type { GetOrganizationOutput } from '@photon-ai/api'
import type { CliOutput } from '../core/output.ts'
import { detail } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import type { ResolvedOrganizationContext } from './context-service.ts'
import type { OrganizationPaymentStatus } from './service.ts'

const BRAND_SEPARATOR_PATTERN = /[_-]+/gu
const BRAND_WORD_PATTERN = /\b[a-z]/gu

const sourceLabel = (context: ResolvedOrganizationContext): string => {
  switch (context.source) {
    case 'default':
      return 'account default'
    case 'environment':
      return 'PHOTON_ORGANIZATION_ID'
    case 'flag':
      return '--org flag'
    case 'folder':
      return context.path
    case 'stored':
      return `${CLI_NAME} org use`
    default:
      return context satisfies never
  }
}

export const organizationDetails = (
  output: CliOutput,
  organization: GetOrganizationOutput,
  context?: ResolvedOrganizationContext
): string[] =>
  detail(output, 'Organization', [
    { label: 'Name', value: organization.name },
    { label: 'ID', value: organization.organizationId },
    ...(context === undefined
      ? []
      : [{ label: 'Selected by', value: sourceLabel(context) }]),
    { label: 'Created', value: organization.createdAt },
    { label: 'Updated', value: organization.updatedAt }
  ])

const displayBrand = (brand: string): string =>
  brand
    .replace(BRAND_SEPARATOR_PATTERN, ' ')
    .replace(BRAND_WORD_PATTERN, (character) => character.toUpperCase())

export const paymentDetails = (
  output: CliOutput,
  payment: OrganizationPaymentStatus
): string[] => {
  const entries: { label: string; value: unknown }[] = [
    { label: 'Card on file', value: payment.cardOnFile ? 'yes' : 'no' }
  ]
  if (payment.paymentMethod === null) {
    if (payment.cardOnFile) {
      entries.push({ label: 'Details', value: 'unavailable' })
    }
  } else {
    entries.push(
      { label: 'Brand', value: displayBrand(payment.paymentMethod.brand) },
      { label: 'Last four', value: payment.paymentMethod.last4 },
      {
        label: 'Expires',
        value: `${String(payment.paymentMethod.expiresMonth).padStart(2, '0')}/${payment.paymentMethod.expiresYear}`
      }
    )
  }
  return detail(output, 'Payment method', entries)
}
