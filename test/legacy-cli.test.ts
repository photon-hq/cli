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
    for (const [index, result] of results.entries()) {
      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'LEGACY_COMMAND',
          next: [
            {
              run: expect.stringMatching(
                `^npx @photon-ai/cli@legacy ${[...LEGACY_COMMANDS][index]} --help`
              )
            }
          ]
        }
      })
    }
  })

  test('puts the command words first and quotes arguments for the shell', async () => {
    const result = await invoke([
      '--json',
      'spectrum',
      'users',
      'add',
      '--first-name',
      "Ada's bot"
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: "npx @photon-ai/cli@legacy spectrum users add --json --first-name 'Ada'\\''s bot'"
          }
        ]
      }
    })
  })

  test('reads --json=true before a 1.0 command as the parser does, and gives 1.0 --json', async () => {
    const result = await invoke([
      '--json=true',
      'projects',
      'list',
      '--debug=false'
    ])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        message: `"${CLI_NAME} projects" is a Photon CLI 1.0 command.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy projects list --json'
          }
        ]
      }
    })
    expect(result.stderr).toBe('')
  })

  test.each([
    [
      ['--api-host', 'https://api.example.com', 'spectrum', 'lines', 'list'],
      'spectrum lines list --api-host https://api.example.com'
    ],
    [
      ['--api-host=https://api.example.com', 'spectrum', 'lines', 'list'],
      'spectrum lines list --api-host=https://api.example.com'
    ],
    [
      ['-p', 'project', 'spectrum', 'lines', 'list'],
      'spectrum lines list -p project'
    ],
    [['projects', 'rename', 'project'], 'projects rename project']
  ])(
    'finds the 1.0 command after the 1.0 options in %j and puts it first',
    async (args, legacyArgs) => {
      const result = await invoke([...args, '--json'])
      const command = args.find((arg) => LEGACY_COMMANDS.has(arg))

      expect(result.exitCodes).toEqual([2])
      const { error } = JSON.parse(result.stdout)
      expect(error).toMatchObject({
        code: 'LEGACY_COMMAND',
        message: `"${CLI_NAME} ${command}" is a Photon CLI 1.0 command.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: `npx @photon-ai/cli@legacy ${legacyArgs} --json`
          }
        ]
      })
      expect(error).not.toHaveProperty('detail')
      expect(result.stderr).toBe('')
    }
  )

  test.each([
    [
      ['--json', '--api-host', 'https://api.example.com', 'ping'],
      'ping --api-host https://api.example.com',
      'Photon CLI 1.0 has no --json for "ping", so the suggested command leaves it out.'
    ],
    [
      [
        '--api-host',
        'https://api.example.com',
        '--org',
        'acme',
        '--no-input',
        'spectrum',
        'lines',
        'list',
        '--json'
      ],
      'spectrum lines list --api-host https://api.example.com --json',
      'Photon CLI 1.0 has no --org or --no-input for "spectrum lines list", so the suggested command leaves them out.'
    ],
    [
      ['--json', '--debug', 'env', 'current', '--project', 'project'],
      'env current --debug',
      'Photon CLI 1.0 has no --json or --project for "env current", so the suggested command leaves them out.'
    ],
    [
      ['--json', 'projects', 'list', '--debug=1', '-jy', '--json=true=x'],
      'projects list --json',
      'Photon CLI 1.0 has no --debug=1, -jy, or --json=true=x for "projects list", so the suggested command leaves them out.'
    ]
  ])(
    'names the options of %j that 1.0 has no equivalent for',
    async (args, legacyArgs, detail) => {
      const result = await invoke(args)

      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'LEGACY_COMMAND',
          detail,
          next: [
            {
              description: 'Use Photon CLI 1.0',
              run: `npx @photon-ai/cli@legacy ${legacyArgs}`
            }
          ]
        }
      })
    }
  )

  test.each([
    [['--token', 'secret-token', 'projects', 'list']],
    [['-t', 'secret-token', 'projects', 'list']],
    [['projects', 'list', '--token=secret-token']],
    [['projects', 'list', '-tsecret-token']]
  ])(
    'finds the 1.0 command in %j and leaves the 1.0 token out of the pointer',
    async (args) => {
      const result = await invoke([...args, '--json'])

      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'LEGACY_COMMAND',
          detail:
            "The suggested command leaves out --token so that the token isn't printed. Set PHOTON_TOKEN to it instead, which Photon CLI 1.0 reads.",
          next: [
            {
              description: 'Use Photon CLI 1.0',
              run: 'npx @photon-ai/cli@legacy projects list --json'
            }
          ]
        }
      })
      expect(result.stdout).not.toContain('secret-token')
      expect(result.stderr).toBe('')
    }
  )

  test.each([
    [['projects', 'show', '-yt', 'secret-token'], '-yt'],
    [['projects', 'show', '-jtsecret-token'], '-jt']
  ])(
    'leaves out the cluster in %j and never prints the token in it',
    async (args, cluster) => {
      const result = await invoke([...args, '--json'])

      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'LEGACY_COMMAND',
          detail: `Photon CLI 1.0 has no ${cluster} for "projects show", so the suggested command leaves it out.`,
          next: [
            {
              description: 'Use Photon CLI 1.0',
              run: 'npx @photon-ai/cli@legacy projects show --json'
            }
          ]
        }
      })
      expect(result.stdout).not.toContain('secret-token')
      expect(result.stderr).toBe('')
    }
  )

  test.each([
    [
      ['spectrum', 'lines', 'list', '--api-host='],
      'spectrum lines list',
      `Photon CLI 1.0's "spectrum lines list" needs a value for --api-host.`
    ],
    [
      ['spectrum', 'lines', 'list', '--api-host'],
      'spectrum lines list',
      `Photon CLI 1.0's "spectrum lines list" needs a value for --api-host.`
    ],
    [
      ['spectrum', 'lines', 'lst'],
      'spectrum lines',
      'Photon CLI 1.0 has no "spectrum lines lst" command.'
    ],
    [
      ['--api-host', 'https://api.example.com', 'spectrum', 'users', 'remove'],
      'spectrum users remove',
      `Photon CLI 1.0's "spectrum users remove" takes <user-id>.`
    ],
    [
      ['billing', 'checkout', 'pro', 'yearly'],
      'billing checkout',
      `Photon CLI 1.0's "billing checkout" takes [tier].`
    ],
    [
      ['spectrum', 'lines', 'list', '--', '--help'],
      'spectrum lines list',
      `Photon CLI 1.0's "spectrum lines list" takes no arguments.`
    ]
  ])(
    'points %j, which 1.0 rejects, to the help of the 1.0 command',
    async (args, command, detail) => {
      const result = await invoke(args)

      expect(result.exitCodes).toEqual([2])
      expect(result.stderr).toContain(`Detail: ${detail}\n`)
      expect(result.stderr).toContain(
        `Next: Use Photon CLI 1.0: npx @photon-ai/cli@legacy ${command} --help\n`
      )
    }
  )

  test.each([
    [['--bogus', 'value', 'spectrum', 'lines', 'list']],
    [['--api-host', 'https://api.example.com', 'account', 'billing', 'payment']]
  ])('leaves %j to the parser', async (args) => {
    const result = await invoke([...args, '--json'])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
  })

  test('cuts a full API key down to its ID in the 1.0 pointer', async () => {
    const apiKeyId = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
    const credential = `${apiKeyId}_private-key-material`
    const [command, unknown] = await Promise.all([
      invoke([
        'projects',
        'upgrade',
        credential,
        photonKey('sk', 'BADID_SECRETMATERIAL'),
        `--token=${credential}`,
        '--plan',
        `${apiKeyId}_odd$secret!material`,
        '--project=pho_sk_BADID_odd$secret!material',
        `--org=${credential}`,
        '--json'
      ]),
      invoke(['projects', credential, '--json'])
    ])

    expect(JSON.parse(command.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        detail:
          'Photon CLI 1.0 has no --org for "projects upgrade", so the suggested command leaves it out. The suggested command leaves out --token so that the token isn\'t printed. Set PHOTON_TOKEN to it instead, which Photon CLI 1.0 reads.',
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: `npx @photon-ai/cli@legacy projects upgrade ${apiKeyId} pho_sk_BADID --plan ${apiKeyId} --project=pho_sk_BADID --json`
          }
        ]
      }
    })
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_COMMAND',
        detail: `Photon CLI 1.0 has no "projects ${apiKeyId}" command.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy projects --help'
          }
        ]
      }
    })
    for (const output of [
      command.stderr,
      command.stdout,
      unknown.stderr,
      unknown.stdout
    ]) {
      expect(output).not.toContain('private-key-material')
      expect(output).not.toContain('SECRETMATERIAL')
      expect(output).not.toContain('secret!material')
    }
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

  test('points a run with a 1.0 credential to 1.0 help when 1.0 has no such command', async () => {
    const result = await invoke(['org', 'list', '--json'], {
      PHOTON_TOKEN: 'legacy-token'
    })

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'LEGACY_TOKEN',
        detail: 'Photon CLI 1.0 has no "org" command.',
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy --help'
          },
          { description: `To use ${CLI_NAME} instead, unset PHOTON_TOKEN.` }
        ]
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
    'reads %j as an operand and points to the legacy CLI, as it does for whoami',
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
        `Detail: Photon CLI 1.0's "whoami" takes no arguments.\n`
      )
      expect(result.stderr).toContain(
        'Next:\n  1. Use Photon CLI 1.0: npx @photon-ai/cli@legacy whoami --help\n'
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
        detail: `Photon CLI 1.0's "whoami" takes no arguments.`,
        next: [
          {
            description: 'Use Photon CLI 1.0',
            run: 'npx @photon-ai/cli@legacy whoami --help'
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
