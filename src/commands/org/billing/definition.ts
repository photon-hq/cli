import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { runs, skip, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'

type OrgBillingParams = PhotonCommandParams
type PaymentStatusParams = PhotonCommandParams

const setupArgs = {
  noBrowser: {
    default: false,
    description: 'Print the checkout URL instead of opening a browser',
    toKebab: true,
    type: 'boolean'
  }
} as const

export type PaymentSetupParams = PhotonCommandParams<typeof setupArgs>

const statusDefinition = defineWithTypes<PaymentStatusParams>()({
  description: 'Check whether a payment card is on file',
  name: 'status'
})

const setupDefinition = defineWithTypes<PaymentSetupParams>()({
  args: setupArgs,
  description: 'Open hosted payment setup',
  name: 'setup',
  toKebab: true
})

const paymentMethodCommand = defineWithTypes<OrgBillingParams>()({
  description: 'Inspect and configure the organization payment method',
  name: 'payment-method',
  subCommands: {
    setup: tested(
      skip(
        'needs a person to add a card on the checkout page, and a card would let purchases spend money'
      ),
      lazyWithTypes<PaymentSetupParams>()(
        async () => (await import('./run.ts')).runSetup,
        setupDefinition
      )
    ),
    status: tested(
      runs,
      lazyWithTypes<PaymentStatusParams>()(
        async () => (await import('./run.ts')).runStatus,
        statusDefinition
      )
    )
  }
})

export const orgBillingCommand = defineWithTypes<OrgBillingParams>()({
  description: 'Inspect and manage organization billing',
  name: 'billing',
  subCommands: {
    'payment-method': paymentMethodCommand
  },
  toKebab: true
})
