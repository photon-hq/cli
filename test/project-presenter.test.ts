import { describe, expect, test } from 'vitest'
import { CliOutput } from '../src/core/output.ts'
import { table } from '../src/core/presenter.ts'
import { collector } from './project-test-support.ts'

describe('project presenter', () => {
  test('aligns table columns using terminal display width', () => {
    const output = new CliOutput({
      color: false,
      json: false,
      stdout: collector()
    })

    expect(
      table(
        output,
        ['NAME', 'ID'],
        [
          ['界', '1'],
          ['🙂', '2'],
          ['a', '3']
        ],
        'No projects.'
      )
    ).toEqual(['NAME  ID', '界    1', '🙂    2', 'a     3'])
  })

  test('renders an opt-in bordered table', () => {
    const output = new CliOutput({
      color: false,
      json: false,
      stdout: collector()
    })

    expect(
      table(output, ['TYPE', 'VALUE'], [['MX', 'mail.example.com']], 'Empty.', {
        bordered: true
      })
    ).toEqual([
      '┌──────┬──────────────────┐',
      '│ TYPE │ VALUE            │',
      '├──────┼──────────────────┤',
      '│ MX   │ mail.example.com │',
      '└──────┴──────────────────┘'
    ])
  })
})
