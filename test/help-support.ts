import type { Commandable } from 'gunshi'
import { getCommandSubCommands } from 'gunshi/utils'
import type { PhotonPluginOptions } from '../src/app/plugin.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'

// This module runs inside the production and staging bundles that
// test/help.test.ts builds, so it imports nothing from Vitest.

const isActionlessGroup = (command: Commandable): boolean =>
  typeof command === 'object' &&
  command.run === undefined &&
  getCommandSubCommands(command) !== undefined

// The path of every command group without an action, parents first.
export const groupPaths = (
  commands:
    | ReadonlyMap<string, Commandable>
    | undefined = getCommandSubCommands({ subCommands: photonCommands }),
  path: readonly string[] = []
): string[][] =>
  [...(commands ?? [])]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([name, command]) =>
      isActionlessGroup(command)
        ? [
            [...path, name],
            ...groupPaths(getCommandSubCommands(command), [...path, name])
          ]
        : []
    )

// Every command with its path, parents first.
export const allCommands = (
  commands:
    | ReadonlyMap<string, Commandable>
    | undefined = getCommandSubCommands({ subCommands: photonCommands }),
  path: readonly string[] = []
): [string[], Commandable][] =>
  [...(commands ?? [])]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([name, command]): [string[], Commandable][] => [
      [[...path, name], command],
      ...allCommands(getCommandSubCommands(command) ?? new Map(), [
        ...path,
        name
      ])
    ])

// What a run writes to stdout, where the CLI writes help, without the newline
// that ends each write: the text console.log was given when Gunshi printed help.
// It fails when the run also prints through console.log, as Gunshi does
// without usageSilent, so help can't reach stdout twice.
export const printed = async (
  args: string[],
  options: PhotonPluginOptions = {}
): Promise<string> => {
  let text = ''
  let logged = 0
  const { log } = console
  console.log = () => {
    logged += 1
  }
  try {
    await runCli(args, {
      ...options,
      stdout: {
        write: (chunk: string) => {
          text += chunk
        }
      }
    })
  } finally {
    console.log = log
  }
  if (logged > 0) {
    throw new Error(`${args.join(' ')} printed through console.log.`)
  }
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

// The help of the CLI and of every group, one after the other.
export const helpDump = async (): Promise<string> => {
  const sections: string[] = []
  for (const path of [[], ...groupPaths()]) {
    const args = [...path, '--help']
    // biome-ignore lint/performance/noAwaitInLoops: the sections stay in the order of the runs.
    sections.push(`$ ${[CLI_NAME, ...args].join(' ')}\n${await printed(args)}`)
  }
  return `${sections.join('\n')}\n`
}
