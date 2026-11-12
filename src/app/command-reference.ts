import type { ArgSchema, Commandable, CommandContext } from 'gunshi'
import { getCommandSubCommands, kebabnize } from 'gunshi/utils'
import { isBeta } from '../commands/beta.ts'
import { CLI_NAME } from '../meta.ts'

export interface CommandReference {
  beta?: true
  description: string
  options: (ArgSchema & { global: boolean; name: string })[]
  path: string[]
}

export interface CommandTree {
  globals: ReadonlySet<string>
  subCommands: ReadonlyMap<string, Commandable>
}

export const commandAtPath = (
  subCommands: ReadonlyMap<string, Commandable>,
  path: readonly string[]
): Commandable | undefined => {
  let commands: ReadonlyMap<string, Commandable> | undefined = subCommands
  let command: Commandable | undefined
  for (const name of path) {
    command = commands?.get(name)
    if (command === undefined) {
      return
    }
    commands = getCommandSubCommands(command)
  }
  return command
}

const isBetaPath = (
  subCommands: ReadonlyMap<string, Commandable>,
  path: readonly string[]
): boolean => {
  const command = commandAtPath(subCommands, path)
  return command !== undefined && isBeta(command)
}

export const commandReference = (
  context: Readonly<CommandContext>,
  { globals, subCommands }: CommandTree
): CommandReference => ({
  ...(isBetaPath(subCommands, context.commandPath) ? { beta: true } : {}),
  description: context.description ?? '',
  options: Object.entries(context.args)
    .filter(([, schema]) => !schema.hidden)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, schema]) => ({
      ...schema,
      ...(schema.type === 'positional'
        ? {
            required:
              schema.required ??
              (!schema.multiple &&
                (schema.default === undefined || schema.default === null)),
            variadic: schema.multiple ?? false
          }
        : {}),
      global: globals.has(name),
      name: context.toKebab || schema.toKebab ? kebabnize(name) : name
    })),
  path: [CLI_NAME, ...context.commandPath]
})
