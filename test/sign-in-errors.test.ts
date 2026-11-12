import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  process.exitCode = undefined
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

const emptyConfig = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-sign-in-'))
  temporaryDirectories.push(directory)
  return directory
}

const unreadableConfig = async (): Promise<string> => {
  const directory = await emptyConfig()
  await writeFile(join(directory, 'auth.json'), '{', { mode: 0o600 })
  return directory
}

const runText = async (
  configDirectory: string,
  args: string[]
): Promise<{ exitCodes: number[]; stderr: string; stdout: string }> => {
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    configDirectory,
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const SIGN_IN_ERROR = {
  error: {
    code: 'NOT_AUTHENTICATED',
    docsUrl: 'https://photon.codes/docs/cli/output#errors',
    message: 'You are not signed in to Photon.',
    next: [{ description: 'Sign in', person: true, run: `${CLI_NAME} login` }],
    retryable: false
  }
}

const REMOVE_UNREADABLE_SIGN_IN = [
  {
    description: 'Remove the unreadable sign-in',
    run: `${CLI_NAME} logout --force`
  }
]

describe('not signed in', () => {
  test.each([
    ['project current'],
    ['operation list'],
    ['org show'],
    ['whoami']
  ])('%s prints the one not-signed-in error as JSON', async (command) => {
    const invoke = cliInvoker(await emptyConfig(), asProjectScope({}))

    const result = await invoke(command.split(' '))

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(SIGN_IN_ERROR)
    expect(result.exitCodes).toEqual([4])
  })

  test('project current and operation list print the same text error', async () => {
    const configDirectory = await emptyConfig()

    const project = await runText(configDirectory, ['project', 'current'])
    const operations = await runText(configDirectory, ['operation', 'list'])

    expect(project.stderr).toBe(operations.stderr)
    expect(project.stderr).toContain(
      'Error: You are not signed in to Photon. (NOT_AUTHENTICATED)'
    )
    expect(project.stderr).toContain(
      `Next: Sign in (you do this): ${CLI_NAME} login`
    )
    expect(project.exitCodes).toEqual([4])
    expect(operations.exitCodes).toEqual([4])
  })
})

describe('unreadable sign-in', () => {
  test('a command gives photon logout --force as its next step', async () => {
    const invoke = cliInvoker(await unreadableConfig(), asProjectScope({}))

    const result = await invoke(['project', 'current'])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'AUTH_STORAGE_CORRUPT',
        message: 'Photon authentication data is malformed.',
        next: REMOVE_UNREADABLE_SIGN_IN
      }
    })
    expect(result.exitCodes).toEqual([1])
  })

  test('the text error shows the step instead of pointing to auth status', async () => {
    const result = await runText(await unreadableConfig(), [
      'project',
      'current'
    ])

    expect(result.stderr).toContain(
      `Next: Remove the unreadable sign-in: ${CLI_NAME} logout --force`
    )
    expect(result.stderr).not.toContain('auth status')
    expect(result.exitCodes).toEqual([1])
  })

  test('auth status reports the same step, and following it signs out', async () => {
    const configDirectory = await unreadableConfig()
    const invoke = cliInvoker(configDirectory, asProjectScope({}))

    const status = await invoke(['auth', 'status'])
    const document = JSON.parse(status.stdout)
    expect(document).toMatchObject({
      reason: 'Photon authentication data is malformed.',
      state: 'unavailable'
    })
    expect(document).not.toHaveProperty('next')
    expect(status.stderr).toBe(
      `Next: Remove the unreadable sign-in: ${CLI_NAME} logout --force\n`
    )
    const text = await runText(configDirectory, ['auth', 'status'])
    expect(text.stdout).toContain(
      `Next: Remove the unreadable sign-in: ${CLI_NAME} logout --force`
    )

    const logout = await invoke(['logout', '--force'])
    expect(JSON.parse(logout.stdout)).toMatchObject({ removed: true })

    const after = await invoke(['auth', 'status'])
    expect(JSON.parse(after.stdout)).toEqual({
      apiOrigin: BUILD_CONFIG.apiOrigin,
      state: 'not_authenticated'
    })
  })
})
