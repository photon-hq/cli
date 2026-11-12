import { parseArgs } from 'gunshi'
import { describe, expect, test } from 'vitest'
import { typedCommand } from '../src/core/presenter.ts'
import { CLI_NAME } from '../src/meta.ts'

const args = {
  displayName: { toKebab: true, type: 'string' },
  noBrowser: { toKebab: true, type: 'boolean' },
  pageToken: { type: 'string' },
  source: { type: 'string' }
} as const

const typed = (argv: string[]) => ({
  _: argv,
  args,
  commandPath: ['number', 'add'],
  tokens: parseArgs(argv)
})

describe('typedCommand', () => {
  test.each([
    {
      argv: ['--json', 'number', 'add', '--source', 'photon'],
      change: {},
      run: `${CLI_NAME} --json number add --source photon`
    },
    {
      argv: ['number', 'add', '--display-name', 'A', '--display-name', 'B'],
      change: { without: ['displayName'] },
      run: `${CLI_NAME} number add`
    },
    {
      argv: ['number', 'add', '--display-name=A', '--source', 'photon'],
      change: { without: ['displayName'] },
      run: `${CLI_NAME} number add --source photon`
    },
    {
      argv: ['number', 'add', '--no-browser', '--source', 'photon'],
      change: { without: ['noBrowser'] },
      run: `${CLI_NAME} number add --source photon`
    },
    {
      argv: ['number', 'add', '--no-browser=true', '--source', 'photon'],
      change: { without: ['noBrowser'] },
      run: `${CLI_NAME} number add --source photon`
    },
    {
      argv: ['number', 'add', '--pageToken', 'x', '--source', 'photon'],
      change: { without: ['pageToken'] },
      run: `${CLI_NAME} number add --source photon`
    },
    {
      argv: ['number', 'add', '--source', "it's mine"],
      change: {},
      run: `${CLI_NAME} number add --source 'it'\\''s mine'`
    },
    {
      argv: ['number', 'add', '--source', 'photon'],
      change: { add: '--voip-resource-id <resource-id>' },
      run: `${CLI_NAME} number add --source photon --voip-resource-id <resource-id>`
    },
    {
      argv: ['number', 'add', '--source', 'photon', '--'],
      change: { add: '--voip-resource-id <resource-id>' },
      run: `${CLI_NAME} number add --source photon --voip-resource-id <resource-id> --`
    }
  ])('rebuilds $argv as typed', ({ argv, change, run }) => {
    expect(typedCommand(typed(argv), change)).toBe(run)
  })
})
