import completion from '@gunshi/plugin-completion'
import {
  ArgsValidationErrorKeys,
  type CommandContext,
  type CommandRunner,
  isArgsValidationError,
  plugin
} from 'gunshi'
import { renamedWarning } from '../commands/moved.ts'
import { argumentValidationError } from '../core/errors.ts'
import { shellArgument } from '../core/presenter.ts'
import type { PhotonExtensions } from './services.ts'

const COMPLETE_COMMAND = 'complete'
const COMPLETION_COMMAND = 'completion'
const COMPLETION_DESCRIPTION = 'Generate shell completion script'
const SHELL = 'shell'
const SHELLS: readonly string[] = ['bash', 'fish', 'powershell', 'zsh']
const SHELL_NAMES = 'bash, fish, powershell or zsh'
const SETUP_GUIDE = 'https://photon.codes/docs/cli/shell-completion'

type CompletionContext = CommandContext<{ extensions: PhotonExtensions }>

// The completion plugin prints nothing, and exits 0, for a shell it can't
// complete, so the shell is checked here.
const supportedShell = (shell: string): string => {
  if (!SHELLS.includes(shell)) {
    throw argumentValidationError(
      `Unsupported shell: ${shellArgument(shell)}. Use ${SHELL_NAMES}.`
    )
  }
  return shell
}

const shellPositional = (required: boolean) =>
  ({
    description: `Shell to print the completion script for: ${SHELL_NAMES}. Setup: ${SETUP_GUIDE}`,
    parse: supportedShell,
    required,
    type: 'positional'
  }) as const

// The plugin reads the shell from the word after the command, which is
// another word when a global option comes first ("photon --no-color
// completion zsh"), so it is given the shell Gunshi parsed.
const printScript = async (
  run: CommandRunner,
  context: Readonly<CommandContext>,
  shell: string
) => await run({ ...context, _: [COMPLETE_COMMAND, shell] })

const isMissingShell = (error: unknown): boolean =>
  isArgsValidationError(error) &&
  error.code === ArgsValidationErrorKeys.requiredPositional &&
  error.values.name === SHELL

/**
 * Gunshi rejects a missing positional argument before any plugin's command
 * runs, with an error that can't name the shells. The CLI runs this before
 * each command, so "completion" without a shell names them.
 */
export const requireCompletionShell = (
  context: Readonly<CommandContext>
): void => {
  const errors = context.validationError?.errors ?? []
  if (
    context.name === COMPLETION_COMMAND &&
    errors.length === 1 &&
    isMissingShell(errors[0]) &&
    context.values.help !== true &&
    context.values.version !== true
  ) {
    throw argumentValidationError(
      `Name the shell to print the completion script for: ${SHELL_NAMES}.`
    )
  }
}

/**
 * @gunshi/plugin-completion with "completion <shell>", which prints the
 * script, in the place of the plugin's "complete". The generated scripts call
 * "complete -- <words>" at every Tab press, so "complete" stays, hidden, and
 * "complete <shell>" still prints the script after a renamed-command warning.
 */
export const completionPlugin = () => {
  const gunshiCompletion = completion()
  return plugin({
    dependencies: gunshiCompletion.dependencies ?? [],
    id: gunshiCompletion.id,
    name: gunshiCompletion.name,
    setup: async (context) => {
      await gunshiCompletion(context)
      const complete = context.subCommands.get(COMPLETE_COMMAND)
      const run = typeof complete === 'object' ? complete.run : undefined
      if (typeof complete !== 'object' || run === undefined) {
        throw new Error(
          `@gunshi/plugin-completion added no "${COMPLETE_COMMAND}" command`
        )
      }
      Object.assign(complete, {
        args: { ...complete.args, [SHELL]: shellPositional(false) },
        internal: true,
        run: async (completeContext: Readonly<CompletionContext>) => {
          const shell = completeContext.values[SHELL]
          if (typeof shell !== 'string') {
            return await run(completeContext)
          }
          completeContext.extensions.photon.output.warning(
            renamedWarning(
              [COMPLETE_COMMAND, shell],
              [COMPLETION_COMMAND, shell]
            )
          )
          return await printScript(run, completeContext, shell)
        }
      })
      context.addCommand(COMPLETION_COMMAND, {
        args: { [SHELL]: shellPositional(true) },
        description: COMPLETION_DESCRIPTION,
        name: COMPLETION_COMMAND,
        run: async (completionContext) =>
          await printScript(
            run,
            completionContext,
            String(completionContext.values[SHELL])
          )
      })
    }
  })
}
