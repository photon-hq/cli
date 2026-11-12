import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { readBuildConfig } from '../scripts/build-config.mjs'
import { buildJavaScript } from '../scripts/build-javascript.mjs'
import { BUILD_CONFIG } from '../src/build-config.ts'
import {
  nodeVersionFailure,
  REQUIRED_NODE_MAJOR
} from '../src/core/node-version.ts'
import { CLI_ERROR_REFERENCE_URL } from '../src/core/output-basics.ts'

const BUILD_TIMEOUT_MS = 120_000
// Any module bin.js imports loads before its check runs, and may need what
// only a newer Node.js has.
const STATIC_IMPORT = /^\s*import\s*[\w{*'"]/mu
const OLD_NODE = '18.20.8'
const MESSAGE = `Photon CLI needs Node.js 22 or newer, and this is Node.js ${OLD_NODE}.`
const ERROR_LINE = `Error: ${MESSAGE} (NODE_VERSION_UNSUPPORTED)\n`
const ERROR_JSON = `{"error":{"code":"NODE_VERSION_UNSUPPORTED","message":"${MESSAGE}","retryable":false,"docsUrl":"${CLI_ERROR_REFERENCE_URL}"}}\n`

describe('the Node.js version check', () => {
  test("requires the version package.json's engines names", async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    )

    expect(manifest.engines.node).toBe(`>=${REQUIRED_NODE_MAJOR}`)
  })

  test('passes Node.js 22 and newer', () => {
    expect(nodeVersionFailure('22.0.0', [])).toBeUndefined()
    expect(nodeVersionFailure('24.11.1', ['--json'])).toBeUndefined()
  })

  test('names the required and the running version in one line on stderr', () => {
    expect(nodeVersionFailure(OLD_NODE, ['project', 'list'])).toEqual({
      stream: 'stderr',
      text: ERROR_LINE
    })
  })

  test('prints the error as JSON on stdout with --json', () => {
    expect(nodeVersionFailure(OLD_NODE, ['project', 'list', '--json'])).toEqual(
      { stream: 'stdout', text: ERROR_JSON }
    )
  })

  test('reads a --json after "--" as an operand', () => {
    expect(nodeVersionFailure(OLD_NODE, ['--', '--json'])).toEqual({
      stream: 'stderr',
      text: ERROR_LINE
    })
  })
})

// The npm package's bin.js, run with process.versions.node set to an older
// version before it starts, as an older Node.js would report it.
describe('the npm package on an older Node.js', () => {
  let directory = ''
  let binary = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'photon-node-version-'))
    await mkdir(join(directory, 'dist'))
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ type: 'module' })
    )
    binary = (
      await buildJavaScript({
        config: await readBuildConfig(BUILD_CONFIG.environment),
        outputDirectory: join(directory, 'dist')
      })
    ).outputFile
    // A Node.js too old for the CLI fails while it loads cli.js, so these
    // tests fail if bin.js loads it before the check.
    await writeFile(
      join(directory, 'dist', 'cli.js'),
      "throw new Error('bin.js loaded cli.js')\n"
    )
  }, BUILD_TIMEOUT_MS)

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  const run = (args: string[]) =>
    new Promise<{ exitCode: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'${OLD_NODE}'})`,
            binary,
            ...args
          ],
          {
            env: {
              HOME: directory,
              PATH: process.env.PATH ?? '',
              PHOTON_NO_UPDATE_NOTIFIER: '1'
            }
          }
        )
        let stderr = ''
        let stdout = ''
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', (exitCode) => {
          resolve({ exitCode, stderr, stdout })
        })
      }
    )

  test('imports nothing before the check', async () => {
    expect(await readFile(binary, 'utf8')).not.toMatch(STATIC_IMPORT)
  })

  test('stops before loading the CLI and exits 1 with the one-line error', async () => {
    expect(await run(['--version'])).toEqual({
      exitCode: 1,
      stderr: ERROR_LINE,
      stdout: ''
    })
  })

  test('prints the JSON error with --json', async () => {
    expect(await run(['project', 'list', '--json'])).toEqual({
      exitCode: 1,
      stderr: '',
      stdout: ERROR_JSON
    })
  })
})
