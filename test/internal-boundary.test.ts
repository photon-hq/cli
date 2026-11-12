import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, test } from 'vitest'
import { bundle } from './bundle-support.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const internalRoot = join(root, 'src', 'internal')
const internalTestRoot = join(root, 'test', 'internal')
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gmu
const SOURCE_FILE = /\.(?:[cm]?[jt]s)$/u
const MFA_COMMAND = /\bmfa\b/u
const COMPLIANCE_COMMAND = /\bcompliance\b/u
const TELEMETRY_COMMAND = /\btelemetry\b/u
const WEBHOOK_COMMAND = /\bwebhook\b/u
const BUILD_TIMEOUT_MS = 60_000

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return await sourceFiles(path)
      }
      return SOURCE_FILE.test(entry.name) ? [path] : []
    })
  )
  return files.flat()
}

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(
      async (directory) => await rm(directory, { force: true, recursive: true })
    )
  )
})

describe('internal-only code', () => {
  test('is never imported by public code except through #internal', async () => {
    const files = [
      ...(await sourceFiles(join(root, 'src'))).filter(
        (file) => !file.startsWith(`${internalRoot}${sep}`)
      ),
      ...(await sourceFiles(join(root, 'test'))).filter(
        (file) => !file.startsWith(`${internalTestRoot}${sep}`)
      )
    ]
    const sources = await Promise.all(
      files.map(async (file) => ({
        file,
        source: await readFile(file, 'utf8')
      }))
    )
    const violations = sources.flatMap(({ file, source }) =>
      [...source.matchAll(IMPORT_SPECIFIER)]
        .map(([, specifier]) => specifier ?? '')
        .filter((specifier) => {
          if (!specifier.startsWith('.')) {
            return false
          }
          const target = resolve(dirname(file), specifier)
          return (
            target === internalRoot ||
            target.startsWith(`${internalRoot}${sep}`)
          )
        })
        .map((specifier) => `${relative(root, file)} imports ${specifier}`)
    )
    expect(violations).toEqual([])
  })

  test(
    'registers no command in a production build',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'photon-public-build-'))
      temporaryDirectories.push(directory)
      const outfile = join(directory, 'bin.js')
      await bundle('production', outfile)
      const help = async (...args: string[]) =>
        (
          await promisify(execFile)(process.execPath, [
            outfile,
            ...args,
            '--help'
          ])
        ).stdout

      expect(await help('auth')).not.toMatch(MFA_COMMAND)
      expect(await help('account')).not.toContain('10dlc')
      const project = await help('project')
      expect(project).not.toMatch(COMPLIANCE_COMMAND)
      expect(project).not.toMatch(TELEMETRY_COMMAND)
      expect(project).toMatch(WEBHOOK_COMMAND)
    },
    BUILD_TIMEOUT_MS
  )
})
