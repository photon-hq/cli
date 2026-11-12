import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../../app/services.ts'
import type { CliOutput } from '../../../../core/output.ts'
import { detail, inert, table } from '../../../../core/presenter.ts'
import { CLI_NAME } from '../../../../meta.ts'
import { resolveProjectId } from '../../../../project/command-helpers.ts'
import { platformResourceTelegramUsername } from '../../../../project/presenter.ts'
import {
  isResourceOperationInProgress,
  type OperationWithResource,
  type PlatformResource,
  type ResourceOperation
} from '../../../../project/service.ts'
import {
  selectTelegramBotDetail,
  selectTelegramOperationName,
  telegramConnectionIssueGuidance
} from '../../../../project/telegram.ts'
import { validatePagination } from '../../../../project/validation.ts'
import { cancelled, confirmRiskyAction } from '../../../helpers.ts'
import { operationStateStyle, presentPlatformResourceList } from '../run.ts'
import type {
  TelegramConnectParams,
  TelegramDisconnectParams,
  TelegramListParams,
  TelegramViewParams
} from './definition.ts'

const CONNECT_COMMAND = `${CLI_NAME} project platform telegram connect`
const CANCEL_COMMAND = `${CLI_NAME} project platform operation cancel`

const telegramBotHealth = (resource: PlatformResource): string | undefined => {
  const bot = selectTelegramBotDetail(resource.detail)
  if (bot === undefined) {
    return
  }
  return bot.connectionIssue === undefined ? 'healthy' : 'needs attention'
}

const telegramBotDetails = (
  output: CliOutput,
  resource: PlatformResource
): string[] => {
  const bot = selectTelegramBotDetail(resource.detail)
  const lines = detail(output, 'Telegram bot', [
    { label: 'Name', value: bot?.displayName },
    {
      label: 'Username',
      value: bot === undefined ? undefined : `@${bot.username}`
    },
    { label: 'Link', value: bot?.url },
    { label: 'Resource ID', value: resource.resourceId },
    { label: 'State', value: resource.state },
    { label: 'Health', value: telegramBotHealth(resource) },
    { label: 'Abilities', value: resource.abilities },
    { label: 'Project', value: resource.projectId },
    { label: 'Created', value: resource.createdAt },
    { label: 'Updated', value: resource.updatedAt },
    { label: 'Retired', value: resource.retiredAt }
  ])
  return bot?.connectionIssue === undefined
    ? lines
    : [
        ...lines,
        '',
        output.style(
          'yellow',
          telegramConnectionIssueGuidance(bot.connectionIssue)
        )
      ]
}

const telegramSetupTable = (
  output: CliOutput,
  operation: ResourceOperation
): string[] =>
  table(
    output,
    ['BOT', 'OPERATION ID', 'STATE'],
    [
      [
        selectTelegramOperationName(operation.detail) ?? 'Not chosen yet',
        { style: 'cyan', text: operation.operationId },
        { style: operationStateStyle(operation.state), text: operation.state }
      ]
    ],
    'No Telegram bot setup returned.',
    { bordered: true }
  )

// The QR code is for a person holding a phone. It is left out when nobody is
// at the terminal, and a failure to draw it costs nothing: the link is printed.
const telegramSetupQr = async (
  photon: PhotonCommandServices,
  setupUrl: string
): Promise<string[]> => {
  if (!photon.input.interactive) {
    return []
  }
  try {
    const qr = await photon.mfaQr(setupUrl)
    return [
      '',
      'Or scan this code with the phone that has Telegram:',
      qr.trimEnd()
    ]
  } catch {
    return []
  }
}

const launchTelegramSetup = async (
  photon: PhotonCommandServices,
  setupUrl: string | undefined,
  noBrowser: boolean
): Promise<string[]> => {
  if (setupUrl === undefined) {
    photon.output.warning(
      `Photon did not return the setup link. Run "${CONNECT_COMMAND}" again to get it.`
    )
    return []
  }
  const instructions = [
    '',
    'Open this link in Telegram, then choose or create the bot there:',
    photon.output.style('cyan', inert(setupUrl)),
    ...(await telegramSetupQr(photon, setupUrl))
  ]
  if (noBrowser) {
    return instructions
  }
  try {
    await photon.browser.open(setupUrl)
    return [
      ...instructions,
      '',
      photon.output.style('green', 'Opened the setup link in your browser.')
    ]
  } catch {
    photon.output.warning(
      'The browser could not be opened. Open the setup link manually.'
    )
    return instructions
  }
}

const presentConnectedTelegramBot = (
  photon: PhotonCommandServices,
  connected: OperationWithResource
): void => {
  const username = platformResourceTelegramUsername(connected.resource)
  photon.output.success(connected, [
    photon.output.style(
      'green',
      username === undefined
        ? 'Connected the Telegram bot.'
        : inert(`Connected ${username}.`)
    ),
    ...telegramBotDetails(photon.output, connected.resource)
  ])
}

const waitForTelegramBot = async (
  photon: PhotonCommandServices,
  projectId: string,
  operationId: string
): Promise<void> => {
  presentConnectedTelegramBot(
    photon,
    await photon.output.withLoading(
      'Waiting for the bot to be connected in Telegram',
      async () =>
        await photon.projects.waitForTelegramBotConnection(
          projectId,
          operationId
        ),
      { nonInteractive: 'silent' }
    )
  )
}

interface TelegramProjectState {
  connected: string[]
  setupInProgress: boolean
}

const CONNECTED_BOTS_LIMIT = 30

