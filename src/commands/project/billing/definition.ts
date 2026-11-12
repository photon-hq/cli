import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../args.ts'
import { expectError, runs, tested } from '../../production-test.ts'
import type { PhotonCommandParams } from '../../types.ts'
import { paginationArgs } from '../args.ts'

type BillingParams = PhotonCommandParams
type BillingOverviewParams = PhotonCommandParams
export type InvoiceListParams = PhotonCommandParams<typeof paginationArgs>

const operationViewArgs = {
  'operation-id': {
    description: 'Billing operation ID',
    parse: idArgument('billingOperation', 'Operation ID'),
    type: 'positional'
  }
} as const
const purchaseArgs = {
  category: {
    description: 'Billing category',
    required: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  planCode: {
    description: 'Plan code to purchase',
    required: true,
    toKebab: true,
    type: 'string'
  },
  yes: yesArg
} as const
const cancelArgs = {
  category: {
    description: 'Billing category to cancel',
    required: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg,
  yes: yesArg
} as const
const resumeArgs = {
  category: {
    description: 'Billing category to resume',
    required: true,
    type: 'string'
  },
  idempotencyKey: idempotencyKeyArg
} as const

export type BillingOperationViewParams = PhotonCommandParams<
  typeof operationViewArgs
>
export type PlanPurchaseParams = PhotonCommandParams<typeof purchaseArgs>
export type SubscriptionCancelParams = PhotonCommandParams<typeof cancelArgs>
export type SubscriptionResumeParams = PhotonCommandParams<typeof resumeArgs>

const overviewDefinition = defineWithTypes<BillingOverviewParams>()({
  description: 'View subscriptions, entitlements, and usage',
  name: 'overview'
})
const invoiceListDefinition = defineWithTypes<InvoiceListParams>()({
  args: paginationArgs,
  description: "List invoices for the project's organization",
  name: 'list'
})
const operationViewDefinition = defineWithTypes<BillingOperationViewParams>()({
  args: operationViewArgs,
  description: 'View a billing operation',
  name: 'view'
})
const purchaseDefinition = defineWithTypes<PlanPurchaseParams>()({
  args: purchaseArgs,
  description: 'Purchase a project plan',
  name: 'purchase',
  toKebab: true
})
const cancelDefinition = defineWithTypes<SubscriptionCancelParams>()({
  args: cancelArgs,
  description:
    "Move to the category's default plan at the end of the billing period",
  name: 'cancel',
  toKebab: true
})
const resumeDefinition = defineWithTypes<SubscriptionResumeParams>()({
  args: resumeArgs,
  description:
    'Keep the current plan, dropping a change scheduled for the period end',
  name: 'resume',
  toKebab: true
})

const invoiceCommand = defineWithTypes<BillingParams>()({
  description: "Inspect invoices for the project's organization",
  name: 'invoice',
  subCommands: {
    list: tested(
      runs,
      lazyWithTypes<InvoiceListParams>()(
        async () => (await import('./run.ts')).runInvoiceList,
        invoiceListDefinition
      )
    )
  }
})

const operationCommand = defineWithTypes<BillingParams>()({
  description: 'Inspect billing operations',
  name: 'operation',
  subCommands: {
    view: tested(
      runs,
      lazyWithTypes<BillingOperationViewParams>()(
        async () => (await import('./run.ts')).runOperationView,
        operationViewDefinition
      )
    )
  }
})

const planCommand = defineWithTypes<BillingParams>()({
  description: 'Manage project plans',
  name: 'plan',
  subCommands: {
    purchase: tested(
      expectError('BILLING_OPERATION_REJECTED', 'payment_method_required'),
      lazyWithTypes<PlanPurchaseParams>()(
        async () => (await import('./run.ts')).runPlanPurchase,
        purchaseDefinition
      )
    )
  }
})

const subscriptionCommand = defineWithTypes<BillingParams>()({
  description: 'Manage project subscriptions',
  name: 'subscription',
  subCommands: {
    cancel: tested(
      runs,
      lazyWithTypes<SubscriptionCancelParams>()(
        async () => (await import('./run.ts')).runSubscriptionCancel,
        cancelDefinition
      )
    ),
    resume: tested(
      runs,
      lazyWithTypes<SubscriptionResumeParams>()(
        async () => (await import('./run.ts')).runSubscriptionResume,
        resumeDefinition
      )
    )
  }
})

export const billingCommand = defineWithTypes<BillingParams>()({
  description: 'Inspect and manage project billing',
  name: 'billing',
  subCommands: {
    invoice: invoiceCommand,
    operation: operationCommand,
    overview: tested(
      runs,
      lazyWithTypes<BillingOverviewParams>()(
        async () => (await import('./run.ts')).runOverview,
        overviewDefinition
      )
    ),
    plan: planCommand,
    subscription: subscriptionCommand
  }
})
