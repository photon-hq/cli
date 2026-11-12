import { lazy } from 'gunshi'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { commandMetadata } from '../scripts/export-docs.ts'
import { BETA_LABEL, beta, isBeta } from '../src/commands/beta.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'

const BETA_COMMANDS = [
  'org invitation accept',
  'org invitation list',
  'org invitation preview',
  'org invitation revoke',
  'org leave',
  'org list',
  'org member edit',
  'org member invite',
  'org member list',
  'org member remove',
  'org oauth-client authorize',
  'org oauth-client list',
  'org oauth-client update',
  'org oauth-client view',
  'org show',
  'org use'
].map((command) => `${CLI_NAME} ${command}`)

const BETA_ENTRY = /list\s+List your organizations \(beta\)/
const STABLE_ENTRY = /clear\s+Clear the stored active organization\n/

const help = async (args: string[]) => {
  const lines: string[] = []
  lines.push(await printed(args))
  return lines.join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('beta label', () => {
  test('flags a lazy command and labels its description', () => {
    const command = beta(
      lazy(async () => () => undefined, {
        description: 'List widgets',
        name: 'list'
      })
    )

    expect(isBeta(command)).toBe(true)
    expect(command.description).toBe(`List widgets ${BETA_LABEL}`)
    expect(isBeta(lazy(async () => () => undefined, { name: 'list' }))).toBe(
      false
    )
  })

  test('shows beta commands in the parent help', async () => {
    const text = await help(['org', '--help', '--no-color'])

    expect(text).toMatch(BETA_ENTRY)
    expect(text).toMatch(STABLE_ENTRY)
  })

  test('shows the label in the command help', async () => {
    const text = await help(['org', 'member', 'invite', '--help', '--no-color'])

    expect(text.split('\n')[0]).toBe(
      'Invite a member to the current organization (beta)'
    )
  })

  test('prints help as JSON with beta set for beta commands only', async () => {
    const list = JSON.parse(await help(['org', 'list', '--help', '--json']))
    const clear = JSON.parse(await help(['org', 'clear', '--help', '--json']))

    expect(list).toEqual(
      expect.objectContaining({
        beta: true,
        description: 'List your organizations (beta)',
        path: [CLI_NAME, 'org', 'list']
      })
    )
    expect(list.options).toContainEqual(
      expect.objectContaining({ global: true, name: 'json' })
    )
    expect(clear).not.toHaveProperty('beta')
    expect(clear.path).toEqual([CLI_NAME, 'org', 'clear'])
  })

  test('keeps text help when --json is absent', async () => {
    const text = await help(['org', 'list', '--help'])

    expect(() => JSON.parse(text)).toThrow()
    expect(text).toContain('USAGE:')
  })

  test('marks exactly the reviewed beta commands in the docs metadata', async () => {
    const commands = await commandMetadata(photonCommands)

    expect(
      commands
        .filter((command) => command.beta)
        .map(({ path }) => path.join(' '))
    ).toEqual(BETA_COMMANDS)
    for (const command of commands) {
      expect(command.description.endsWith(BETA_LABEL)).toBe(
        command.beta === true
      )
    }
  })
})
