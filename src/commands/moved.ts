import { PHOTON_GLOBAL_OPTIONS } from '../app/global-options.ts'
import { CliError } from '../core/errors.ts'
import { shellArgument } from '../core/presenter.ts'
import { CLI_NAME } from '../meta.ts'

interface MovedCommand {
  from: readonly string[]
  to: readonly string[]
}

// Commands that moved when project membership, OAuth clients and the payment
// method became organization resources, and when an OAuth client went to one
// secret. The old names stay for one release and only point to the
// replacement; they never run it.
const MOVED_COMMANDS: readonly MovedCommand[] = [
  {
    from: ['account', 'billing', 'payment'],
    to: ['org', 'billing', 'payment-method']
  },
  { from: ['account', 'billing'], to: ['org', 'billing'] },
  { from: ['account', 'oauth', 'client'], to: ['org', 'oauth-client'] },
  {
    from: ['account', 'oauth', 'secret', 'list'],
    to: ['org', 'oauth-client', 'secret', 'view']
  },
  {
    from: ['account', 'oauth', 'secret'],
    to: ['org', 'oauth-client', 'secret']
  },
  {
    from: ['org', 'oauth-client', 'secret', 'list'],
    to: ['org', 'oauth-client', 'secret', 'view']
  },
  { from: ['project', 'invitation'], to: ['org', 'invitation'] },
  { from: ['project', 'leave'], to: ['org', 'leave'] },
  { from: ['project', 'member'], to: ['org', 'member'] }
]

const CAPITAL = /[A-Z]/gu

const optionName = (name: string, schema: object): string =>
  'toKebab' in schema && schema.toKebab === true
    ? name.replace(CAPITAL, (letter) => `-${letter.toLowerCase()}`)
    : name

export const GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(
  Object.entries(PHOTON_GLOBAL_OPTIONS).flatMap(([name, schema]) =>
    schema.type === 'string' ? [`--${name}`] : []
  )
)

// The boolean global options in the forms the parser accepts: only a
// negatable one has a --no- form. The command-word lookup skips these and the
// replacement carries them, so both read the same forms. A form the parser
// rejects, such as --no-json, is not one of them: the lookup treats it as any
// other unknown option, which ends the command words, and the replacement
// leaves it out.
const GLOBAL_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(PHOTON_GLOBAL_OPTIONS).flatMap(([name, schema]) => {
    const option = optionName(name, schema)
    return schema.type === 'boolean'
      ? [
          `--${option}`,
          `--${option}=true`,
          `--${option}=false`,
          ...('negatable' in schema && schema.negatable
            ? [`--no-${option}`]
            : [])
        ]
      : []
  })
)

const isValueAssignment = (
  arg: string,
  valueOptions: ReadonlySet<string>
): boolean => [...valueOptions].some((option) => arg.startsWith(`${option}=`))

// The argument after a value option is its value unless there is none or it
// starts with "-". So in "--org --project pho_prj_x" --org has no value, as
// the parser reads it, and pho_prj_x is the value of --project, not a command
// word. An empty argument is a value, as it is to the parser, so "--org ''"
// never makes '' a command word. The parser also takes a lone "-" as a value;
// no ID is "-", so this rule doesn't.
export const isOptionValue = (arg: string | undefined): arg is string =>
  arg !== undefined && !arg.startsWith('-')

// Where the command words are: the arguments before the first
// command-specific option. Global options may appear anywhere: they are
// skipped, together with the value of a value option written as "--org <id>".
// valueOptions names the value options to skip, the global ones by default.
export const commandWordPositions = (
  args: readonly string[],
  valueOptions: ReadonlySet<string> = GLOBAL_VALUE_OPTIONS
): number[] => {
  const positions: number[] = []
  let skipValue = false
  for (const [position, arg] of args.entries()) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (valueOptions.has(arg)) {
      skipValue = isOptionValue(args[position + 1])
      continue
    }
    if (GLOBAL_FLAGS.has(arg) || isValueAssignment(arg, valueOptions)) {
      continue
    }
    if (arg.startsWith('-')) {
      break
    }
    positions.push(position)
  }
  return positions
}

export const commandWords = (
  args: readonly string[],
  valueOptions: ReadonlySet<string> = GLOBAL_VALUE_OPTIONS
): string[] => {
  const positions = new Set(commandWordPositions(args, valueOptions))
  return args.filter((_, position) => positions.has(position))
}

// The global options the user gave, in their order and as written, up to
// "--". A value option without a usable value is left out: "--org=" or
// "--org ''", and "--org" followed by nothing or by another option, which the
// parser does not read as its value either. So "--org --yes" never carries the
// --yes.
const globalOptionArguments = (args: readonly string[]): string[] => {
  const options: string[] = []
  let skipValue = false
  for (const [position, arg] of args.entries()) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (arg === '--') {
      break
    }
    if (GLOBAL_VALUE_OPTIONS.has(arg)) {
      const value = args[position + 1]
      if (isOptionValue(value) && value !== '') {
        options.push(arg, value)
        skipValue = true
      }
      continue
    }
    if (
      GLOBAL_FLAGS.has(arg) ||
      (isValueAssignment(arg, GLOBAL_VALUE_OPTIONS) &&
        arg.split('=', 2)[1] !== '')
    ) {
      options.push(arg)
    }
  }
  return options
}

const startsWith = (
  words: readonly string[],
  prefix: readonly string[]
): boolean => prefix.every((word, index) => words[index] === word)

const command = (words: readonly string[]): string =>
  [CLI_NAME, ...words.map(shellArgument)].join(' ')

// Renamed commands whose old names still run (project use, project clear and
// project create --use) are hidden beside the new ones, and print this warning
// on stderr first.
export const renamedWarning = (
  from: readonly string[],
  to: readonly string[]
): string => `"${command(from)}" is now "${command(to)}".`

// Returns the pointer error for an old command name, or undefined when the
// arguments do not name a moved command. The longest matching name wins. The
// replacement keeps the global options the user gave, so it acts on the same
// organization and project, and leaves out the command's own options, so a
// --yes is never carried over.
export const movedCommandError = (
  args: readonly string[]
): CliError | undefined => {
  const words = commandWords(args)
  const moved = MOVED_COMMANDS.filter(({ from }) => startsWith(words, from))
    .sort((left, right) => right.from.length - left.from.length)
    .at(0)
  if (moved === undefined) {
    return
  }
  const replacement = [
    ...moved.to,
    ...words.slice(moved.from.length),
    ...globalOptionArguments(args)
  ]
  return new CliError(
    'COMMAND_MOVED',
    `"${command(moved.from)}" moved to "${command(moved.to)}".`,
    {
      exitCode: 2,
      next: [{ description: 'Use the new command', run: command(replacement) }]
    }
  )
}
