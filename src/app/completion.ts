import completion from '@gunshi/plugin-completion'
import { plugin } from 'gunshi'

const COMPLETE_COMMAND = 'complete'

// "complete <shell>" prints the shell's completion script, and
// "complete -- <words>", how that script calls it, completes the words, so the
// shell is optional.
const SHELL_ARGUMENT = {
  description:
    'Shell to print the completion script for: bash, fish, powershell or zsh',
  required: false,
  type: 'positional'
} as const

/**
 * @gunshi/plugin-completion with the shell argument of "complete" declared.
 * The plugin reads the shell from the first operand but declares no
 * arguments, so help and the command reference left the shell out.
 */
export const completionPlugin = () => {
  const completionWithoutShell = completion()
  return plugin({
    dependencies: completionWithoutShell.dependencies ?? [],
    id: completionWithoutShell.id,
    name: completionWithoutShell.name,
    setup: async (context) => {
      await completionWithoutShell(context)
      const complete = context.subCommands.get(COMPLETE_COMMAND)
      if (typeof complete === 'object') {
        complete.args = { ...complete.args, shell: SHELL_ARGUMENT }
      }
    }
  })
}
