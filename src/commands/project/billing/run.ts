import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../app/services.ts'
import { CliError } from '../../../core/errors.ts'
import { detail, inert, presentList, table } from '../../../core/presenter.ts'
import { CLI_NAME } from '../../../meta.ts'
import { billingRejection } from '../../../operation/service.ts'
import { resolveProjectId } from '../../../project/command-helpers.ts'
import {
  validateBillingCategory,
  validateBillingPlanCode,
  validatePagination
} from '../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../helpers.ts'
import type { PhotonCommandParams } from '../../types.ts'
import type {
  BillingOperationViewParams,
  InvoiceListParams,
  PlanPurchaseParams,
  SubscriptionCancelParams,
  SubscriptionResumeParams
} from './definition.ts'

type BillingOverviewParams = PhotonCommandParams

const formatCents = (amountCents: number): string => {
  const sign = amountCents < 0 ? '-' : ''
  const absoluteCents = Math.abs(amountCents)
  const whole = Math.trunc(absoluteCents / 100)
  const fraction = Math.trunc(absoluteCents % 100)
    .toString()
    .padStart(2, '0')
  return `${sign}${whole.toString()}.${fraction}`
}

export const runOverview: CommandRunner<BillingOverviewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const [overview, terms] = await Promise.all([
    photon.projects.getBillingOverview(projectId),
    photon.projects.getEffectiveTerms(projectId)
  ])
  const entitlements = overview.subscriptions.flatMap((subscription) =>
    subscription.entitlements.map((entitlement) => [
      subscription.category,
      entitlement.featureKey,
      entitlement.value
    ])
  )
  photon.output.success({ billing: overview, terms }, [
    photon.output.style('bold', 'Subscriptions'),
    ...table(
      photon.output,
      ['CATEGORY', 'PLAN', 'STATUS', 'PERIOD END', 'CANCELS', 'SCHEDULED'],
      overview.subscriptions.map((subscription) => {
        const scheduled =
          terms.subscriptions.find(
            (entry) => entry.category === subscription.category
          )?.scheduledPlanChange ?? null
        return [
          subscription.category,
          subscription.planCode,
          subscription.status,
          { style: 'dim', text: subscription.currentPeriodEnd ?? '—' },
          { style: 'dim', text: subscription.cancelsAt ?? '—' },
          scheduled === null
            ? { style: 'dim', text: '—' }
            : `${scheduled.planCode} on ${scheduled.effectiveAt}`
        ]
      }),
      'No subscriptions found.'
    ),
    '',
    photon.output.style(
      'bold',
      `Entitlements (version ${overview.entitlementsVersion.toString()})`
    ),
    ...table(
      photon.output,
      ['CATEGORY', 'FEATURE', 'VALUE'],
      entitlements,
      'No entitlements found.'
    ),
    '',
    photon.output.style('bold', 'Usage'),
    ...table(
      photon.output,
      ['CATEGORY', 'METRIC', 'UNITS', 'AMOUNT', 'CURRENCY'],
      overview.usage.map((usage) => [
        usage.category,
        usage.metricCode,
        usage.units.toString(),
        formatCents(usage.amountCents),
        usage.currency
      ]),
      'No usage found.'
    )
  ])
}

export const runInvoiceList: CommandRunner<InvoiceListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listInvoices(
    projectId,
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentList(photon.output, {
    document: result,
    emptyMessage: 'No invoices found.',
    items: result.invoices,
    lines: table(
      photon.output,
      ['NUMBER', 'INVOICE ID', 'STATUS', 'TOTAL', 'CURRENCY', 'ISSUED'],
      result.invoices.map((invoice) => [
        invoice.number,
        { style: 'cyan', text: invoice.invoiceId },
        invoice.paymentStatus,
        formatCents(invoice.totalCents),
        invoice.currency,
        { style: 'dim', text: invoice.issuedAt ?? '—' }
      ])
    ),
    page: {
      command: context,
      inDocument: true,
      scope: { project: projectId },
      token: result.nextCursor ?? undefined
    }
  })
}

export const runOperationView: CommandRunner<
  BillingOperationViewParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const operation = await photon.output.withLoading(
    'Waiting for the billing operation to finish…',
    async () => {
      const initial = await photon.projects.getBillingOperation(
        projectId,
        context.values['operation-id']
      )
      return await photon.projects.pollBillingOperation(projectId, initial)
    },
    { nonInteractive: 'silent' }
  )
  photon.output.success(
    operation,
    detail(photon.output, 'Billing operation', [
      { label: 'ID', value: operation.operationId },
      { label: 'Kind', value: operation.kind },
      { label: 'Status', value: operation.status },
      { label: 'Failure', value: operation.failure?.code },
      { label: 'Failure detail', value: operation.failure?.detail },
      { label: 'Retryable', value: operation.failure?.retryable },
      { label: 'Result version', value: operation.result?.version },
      { label: 'Submitted', value: operation.submittedAt },
      { label: 'Resolved', value: operation.resolvedAt }
    ])
  )
}

