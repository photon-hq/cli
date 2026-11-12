import { CLI_NAME } from '../meta.ts'
import { argumentValidationError } from './errors.ts'
import { boundedText, invalidInput } from './validation.ts'

const MAX_ID_LENGTH = 512
// A TypeID's suffix: a UUID as 26 lowercase Crockford base32 characters, the
// first of which is 0–7. Photon's services mint their IDs as TypeIDs.
const TYPE_ID_SUFFIX = '[0-7][0-9a-hjkmnp-tv-z]{25}'
// A full project API key: its ID, "_", and the secret.
export const API_KEY_CREDENTIAL_PATTERN =
  /^(pho_sk_[0-9a-hjkmnp-tv-z]{26})_[A-Za-z0-9_-]+$/u
// Characters that would end or escape a URL path segment.
const PATH_UNSAFE_PATTERN = /[\s/?#%]/u

export interface IdFormat {
  readonly format: string
  readonly pattern: RegExp
}

export const typeId = (prefix: string): IdFormat => ({
  format: `a canonical ${prefix} identifier`,
  pattern: new RegExp(`^${prefix}${TYPE_ID_SUFFIX}$`, 'u')
})

// The exact format of every ID a public command takes. Internal-only
// commands keep theirs in src/internal/ids.ts.
export const ID_FORMATS = {
  account: typeId('pho_acc_'),
  accountServiceKey: typeId('pho_ask_'),
  apiKey: typeId('pho_sk_'),
  assignment: typeId('pho_asg_'),
  // The billing service derives these from a SHA-256 of the request.
  billingOperation: {
    format: 'pho_bop_ followed by 64 lowercase hexadecimal characters',
    pattern: /^pho_bop_[0-9a-f]{64}$/u
  },
  invitation: typeId('pho_oinv_'),
  // The journal's own IDs, which this CLI mints.
  localOperation: {
    format: 'op_ followed by a UUID, as operation list shows it',
    pattern:
      /^op_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  },
  // Meta's WhatsApp Business Account ID.
  metaWaba: { format: 'digits only', pattern: /^\d+$/u },
  oauthApplication: {
    format: 'connect_app_ followed by letters or numbers',
    pattern: /^connect_app_[A-Za-z0-9]+$/u
  },
  oauthClient: {
    format: 'client_ followed by letters or numbers',
    pattern: /^client_[A-Za-z0-9]+$/u
  },
  organization: typeId('pho_org_'),
  platformOperation: typeId('pho_opr_'),
  project: typeId('pho_prj_'),
  resource: typeId('pho_res_'),
  voiceProfile: typeId('pho_vpf_'),
  webhookDestination: typeId('pho_whd_')
} as const satisfies Record<string, IdFormat>

export type IdKind = keyof typeof ID_FORMATS

export const validateIdFormat = (
  value: string,
  label: string,
  { format, pattern }: IdFormat
): string => {
  const id = boundedText(value, label, MAX_ID_LENGTH)
  if (!pattern.test(id)) {
    throw invalidInput(`${label} must be ${format}.`)
  }
  return id
}

export const validateId = (
  kind: IdKind,
  value: string,
  label: string
): string => validateIdFormat(value, label, ID_FORMATS[kind])

// An argument's parse function, so the ID is checked before the command runs.
export const idArgument =
  (kind: IdKind, label: string) =>
  (value: string): string =>
    validateId(kind, value, label)

// The api-key-id argument's parse function. A full key passes, so that
// validateApiKeyId can name the command to run with the key's ID instead.
export const apiKeyIdArgument = (value: string): string =>
  API_KEY_CREDENTIAL_PATTERN.test(value.trim())
    ? value
    : validateId('apiKey', value, 'API key ID')

// The --waba-id option's parse function. A value that isn't a WABA ID names the
// option, and its step lists the project's connected WABA, whose ID it takes.
// A parse function can't see --project, so the step leaves the project out.
export const wabaIdArgument = (value: string): string => {
  const id = boundedText(value, '--waba-id', MAX_ID_LENGTH)
  if (!ID_FORMATS.metaWaba.pattern.test(id)) {
    throw argumentValidationError(
      `--waba-id must be ${ID_FORMATS.metaWaba.format}.`,
      {
        next: [
          {
            description: "See the connected WABA's ID",
            run: `${CLI_NAME} project platform whatsapp-business account list --project <project-id>`
          }
        ]
      }
    )
  }
  return id
}

// A value another system issues, such as a request ID, keeps that system's
// format, but it can never be "." or "..", or end a URL path segment.
export const validateOpaqueId = (
  value: string,
  label: string,
  maximumLength = MAX_ID_LENGTH
): string => {
  const id = boundedText(value, label, maximumLength)
  if (id === '.' || id === '..' || PATH_UNSAFE_PATTERN.test(id)) {
    throw invalidInput(
      `${label} cannot be "." or "..", or contain whitespace, /, ?, # or %.`
    )
  }
  return id
}
