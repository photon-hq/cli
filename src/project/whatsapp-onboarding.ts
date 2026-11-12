import { APP_ORIGIN } from '../auth/constants.ts'
import { argumentValidationError, validOptionsStep } from '../core/errors.ts'
import { ID_FORMATS, validateId } from '../core/photon-id.ts'
import {
  shellArgument,
  type TypedCommand,
  typedCommand
} from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import type { PlatformResource, WhatsappVoipNumber } from './service.ts'
import { validateIdentifier } from './validation.ts'

const META_WABA_ID_PATTERN = ID_FORMATS.metaWaba.pattern

export type WhatsappAddMode =
  | { kind: 'interactive'; noBrowser: boolean }
  | { kind: 'byon-handoff'; noBrowser: boolean }
  | {
      displayName?: string
      idempotencyKey?: string
      kind: 'photon-existing-waba'
      voipResourceId: string
      wabaId: string
    }
  | {
      kind: 'photon-new-waba-handoff'
      noBrowser: boolean
      voipResourceId: string
    }

/** The `number add` that was run, which an error's steps give again, changed. */
export interface WhatsappAddCommand {
  readonly projectId: string
  readonly typed: TypedCommand
}

export interface WhatsappAddValues {
  displayName?: string
  idempotencyKey?: string
  newWaba?: boolean
  noBrowser?: boolean
  source?: string
  voipResourceId?: string
  wabaId?: string
}

export interface WhatsappEmbeddedSignupHandoff {
  browserAttempted: boolean
  kind: 'whatsapp-embedded-signup'
  nextSteps: string[]
  opened: boolean
  projectId: string
  requiresHumanInteraction: true
  resource?: PlatformResource
  source: 'byon' | 'photon'
  url: string
  verificationOwner?: 'dashboard'
}

const invalidMode = (detail: string) =>
  argumentValidationError(detail, {
    next: [
      { description: 'Use --source byon for a browser handoff.' },
      {
        description:
          'Or use --source photon with exactly one of --waba-id or --new-waba.'
      }
    ]
  })

const validateWabaId = (value: string): string => {
  const wabaId = validateIdentifier(value, 'WABA ID')
  if (!META_WABA_ID_PATTERN.test(wabaId)) {
    throw argumentValidationError('WABA ID must contain digits only.')
  }
  return wabaId
}

const hasProvisioningOptions = (values: WhatsappAddValues): boolean =>
  values.newWaba === true ||
  values.wabaId !== undefined ||
  values.voipResourceId !== undefined ||
  values.displayName !== undefined ||
  values.idempotencyKey !== undefined

const resolveInteractiveMode = (
  values: WhatsappAddValues,
  promptBlocker: string | undefined,
  noBrowser: boolean
): WhatsappAddMode => {
  if (hasProvisioningOptions(values)) {
    throw invalidMode(
      'WABA and Photon provisioning options require --source photon.'
    )
  }
  if (promptBlocker !== undefined) {
    throw invalidMode(
      `Without --source this command asks its questions, and Photon can't ask: ${promptBlocker}.`
    )
  }
  return { kind: 'interactive', noBrowser }
}

const resolveByonMode = (
  values: WhatsappAddValues,
  noBrowser: boolean
): WhatsappAddMode => {
  if (hasProvisioningOptions(values)) {
    throw invalidMode(
      '--source byon cannot be combined with WABA, Photon-resource, display-name, or idempotency options.'
    )
  }
  return { kind: 'byon-handoff', noBrowser }
}

