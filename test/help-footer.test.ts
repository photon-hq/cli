import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { commandMetadata } from '../scripts/export-docs.ts'
import { HELP_FOOTER } from '../src/app/plugin.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { runCli } from '../src/main.ts'
import { collector } from './project-test-support.ts'

const configDirectory = await mkdtemp(join(tmpdir(), 'photon-help-'))

// Every command and every group above one, the root included, as the staging
// build has them.
const commandPaths = [
  ...new Set(
    (await commandMetadata(photonCommands)).flatMap(({ path }) =>
      path.map((_, end) => path.slice(0, end + 1).join(' '))
    )
  )
]

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await rm(configDirectory, { force: true, recursive: true })
})

describe('the help footer', () => {
  test('tells agents and scripts about --json', () => {
    expect(HELP_FOOTER).toContain('--json')
  })

  test.each(commandPaths)('"%s --help" ends with it', async (command) => {
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli([...command.split(' ').slice(1), '--help'], {
      configDirectory,
      env: {},
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    const help = stdout.value().trimEnd().split('\n')
    expect(help.slice(-2)).toEqual(['', HELP_FOOTER])
    expect(help.length).toBeGreaterThan(2)
    expect(stderr.value()).toBe('')
    expect(exitCodes).toEqual([])
  })
})
