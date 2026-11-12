import { defineWithTypes, lazyWithTypes } from 'gunshi'
import { idArgument } from '../../../../core/photon-id.ts'
import { idempotencyKeyArg, yesArg } from '../../../args.ts'
import { runs, skip, tested } from '../../../production-test.ts'
import type { PhotonCommandParams } from '../../../types.ts'
import { paginationArgs } from '../../args.ts'

type TelegramParams = PhotonCommandParams

const telegramListArgs = { ...paginationArgs } as const
const telegramConnectArgs = {
  idempotencyKey: idempotencyKeyArg,
  noBrowser: {
    default: false,
    description: 'Print the Telegram setup link without opening it',
    toKebab: true,
    type: 'boolean'
  },
  wait: {
    default: true,
    description: 'Wait for the bot to be connected in Telegram',
    negatable: true,
    type: 'boolean'
  },
  yes: yesArg
} as const
const telegramBotArgs = {
  'resource-id': {
    description: 'Telegram bot resource ID',
    parse: idArgument('resource', 'Telegram bot resource ID'),
    type: 'positional'
  }
} as const
const telegramDisconnectArgs = {
  ...telegramBotArgs,
  yes: yesArg
} as const

export type TelegramListParams = PhotonCommandParams<typeof telegramListArgs>
export type TelegramConnectParams = PhotonCommandParams<
  typeof telegramConnectArgs
>
export type TelegramViewParams = PhotonCommandParams<typeof telegramBotArgs>
export type TelegramDisconnectParams = PhotonCommandParams<
  typeof telegramDisconnectArgs
>

const telegramListDefinition = defineWithTypes<TelegramListParams>()({
  args: telegramListArgs,
  description: 'List project Telegram bots and setups in progress',
  name: 'list',
  toKebab: true
})
const telegramConnectDefinition = defineWithTypes<TelegramConnectParams>()({
  args: telegramConnectArgs,
  description: 'Connect a Telegram bot to the project',
  name: 'connect'
})
const telegramViewDefinition = defineWithTypes<TelegramViewParams>()({
  args: telegramBotArgs,
  description: 'View a project Telegram bot',
  name: 'view'
})
const telegramDisconnectDefinition =
  defineWithTypes<TelegramDisconnectParams>()({
    args: telegramDisconnectArgs,
    description: 'Disconnect a Telegram bot from the project',
    name: 'disconnect'
  })

export const telegramCommand = defineWithTypes<TelegramParams>()({
  description: 'Inspect and manage project Telegram bots',
  name: 'telegram',
  subCommands: {
    connect: tested(
      skip('needs a person to create the bot in Telegram from the setup link'),
      lazyWithTypes<TelegramConnectParams>()(
        async () => (await import('./run.ts')).runTelegramConnect,
        telegramConnectDefinition
      )
    ),
    disconnect: tested(
      skip('needs a connected Telegram bot, which a person creates'),
      lazyWithTypes<TelegramDisconnectParams>()(
        async () => (await import('./run.ts')).runTelegramDisconnect,
        telegramDisconnectDefinition
      )
    ),
    list: tested(
      runs,
      lazyWithTypes<TelegramListParams>()(
        async () => (await import('./run.ts')).runTelegramList,
        telegramListDefinition
      )
    ),
    view: tested(
      skip('needs a connected Telegram bot, which a person creates'),
      lazyWithTypes<TelegramViewParams>()(
        async () => (await import('./run.ts')).runTelegramView,
        telegramViewDefinition
      )
    )
  }
})
