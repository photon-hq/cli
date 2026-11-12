import {
  type GetBillingOperationOutput,
  GetBillingOperationOutputSchema,
  type GetBillingOverviewOutput,
  GetBillingOverviewOutputSchema,
  type GetEffectiveTermsOutput,
  GetEffectiveTermsOutputSchema,
  type GetProjectOutput,
  type ListBillingPlansOutput,
  type ListInvoicesOutput,
  ListInvoicesOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import {
  buildsDocument,
  type Declared,
  type FakeRoute,
  type GoldenCase,
  PLANTED,
  withNewField
} from './support.ts'

const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT = ['--project', PROJECT_ID]
const OPERATION_ID = `pho_bop_${'0123456789abcdef'.repeat(4)}`
const PROJECT_PATH = `/v1/projects/${PROJECT_ID}`
const BILLING = `${PROJECT_PATH}/billing`
const PLANS = `${BILLING}/plans`
const OPERATION = `${BILLING}/operations/${OPERATION_ID}`
const ORGANIZATION_BILLING = `/v1/organizations/${ORGANIZATION_ID}/billing`
const TERMS = `${ORGANIZATION_BILLING}/projects/${PROJECT_ID}/terms`
const PURCHASE = `${ORGANIZATION_BILLING}/projects/${PROJECT_ID}/purchase`
const CATEGORY = 'platforms'
const createdAt = '2026-07-31T18:00:00.000Z'
const submittedAt = '2026-08-01T18:00:00.000Z'
const resolvedAt = '2026-08-01T18:00:05.000Z'
const periodStart = '2026-08-01T00:00:00.000Z'
const periodEnd = '2026-09-01T00:00:00.000Z'

const project = {
  agentProfile: {
    avatarUrl: 'https://images.example.test/agents/ada.png',
    firstName: 'Ada',
    lastName: 'Lovelace'
  },
  billingInitialization: 'completed',
  createdAt,
  createdByAccountId: 'pho_acc_00000000000000000000000002',
  createdByActorId: 'pho_acc_00000000000000000000000002',
  createdByActorKind: 'account',
  deletedAt: null,
  name: 'Acme Support',
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: 'acme-support',
  updatedAt: createdAt
} satisfies Declared<GetProjectOutput>

// Every billing command that reaches the organization's billing reads the
// project first, for its organization ID.
const projectRoute = {
  body: project,
  method: 'GET',
  path: PROJECT_PATH
} as const satisfies FakeRoute

type Plan = ListBillingPlansOutput['plans'][string][number]

const freePlan = {
  baseAmountCents: 0,
  categoryDisplayName: 'Platforms',
  currency: 'USD',
  description: 'Shared lines for trying Photon.',
  entitlements: [
    { featureKey: 'imessage_shared_lines.max_user_assignments', value: '1' }
  ],
  fixedCharges: [],
  interval: 'monthly',
  isDefault: true,
  minimumCommitment: null,
  name: 'Free',
  payInAdvance: true,
  planCode: 'free',
  tier: 0,
  tierDisplayName: 'Free',
  usageCharges: [],
  usageThresholds: []
} satisfies Declared<Plan>

const businessPlan = {
  ...freePlan,
  baseAmountCents: 25_000,
  description: 'Dedicated lines and more assignments.',
  entitlements: [
    { featureKey: 'imessage_shared_lines.max_user_assignments', value: '5' }
  ],
  isDefault: false,
  minimumCommitment: { amountCents: 25_000, displayName: 'Platform minimum' },
  name: 'Business',
  planCode: 'business',
  tier: 1,
  tierDisplayName: 'Business',
  usageThresholds: [
    { amountCents: 50_000, displayName: 'Usage alert', recurring: false }
  ]
} satisfies Declared<Plan>

const plans = {
  plans: { [CATEGORY]: [freePlan, businessPlan] }
} satisfies ListBillingPlansOutput

const subscription = {
  baseAmountCents: 25_000,
  cancelsAt: null,
  category: CATEGORY,
  categoryDisplayName: 'Platforms',
  currency: 'USD',
  currentPeriodEnd: periodEnd,
  entitlements: businessPlan.entitlements,
  fixedCharges: [],
  minimumCommitment: businessPlan.minimumCommitment,
  planCode: 'business',
  planName: 'Business',
  status: 'active',
  tierDisplayName: 'Business'
} satisfies Declared<GetBillingOverviewOutput['subscriptions'][number]>

const overview = {
  entitlementsVersion: 7,
  subscriptions: [withNewField(subscription)],
  usage: [
    withNewField({
      amountCents: 1250,
      category: CATEGORY,
      categoryDisplayName: 'Platforms',
      currency: 'USD',
      displayName: 'iMessage messages',
      metricCode: 'imessage_message',
      units: 125
    })
  ]
} satisfies Declared<GetBillingOverviewOutput>

const freeOverview = {
  ...overview,
  subscriptions: [
    {
      ...subscription,
      baseAmountCents: 0,
      entitlements: freePlan.entitlements,
      minimumCommitment: null,
      planCode: 'free',
      planName: 'Free',
      tierDisplayName: 'Free'
    }
  ]
} satisfies Declared<GetBillingOverviewOutput>

const subscriptionTerms = {
  cancelsAt: null,
  category: CATEGORY,
  currentPeriodEnd: periodEnd,
  currentPeriodStart: periodStart,
  nextBillingAt: periodEnd,
  paymentMode: 'automatic',
  plan: businessPlan,
  planSource: 'catalog',
  scheduledPlanChange: null
} satisfies Declared<GetEffectiveTermsOutput['subscriptions'][number]>

const terms = {
  subscriptions: [subscriptionTerms],
  timeZone: 'UTC'
} satisfies Declared<GetEffectiveTermsOutput>

// The business plan with the change to the free plan scheduled for the
// period end, as a cancellation leaves it.
const scheduledTerms = {
  ...terms,
  subscriptions: [
    withNewField({
      ...subscriptionTerms,
      scheduledPlanChange: { effectiveAt: periodEnd, planCode: 'free' }
    })
  ]
} satisfies Declared<GetEffectiveTermsOutput>

const invoices = {
  invoices: [
    withNewField({
      currency: 'USD',
      invoiceId: 'inv_01h455vb4pex5vsknk084sn02q',
      issuedAt: submittedAt,
      kind: 'subscription',
      number: 'INV-2026-0008',
      paymentActionRequired: false,
      paymentDueAt: null,
      paymentOverdue: false,
      paymentStatus: 'succeeded',
      pdfUrl: 'https://billing.example.test/invoices/INV-2026-0008.pdf',
      status: 'finalized',
      subjects: [{ projectId: PROJECT_ID, type: 'project' }],
      totalCents: 26_250
    }),
    {
      currency: 'USD',
      invoiceId: 'inv_01h455vb4pex5vsknk084sn02r',
      issuedAt: null,
      kind: 'one_off',
      number: 'INV-2026-0009',
      paymentActionRequired: true,
      paymentDueAt: periodEnd,
      paymentOverdue: false,
      paymentStatus: 'pending',
      pdfUrl: null,
      status: 'pending',
      subjects: [{ organizationId: ORGANIZATION_ID, type: 'organization' }],
      totalCents: 4900
    }
  ],
  nextCursor: 'invoices_cursor_2'
} satisfies Declared<ListInvoicesOutput>

const pendingOperation = {
  failure: null,
  kind: 'change_plan',
  operationId: OPERATION_ID,
  paymentAction: null,
  resolvedAt: null,
  result: null,
  status: 'pending',
  submittedAt
} satisfies Declared<GetBillingOperationOutput>

const settledOperation = withNewField({
  failure: null,
  kind: 'change_plan',
  operationId: OPERATION_ID,
  paymentAction: null,
  resolvedAt,
  result: { effectiveAt: periodEnd, type: 'version', version: 'version_8' },
  status: 'succeeded',
  submittedAt
}) satisfies Declared<GetBillingOperationOutput>

const failedOperation = withNewField({
  failure: {
    code: 'payment_failed',
    detail: 'payment_declined',
    retryable: false,
    unsoldFixedCharges: []
  },
  kind: 'change_plan',
  operationId: OPERATION_ID,
  paymentAction: null,
  resolvedAt,
  result: null,
  status: 'failed',
  submittedAt
}) satisfies Declared<GetBillingOperationOutput>

// A plan change answers with the pending operation, and the CLI polls the
// operation until it settles.
const changeRoutes = (planCode: string): readonly FakeRoute[] => [
  { ...projectRoute },
  {
    body: pendingOperation,
    method: 'POST',
    path: PURCHASE,
    requestBody: { category: CATEGORY, planCode },
    status: 202
  }
]

const settledRoute = {
  body: settledOperation,
  method: 'GET',
  path: OPERATION
} as const satisfies FakeRoute

const OverviewSchema = z.strictObject({
  billing: GetBillingOverviewOutputSchema,
  terms: GetEffectiveTermsOutputSchema
})

const CancelledSchema = z.strictObject({
  operation: GetBillingOperationOutputSchema,
  subscription: z.strictObject({
    cancellationScheduled: z.literal(true),
    cancelsAt: z.string().nullable(),
    category: z.string()
  })
})

const UncancelledSchema = z.strictObject({
  subscription: z.strictObject({
    cancellationScheduled: z.literal(false),
    cancelsAt: z.null(),
    category: z.string()
  })
})

const ResumedSchema = z.strictObject({
  operation: GetBillingOperationOutputSchema,
  subscription: z.strictObject({
    category: z.string(),
    resumed: z.literal(true)
  })
})

const UnresumedSchema = z.strictObject({
  subscription: z.strictObject({
    category: z.string(),
    resumed: z.literal(false)
  })
})

export const BILLING_GOLDENS: readonly GoldenCase[] = [
  // Invoices belong to the project's organization, so the CLI reads the
  // project for its organization ID first.
  {
    args: [...PROJECT, '--limit', '2'],
    command: 'project billing invoice list',
    document: invoices,
    routes: [
      projectRoute,
      {
        body: invoices,
        method: 'GET',
        path: `${ORGANIZATION_BILLING}/invoices?limit=2`
      }
    ],
    schema: ListInvoicesOutputSchema,
    shows: 'INV-2026-0008'
  },
  // It polls the operation until it settles, and prints the operation it
  // settles as.
  {
    args: [OPERATION_ID, ...PROJECT],
    command: 'project billing operation view',
    document: settledOperation,
    routes: [
      { body: pendingOperation, method: 'GET', path: OPERATION },
      settledRoute
    ],
    schema: GetBillingOperationOutputSchema,
    shows: 'version_8'
  },
  // An operation that settles as failed prints the same way, and exits 0.
  {
    args: [OPERATION_ID, ...PROJECT],
    command: 'project billing operation view',
    document: failedOperation,
    routes: [
      { body: pendingOperation, method: 'GET', path: OPERATION },
      { body: failedOperation, method: 'GET', path: OPERATION }
    ],
    schema: GetBillingOperationOutputSchema,
    shows: 'payment_declined'
  },
  // It reads the overview and the effective terms at once, and the terms
  // read reads the project for its organization ID first.
  {
    args: PROJECT,
    command: 'project billing overview',
    concurrent: 3,
    document: { billing: overview, terms: scheduledTerms },
    embeds: ['billing', 'terms'],
    routes: [
      { body: overview, method: 'GET', path: BILLING },
      projectRoute,
      { body: scheduledTerms, method: 'GET', path: TERMS }
    ],
    schema: OverviewSchema,
    shows: `free on ${periodEnd}`
  },
  {
    args: [
      '--category',
      CATEGORY,
      '--plan-code',
      'business',
      ...PROJECT,
      '--yes'
    ],
    command: 'project billing plan purchase',
    document: settledOperation,
    routes: [...changeRoutes('business'), settledRoute],
    schema: GetBillingOperationOutputSchema,
    shows: `Completed plan purchase ${OPERATION_ID}.`
  },
  // It reads the plan catalog and the overview at once, moves the project to
  // the category's default plan, and prints the operation it settles as
  // beside what the change means for the subscription. Text shows the
  // default plan's name from the catalog.
  buildsDocument({
    args: ['--category', CATEGORY, ...PROJECT, '--yes'],
    build: (operation: typeof settledOperation) => ({
      operation,
      subscription: {
        cancellationScheduled: true,
        cancelsAt: operation.result.effectiveAt,
        category: CATEGORY
      }
    }),
    command: 'project billing subscription cancel',
    concurrent: 2,
    from: [settledRoute],
    routes: [
      {
        body: plans,
        method: 'GET',
        path: PLANS,
        planted: {
          plans: {
            [CATEGORY]: [{ ...freePlan, name: `a${PLANTED}Free` }, businessPlan]
          }
        },
        plantedOn: 'stdout'
      },
      { body: overview, method: 'GET', path: BILLING },
      ...changeRoutes('free'),
      settledRoute
    ],
    schema: CancelledSchema,
    shows: `the project moves to Free on ${periodEnd}.`
  }),
  // A project already on the default plan has nothing to cancel, so the CLI
  // changes nothing.
  {
    args: ['--category', CATEGORY, ...PROJECT, '--yes'],
    command: 'project billing subscription cancel',
    concurrent: 2,
    document: {
      subscription: {
        cancellationScheduled: false,
        cancelsAt: null,
        category: CATEGORY
      }
    },
    routes: [
      { body: plans, method: 'GET', path: PLANS, unshown: true },
      { body: freeOverview, method: 'GET', path: BILLING, unshown: true }
    ],
    schema: UncancelledSchema,
    shows: `The project is on the default ${CATEGORY} plan; nothing changed.`,
    showsNoApiText: true
  },
  // It reads the overview and the effective terms at once, changes to the
  // plan the project holds, which drops the change scheduled for the period
  // end, and prints the operation it settles as. Text shows the plan's name
  // from the overview and the date from the terms.
  buildsDocument({
    args: ['--category', CATEGORY, ...PROJECT],
    build: (operation: typeof settledOperation) => ({
      operation,
      subscription: { category: CATEGORY, resumed: true }
    }),
    command: 'project billing subscription resume',
    concurrent: 3,
    from: [settledRoute],
    routes: [
      {
        body: overview,
        method: 'GET',
        path: BILLING,
        planted: {
          ...overview,
          subscriptions: [{ ...subscription, planName: `a${PLANTED}Business` }]
        },
        plantedOn: 'stdout'
      },
      projectRoute,
      {
        body: scheduledTerms,
        method: 'GET',
        path: TERMS,
        planted: {
          ...scheduledTerms,
          subscriptions: [
            {
              ...subscriptionTerms,
              scheduledPlanChange: {
                effectiveAt: `a${PLANTED}${periodEnd}`,
                planCode: 'free'
              }
            }
          ]
        },
        plantedOn: 'stdout'
      },
      ...changeRoutes('business'),
      settledRoute
    ],
    schema: ResumedSchema,
    shows: `Kept the Business plan for ${CATEGORY}; the change scheduled for ${periodEnd} is dropped.`
  }),
  // With no change scheduled for the period end there's nothing to keep, so
  // the CLI changes nothing.
  {
    args: ['--category', CATEGORY, ...PROJECT],
    command: 'project billing subscription resume',
    concurrent: 3,
    document: { subscription: { category: CATEGORY, resumed: false } },
    routes: [
      { body: overview, method: 'GET', path: BILLING, unshown: true },
      { ...projectRoute, unshown: true },
      { body: terms, method: 'GET', path: TERMS, unshown: true }
    ],
    schema: UnresumedSchema,
    shows: `The ${CATEGORY} subscription has no change scheduled for the period end; nothing changed.`,
    showsNoApiText: true
  }
]
