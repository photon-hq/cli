import { withoutApiKeySecrets } from '../project/validation.ts'
import { GLOBAL_VALUE_OPTIONS, isOptionValue } from './moved.ts'

interface LegacyCommand {
  readonly arguments: readonly string[]
  readonly names: readonly string[]
  readonly options: ReadonlySet<string>
  readonly subcommands: readonly LegacyCommand[]
}

// usage is the command's names joined with "|", then its arguments, as 1.0's
// help writes them: "remove|rm <user-id>".
const command = (
  usage: string,
  options: readonly string[],
  subcommands: readonly LegacyCommand[] = []
): LegacyCommand => {
  const [names = '', ...commandArguments] = usage.split(' ')
  return {
    arguments: commandArguments,
    names: names.split('|'),
    options: new Set(options),
    subcommands
  }
}

const HOST = ['--api-host']
const API = [...HOST, '-t', '--token']
const PROJECT = ['-p', '--project']
const JSON_OUTPUT = ['--json']
const READ = [...API, ...JSON_OUTPUT]
const PROJECT_READ = [...PROJECT, ...READ]
const YES = ['-y', '--yes']
const NO_BROWSER = ['--no-browser']
const PERSON = ['--first-name', '--last-name']
const PROFILE = ['--type', '--platforms', '--background', '--company-name']
const PLAN = ['--plan', '--qty']
const NAME = ['-n', '--name']

// Photon CLI 1.0's commands, with the options and arguments each takes, as
// 2.3.0 has them: the release npm's legacy tag installs. The names include
// every alias 2.3.0 registers; its help shows only the first. 1.0 reads a
// command's options only after the command's words, and its own --debug,
// --help and --version anywhere. It rejects an unknown option or command, and
// a missing or extra argument. A group that runs one of its subcommands when
// none is named (projects runs list) takes that subcommand's options.
const LEGACY_CLI = command(
  'photon',
  [],
  [
    command('ping', [...HOST, '-u', '--url']),
    command('env', HOST, [command('current', HOST)]),
    command('login', [...HOST, ...NO_BROWSER]),
    command('logout', HOST),
    command('whoami', API),
    command('update', ['--check', '--force', '--installer', ...JSON_OUTPUT]),
    command('profile', READ, [
      command('show', READ),
      command('init', [...PROFILE, ...READ]),
      command('update|edit', [...PROFILE, ...READ])
    ]),
    command('projects|project', READ, [
      command('list|ls', READ),
      command('show|get [id]', PROJECT_READ),
      command('secret|get-secret [id]', PROJECT_READ),
      command('create|new', [
        ...NAME,
        '-l',
        '--location',
        '--platforms',
        '--template',
        '--observability',
        ...READ
      ]),
      command('update|edit|rename [id]', [...NAME, ...PROJECT_READ]),
      command('delete|rm|remove [id]', [...PROJECT, ...API, ...YES]),
      command('regenerate-secret|rotate-secret [id]', [
        ...PROJECT_READ,
        ...YES
      ]),
      command('open [id]', [...PROJECT, ...HOST, ...NO_BROWSER]),
      command('upgrade [id] [tier]', [
        ...PLAN,
        '--checkout',
        '--manage',
        ...PROJECT_READ,
        ...NO_BROWSER
      ]),
      command('check-phone <number>', READ)
    ]),
    command(
      'spectrum',
      [],
      [
        command('profile', PROJECT_READ, [
          command('show', PROJECT_READ),
          command('update|edit', [...PERSON, ...PROJECT_READ]),
          command('sync', PROJECT_READ)
        ]),
        command('users', PROJECT_READ, [
          command('list|ls', PROJECT_READ),
          command('add|create', [
            ...PERSON,
            '--email',
            '--phone',
            '--invite',
            ...PROJECT_READ
          ]),
          command('remove|rm|delete <user-id>', [...PROJECT, ...API, ...YES])
        ]),
        command('lines', PROJECT_READ, [
          command(
            'profile',
            [],
            [command('update|edit <line-id>', [...PERSON, ...PROJECT_READ])]
          ),
          command(
            'avatar',
            [],
            [command('upload <line-id> <file>', [...PROJECT, ...API])]
          ),
          command('list|ls', PROJECT_READ),
          command('add|create', ['--platform', ...PROJECT_READ]),
          command('remove|rm|delete <line-id>', [...PROJECT, ...API, ...YES])
        ]),
        command('platforms', PROJECT_READ, [
          command('list|ls', PROJECT_READ),
          command('enable <name>', PROJECT_READ),
          command('disable <name>', PROJECT_READ)
        ]),
        command('avatar', [], [command('upload <file>', [...PROJECT, ...API])])
      ]
    ),
    command(
      'billing',
      [],
      [
        command('plans', PROJECT_READ),
        command('show', PROJECT_READ),
        command('checkout [tier]', [...PLAN, ...PROJECT_READ, ...NO_BROWSER]),
        command('manage|portal', [...PROJECT_READ, ...NO_BROWSER])
      ]
    ),
    command('auth', [], [command('status', JSON_OUTPUT)]),
    command('config', JSON_OUTPUT, [command('show', JSON_OUTPUT)])
  ]
)

