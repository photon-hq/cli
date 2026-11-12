import type { PhotonCommandServices } from '../../../app/services.ts'
import { CliError } from '../../../core/errors.ts'
import type { OutputTarget } from '../../../core/output.ts'
import { inert, type TypedCommand } from '../../../core/presenter.ts'
import { CLI_NAME } from '../../../meta.ts'
import type { OperationExecuteOptions } from '../../../operation/service.ts'
import {
  MAXIMUM_PAGINATION_LIMIT,
  validateWhatsappVoipNumber,
  type WhatsappBusinessAccount,
  type WhatsappVoipNumber
} from '../../../project/service.ts'
import {
  byonHandoff,
  photonNewWabaHandoff,
  resolveWhatsappAddMode,
  type WhatsappAddValues,
  type WhatsappEmbeddedSignupHandoff,
  whatsappOnboardingUrl
} from '../../../project/whatsapp-onboarding.ts'

const INTERACTIVE_BUY_NUMBER = '__buy_number__'
const INTERACTIVE_BACK = '__back__'
const INTERACTIVE_NEW_WABA = '__new_waba__'

interface BrowserAttempt {
  attempted: boolean
  opened: boolean
}

const attemptBrowserHandoff = async (
  photon: PhotonCommandServices,
  url: string,
  noBrowser: boolean
): Promise<BrowserAttempt> => {
  if (noBrowser) {
    return { attempted: false, opened: false }
  }
  try {
    await photon.browser.open(url)
    return { attempted: true, opened: true }
  } catch {
    photon.output.warning(
      'Photon could not open your browser. Open the dashboard URL manually.'
    )
    return { attempted: true, opened: false }
  }
}

const handoffHumanOutput = (
  photon: PhotonCommandServices,
  handoff: WhatsappEmbeddedSignupHandoff,
  target: OutputTarget
): string[] => [
  photon.output.style(
    handoff.opened ? 'green' : 'yellow',
    handoff.opened
      ? 'Opened WhatsApp onboarding in your browser.'
      : 'Continue WhatsApp onboarding in a browser.',
    target
  ),
  inert(`Dashboard URL: ${handoff.url}`),
  '',
  ...handoff.nextSteps.map((step, index) =>
    inert(`${(index + 1).toString()}. ${step}`)
  )
]

// The guide is for the person, so JSON mode writes it to stderr and leaves
// the steps out of the document. The URL is the result, so it stays in too.
const emitHandoff = (
  photon: PhotonCommandServices,
  handoff: WhatsappEmbeddedSignupHandoff
): void => {
  const { nextSteps: _nextSteps, ...document } = handoff
  if (photon.output.json) {
    for (const line of handoffHumanOutput(photon, handoff, 'stderr')) {
      photon.output.progress(line)
    }
  }
  photon.output.success(
    { handoff: document },
    handoffHumanOutput(photon, handoff, 'stdout')
  )
}

const runByonHandoff = async (
  photon: PhotonCommandServices,
  projectId: string,
  noBrowser: boolean
): Promise<void> => {
  const url = whatsappOnboardingUrl(projectId, { source: 'byon' })
  const browser = await attemptBrowserHandoff(photon, url, noBrowser)
  emitHandoff(photon, byonHandoff(projectId, browser.attempted, browser.opened))
}

const provisionWithExistingWaba = async (
  photon: PhotonCommandServices,
  projectId: string,
  number: WhatsappVoipNumber,
  wabaId: string,
  options: {
    displayName?: string
    idempotencyKey?: string
    retry?: OperationExecuteOptions['retry']
  } = {}
): Promise<void> => {
  await photon.projects.assertWhatsappBusinessAccountConnected(
    projectId,
    wabaId
  )
  const execution = await photon.operations.execute(
    {
      ...(options.displayName === undefined
        ? {}
        : { displayName: options.displayName }),
      kind: 'whatsapp-business-number.provision',
      projectId,
      voipResourceId: number.resource.resourceId,
      wabaId
    },
    options.idempotencyKey,
    async ({ idempotencyKey, updateRemoteOperationId }) => {
      if (idempotencyKey === undefined) {
        throw new CliError(
          'OPERATION_JOURNAL_CORRUPT',
          'WhatsApp provisioning is missing its idempotency key.'
        )
      }
      return await photon.output.withLoading(
        `Connecting ${number.displayPhoneNumber} to WABA ${wabaId}`,
        async () =>
          await photon.projects.createWhatsappVoipSender(
            projectId,
            wabaId,
            {
              ...(options.displayName === undefined
                ? {}
                : { displayName: options.displayName }),
              voipResourceId: number.resource.resourceId
            },
            idempotencyKey,
            updateRemoteOperationId
          ),
        { nonInteractive: 'silent' }
      )
    },
    options.retry === undefined ? {} : { retry: options.retry }
  )
  const { response, sender } = execution.result
  photon.output.success(response, [
    photon.output.style(
      'green',
      inert(`Connected ${sender.detail.phoneNumber} to WhatsApp Business.`)
    ),
    inert(`WABA: ${sender.detail.account.wabaId}`),
    inert(`Resource ID: ${sender.resourceId}`)
  ])
}

