import type { CliOptions, Command } from 'gunshi'
import { getCommandSubCommands } from 'gunshi/utils'
import {
  type ProductionTest,
  pluginCommandTests,
  productionTestOf
} from '../../src/commands/production-test.ts'
import { photonCommands } from '../../src/commands/registry.ts'
import { commandMetadata } from '../export-docs.ts'

type SubCommands = NonNullable<CliOptions['subCommands']>

export interface CommandOption {
  global: boolean
  multiple: boolean
  name: string
  negatable: boolean
  required: boolean
  short?: string
  type: string
}

export interface PublicCommand {
  options: readonly CommandOption[]
  path: string
  productionTest: ProductionTest | undefined
}

const commandAt = (
  subCommands: SubCommands,
  path: readonly string[]
): object | undefined => {
  let commands = getCommandSubCommands({ subCommands } as Command)
  let command: object | undefined
  for (const name of path) {
    command = commands?.get(name)
    if (command === undefined) {
      return
    }
    commands = getCommandSubCommands(command as Command)
  }
  return command
}

const isPrefix = (prefix: readonly string[], path: readonly string[]) =>
  prefix.length < path.length &&
  prefix.every((name, index) => path[index] === name)

// The commands the docs exporter lists, less the root and the groups, which
// only print help, each with the declaration its definition carries.
export const publicCommands = async (
  subCommands: SubCommands = photonCommands
): Promise<PublicCommand[]> => {
  const metadata = (await commandMetadata(subCommands)).map(
    ({ options, path }) => ({ options, path: path.slice(1) })
  )
  return metadata
    .filter(
      ({ path }) =>
        path.length > 0 && !metadata.some((other) => isPrefix(path, other.path))
    )
    .map(({ options, path }) => {
      const name = path.join(' ')
      const command = commandAt(subCommands, path)
      return {
        options: options.map((option) => ({
          global: option.global,
          multiple: option.multiple ?? false,
          name: option.name,
          negatable: option.negatable ?? false,
          required: option.required ?? false,
          ...(option.short === undefined ? {} : { short: option.short }),
          type: option.type
        })),
        path: name,
        productionTest:
          command === undefined
            ? pluginCommandTests[name]
            : productionTestOf(command)
      }
    })
}

export const undeclaredCommands = (
  commands: readonly PublicCommand[]
): string[] =>
  commands
    .filter(({ productionTest }) => productionTest === undefined)
    .map(({ path }) => path)