const ROOT_OPTIONS: ReadonlySet<string> = new Set([
  '--debug',
  '-h',
  '--help',
  '-v',
  '--version'
])

/** The options that take a value: 1.0's and this CLI's global ones. */
export const LEGACY_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  ...GLOBAL_VALUE_OPTIONS,
  ...API,
  ...PROJECT,
  ...PROFILE,
  ...PLAN,
  ...NAME,
  ...PERSON,
  '-u',
  '--url',
  '--installer',
  '-l',
  '--location',
  '--email',
  '--phone',
  '--platform'
])

export interface LegacyCommandLine {
  /** The arguments to give Photon CLI 1.0, its command words first. */
  args: string[]
  /** Why args differ from the arguments given, beyond their order. */
  detail: string | undefined
}

interface Entry {
  readonly option?: string
  readonly tokens: readonly string[]
}

interface ParsedCommandLine {
  entries: Entry[]
  /** The command the words name. */
  named: LegacyCommand
  operands: string[]
  /** The first operand before "--", which a group reads as a subcommand. */
  unknown: string | undefined
  words: string[]
}

// An option and its value: "--api-host <url>", or one argument that holds
// both, as "--api-host=<url>" and "-p<id>" do. As for this CLI's global
// options, the argument after a value option is its value unless it starts
// with "-". In a cluster of short options, as in "-yt <token>", the first
// value option takes the rest of the cluster or the next argument. 1.0 reads
// a cluster, and a boolean option with a value other than true or false (as
// in "--json=1"), as an option it doesn't have, and so does this: a pointer
// leaves it out and names it, up to its value.
const optionEntry = (arg: string, next: string | undefined): Entry => {
  const letter = arg.startsWith('--')
    ? -1
    : [...arg.slice(1)].findIndex((name) =>
        LEGACY_VALUE_OPTIONS.has(`-${name}`)
      )
  const equals = arg.indexOf('=')
  let option = equals === -1 ? arg : arg.slice(0, equals)
  if (letter !== -1) {
    option = arg.slice(0, letter + 2)
  }
  if (letter !== -1 || LEGACY_VALUE_OPTIONS.has(option)) {
    return option === arg && isOptionValue(next)
      ? { option, tokens: [arg, next] }
      : { option, tokens: [arg] }
  }
  const value = arg.slice(equals + 1)
  return equals === -1 || value === 'true' || value === 'false'
    ? { option, tokens: [arg] }
    : { option: arg, tokens: [arg] }
}

// Reads a command line the way 1.0 does: the words that name a command, then
// the options and operands, in the order given.
const parseCommandLine = (args: readonly string[]): ParsedCommandLine => {
  const parsed: ParsedCommandLine = {
    entries: [],
    named: LEGACY_CLI,
    operands: [],
    unknown: undefined,
    words: []
  }
  let position = 0
  while (position < args.length) {
    const arg = args[position] ?? ''
    if (arg === '--') {
      const rest = args.slice(position + 1)
      parsed.entries.push({ tokens: [arg, ...rest] })
      parsed.operands.push(...rest)
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      const entry = optionEntry(arg, args[position + 1])
      parsed.entries.push(entry)
      position += entry.tokens.length
      continue
    }
    const subcommand =
      parsed.operands.length === 0
        ? parsed.named.subcommands.find(({ names }) => names.includes(arg))
        : undefined
    if (subcommand === undefined) {
      parsed.unknown ??= withoutApiKeySecrets(arg)
      parsed.operands.push(arg)
      parsed.entries.push({ tokens: [arg] })
    } else {
      parsed.words.push(arg)
      parsed.named = subcommand
    }
    position += 1
  }
  return parsed
}

