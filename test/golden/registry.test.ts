import type { Commandable } from 'gunshi'
import { getCommandSubCommands } from 'gunshi/utils'
import { describe, expect, test } from 'vitest'
import { internalCommands } from '#internal'
import { photonCommands } from '../../src/commands/registry.ts'
import { stagingTarget } from '../target-support.ts'
import { GOLDEN_CASES } from './cases.ts'

// Every command that runs, under the path that runs it.
const leafPaths = (
  commands: ReadonlyMap<string, Commandable> | undefined,
  path: readonly string[] = []
): string[] =>
  [...(commands ?? [])].flatMap(([name, command]) => {
    const children = getCommandSubCommands(command)
    return children === undefined || children.size === 0
      ? [[...path, name].join(' ')]
      : leafPaths(children, [...path, name])
  })

const REGISTERED = leafPaths(
  getCommandSubCommands({ subCommands: photonCommands })
)

// The staging target's registry also holds the staging-only commands of
// src/internal/. Production builds leave them out, so on the production target
// this list is empty.
const STAGING_ONLY = Object.entries(internalCommands).flatMap(
  ([group, commands]) =>
    leafPaths(getCommandSubCommands({ subCommands: commands }), [group])
)

const PRODUCTION = REGISTERED.filter(
  (command) => !STAGING_ONLY.includes(command)
)

const GOLDEN = new Set(GOLDEN_CASES.map(({ command }) => command))

// Production commands with no golden test yet. Each pull request that turns
// an area's JSON into the API's response adds its golden tests and takes its
// commands off this list.
const PENDING: ReadonlySet<string> = new Set()

describe('golden tests', () => {
  test('leave out the staging-only commands, which production builds drop', () => {
    expect(STAGING_ONLY.length > 0).toBe(stagingTarget)
    expect(STAGING_ONLY.every((command) => REGISTERED.includes(command))).toBe(
      true
    )
    expect(PRODUCTION).toHaveLength(REGISTERED.length - STAGING_ONLY.length)
    expect(PRODUCTION).toContain('project webhook list')
  })

  test.each(PRODUCTION)('%s has a golden test, or is pending', (command) => {
    expect(GOLDEN.has(command) || PENDING.has(command)).toBe(true)
  })

  test('cover no pending command, so the pending list stays current', () => {
    expect([...PENDING].filter((command) => GOLDEN.has(command))).toEqual([])
  })

  test('name production commands only, and so does the pending list', () => {
    expect(
      [...GOLDEN, ...PENDING].filter((command) => !PRODUCTION.includes(command))
    ).toEqual([])
  })
})
