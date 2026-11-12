import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, test } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome')
const PLUGIN = './biome/terminal-reads.grit'
const PLUGIN_DIAGNOSTIC = /^::error title=plugin,file=([^,]+),line=(\d+),/gmu
const LINT_TIMEOUT_MS = 30_000

const PLANTED_READS = [
  'stream.isTTY',
  'process.stdin.isTTY',
  'stream?.isTTY',
  "stream['isTTY']",
  'env.CI',
  'process.env.PHOTON_NO_INPUT',
  'env.NO_COLOR',
  'env.NO_COLORS',
  'env.FORCE_COLOR',
  'env.NODE_DISABLE_COLORS',
  'env.TERM',
  "env['NO_COLOR']"
]

const PLANTED_SOURCE = [
  'declare const stream: { isTTY?: boolean }',
  'declare const env: NodeJS.ProcessEnv',
  ...PLANTED_READS.map((read, index) => `export const read${index} = ${read}`),
  'export const { isTTY } = stream',
  'export const { TERM: term } = env'
].join('\n')

const plantedLines = Array.from(
  { length: PLANTED_READS.length + 2 },
  (_, index) => index + 3
)

const ALLOWED_SOURCE = [
  'export interface Stream { isTTY?: boolean }',
  "export const fake = { CI: '1', isTTY: true }",
  'declare const env: NodeJS.ProcessEnv',
  'export const program = env.TERM_PROGRAM',
  'export const codex = env.CODEX_CI'
].join('\n')

interface BiomeOverride {
  includes?: string[]
  plugins?: string[]
}

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(
      async (directory) => await rm(directory, { force: true, recursive: true })
    )
  )
})

const terminalReadsOverride = async (): Promise<BiomeOverride> => {
  const config = JSON.parse(
    await readFile(join(root, 'biome.json'), 'utf8')
  ) as { overrides?: BiomeOverride[] }
  const override = config.overrides?.find(({ plugins }) =>
    plugins?.includes(PLUGIN)
  )
  if (override === undefined) {
    throw new Error(`biome.json does not run ${PLUGIN}.`)
  }
  return override
}

/**
 * Lints a scratch project that has only the terminal-reads check of this
 * repository's biome.json, and returns the file and line of each report.
 */
const lintWithTerminalCheck = async (
  files: Record<string, string>
): Promise<string[]> => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-terminal-reads-'))
  temporaryDirectories.push(directory)
  await cp(join(root, PLUGIN), join(directory, PLUGIN))
  await writeFile(
    join(directory, 'biome.json'),
    JSON.stringify({
      linter: { rules: { preset: 'none' } },
      overrides: [await terminalReadsOverride()]
    })
  )
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), `${source}\n`)
    })
  )
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [biome, 'lint', '--config-path=.', '--reporter=github', '.'],
    { cwd: directory }
  ).catch((error: unknown) => ({
    stdout: (error as { stdout?: string }).stdout ?? ''
  }))
  return [...stdout.matchAll(PLUGIN_DIAGNOSTIC)].map(
    ([, file, line]) => `${file}:${line}`
  )
}

describe('terminal reads check', () => {
  test(
    'reports every isTTY or terminal variable read outside src/core/terminal.ts',
    async () => {
      const reports = await lintWithTerminalCheck({
        'src/commands/planted.ts': PLANTED_SOURCE
      })

      expect(reports).toEqual(
        plantedLines.map((line) => `src/commands/planted.ts:${line}`)
      )
    },
    LINT_TIMEOUT_MS
  )

  test(
    'leaves type declarations, other variables, the module and tests alone',
    async () => {
      const reports = await lintWithTerminalCheck({
        'src/commands/allowed.ts': ALLOWED_SOURCE,
        'src/core/terminal.ts': PLANTED_SOURCE,
        'test/planted.test.ts': PLANTED_SOURCE
      })

      expect(reports).toEqual([])
    },
    LINT_TIMEOUT_MS
  )
})
