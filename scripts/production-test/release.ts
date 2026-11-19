import { leafCommands } from './commands.ts'

// Release Please tags each published version of this repository as
// cli-v<version>, on the commit whose tree photon-hq/cli's release exports,
// so that tag holds the test the release shipped with.
const SOURCE_TAG_PREFIX = 'cli-v'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export interface CommandSkew {
  // Commands the release has that main no longer has, which the run still
  // runs, with the release's own declaration.
  onlyInRelease: string[]
  // Commands main has that the release doesn't, which the run leaves out.
  onlyOnMain: string[]
}

export const sourceTag = (version: string): string => {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" isn't a release version.`)
  }
  return `${SOURCE_TAG_PREFIX}${version}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The commands that run something in a release's docs-reference.json, which
// photon-hq/cli attaches to each release: the root and the groups are
// dropped, as the test plan drops them.
export const referenceCommands = (
  contents: string,
  version: string
): string[] => {
  const reference: unknown = JSON.parse(contents)
  const source = isRecord(reference) ? reference.source : undefined
  const documented = isRecord(source) ? source.version : undefined
  if (documented !== version) {
    throw new Error(
      `docs-reference.json is for ${String(documented)}, not ${version}.`
    )
  }
  const entries =
    isRecord(reference) && Array.isArray(reference.commands)
      ? reference.commands
      : []
  const paths = entries.map((entry) => {
    const path = isRecord(entry) ? entry.path : undefined
    if (!(Array.isArray(path) && path.every((n) => typeof n === 'string'))) {
      throw new Error('docs-reference.json has a command with no path.')
    }
    return { path: path.slice(1) as string[] }
  })
  return leafCommands(paths).map(({ path }) => path.join(' '))
}

export const commandSkew = (
  main: readonly string[],
  release: readonly string[]
): CommandSkew => ({
  onlyInRelease: release.filter((path) => !main.includes(path)).sort(),
  onlyOnMain: main.filter((path) => !release.includes(path)).sort()
})

const list = (paths: readonly string[]): string =>
  paths.map((path) => `\`${path}\``).join(', ')

export const skewMarkdown = (version: string, skew: CommandSkew): string[] => [
  `## Commands in ${version} and on main`,
  '',
  `The test is the one in ${sourceTag(version)}, not main's, so it runs the commands ${version} ships, as ${version} declares them.`,
  '',
  skew.onlyOnMain.length === 0
    ? `Every command on main is in ${version}.`
    : `On main but not in ${version}, so not run: ${list(skew.onlyOnMain)}.`,
  '',
  ...(skew.onlyInRelease.length === 0
    ? []
    : [
        `In ${version} but not on main, and run: ${list(skew.onlyInRelease)}.`,
        ''
      ])
]