export const runPlanPurchase: CommandRunner<PlanPurchaseParams> = async (
  context
) => {
  const { photon } = context.extensions
  const category = validateBillingCategory(context.values.category)
  const planCode = validateBillingPlanCode(context.values.planCode)
  const projectId = await resolveProjectId(photon)
  const confirmed = await confirmRiskyAction(context, {
    action: `purchase plan ${planCode} in category ${category} for project ${projectId}`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.output.withLoading(
    'Purchasing the plan and waiting for the billing operation to finish…',
    async () =>
      await photon.operations.execute(
        { category, kind: 'billing.plan.purchase', planCode, projectId },
        context.values.idempotencyKey,
        async ({ idempotencyKey }) => {
          const operation = await photon.projects.purchasePlan(
            projectId,
            category,
            planCode,
            idempotencyKey
          )
          const rejected = billingRejection(operation)
          if (rejected !== undefined) {
            throw rejected
          }
          return operation
        }
      ),
    { nonInteractive: 'silent' }
  )
  const operation = execution.result
  photon.output.success(
    operation,
    photon.output.style(
      'green',
      inert(`Completed plan purchase ${operation.operationId}.`)
    )
  )
}

// Cancelling is a change to the category's default plan, which the API
// schedules for the end of the billing period, as the Dashboard cancels.
export const runSubscriptionCancel: CommandRunner<
  SubscriptionCancelParams
> = async (context) => {
  const { photon } = context.extensions
  const category = validateBillingCategory(context.values.category)
  const projectId = await resolveProjectId(photon)
  const [catalog, overview] = await Promise.all([
    photon.projects.listBillingPlans(projectId),
    photon.projects.getBillingOverview(projectId)
  ])
  const defaultPlan = catalog.plans[category]?.find((plan) => plan.isDefault)
  if (defaultPlan === undefined) {
    throw new CliError(
      'BILLING_DEFAULT_PLAN_NOT_FOUND',
      `The ${category} category has no default plan to move to.`,
      {
        next: [
          {
            description: 'Check the category',
            run: `${CLI_NAME} project billing overview`
          }
        ]
      }
    )
  }
  const held = overview.subscriptions.find(
    (entry) => entry.category === category
  )
  if (held === undefined || held.planCode === defaultPlan.planCode) {
    photon.output.success(
      {
        subscription: {
          cancellationScheduled: false,
          cancelsAt: null,
          category
        }
      },
      `The project is on the default ${category} plan; nothing changed.`
    )
    return
  }
  const confirmed = await confirmRiskyAction(context, {
    action: `cancel the ${held.planName} plan for project ${projectId}`,
    consequence: `It moves to ${defaultPlan.name} at the end of the billing period.`,
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const operation = await changePlan(photon, {
    category,
    failure: 'The cancellation failed.',
    idempotencyKey: context.values.idempotencyKey,
    planCode: defaultPlan.planCode,
    projectId
  })
  const subscription = {
    cancellationScheduled: true,
    cancelsAt: operation.result?.effectiveAt ?? null,
    category
  }
  const when =
    subscription.cancelsAt === null
      ? 'at the end of the billing period'
      : `on ${subscription.cancelsAt}`
  photon.output.success(
    { operation, subscription },
    photon.output.style(
      'green',
      inert(
        `Scheduled cancellation for ${category}: the project moves to ${defaultPlan.name} ${when}.`
      )
    )
  )
}

// Changing to the plan already held drops the change scheduled for the period
// end, as the Dashboard's "Keep <plan>" does.
export const runSubscriptionResume: CommandRunner<
  SubscriptionResumeParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const category = validateBillingCategory(context.values.category)
  const [overview, terms] = await Promise.all([
    photon.projects.getBillingOverview(projectId),
    photon.projects.getEffectiveTerms(projectId)
  ])
  const held = overview.subscriptions.find(
    (entry) => entry.category === category
  )
  const scheduled = terms.subscriptions.find(
    (entry) => entry.category === category
  )?.scheduledPlanChange
  if (held === undefined || scheduled === undefined || scheduled === null) {
    photon.output.success(
      { subscription: { category, resumed: false } },
      `The ${category} subscription has no change scheduled for the period end; nothing changed.`
    )
    return
  }
  const operation = await changePlan(photon, {
    category,
    failure: 'Keeping the plan failed.',
    idempotencyKey: context.values.idempotencyKey,
    planCode: held.planCode,
    projectId
  })
  photon.output.success(
    { operation, subscription: { category, resumed: true } },
    photon.output.style(
      'green',
      inert(
        `Kept the ${held.planName} plan for ${category}; the change scheduled for ${scheduled.effectiveAt} is dropped.`
      )
    )
  )
}

// A plan change is journaled as a plan purchase: the same keyed request, so a
// retry with the same idempotency key reads the same outcome.
const changePlan = async (
  photon: PhotonCommandServices,
  change: {
    category: string
    failure: string
    idempotencyKey: string | undefined
    planCode: string
    projectId: string
  }
) => {
  const { category, failure, planCode, projectId } = change
  const execution = await photon.output.withLoading(
    'Changing the plan and waiting for the billing operation to finish…',
    async () =>
      await photon.operations.execute(
        { category, kind: 'billing.plan.purchase', planCode, projectId },
        change.idempotencyKey,
        async ({ idempotencyKey }) => {
          const operation = await photon.projects.purchasePlan(
            projectId,
            category,
            planCode,
            idempotencyKey
          )
          const rejected = billingRejection(operation, failure)
          if (rejected !== undefined) {
            throw rejected
          }
          return operation
        }
      ),
    { nonInteractive: 'silent' }
  )
  return execution.result
}
