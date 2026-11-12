import { createHash } from 'node:crypto'
import { ID_FORMATS, type IdFormat, typeId } from '../core/photon-id.ts'
import { API_TOKEN_VARIABLE } from './constants.ts'

/** The kinds of Photon key, told apart by their ID as Photon's gateway does. */
export type EnvironmentKeyKind =
  | 'account_service_key'
  | 'project_api_key'
  | 'service_identity_key'
  | 'unknown'

/**
 * The key in this build's API token variable. It is used for this process
 * only: the CLI never writes it to disk or a keychain.
 */
export interface EnvironmentKey {
  /** The key's public ID, the part before its secret, when its shape is known. */
  keyId?: string
  kind: EnvironmentKeyKind
  secret: string
  variable: string
}

// A Photon key is its ID (a TypeID), an underscore, then its secret.
const KEY_FORMATS: readonly [
  Exclude<EnvironmentKeyKind, 'unknown'>,
  IdFormat,
  string
][] = [
  ['account_service_key', ID_FORMATS.accountServiceKey, 'pho_ask_'],
  ['project_api_key', ID_FORMATS.apiKey, 'pho_sk_'],
  ['service_identity_key', typeId('pho_scred_'), 'pho_scred_']
]
const TYPE_ID_SUFFIX_LENGTH = 26

/** The key in the environment, or `undefined` when the variable is unset or empty. */
export const environmentKey = (
  env: NodeJS.ProcessEnv
): EnvironmentKey | undefined => {
  const secret = env[API_TOKEN_VARIABLE]?.trim()
  if (secret === undefined || secret === '') {
    return
  }
  for (const [kind, format, prefix] of KEY_FORMATS) {
    const keyId = secret.slice(0, prefix.length + TYPE_ID_SUFFIX_LENGTH)
    if (
      format.pattern.test(keyId) &&
      secret.length > keyId.length + 1 &&
      secret[keyId.length] === '_'
    ) {
      return { keyId, kind, secret, variable: API_TOKEN_VARIABLE }
    }
  }
  return { kind: 'unknown', secret, variable: API_TOKEN_VARIABLE }
}

/**
 * What names the key in files keyed by identity, such as the selected
 * organization: its public ID, never its secret. A value of no known shape has
 * no ID, and Photon's gateway takes it as a session token, so it is named by a
 * SHA-256 digest: two such values never share a saved selection.
 */
export const environmentKeyIdentity = (key: EnvironmentKey): string =>
  key.keyId ??
  `${key.variable}:${createHash('sha256').update(key.secret).digest('hex')}`
