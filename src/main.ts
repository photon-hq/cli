import {
  defineSuggestNames,
  levenshtein,
  suggestion
} from '@gunshi/plugin-suggestion'
import {
  ArgsValidationErrorKeys,
  cli,
  defineWithTypes,
  isArgsValidationError,
  isCommandNotFoundError
} from 'gunshi'
import { completionPlugin, requireCompletionShell } from './app/completion.ts'
import { printUsage } from './app/help.ts'
import { createPhotonPlugin, type PhotonPluginOptions } from './app/plugin.ts'
import type { PhotonExtensions } from './app/services.ts'
import { helpCommandArguments } from './commands/help.ts'
import { legacyCliError } from './commands/legacy.ts'
import { movedCommandError } from './commands/moved.ts'
import { photonCommands } from './commands/registry.ts'
import {
  type CliError,
  copyCliError,
  normalizeCliError
} from './core/errors.ts'
import { CliOutput, outputOptionsFromArgs } from './core/output.ts'
import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from './meta.ts'

// Gunshi's name for the entry command, which it lists among the top-level
// commands.
const ENTRY_COMMAND_NAME = '(anonymous)'

const entry = defineWithTypes<{ extensions: PhotonExtensions }>()({
  description: CLI_DESCRIPTION,
  run: async (context) => {
    const { output } = context.extensions.photon
    if (!output.json) {
      await printUsage(context)
      return
    }
    output.success({ name: CLI_NAME, version: CLI_VERSION }, [])
  }
})

// The defaults of @gunshi/plugin-suggestion: the one closest name within a
// Levenshtein distance of 2.
const suggestNames = defineSuggestNames({
  distance: levenshtein,
  includeCommands: true,
  includeOptions: true,
  maxDistance: 2,
  maxSuggestions: 1,
  normalize: (name) => name
})

const suggestedNames = (error: unknown): string[] => {
  if (isCommandNotFoundError(error)) {
    return suggestNames(
      error.commandName,
      error.candidates.filter((name) => name !== ENTRY_COMMAND_NAME)
    )
  }
  if (
    !isArgsValidationError(error) ||
    error.code !== ArgsValidationErrorKeys.unknownOption
  ) {
    return []
  }
  const { candidates, rawName } = error.values
  if (
    typeof rawName !== 'string' ||
    !rawName.startsWith('--') ||
    !Array.isArray(candidates)
  ) {
    return []
  }
  return suggestNames(
    rawName,
    candidates.filter(
      (name): name is string =>
        typeof name === 'string' && name.startsWith('--')
    )
  )
}

const invocationError = (error: unknown): CliError => {
  const normalized = normalizeCliError(error)
  const suggestions =
    error instanceof AggregateError
      ? [...new Set(error.errors.flatMap(suggestedNames))]
      : []
  return suggestions.length === 0
    ? normalized
    : copyCliError(normalized, { suggestions })
}

export async function runCli(
  args: string[],
  options: PhotonPluginOptions = {}
): Promise<string | undefined> {
  const outputOptions = {
    ...outputOptionsFromArgs(args),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout })
  }
  try {
    const commandArgs = helpCommandArguments(args)
    const redirect =
      movedCommandError(commandArgs) ??
      legacyCliError(commandArgs, options.env ?? process.env)
    if (redirect !== undefined) {
      throw redirect
    }
    const usage = await cli(commandArgs, entry, {
      description: CLI_DESCRIPTION,
      name: CLI_NAME,
      onBeforeCommand: requireCompletionShell,
      plugins: [
        suggestion(),
        completionPlugin(),
        createPhotonPlugin(options, photonCommands)
      ],
      renderHeader: null,
      renderValidationErrors: null,
      strict: true,
      subCommands: photonCommands,
      usageSilent: true,
      version: CLI_VERSION
    })
    if (usage !== undefined) {
      new CliOutput(outputOptions).usage(usage)
    }
    return usage
  } catch (error) {
    const output = new CliOutput(outputOptions)
    const normalized = invocationError(error)
    output.error(normalized)
    const setExitCode =
      options.setExitCode ??
      ((exitCode: number) => {
        process.exitCode = exitCode
      })
    setExitCode(normalized.exitCode)
  }
}
