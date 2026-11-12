import { defineWithTypes } from 'gunshi'
import { API_TOKEN_VARIABLE } from '../../auth/constants.ts'
import { CLI_NAME } from '../../meta.ts'
import type { PhotonCommandParams } from '../types.ts'

export const loginArgs = {
  browser: {
    default: true,
    description: 'Open the verification page in a browser',
    negatable: true,
    type: 'boolean'
  },
  force: {
    default: false,
    description: 'Replace the current session after a new login succeeds',
    type: 'boolean'
  },
  insecureStorage: {
    default: false,
    description:
      'Store credentials in a protected file instead of an OS keychain',
    toKebab: true,
    type: 'boolean'
  },
  serviceKey: {
    default: false,
    description: 'Read an account service key from non-interactive stdin',
    toKebab: true,
    type: 'boolean'
  }
} as const

export type LoginParams = PhotonCommandParams<typeof loginArgs>

export const loginDefinition = defineWithTypes<LoginParams>()({
  args: loginArgs,
  description: 'Log in with a device code or account service key',
  examples: [
    '# Sign in. An agent runs this and passes the printed link and code to a person, who approves the sign-in in a browser:',
    `$ ${CLI_NAME} login`,
    `# Where no one can approve a sign-in (CI, a scheduled job), set a Photon key instead. ${CLI_NAME} uses it for each command and saves no credential:`,
    `$ export ${API_TOKEN_VARIABLE}=<key>`
  ].join('\n'),
  name: 'login',
  toKebab: true
})