// `connect` always adds a bot. On a project that already has one it asks
// before a setup is started, and `--yes` answers; a failure to read the bots
// never stands in the way of connecting.
const telegramProjectState = async (
  photon: PhotonCommandServices,
  projectId: string
): Promise<TelegramProjectState> => {
  try {
    const { provisioning, resources } =
      await photon.projects.listPlatformResources(projectId, 'telegram', {
        limit: CONNECTED_BOTS_LIMIT
      })
    return {
      connected: resources.map(
        (bot) => platformResourceTelegramUsername(bot) ?? bot.resourceId
      ),
      setupInProgress: provisioning.length > 0
    }
  } catch {
    return { connected: [], setupInProgress: false }
  }
}

export const runTelegramList: CommandRunner<TelegramListParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const result = await photon.projects.listPlatformResources(
    projectId,
    'telegram',
    validatePagination(context.values.limit, context.values.pageToken)
  )
  presentPlatformResourceList(photon, { command: context, projectId }, result, {
    emptyMessage: 'No Telegram bots found.',
    heading: 'Telegram bots',
    healthOf: telegramBotHealth,
    hideResourceType: true,
    identityHeading: 'BOT',
    identityOf: platformResourceTelegramUsername,
    includeHealth: true,
    provisioningHint: `Continue a setup in progress with "${CONNECT_COMMAND}".`
  })
}

export const runTelegramConnect: CommandRunner<TelegramConnectParams> = async (
  context
) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const { connected, setupInProgress } = await telegramProjectState(
    photon,
    projectId
  )
  const alreadyConnected =
    connected.length === 0
      ? undefined
      : `Project ${projectId} already has ${connected.join(', ')} connected.`
  // The question is for a request that would start a setup. A setup already in
  // progress is continued, and so is a request recorded under the supplied key;
  // declining either would only hide the setup link. A key with no record
  // starts a setup like no key at all.
  const continued = await photon.operations.continuationIntent(
    'telegram-bot.connect',
    context.values.idempotencyKey,
    (intent) => intent.projectId === projectId
  )
  const startsSetup = !setupInProgress && continued === undefined
  if (alreadyConnected !== undefined && startsSetup) {
    const confirmed = await confirmRiskyAction(context, {
      action: `connect another Telegram bot to project ${projectId}`,
      consequence: alreadyConnected,
      scope: { project: projectId }
    })
    if (!confirmed) {
      cancelled(photon)
      return
    }
  }
  const connection = (
    await photon.operations.execute(
      { kind: 'telegram-bot.connect', projectId },
      context.values.idempotencyKey,
      async ({ idempotencyKey, updateRemoteOperationId }) =>
        await photon.output.withLoading(
          'Starting the Telegram bot setup',
          async () =>
            await photon.projects.connectTelegramBot(
              projectId,
              idempotencyKey,
              updateRemoteOperationId
            ),
          { nonInteractive: 'silent' }
        )
    )
  ).result
  const { operation } = connection.response
  const { operationId } = operation
  if (!isResourceOperationInProgress(operation.state)) {
    // An idempotency key was replayed after its setup finished.
    await waitForTelegramBot(photon, projectId, operationId)
    return
  }
  const human = [
    photon.output.style(
      'green',
      connection.resumed
        ? 'Continuing the Telegram bot setup already in progress.'
        : 'Started a Telegram bot setup.'
    ),
    ...telegramSetupTable(photon.output, operation),
    ...(alreadyConnected === undefined
      ? []
      : ['', inert(`${alreadyConnected} This setup adds another bot.`)]),
    ...(connection.resumed
      ? [
          '',
          inert(
            `A project has one Telegram setup at a time. To start over, run "${CANCEL_COMMAND} ${operationId}", then connect again.`
          )
        ]
      : []),
    ...(await launchTelegramSetup(
      photon,
      connection.setupUrl,
      context.values.noBrowser ?? false
    ))
  ]
  if (context.values.wait === false) {
    photon.output.success(connection.response, human)
    return
  }
  human.push(
    '',
    'Waiting for the bot to be connected in Telegram. Press Ctrl-C to stop waiting; the setup stays open and this command continues it.'
  )
  await photon.output.beforeWait(human)
  await waitForTelegramBot(photon, projectId, operationId)
}

export const runTelegramView: CommandRunner<TelegramViewParams> = async (
  context
) => {
  const { photon } = context.extensions
  const resource = await photon.projects.getTelegramBot(
    await resolveProjectId(photon),
    context.values['resource-id']
  )
  photon.output.success(resource, telegramBotDetails(photon.output, resource))
}

export const runTelegramDisconnect: CommandRunner<
  TelegramDisconnectParams
> = async (context) => {
  const { photon } = context.extensions
  const projectId = await resolveProjectId(photon)
  const resourceId = context.values['resource-id']
  const confirmed = await confirmRiskyAction(context, {
    action: `disconnect Telegram bot resource ${resourceId} from project ${projectId}`,
    consequence:
      'The bot stops sending and receiving through Photon. It is not deleted from Telegram.',
    scope: { project: projectId }
  })
  if (!confirmed) {
    cancelled(photon)
    return
  }
  const execution = await photon.output.withLoading(
    `Disconnecting Telegram bot resource ${resourceId}`,
    async () =>
      await photon.operations.execute(
        { kind: 'telegram-bot.disconnect', projectId, resourceId },
        undefined,
        async ({ updateRemoteOperationId }) =>
          await photon.projects.disconnectTelegramBot(
            projectId,
            resourceId,
            updateRemoteOperationId
          )
      ),
    { nonInteractive: 'silent' }
  )
  photon.output.success(execution.result, [
    photon.output.style(
      'green',
      `Disconnected Telegram bot resource ${resourceId}.`
    ),
    'The bot still exists in Telegram and is still yours.'
  ])
}
