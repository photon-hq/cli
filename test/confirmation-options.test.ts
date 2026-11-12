import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { commandMetadata } from '../scripts/export-docs.ts'
import { photonCommands } from '../src/commands/registry.ts'

// The registry as the staging build has it, internal-only commands included.
const commands = await commandMetadata(photonCommands)

const SOURCE = join(import.meta.dirname, '..', 'src')

const FORCE_COMMAND = /\$\{CLI_NAME\} (?:login|logout)\b[^`]*--force/u

const OTHER_SPELLING =
  /^(?:assume-yes|confirm|confirmed|no-confirm|no-prompt|skip-confirmation)$/u

const commandsWith = (name: string) =>
  commands.flatMap(({ options, path }) =>
    options
      .filter((option) => option.name === name)
      .map((option) => ({ command: path.slice(1).join(' '), option }))
  )

describe('the option that skips a confirmation', () => {
  test('is --force only on login and logout, where it overrides a safety check', () => {
    expect(commandsWith('force').map(({ command }) => command)).toEqual([
      'login',
      'logout'
    ])
  })

  test('is --yes everywhere else: a boolean that defaults to false, with -y', () => {
    const yes = commandsWith('yes')

    expect(yes.length).toBeGreaterThan(0)
    for (const { command, option } of yes) {
      expect({ command, ...option }).toMatchObject({
        command,
        default: false,
        short: 'y',
        type: 'boolean'
      })
    }
  })

  test('is named in no message or next step except for login and logout', () => {
    const mentions = readdirSync(SOURCE, { recursive: true })
      .filter((file) => String(file).endsWith('.ts'))
      // Photon CLI 1.0's commands and options, which include 1.0's
      // update --force, not this CLI's.
      .filter(
        (file) => String(file) !== join('commands', 'legacy-command-line.ts')
      )
      .flatMap((file) =>
        readFileSync(join(SOURCE, String(file)), 'utf8')
          .split('\n')
          .filter((line) => line.includes('--force'))
          .map((line) => `src/${String(file)}: ${line.trim()}`)
      )
      .filter((mention) => !FORCE_COMMAND.test(mention))

    expect(mentions).toEqual([
      "src/auth/lifecycle-service.ts: 'Photon is already authenticated. Pass --force to replace the current session with an account service key.',"
    ])
  })

  test('has no other spelling on any command', () => {
    const spellings = commands.flatMap(({ options, path }) =>
      options
        .filter(({ name }) => OTHER_SPELLING.test(name))
        .map(({ name }) => `${path.join(' ')} --${name}`)
    )

    expect(spellings).toEqual([])
  })
})
