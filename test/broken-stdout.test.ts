import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readBuildConfig } from '../scripts/build-config.mjs'
import { buildJavaScript } from '../scripts/build-javascript.mjs'
import { BUILD_CONFIG } from '../src/build-config.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 15_000
const execFileAsync = promisify(execFile)
const WRITE_FAILURE =
  'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)\n'

let directory = ''
const builds: Record<'binary' | 'npm package', string[]> = {
  binary: [],
  'npm package': []
}

interface Run {
  exitCode: number | null
  stderr: string
}

/**
 * Runs a build with stdout on /dev/full, which refuses every write with
 * ENOSPC as a full disk does, or on a pipe whose reader has already closed.
 */
const run = async (
  command: string[],
  args: string[],
  stdout: 'closed pipe' | 'full disk',
  stderr: 'full disk' | 'pipe' = 'pipe'
): Promise<Run> => {
  const full = stdout === 'full disk' ? await open('/dev/full', 'w') : undefined
  const fullStderr =
    stderr === 'full disk' ? await open('/dev/full', 'w') : undefined
  const [file = '', ...rest] = command
  const child = spawn(file, [...rest, ...args], {
    env: {
      HOME: directory,
      PATH: process.env.PATH ?? '',
      PHOTON_NO_UPDATE_NOTIFIER: '1',
      XDG_CONFIG_HOME: join(directory, 'config')
    },
    stdio: [
      'ignore',
      full === undefined ? 'pipe' : full.fd,
      fullStderr === undefined ? 'pipe' : fullStderr.fd
    ]
  })
  child.stdout?.destroy()
  let written = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    written += chunk.toString()
  })
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.on('close', resolveExit)
  })
  await full?.close()
  await fullStderr?.close()
  return { exitCode, stderr: written }
}

describe.runIf(existsSync('/dev/full'))('stdout that refuses writes', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'photon-broken-stdout-'))
    const config = await readBuildConfig(BUILD_CONFIG.environment)
    const packageDirectory = join(directory, 'package')
    await mkdir(packageDirectory)
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ type: 'module' })
    )
    const { outputFile } = await buildJavaScript({
      config,
      outputDirectory: join(packageDirectory, 'dist')
    })
    builds['npm package'] = [process.execPath, outputFile]

    const binary = join(directory, config.executableName)
    const binaryBuild = pathToFileURL(
      join(root, 'scripts', 'build-local-binary.mjs')
    ).href
    await execFileAsync(join(root, 'node_modules', '.bin', 'bun'), [
      '--eval',
      `const { buildLocalBinary } = await import(${JSON.stringify(binaryBuild)})
await buildLocalBinary(${JSON.stringify({ config, outfile: binary })})`
    ])
    builds.binary = [binary]
  }, BUILD_TIMEOUT_MS)

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  describe.each(['npm package', 'binary'] as const)('the %s', (build) => {
    test.each(['--version', '--help', 'project --help', 'project'])(
      'reports "%s" on a full disk in one line and exits 1',
      async (args) => {
        const result = await run(builds[build], args.split(' '), 'full disk')

        expect(result).toEqual({ exitCode: 1, stderr: WRITE_FAILURE })
      },
      RUN_TIMEOUT_MS
    )

    test(
      'reports a JSON result on a full disk as one JSON error line and exits 1',
      async () => {
        const result = await run(builds[build], ['--json'], 'full disk')

        expect(result.exitCode).toBe(1)
        expect(result.stderr.endsWith('\n')).toBe(true)
        expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: {
            code: 'OUTPUT_WRITE_FAILED',
            message: 'Photon could not write the result to standard output.'
          }
        })
      },
      RUN_TIMEOUT_MS
    )

    test.each(['--version', '--json'])(
      'exits 1 when stderr refuses the report too, for "%s"',
      async (args) => {
        const result = await run(
          builds[build],
          args.split(' '),
          'full disk',
          'full disk'
        )

        expect(result.exitCode).toBe(1)
      },
      RUN_TIMEOUT_MS
    )

    test.each(['--version', '--json'])(
      'exits 1 without a message when the reader closed the pipe, for "%s"',
      async (args) => {
        const result = await run(builds[build], args.split(' '), 'closed pipe')

        expect(result).toEqual({ exitCode: 1, stderr: '' })
      },
      RUN_TIMEOUT_MS
    )
  })
})
