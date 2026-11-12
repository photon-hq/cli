import type { ArgSchema, CommandContext } from 'gunshi'
import { kebabnize } from 'gunshi/utils'
import { CLI_NAME } from '../meta.ts'
import type { PhotonExtensions } from './services.ts'

type UsageRenderer = (context: Readonly<CommandContext>) => Promise<string>

const USAGE_HEADING = 'USAGE:'
const OPTIONS_SYMBOL = /[<[]OPTIONS[>\]]/u

const commandList = (context: Readonly<CommandContext>): string[] => {
  const commands = [...(context.env.subCommands ?? [])]
    .filter(
      ([, command]) => command.entry !== true && command.internal !== true
    )
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
  const width =
    Math.max(...commands.map(([name]) => name.length)) +
    context.env.middleMargin
  const indent = ' '.repeat(context.env.leftMargin)
  return commands.map(([name, command]) =>
    command.description
      ? `${indent}${name.padEnd(width)}${command.description}`
      : `${indent}${name}`
  )
}

const optionName = (
  context: Readonly<CommandContext>,
  name: string,
  schema: ArgSchema
): string => (context.toKebab || schema.toKebab ? kebabnize(name) : name)

// Gunshi draws the value of an option that has a default as "[name]", the
// mark of a value that can be left out. Its parser needs a value for every
// option but a boolean flag, so the value is drawn as "<name>" instead.
const showRequiredValues = (
  usage: string,
  context: Readonly<CommandContext>
): string =>
  Object.entries(context.args)
    .filter(
      ([, schema]) => schema.type !== 'boolean' && schema.type !== 'positional'
    )
    .reduce((shown, [name, schema]) => {
      const value = optionName(context, name, schema)
      const short = schema.short ? `-${schema.short}, ` : ''
      const option = `\n${' '.repeat(context.env.leftMargin)}${short}--${value}`
      return shown.replace(`${option} [${value}]`, `${option} <${value}>`)
    }, usage)

// Gunshi writes "<OPTIONS>", the mark of a part that can't be left out, on the
// usage line of any command with an option that has no default. As kubectl
// and git do, the usage line names each required option and writes the rest
// as "[OPTIONS]".
const showOptionalOptions = (
  usage: string,
  context: Readonly<CommandContext>
): string => {
  const lines = usage.split('\n')
  const line = lines.indexOf(USAGE_HEADING) + 1
  const required = Object.entries(context.args)
    .filter(
      ([, schema]) =>
        schema.required === true &&
        schema.type !== 'positional' &&
        schema.hidden !== true
    )
    .map(([name, schema]) => {
      const value = optionName(context, name, schema)
      return `--${value} <${value}>`
    })
  lines[line] = (lines[line] ?? '').replace(
    OPTIONS_SYMBOL,
    [...required, '[OPTIONS]'].join(' ')
  )
  return lines.join('\n')
}

// A command with sub-commands is shown the way Gunshi shows a leaf command,
// with "<COMMAND>" after its path and its sub-commands listed by name.
export const renderHelp = async (
  render: UsageRenderer,
  context: Readonly<CommandContext>
): Promise<string> => {
  if (!context.omitted) {
    return showOptionalOptions(
      showRequiredValues(await render(context), context),
      context
    )
  }
  const lines = showOptionalOptions(
    showRequiredValues(await render({ ...context, omitted: false }), context),
    context
  ).split('\n')
  const usage = lines.indexOf(USAGE_HEADING) + 1
  const path = [CLI_NAME, ...context.commandPath].join(' ')
  lines[usage] = (lines[usage] ?? '').replace(path, `${path} <COMMAND>`)
  lines.splice(usage + 2, 0, 'COMMANDS:', ...commandList(context), '')
  return lines.join('\n')
}

export const printUsage = async (
  context: Readonly<CommandContext<{ extensions: PhotonExtensions }>>
): Promise<void> => {
  const usage = await context.env.renderUsage?.(context)
  if (usage) {
    context.extensions.photon.output.usage(usage)
  }
}