const purchaseWhatsappVoipNumber = async (
  photon: PhotonCommandServices,
  projectId: string
): Promise<WhatsappVoipNumber | undefined> => {
  const confirmed = await photon.input.confirm(
    'Purchase a new US local SMS number? The project will be charged once provisioning succeeds.'
  )
  if (!confirmed) {
    return
  }
  const execution = await photon.operations.execute(
    { input: { countryCode: 'US' }, kind: 'sms-number.purchase', projectId },
    undefined,
    async ({ idempotencyKey, updateRemoteOperationId }) =>
      await photon.output.withLoading(
        `Purchasing an SMS number for project ${projectId}`,
        async () =>
          await photon.projects.purchaseSmsNumber(
            projectId,
            { countryCode: 'US' },
            idempotencyKey,
            updateRemoteOperationId
          ),
        { nonInteractive: 'silent' }
      ),
    {
      retry: (idempotencyKey) => ({
        description: 'Retry the purchase with its idempotency key',
        run: `${CLI_NAME} project platform sms purchase --project ${projectId} --country US --idempotency-key ${idempotencyKey}`
      })
    }
  )
  const number = validateWhatsappVoipNumber(
    execution.result.resource,
    projectId
  )
  photon.output.progress(
    inert(
      `Purchased ${number.displayPhoneNumber} (${number.resource.resourceId}). The number remains in the project if you stop onboarding.`
    )
  )
  return number
}

const selectPhotonNumber = async (
  photon: PhotonCommandServices,
  projectId: string,
  retainedNumbers: WhatsappVoipNumber[]
): Promise<'back' | WhatsappVoipNumber> => {
  const fetched =
    await photon.projects.listEligibleWhatsappVoipNumbers(projectId)
  const numbersById = new Map(
    [...retainedNumbers, ...fetched].map((candidate) => [
      candidate.resource.resourceId,
      candidate
    ])
  )
  const selected = await photon.input.select(
    'Which Photon SMS number should connect to WhatsApp Business?',
    [
      ...[...numbersById.values()].map((candidate) => ({
        hint: candidate.resource.resourceId,
        label: candidate.displayPhoneNumber,
        value: candidate.resource.resourceId
      })),
      {
        hint: 'Purchase and keep a new SMS-capable VoIP line',
        label: 'Buy a new US local SMS number',
        value: INTERACTIVE_BUY_NUMBER
      },
      { label: 'Back', value: INTERACTIVE_BACK }
    ],
    '--voip-resource-id'
  )
  if (selected === INTERACTIVE_BACK) {
    return 'back'
  }
  if (selected === INTERACTIVE_BUY_NUMBER) {
    const purchased = await purchaseWhatsappVoipNumber(photon, projectId)
    if (purchased === undefined) {
      return await selectPhotonNumber(photon, projectId, retainedNumbers)
    }
    retainedNumbers.push(purchased)
    return purchased
  }
  const selectedNumber = numbersById.get(selected)
  if (selectedNumber === undefined) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'The selected Photon number is no longer available.',
      { next: [{ description: 'Choose another active Photon SMS number.' }] }
    )
  }
  return selectedNumber
}

