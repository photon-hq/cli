import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { API_TOKEN_VARIABLE } from '../src/auth/constants.ts'
import { LEGACY_COMMANDS } from '../src/commands/legacy.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME, CLI_VERSION } from '../src/meta.ts'
import { photonKey } from './key-support.ts'
import { collector } from './project-test-support.ts'

const invoke = async (
  args: string[],
  env: NodeJS.ProcessEnv = {},
  fetch?: typeof globalThis.fetch
) => {
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    configDirectory: await mkdtemp(join(tmpdir(), 'photon-legacy-')),
    env,
    ...(fetch === undefined ? {} : { fetch }),
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Photon CLI 1.0 pointers', () => {
  test('sends a 1.0-only command to the legacy CLI with the same arguments', async () => {
    const result = await invoke(['spectrum', 'lines', 'list', '--json'])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        message: `"${CLI_NAME} spectrum" is a Photon CLI 1.0 command.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy spectrum lines list --json'
          }
        ]
      }
    })
    expect(result.stderr).toBe('')
  })

  test('prints the step for humans with its description and command', async () => {
    const result = await invoke(['profile'])

    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toContain(
      'Next: Use Photon CLI 1.0: npx @photon-ai/cli@legacy profile'
    )
  })

  test('points every 1.0-only command to the legacy CLI, help included', async () => {
    const results = await Promise.all(
      [...LEGACY_COMMANDS].map(
        async (name) => await invoke([name, '--help', '--json'])
      )
    )
    for (const result of results) {
      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'LEGACY_COMMAND' }
      })
    }
  })

  test('keeps global options in place and quotes arguments for the shell', async () => {
    const result = await invoke([
      '--json',
      'profile',
      'set',
      'name',
      "Ada's bot"
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: "npx @photon-ai/cli@legacy --json profile set name 'Ada'\\''s bot'"
          }
        ]
      }
    })
  })

  test('reads --json=true before a 1.0 command as the parser does', async () => {
    const result = await invoke(['--json=true', 'projects', 'list'])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        message: `"${CLI_NAME} projects" is a Photon CLI 1.0 command.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy --json=true projects list'
          }
        ]
      }
    })
    expect(result.stderr).toBe('')
  })

  test('cuts a full API key down to its ID in the 1.0 pointer', async () => {
    const apiKeyId = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
    const credential = `${apiKeyId}_private-key-material`
    const result = await invoke([
      'projects',
      'keys',
      credential,
      `--key=${credential}`,
      photonKey('sk', 'BADID_SECRETMATERIAL'),
      `${apiKeyId}_odd$secret!material`,
      '--key=pho_sk_BADID_odd$secret!material',
      '--json'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: `npx @photon-ai/cli@legacy projects keys ${apiKeyId} --key=${apiKeyId} pho_sk_BADID ${apiKeyId} --key=pho_sk_BADID --json`
          }
        ]
      }
    })
    expect(result.stderr).not.toContain('private-key-material')
    expect(result.stdout).not.toContain('private-key-material')
    expect(result.stderr).not.toContain('SECRETMATERIAL')
    expect(result.stdout).not.toContain('SECRETMATERIAL')
    expect(result.stderr).not.toContain('secret!material')
    expect(result.stdout).not.toContain('secret!material')
  })

  test('names no command this CLI has', () => {
    expect(
      [...LEGACY_COMMANDS].filter((name) => name in photonCommands)
    ).toEqual([])
  })

  test('sends a run with a 1.0 credential and no PHOTON_API_TOKEN to the legacy CLI', async () => {
    const variables = ['PHOTON_TOKEN', 'DASHBOARD_TOKEN']
    const results = await Promise.all(
      variables.map(
        async (variable) =>
          await invoke(['project', 'list', '--json'], {
            [variable]: 'legacy-token'
          })
      )
    )
    for (const [index, result] of results.entries()) {
      const variable = variables[index]
      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'LEGACY_TOKEN',
          message: `${variable} is a Photon CLI 1.0 credential, which this CLI does not read.`,
          next: [
            {
              description: 'Use Photon CLI 1.0',
              run: 'npx @photon-ai/cli@legacy project list --json'
            },
            { description: `To use ${CLI_NAME} instead, unset ${variable}.` }
          ]
        }
      })
      expect(result.stderr).not.toContain('legacy-token')
      expect(result.stdout).not.toContain('legacy-token')
    }
  })

  test('names both 1.0 credentials when both are set', async () => {
    const result = await invoke(['whoami', '--json'], {
      DASHBOARD_TOKEN: 'legacy-dashboard-token',
      PHOTON_TOKEN: 'legacy-token'
    })

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_TOKEN',
        message:
          'PHOTON_TOKEN and DASHBOARD_TOKEN are Photon CLI 1.0 credentials, which this CLI does not read.'
      }
    })
  })

  test('runs normally with the API token variable set, and for help and version', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { status: 401, title: 'Unauthorized', type: 'about:blank' },
          {
            headers: { 'content-type': 'application/problem+json' },
            status: 401
          }
        )
      )
    )
    const withApiToken = await invoke(
      ['project', 'list', '--json'],
      { [API_TOKEN_VARIABLE]: 'pho_token', PHOTON_TOKEN: 'legacy-token' },
      fetch
    )
    expect(withApiToken.stderr).not.toContain('LEGACY_TOKEN')
    expect(withApiToken.stdout).not.toContain('LEGACY_TOKEN')
    expect(fetch).toHaveBeenCalled()

    const results = await Promise.all(
      [['--json'], ['project', '--help'], ['-h'], ['-v']].map(
        async (args) => await invoke(args, { PHOTON_TOKEN: 'legacy-token' })
      )
    )
    for (const result of results) {
      expect(result.exitCodes).toEqual([])
      expect(result.stderr).toBe('')
    }
  })

  test.each([
    [['whoami', '--', '--help']],
    [['whoami', '--', '--version']],
    [['whoami', '--', '-h']],
    [['whoami', '--', '-v']]
  ])(
    'reads %j as an operand and sends it to the legacy CLI, as it sends whoami',
    async (args) => {
      const env = { PHOTON_TOKEN: 'legacy-token' }
      const [command, result] = await Promise.all([
        invoke(['whoami'], env),
        invoke(args, env)
      ])
      const message =
        'PHOTON_TOKEN is a Photon CLI 1.0 credential, which this CLI does not read. (LEGACY_TOKEN)'

      expect(command.exitCodes).toEqual([2])
      expect(command.stderr).toContain(message)
      expect(result.exitCodes).toEqual([2])
      expect(result.stderr).toContain(message)
      expect(result.stderr).toContain(
        `Next:\n  1. Use Photon CLI 1.0: npx @photon-ai/cli@legacy ${args.join(' ')}\n`
      )
      expect(result.stdout).toBe('')
    }
  )

  test('reports LEGACY_TOKEN in JSON for --help after "--"', async () => {
    const result = await invoke(['--json', 'whoami', '--', '--help'], {
      PHOTON_TOKEN: 'legacy-token'
    })

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_TOKEN',
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy --json whoami -- --help'
          },
          { description: `To use ${CLI_NAME} instead, unset PHOTON_TOKEN.` }
        ]
      }
    })
    expect(result.stderr).toBe('')
  })

  test.each([
    [['whoami', '--help'], `${CLI_NAME} whoami [OPTIONS]`],
    [['whoami', '--help', '--', 'x'], `${CLI_NAME} whoami [OPTIONS]`],
    [['whoami', '--version'], CLI_VERSION],
    [['whoami', '--version', '--', '--help'], CLI_VERSION]
  ])(
    'still answers %j before "--" with a 1.0 credential set',
    async (args, expected) => {
      const result = await invoke(args, { PHOTON_TOKEN: 'legacy-token' })

      expect(result.exitCodes).toEqual([])
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(expected)
    }
  )
})