const resolvePhotonMode = (
  values: WhatsappAddValues,
  noBrowser: boolean,
  command: WhatsappAddCommand
): WhatsappAddMode => {
  const hasWabaId = values.wabaId !== undefined
  const hasNewWaba = values.newWaba === true
  if (hasWabaId === hasNewWaba) {
    throw invalidMode(
      '--source photon requires exactly one of --waba-id or --new-waba.'
    )
  }
  if (values.voipResourceId === undefined) {
    throw argumentValidationError(
      '--source photon requires --voip-resource-id.',
      {
        next: [
          {
            description: "List the project's SMS numbers",
            run: `${CLI_NAME} project platform sms list --project ${shellArgument(command.projectId)}`
          },
          {
            description: 'Run it with one of them',
            run: typedCommand(command.typed, {
              add: '--voip-resource-id <resource-id>'
            })
          }
        ]
      }
    )
  }
  const voipResourceId = validateId(
    'resource',
    values.voipResourceId,
    'Photon SMS resource ID'
  )
  if (hasNewWaba) {
    if (
      values.displayName !== undefined ||
      values.idempotencyKey !== undefined
    ) {
      throw argumentValidationError(
        '--source photon --new-waba does not accept --display-name or --idempotency-key because it sends no mutation.',
        {
          next: [
            {
              description: 'Run it without them',
              run: typedCommand(command.typed, {
                without: ['displayName', 'idempotencyKey']
              })
            },
            validOptionsStep(command.typed.commandPath)
          ]
        }
      )
    }
    return {
      kind: 'photon-new-waba-handoff',
      noBrowser,
      voipResourceId
    }
  }
  if (noBrowser) {
    throw argumentValidationError(
      '--no-browser is not valid with --source photon --waba-id because this mode does not open a browser.',
      {
        next: [
          {
            description: 'Run it without --no-browser',
            run: typedCommand(command.typed, { without: ['noBrowser'] })
          },
          validOptionsStep(command.typed.commandPath)
        ]
      }
    )
  }
  return {
    ...(values.displayName === undefined
      ? {}
      : { displayName: values.displayName }),
    ...(values.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: values.idempotencyKey }),
    kind: 'photon-existing-waba',
    voipResourceId,
    wabaId: validateWabaId(values.wabaId ?? '')
  }
}

/**
 * What `whatsapp-business number add` does, from its options. Without
 * `--source` it asks, which needs a terminal: `promptBlocker` is why it may
 * not ask, if it may not. An error's steps give `command` again, changed.
 */
export const resolveWhatsappAddMode = (
  values: WhatsappAddValues,
  promptBlocker: string | undefined,
  command: WhatsappAddCommand
): WhatsappAddMode => {
  const noBrowser = values.noBrowser ?? false
  if (values.source === undefined) {
    return resolveInteractiveMode(values, promptBlocker, noBrowser)
  }

  if (values.source === 'byon') {
    return resolveByonMode(values, noBrowser)
  }

  if (values.source !== 'photon') {
    throw invalidMode('--source must be either byon or photon.')
  }
  return resolvePhotonMode(values, noBrowser, command)
}

export const whatsappOnboardingUrl = (
  projectId: string,
  options:
    | { source: 'byon' }
    | {
        source: 'photon'
        verification: 'dashboard' | 'terminal'
        voipResourceId: string
      }
): string => {
  const url = new URL(
    `/${encodeURIComponent(projectId)}/platforms/whatsapp-business`,
    APP_ORIGIN
  )
  url.searchParams.set('onboarding', 'cli')
  url.searchParams.set('source', options.source)
  if (options.source === 'photon') {
    url.searchParams.set('voipResourceId', options.voipResourceId)
    url.searchParams.set('verification', options.verification)
  }
  return url.toString()
}

export const byonHandoff = (
  projectId: string,
  browserAttempted: boolean,
  opened: boolean
): WhatsappEmbeddedSignupHandoff => ({
  browserAttempted,
  kind: 'whatsapp-embedded-signup',
  nextSteps: [
    'Continue setup in the Photon dashboard.',
    'Sign in to Meta when prompted.',
    'Select your WhatsApp Business Account and phone number.',
    'Complete phone verification in the browser.',
    'Wait for the dashboard to confirm the connected sender.'
  ],
  opened,
  projectId,
  requiresHumanInteraction: true,
  source: 'byon',
  url: whatsappOnboardingUrl(projectId, { source: 'byon' })
})

export const photonNewWabaHandoff = (
  projectId: string,
  number: WhatsappVoipNumber,
  browserAttempted: boolean,
  opened: boolean
): WhatsappEmbeddedSignupHandoff => ({
  browserAttempted,
  kind: 'whatsapp-embedded-signup',
  nextSteps: [
    'Continue setup in the Photon dashboard.',
    `Enter ${number.displayPhoneNumber} when Meta asks which number to connect.`,
    'Before clicking Send code in Meta, follow the dashboard verification instructions.',
    'Copy the OTP displayed by Photon into Meta.',
    'Wait for the dashboard to confirm the connected sender.'
  ],
  opened,
  projectId,
  requiresHumanInteraction: true,
  resource: number.resource,
  source: 'photon',
  url: whatsappOnboardingUrl(projectId, {
    source: 'photon',
    verification: 'dashboard',
    voipResourceId: number.resource.resourceId
  }),
  verificationOwner: 'dashboard'
})
