import { ACCOUNT_GOLDENS } from './account.ts'
import { BILLING_GOLDENS } from './billing.ts'
import { OAUTH_GOLDENS } from './oauth.ts'
import { OPERATION_REPLAY_GOLDENS } from './operation-replay.ts'
import { ORG_GOLDENS } from './org.ts'
import { PLATFORM_GOLDENS } from './platform.ts'
import { PLATFORM_OPERATION_GOLDENS } from './platform-operations.ts'
import { PROJECT_GOLDENS } from './project.ts'
import { SESSION_GOLDENS } from './session.ts'
import type { GoldenCase } from './support.ts'
import { VOICE_GOLDENS } from './voice.ts'
import { WEBHOOK_GOLDENS } from './webhook.ts'
import { WHATSAPP_BUSINESS_GOLDENS } from './whatsapp-business.ts'

/** Every golden test, one per command. */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  ...ACCOUNT_GOLDENS,
  ...BILLING_GOLDENS,
  ...OAUTH_GOLDENS,
  ...OPERATION_REPLAY_GOLDENS,
  ...ORG_GOLDENS,
  ...PLATFORM_GOLDENS,
  ...PLATFORM_OPERATION_GOLDENS,
  ...PROJECT_GOLDENS,
  ...SESSION_GOLDENS,
  ...VOICE_GOLDENS,
  ...WEBHOOK_GOLDENS,
  ...WHATSAPP_BUSINESS_GOLDENS
]