const selectWaba = async (
  photon: PhotonCommandServices,
  number: WhatsappVoipNumber,
  accounts: WhatsappBusinessAccount[]
): Promise<'back' | 'new' | WhatsappBusinessAccount> => {
  if (accounts.length === 0) {
    return 'new'
  }
  const selected = await photon.input.select(
    inert(
      `Which WhatsApp Business Account should use ${number.displayPhoneNumber}?`
    ),
    [
      ...accounts.map((candidate) => ({
        hint: inert(
          `Business ${candidate.businessId} · ${candidate.senderCount.toString()} connected sender${candidate.senderCount === 1 ? '' : 's'}`
        ),
        label: inert(`WABA ${candidate.wabaId}`),
        value: `waba:${candidate.wabaId}`
      })),
      {
        hint: 'Continue with Meta Embedded Signup',
        label: 'Connect another WABA with Meta',
        value: INTERACTIVE_NEW_WABA
      },
      { label: 'Back', value: INTERACTIVE_BACK }
    ],
    '--waba-id or --new-waba'
  )
  if (selected === INTERACTIVE_BACK) {
    return 'back'
  }
  if (selected === INTERACTIVE_NEW_WABA) {
    return 'new'
  }
  const wabaId = selected.startsWith('waba:') ? selected.slice(5) : ''
  const selectedAccount = accounts.find(
    (candidate) => candidate.wabaId === wabaId
  )
  if (selectedAccount === undefined) {
    throw new CliError(
      'PROJECT_PROTOCOL_ERROR',
      'The selected WhatsApp Business Account is no longer available.',
      { next: [{ description: 'Choose another connected WABA.' }] }
    )
  }
  return selectedAccount
}

const terminalVerification = async (
  photon: PhotonCommandServices,
  projectId: string,
  number: WhatsappVoipNumber,
  noBrowser: boolean
): Promise<void> => {
  const existing = await photon.projects.listWhatsappBusinessNumbers(
    projectId,
    { limit: MAXIMUM_PAGINATION_LIMIT }
  )
  const knownSenderIds = new Set(
    existing.senders.map((known) => known.sender.resourceId)
  )
  const url = whatsappOnboardingUrl(projectId, {
    source: 'photon',
    verification: 'terminal',
    voipResourceId: number.resource.resourceId
  })
  const browser = await attemptBrowserHandoff(photon, url, noBrowser)
  photon.output.progress(
    browser.opened
      ? 'Continue with Meta in the dashboard, then return here before clicking Send code.'
      : inert(
          `Open ${url}, continue with Meta, then return here before clicking Send code.`
        )
  )

  let verificationComplete = false
  while (!verificationComplete) {
    // biome-ignore lint/performance/noAwaitInLoops: readiness retries require sequential human input.
    const ready = await photon.input.confirm(
      'Are you at Meta’s Send code step and ready to request the SMS code?'
    )
    if (!ready) {
      photon.output.notice(
        inert(
          `Onboarding stopped. Photon SMS number ${number.displayPhoneNumber} remains in the project.`
        )
      )
      return
    }
    const receivedAfter = new Date(photon.now()).toISOString()
    photon.output.progress('Click Send code in Meta now. Waiting for the SMS…')
    try {
      const verification =
        await photon.projects.waitForWhatsappBusinessVerificationCode(
          projectId,
          number.resource.resourceId,
          receivedAfter
        )
      photon.output.progress(
        inert(`WhatsApp verification code: ${verification.code}`)
      )
      photon.output.progress(
        'Enter this code in Meta, finish Embedded Signup, and keep this terminal open.'
      )
      verificationComplete = true
    } catch (error) {
      if (
        error instanceof CliError &&
        (error.code === 'WHATSAPP_VERIFICATION_WINDOW_EXPIRED' ||
          error.code === 'WHATSAPP_VERIFICATION_CODE_TIMEOUT')
      ) {
        photon.output.warning(
          'The verification window ended. Return to Meta’s Send code step and request a new code.'
        )
        continue
      }
      throw error
    }
  }

  const connection = await photon.output.withLoading(
    `Waiting for ${number.displayPhoneNumber} to connect`,
    async () =>
      await photon.projects.waitForWhatsappBusinessSender(
        projectId,
        number.resource.resourceId,
        number.displayPhoneNumber,
        knownSenderIds
      ),
    { nonInteractive: 'silent' }
  )
  const { resource, sender } = connection
  if (!connection.matchesExpectedNumber) {
    photon.output.success({ resource }, [
      photon.output.style(
        'yellow',
        inert(
          `Meta connected ${sender.detail.phoneNumber}, not ${number.displayPhoneNumber}.`
        )
      ),
      inert(
        `Review the sender, then remove it if needed with "${CLI_NAME} project platform whatsapp-business number delete ${sender.resourceId}".`
      ),
      'Photon did not delete either number automatically.'
    ])
    return
  }
  photon.output.success({ resource }, [
    photon.output.style(
      'green',
      inert(`Connected ${sender.detail.phoneNumber} to WhatsApp Business.`)
    ),
    inert(`Resource ID: ${sender.resourceId}`)
  ])
}

