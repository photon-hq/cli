import { commandWordPositions } from './moved.ts'

// "photon help <command>" is "photon <command> --help", and "photon help" is
// "photon --help".
export const helpCommandArguments = (args: readonly string[]): string[] => {
  const [position] = commandWordPositions(args)
  if (position === undefined || args[position] !== 'help') {
    return [...args]
  }
  const rest = args.filter((_, index) => index !== position)
  const terminator = rest.indexOf('--')
  return terminator === -1
    ? [...rest, '--help']
    : [...rest.slice(0, terminator), '--help', ...rest.slice(terminator)]
}
