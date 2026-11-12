import { ID_FORMATS } from '../core/photon-id.ts'
export const TELEGRAM_ABILITY = 'telegram'
export const TELEGRAM_BOT_RESOURCE_TYPE = 'telegram_bot'
export const TELEGRAM_PROVISION_IN_PROGRESS_CODE =
  'TELEGRAM_PROVISION_IN_PROGRESS'

const TELEGRAM_HOSTNAME = 't.me'
const TELEGRAM_USERNAME_PATH_PATTERN = /^\/[a-z][a-z0-9_]{4,31}$/iu
const TELEGRAM_START_PARAMETER_PATTERN = /^[a-z0-9_-]{1,64}$/iu
const UNSAFE_URL_TEXT_PATTERN = /[\s\\#]/u

export interface TelegramBotDetail {
  connectionIssue?: string
  displayName: string
  url: string
  username: string
}

// Both links are opened or printed for a person to follow, so anything other
// than an https://t.me/<username> address is treated as absent.
const telegramUrl = (value: unknown): URL | undefined => {
  if (typeof value !== 'string' || UNSAFE_URL_TEXT_PATTERN.test(value)) {
    return
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === TELEGRAM_HOSTNAME &&
      url.port.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      TELEGRAM_USERNAME_PATH_PATTERN.test(url.pathname)
      ? url
      : undefined
  } catch {
    // An unparseable address is treated as absent.
  }
}

// Telegram names are chosen by the bot's owner; a blank one counts as absent.
const nonBlankText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return
  }
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

// The setup link carries the authority to connect a bot to the project. The
// API includes it only for callers that may write the project's platforms.
export const selectTelegramSetupUrl = (
  detail: Record<string, unknown> | undefined
): string | undefined => {
  const url = telegramUrl(detail?.setupUrl)
  if (
    url === undefined ||
    url.searchParams.size !== 1 ||
    !TELEGRAM_START_PARAMETER_PATTERN.test(url.searchParams.get('start') ?? '')
  ) {
    return
  }
  return url.href
}

export const selectTelegramOperationName = (
  detail: Record<string, unknown> | undefined
): string | undefined => nonBlankText(detail?.displayName)

export const selectTelegramBotDetail = (
  detail: Record<string, unknown>
): TelegramBotDetail | undefined => {
  const displayName = nonBlankText(detail.displayName)
  const url = telegramUrl(detail.url)
  const { username } = detail
  if (
    displayName === undefined ||
    typeof username !== 'string' ||
    url === undefined ||
    url.search.length > 0 ||
    url.pathname.slice(1).toLowerCase() !== username.toLowerCase()
  ) {
    return
  }
  const connectionIssue = nonBlankText(detail.connectionIssue)
  return {
    ...(connectionIssue === undefined ? {} : { connectionIssue }),
    displayName,
    url: url.href,
    username
  }
}

export const telegramConnectionIssueGuidance = (issue: string): string => {
  switch (issue) {
    case 'owner_changed':
      return 'The owner of this bot changed in Telegram. Disconnect it, then connect it again as the current owner.'
    case 'ownership_unverified':
      return 'Photon could not verify the owner of this bot. Check the bot in Telegram, then disconnect it and connect it again.'
    case 'management_access_lost':
      return 'Photon no longer has management access to this bot. Disconnect it, then connect it again and approve management access in Telegram.'
    default:
      return 'The Telegram connection of this bot needs attention. Check the bot in Telegram, then disconnect it and connect it again.'
  }
}

const PLATFORM_OPERATION_ID_PATTERN = ID_FORMATS.platformOperation.pattern

// A refused connect names the setup that occupies the project's single slot.
export const selectTelegramProvisionInProgress = (
  problem: unknown
): string | undefined => {
  if (typeof problem !== 'object' || problem === null) {
    return
  }
  const operationId = 'operationId' in problem ? problem.operationId : undefined
  return typeof operationId === 'string' &&
    PLATFORM_OPERATION_ID_PATTERN.test(operationId)
    ? operationId
    : undefined
}