const runInteractivePhoton = async (
  photon: PhotonCommandServices,
  projectId: string,
  noBrowser: boolean
): Promise<'back' | 'complete'> => {
  const retainedNumbers: WhatsappVoipNumber[] = []
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the interactive menu exits through explicit selections.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: interactive selections are intentionally sequential.
    const number = await selectPhotonNumber(photon, projectId, retainedNumbers)
    if (number === 'back') {
      return 'back'
    }
    const accountResult = await photon.projects.listWhatsappBusinessAccounts(
      projectId,
      { limit: MAXIMUM_PAGINATION_LIMIT }
    )
    const waba = await selectWaba(photon, number, accountResult.accounts)
    if (waba === 'back') {
      continue
    }
    if (waba === 'new') {
      await terminalVerification(photon, projectId, number, noBrowser)
      return 'complete'
    }
    await provisionWithExistingWaba(photon, projectId, number, waba.wabaId, {
      retry: (idempotencyKey) => ({
        description: 'Retry the connection with its idempotency key',
        run: `${CLI_NAME} project platform whatsapp-business number add --project ${projectId} --source photon --voip-resource-id ${number.resource.resourceId} --waba-id ${waba.wabaId} --idempotency-key ${idempotencyKey}`
      })
    })
    return 'complete'
  }
}

const runInteractive = async (
  photon: PhotonCommandServices,
  projectId: string,
  noBrowser: boolean
): Promise<void> => {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Back intentionally restarts the top-level wizard.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: interactive selections are intentionally sequential.
    const source = await photon.input.select(
      'How would you like to add a WhatsApp Business number?',
      [
        {
          hint: 'Connect a number you already own with Meta',
          label: 'Bring Your Own Number',
          value: 'byon'
        },
        {
          hint: 'Use an SMS-capable number managed by Photon',
          label: 'Use a Photon SMS Number',
          value: 'photon'
        }
      ],
      '--source'
    )
    if (source === 'byon') {
      await runByonHandoff(photon, projectId, noBrowser)
      return
    }
    const result = await runInteractivePhoton(photon, projectId, noBrowser)
    if (result === 'complete') {
      return
    }
  }
}

export const runWhatsappNumberAdd = async (
  photon: PhotonCommandServices,
  projectId: string,
  typed: TypedCommand,
  values: WhatsappAddValues
): Promise<void> => {
  const mode = resolveWhatsappAddMode(values, photon.input.blocker, {
    projectId,
    typed
  })
  if (mode.kind === 'interactive') {
    await runInteractive(photon, projectId, mode.noBrowser)
    return
  }
  if (mode.kind === 'byon-handoff') {
    await runByonHandoff(photon, projectId, mode.noBrowser)
    return
  }

  const number = await photon.projects.getAvailableWhatsappVoipNumber(
    projectId,
    mode.voipResourceId
  )
  if (mode.kind === 'photon-existing-waba') {
    await provisionWithExistingWaba(photon, projectId, number, mode.wabaId, {
      ...(mode.displayName === undefined
        ? {}
        : { displayName: mode.displayName }),
      ...(mode.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: mode.idempotencyKey })
    })
    return
  }

  const url = whatsappOnboardingUrl(projectId, {
    source: 'photon',
    verification: 'dashboard',
    voipResourceId: number.resource.resourceId
  })
  const browser = await attemptBrowserHandoff(photon, url, mode.noBrowser)
  emitHandoff(
    photon,
    photonNewWabaHandoff(projectId, number, browser.attempted, browser.opened)
  )
}
