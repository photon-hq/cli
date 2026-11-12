import { API_TOKEN_VARIABLE } from '../auth/constants.ts'
import { CliError, type NextStep } from '../core/errors.ts'
import { shellArgument } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import { withoutApiKeySecrets } from '../project/validation.ts'
import {
  LEGACY_VALUE_OPTIONS,
  legacyCommandLine
} from './legacy-command-line.ts'
import { commandWords } from './moved.ts'

// Top-level commands only Photon CLI 1.0 has. A 1.0 user who reaches this CLI
// through npm's latest tag is sent back to 1.0 instead of getting an
// unknown-command error. A name leaves this list when a 3.x command takes it.
export const LEGACY_COMMANDS: ReadonlySet<string> = new Set([
  'billing',
  'config',
  'env',
  'ping',
  'profile',
  'projects',
  'spectrum'
])

// 1.0's credentials. This CLI never reads them, so a run that has one and no
// API token variable is most likely meant for 1.0.
const LEGACY_TOKEN_VARIABLES = ['PHOTON_TOKEN', 'DASHBOARD_TOKEN'] as const

const HELP_OR_VERSION: ReadonlySet<string> = new Set([
  '--help',
  '--version',
  '-h',
  '-v'
])

// The step to run the command line on Photon CLI 1.0, and the detail that says
// what the step changes beyond the order of the arguments.
const legacyPointer = (
  args: readonly string[]
): { detail: string | undefined; step: NextStep } => {
  const commandLine = legacyCommandLine(args)
  return {
    detail: commandLine.detail,
    step: {
      description: 'Use Photon CLI 1.0',
      run: [
        'npx @photon-ai/cli@legacy',
        ...commandLine.args.map((arg) =>
          shellArgument(withoutApiKeySecrets(arg))
        )
      ].join(' ')
    }
  }
}

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== ''

// Returns the pointer to Photon CLI 1.0 for a 1.0-only command, or for a 1.0
// credential in the environment when the command needs credentials. Help and
// version need none, so they still run with a 1.0 credential set. They are
// read the way the parser reads them: the first "--" ends the options, and a
// --help or --version after it is an operand (POSIX Utility Syntax Guideline
// 10).
export const legacyCliError = (
  args: readonly string[],
  env: NodeJS.ProcessEnv
): CliError | undefined => {
  const [first] = commandWords(args, LEGACY_VALUE_OPTIONS)
  if (first !== undefined && LEGACY_COMMANDS.has(first)) {
    const { detail, step } = legacyPointer(args)
    return new CliError(
      'LEGACY_COMMAND',
      `"${CLI_NAME} ${first}" is a Photon CLI 1.0 command.`,
      { detail, exitCode: 2, next: [step] }
    )
  }
  const tokens = LEGACY_TOKEN_VARIABLES.filter((name) => isSet(env[name]))
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  if (
    tokens.length === 0 ||
    isSet(env[API_TOKEN_VARIABLE]?.trim()) ||
    commandWords(args).length === 0 ||
    options.some((arg) => HELP_OR_VERSION.has(arg))
  ) {
    return
  }
  const { detail, step } = legacyPointer(args)
  return new CliError(
    'LEGACY_TOKEN',
    `${tokens.join(' and ')} ${tokens.length === 1 ? 'is a Photon CLI 1.0 credential' : 'are Photon CLI 1.0 credentials'}, which this CLI does not read.`,
    {
      detail,
      exitCode: 2,
      next: [
        step,
        {
          description: `To use ${CLI_NAME} instead, unset ${tokens.join(' and ')}.`
        }
      ]
    }
  )
}
