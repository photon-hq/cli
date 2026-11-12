import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import completion from '@gunshi/plugin-completion'
import { type CliOptions, type Commandable, plugin } from 'gunshi'
import { generate } from 'gunshi/generator'
import { getCommandSubCommands } from 'gunshi/utils'
import {
  type CommandReference,
  type CommandTree,
  commandReference
} from '../src/app/command-reference.ts'
import { PHOTON_GLOBAL_OPTIONS } from '../src/app/global-options.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { CLI_DESCRIPTION, CLI_NAME, CLI_VERSION } from '../src/meta.ts'
import { PHOTON_PACKAGE } from '../src/update/release.ts'
import { isEntryPoint } from './build-config.mjs'

function publicCommandPaths(
  commands: ReadonlyMap<string, Commandable>,
  parent: string[] = []
) {
  const paths: string[][] = []
  for (const [name, command] of [...commands].sort(([a], [b]) =>
    a.localeCompare(b, 'en')
  )) {
    if (command.internal || command.entry) {
      continue
    }
    const path = [...parent, name]
    paths.push(
      path,
      ...publicCommandPaths(getCommandSubCommands(command) ?? new Map(), path)
    )
  }
  return paths
}

export async function commandMetadata(
  subCommands: NonNullable<CliOptions['subCommands']>
) {
  let paths: string[][] | undefined
  const render = async (path: string[]) => {
    let tree: CommandTree = { globals: new Set(), subCommands: new Map() }
    const output = await generate(
      path.length ? path : null,
      {
        description: CLI_DESCRIPTION,
        name: CLI_NAME
      },
      {
        name: CLI_NAME,
        plugins: [
          completion(),
          plugin({
            id: 'photon-docs',
            setup(context) {
              for (const [name, schema] of Object.entries(
                PHOTON_GLOBAL_OPTIONS
              )) {
                context.addGlobalOption(name, schema)
              }
              tree = {
                globals: new Set(context.globalOptions.keys()),
                subCommands: context.subCommands
              }
              paths ??= publicCommandPaths(context.subCommands)
            }
          })
        ],
        renderHeader: null,
        renderUsage: async (context) =>
          JSON.stringify(commandReference(context, tree)),
        subCommands,
        version: CLI_VERSION
      }
    )
    return JSON.parse(output) as CommandReference
  }
  const commands = [await render([])]
  if (!paths) {
    throw new Error('Gunshi did not register the documentation commands')
  }
  commands.push(...(await Promise.all(paths.map(render))))
  return commands
}

// The docs repository's reference family and package for the repository
// that releases this file: its cli-stable family is the production build's
// release repository, and every other family is named after its
// repository, with the package photon-cli.
export const referenceSource = (
  repository: string
): { family: string; package: string } =>
  BUILD_CONFIG.environment === 'production' &&
  repository === BUILD_CONFIG.releaseRepository
    ? { family: 'cli-stable', package: PHOTON_PACKAGE.name }
    : { family: repository.split('/')[1] ?? repository, package: 'photon-cli' }

if (isEntryPoint(import.meta.url)) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const repository =
    process.env.GITHUB_REPOSITORY ?? BUILD_CONFIG.releaseRepository
  const { family, package: packageName } = referenceSource(repository)
  const artifact = {
    commands: await commandMetadata(photonCommands),
    family,
    schemaVersion: 1,
    source: {
      package: packageName,
      repository,
      revision,
      version: CLI_VERSION
    }
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile(
    'artifacts/docs-reference.json',
    `${JSON.stringify(artifact, null, 2)}\n`
  )
}
