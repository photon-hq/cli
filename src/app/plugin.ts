import {
  type CliOptions,
  type Commandable,
  type CommandContext,
  plugin
} from 'gunshi'
import { getCommandSubCommands } from 'gunshi/utils'
import { environmentKey } from '../auth/environment-key.ts'
import { environmentKeyRefused } from '../auth/errors.ts'
import {
  argumentValidationError,
  type CliError,
  copyCliError,
  hasOwnNextSteps,
  normalizeCliError,
  validOptionsStep
} from '../core/errors.ts'
import { shellArgument } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'
import { commandAtPath, commandReference } from './command-reference.ts'
import { PHOTON_GLOBAL_OPTIONS } from './global-options.ts'
import { printUsage, renderHelp } from './help.ts'
import {
  createPhotonCommandServices,
  type PhotonExtensions,
  type PhotonServiceOptions
} from './services.ts'

export type PhotonPluginOptions = Omit<
  PhotonServiceOptions,
  | 'color'
  | 'colorExplicit'
  | 'debug'
  | 'json'
  | 'noInput'
  | 'organizationId'
  | 'projectId'
>

/** The line every `--help` ends with, for agents reading it. */
export const HELP_FOOTER = `Agents and scripts: add --json to any ${CLI_NAME} command for output a program can read.`

const isJsonRequested = (values: unknown): boolean =>
  typeof values === 'object' &&
  values !== null &&
  'json' in values &&
  values.json === true

const isColorRequested = (values: unknown): boolean =>
  !(
    typeof values === 'object' &&
    values !== null &&
    'color' in values &&
    values.color === false
  )

const isNoInputRequested = (values: unknown): boolean =>
  typeof values === 'object' &&
  values !== null &&
  'noInput' in values &&
  values.noInput === true

const isDebugRequested = (values: unknown): boolean =>
  typeof values === 'object' &&
  values !== null &&
  'debug' in values &&
  values.debug === true

const selectedProject = (values: unknown): string | undefined =>
  typeof values === 'object' &&
  values !== null &&
  'project' in values &&
  typeof values.project === 'string'
    ? values.project
    : undefined

const selectedOrganization = (values: unknown): string | undefined =>
  typeof values === 'object' &&
  values !== null &&
  'org' in values &&
  typeof values.org === 'string'
    ? values.org
    : undefined

const commandError = (error: unknown): CliError => normalizeCliError(error)

const isActionlessGroup = (command: Commandable | undefined): boolean =>
  typeof command === 'object' &&
  command.run === undefined &&
  getCommandSubCommands(command) !== undefined

// The arguments after the command path that no positional argument takes,
// and every argument after "--", which Gunshi never gives to a positional.
const unexpectedArguments = (command: Readonly<CommandContext>): string[] => {
  const declared = Object.values(command.args).filter(
    (schema) => schema.type === 'positional'
  )
  if (declared.some((schema) => schema.multiple === true)) {
    return []
  }
  return [
    ...command.positionals.slice(command.commandPath.length + declared.length),
    ...command.rest
  ]
}

const unexpectedArgumentsError = (
  command: Readonly<CommandContext>
): CliError | undefined => {
  const issues = unexpectedArguments(command).map((arg) => ({
    message: `Unexpected argument: ${shellArgument(arg)}`
  }))
  const [first] = issues
  return first === undefined
    ? undefined
    : argumentValidationError(first.message, { issues })
}

const withCommandRemediation = (
  error: CliError,
  commandPath: readonly string[]
): CliError => {
  if (error.code !== 'ARGUMENT_VALIDATION' || hasOwnNextSteps(error)) {
    return error
  }
  return copyCliError(error, { next: [validOptionsStep(commandPath)] })
}

// A 403 that Photon gave to a request sent with the key from the environment
// is Photon refusing that key, and the error names it. A 403 to a request that
// carried no key, such as an upload to the storage an avatar goes to or a
// public catalog read, stays as it is.
const withEnvironmentKey = (
  error: CliError,
  env: NodeJS.ProcessEnv
): CliError => {
  const key = environmentKey(env)
  return key !== undefined &&
    error.httpStatus === 403 &&
    error.sentEnvironmentKey
    ? environmentKeyRefused(error, key)
    : error
}

// `commands` are the CLI's own commands, which declare their positional
// arguments. A plugin's command, such as completion's "complete", reads its own.
export const createPhotonPlugin = (
  options: PhotonPluginOptions = {},
  commands: CliOptions['subCommands'] = {}
) => {
  const ownCommands =
    getCommandSubCommands({ subCommands: commands }) ?? new Map()
  return plugin({
    extension: (context) => {
      const organizationId = selectedOrganization(context.values)
      const projectId = selectedProject(context.values)
      return createPhotonCommandServices({
        ...options,
        color: isColorRequested(context.values),
        colorExplicit:
          context.explicit?.color === true && isColorRequested(context.values),
        debug: isDebugRequested(context.values),
        json: isJsonRequested(context.values),
        noInput: isNoInputRequested(context.values),
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(projectId === undefined ? {} : { projectId })
      })
    },
    id: 'photon',
    name: 'Photon application services',
    setup(context) {
      for (const [name, schema] of Object.entries(PHOTON_GLOBAL_OPTIONS)) {
        context.addGlobalOption(name, schema)
      }
      const tree = {
        globals: new Set(context.globalOptions.keys()),
        subCommands: context.subCommands
      }
      context.decorateUsageRenderer(async (render, command) =>
        isJsonRequested(command.values)
          ? JSON.stringify(commandReference(command, tree))
          : `${(await renderHelp(render, command)).trimEnd()}\n\n${HELP_FOOTER}\n`
      )
      context.decorateCommand<PhotonExtensions>((run) => async (command) => {
        const definition = commandAtPath(ownCommands, command.commandPath)
        if (isActionlessGroup(definition)) {
          await printUsage(command)
          return
        }
        try {
          const unexpected =
            definition === undefined
              ? undefined
              : unexpectedArgumentsError(command)
          if (unexpected !== undefined) {
            throw unexpected
          }
          const result = await run(command)
          await command.extensions.photon.output.completeDebug()
          return result
        } catch (error) {
          await command.extensions.photon.output.settleDebug()
          const normalized = withEnvironmentKey(
            withCommandRemediation(commandError(error), command.commandPath),
            options.env ?? process.env
          )
          command.extensions.photon.output.error(normalized)
          command.extensions.photon.setExitCode(normalized.exitCode)
        }
      })
    }
  })
}