const takes = (named: LegacyCommand, option: string): boolean =>
  ROOT_OPTIONS.has(option) || named.options.has(option)

// The arguments 1.0 gets for an option the command takes. A boolean option
// written with =true becomes the bare option and one with =false is dropped,
// since 1.0 reads neither form.
const legacyTokens = (option: string, tokens: readonly string[]) => {
  if (LEGACY_VALUE_OPTIONS.has(option)) {
    return tokens
  }
  if (tokens[0] === `${option}=false`) {
    return []
  }
  return tokens[0] === `${option}=true` ? [option] : tokens
}

// Why 1.0 would reject the command line: it has no such command, an argument
// is missing or extra, or an option the command takes has no value.
const rejection = ({
  entries,
  named,
  operands,
  unknown,
  words
}: ParsedCommandLine): string | undefined => {
  const name = words.join(' ')
  if (named.subcommands.length > 0 && unknown !== undefined) {
    return `Photon CLI 1.0 has no "${[...words, unknown].join(' ')}" command.`
  }
  const required = named.arguments.filter((argument) =>
    argument.startsWith('<')
  ).length
  if (operands.length < required || operands.length > named.arguments.length) {
    const usage =
      named.arguments.length === 0 ? 'no arguments' : named.arguments.join(' ')
    return `Photon CLI 1.0's "${name}" takes ${usage}.`
  }
  const bare = entries.find(
    ({ option, tokens }) =>
      option !== undefined &&
      ((tokens.length === 1 && tokens[0] === option) ||
        tokens[0] === `${option}=`) &&
      LEGACY_VALUE_OPTIONS.has(option) &&
      takes(named, option)
  )
  return bare?.option === undefined
    ? undefined
    : `Photon CLI 1.0's "${name}" needs a value for ${bare.option}.`
}

const TOKEN_OPTIONS: ReadonlySet<string> = new Set(['-t', '--token'])

const list = new Intl.ListFormat('en', { type: 'disjunction' })

// Rewrites a command line that names a 1.0 command into one 1.0 accepts: the
// command's words first, then the other arguments in the order given,
// without the options the command doesn't take. It leaves out a 1.0 token
// too, so that the pointer never prints it: 1.0 reads it from PHOTON_TOKEN as
// well. When 1.0 would reject the arguments anyway, the result asks 1.0 for
// the help of the command it found.
export const legacyCommandLine = (
  args: readonly string[]
): LegacyCommandLine => {
  const parsed = parseCommandLine(args)
  const { entries, named, words } = parsed
  const rejected = rejection(parsed)
  if (rejected !== undefined) {
    return { args: [...words, '--help'], detail: rejected }
  }
  const leftOut = new Set<string>()
  let token = false
  const kept = entries.flatMap(({ option, tokens }) => {
    if (option === undefined) {
      return tokens
    }
    if (!takes(named, option)) {
      leftOut.add(withoutApiKeySecrets(option))
      return []
    }
    if (TOKEN_OPTIONS.has(option)) {
      token = true
      return []
    }
    return legacyTokens(option, tokens)
  })
  const details: string[] = []
  if (leftOut.size > 0) {
    details.push(
      `Photon CLI 1.0 has no ${list.format([...leftOut])} for "${words.join(' ')}", so the suggested command leaves ${leftOut.size === 1 ? 'it' : 'them'} out.`
    )
  }
  if (token) {
    details.push(
      "The suggested command leaves out --token so that the token isn't printed. Set PHOTON_TOKEN to it instead, which Photon CLI 1.0 reads."
    )
  }
  return {
    args: [...words, ...kept],
    detail: details.length === 0 ? undefined : details.join(' ')
  }
}
