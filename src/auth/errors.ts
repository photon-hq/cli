import type { ApiError } from '@photon-ai/api'
import {
  CliError,
  copyCliError,
  joinSentences,
  SIGN_IN_EXIT_CODE
} from '../core/errors.ts'
import { apiProblemError } from '../core/sdk-error.ts'
import { CLI_NAME } from '../meta.ts'
import { API_TOKEN_VARIABLE } from './constants.ts'
import type { EnvironmentKey, EnvironmentKeyKind } from './environment-key.ts'

/**
 * The error for a run with no credential at all. Every command that finds
 * no sign-in throws this one, so each prints the same message and step.
 */
export const notSignedInError = (): CliError =>
  new CliError('NOT_AUTHENTICATED', 'You are not signed in to Photon.', {
    exitCode: SIGN_IN_EXIT_CODE,
    next: [{ description: 'Sign in', person: true, run: `${CLI_NAME} login` }]
  })

/**
 * `photon login` while a key is in the environment. The key would still win,
 * so a stored sign-in would go unused (gh refuses `gh auth login` under
 * `GH_TOKEN` the same way).
 */
export const environmentKeySet = (key: EnvironmentKey): CliError =>
  new CliError(
    'AUTH_ENVIRONMENT_KEY_SET',
    `${key.variable} is set, so ${CLI_NAME} uses its key and does not save a sign-in.`,
    {
      exitCode: 2,
      next: [
        {
          description: `To sign in with ${CLI_NAME} login instead, unset ${key.variable}`,
          person: true
        }
      ]
    }
  )

/**
 * Photon refused the key from the environment (HTTP 401): it is missing,
 * expired or revoked. The step is replacing the secret where it is set, since
 * signing in wouldn't change the key this run uses. The error is built as a
 * sensitive one, keeping none of the API's wording, because it is raised
 * before the command's own mapping, which knows whether its request is
 * sensitive (a service key, a verification code).
 */
export const environmentKeyRejected = (error: ApiError): CliError =>
  copyCliError(
    apiProblemError(error, true),
    {
      exitCode: SIGN_IN_EXIT_CODE,
      next: [
        {
          description: `Replace the key in ${API_TOKEN_VARIABLE} with a valid one`,
          person: true
        }
      ]
    },
    `Photon refused the key in ${API_TOKEN_VARIABLE}.`
  )

const ENVIRONMENT_KEY_NAMES: Readonly<Record<EnvironmentKeyKind, string>> = {
  account_service_key: 'account service key',
  project_api_key: 'project API key',
  service_identity_key: 'service identity API key',
  unknown: 'key'
}

/**
 * Photon refused the key from the environment for this request (HTTP 403),
 * often because it is the wrong kind of key. The error names the key's kind
 * and where it came from. The command's own message, which carries the API's
 * words and any kinds they name, becomes the detail. The code and exit code
 * stay the API's.
 */
export const environmentKeyRefused = (
  error: CliError,
  key: EnvironmentKey
): CliError =>
  copyCliError(
    error,
    {
      detail:
        error.detail === undefined
          ? error.message
          : joinSentences(error.message, error.detail)
    },
    `The ${ENVIRONMENT_KEY_NAMES[key.kind]} in ${key.variable} isn't allowed to do this.`
  )
