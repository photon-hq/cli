import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { CliError } from '../src/core/errors.ts'
import { CliInput, type ReadableInput } from '../src/core/input.ts'
import { CliOutput } from '../src/core/output.ts'
import {
  detail,
  inert,
  inertLine,
  presentList,
  table
} from '../src/core/presenter.ts'
import {
  asOrganizationScope,
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  organizationFixture,
  TEST_ORGANIZATION_ID,
  terminalInvoker
} from './project-test-support.ts'

const ESCAPE = '\u001b'
const PLANTED = 'a\u001b[31mb'
const INERT = 'a^[[31mb'
const timestamp = '2026-07-31T18:00:00.000Z'

const terminalInput = (answer: string): Readable & ReadableInput => {
  const stream = Readable.from([answer]) as Readable & ReadableInput
  stream.isTTY = true
  return stream
}

describe('inert', () => {
  test.each([
    ['an escape sequence', PLANTED, INERT],
    ['a C1 control sequence introducer', 'a\u009b2Jb', 'a^[2Jb'],
    ['NUL, tab, line feed and carriage return', '\u0000\t\n\r', '^@^I^J^M'],
    ['DEL', 'a\u007fb', 'a^?b'],
    ['a right-to-left override', 'abc\u202edef', 'abc\\u{202e}def'],
    [
      'a zero-width space and a byte order mark',
      '\u200ba\ufeff',
      '\\u{200b}a\\u{feff}'
    ]
  ])('writes %s out as visible text', (_name, text, expected) => {
    expect(inert(text)).toBe(expected)
  })

  test('leaves printable text as it is', () => {
    const text = 'Acme Café, 東京, 🚀, ^ and \\'
    expect(inert(text)).toBe(text)
  })
})

describe('inertLine', () => {
  test('joins whitespace into one space and writes out other controls', () => {
    expect(inertLine('  Acme\t\u001b[1mCorp\r\n  Ltd  ')).toBe(
      'Acme ^[[1mCorp Ltd'
    )
  })

  test.each([
    ['a format character', 'abcd\u200defgh', 'abcd…'],
    ['a control character', 'abcdef\u001bg', 'abcdef…'],
    ['an escape that fits', 'ab\u001bcdefgh', 'ab^[cde…']
  ])(
    'cuts a long line with %s, never inside an escape',
    (_name, text, expected) => {
      expect(inertLine(text, 8)).toBe(expected)
    }
  )
})

describe('text output', () => {
  test('tables and detail views print API strings inert', () => {
    const output = new CliOutput({ color: false, json: false })
    const lines = [
      ...table(output, ['NAME', 'ID'], [[PLANTED, { text: PLANTED }]]),
      ...detail(output, PLANTED, [
        { label: 'Name', value: PLANTED },
        { label: 'Scopes', value: [PLANTED, 'b'] }
      ])
    ].join('\n')

    expect(lines).not.toContain(ESCAPE)
    expect(lines).toContain(`${INERT}  ${INERT}`)
    expect(lines).toContain(`Scopes  ${INERT}, b`)
  })

  test('table headings are inert, and a bordered table stays aligned', () => {
    const output = new CliOutput({ color: false, json: false })
    const plain = table(output, [PLANTED, 'ID'], [['x', 'y']])
    const bordered = table(output, [PLANTED, 'ID'], [['x', 'y']], undefined, {
      bordered: true
    })

    expect([...plain, ...bordered].join('\n')).not.toContain(ESCAPE)
    expect(plain[0]).toBe(`${INERT}  ID`)
    expect(new Set(bordered.map((line) => line.length)).size).toBe(1)
  })

  test('keeps styling from the CLI while API text is inert', () => {
    const output = new CliOutput({
      color: true,
      env: {},
      json: false,
      stdout: collector(true)
    })
    const lines = table(output, ['NAME'], [[PLANTED]]).join('\n')

    expect(lines).toContain(`${ESCAPE}[1m`)
    expect(lines).toContain(INERT)
    expect(lines).not.toContain(PLANTED)
  })

  test('spinners and the next page command print API strings inert', async () => {
    const stderr = collector()
    const stdout = collector()
    const output = new CliOutput({ color: false, json: false, stderr, stdout })
    await output.withLoading(`Waiting for ${PLANTED}`, () => Promise.resolve())
    presentList(output, {
      document: { names: [PLANTED] },
      emptyMessage: 'No names.',
      items: [PLANTED],
      lines: [inert(PLANTED)],
      page: {
        command: {
          args: {},
          commandPath: ['project', 'webhook', 'list'],
          explicit: {},
          values: {}
        },
        token: PLANTED
      }
    })

    expect(stderr.value()).toContain(`- Waiting for ${INERT}`)
    expect(stderr.value()).toContain(`--page-token '${INERT}'`)
    expect(`${stdout.value()}${stderr.value()}`).not.toContain(ESCAPE)
  })

  test.each([
    [PLANTED, true],
    [INERT, true],
    ['ab', false]
  ])(
    'a typed confirmation shows the value inert and accepts %j',
    async (answer, expected) => {
      const stderr = collector(true)
      const input = new CliInput({
        stderr,
        stdin: terminalInput(`${answer}\n`),
        stdout: collector(true)
      })

      await expect(input.confirmExact(PLANTED)).resolves.toBe(expected)
      expect(stderr.value()).toBe(`Type ${INERT} to confirm: `)
    }
  )

  test('errors and warnings print API strings inert, and JSON keeps them', () => {
    const error = new CliError(
      'NOT_FOUND',
      `Project ${PLANTED} was not found.`,
      {
        detail: PLANTED,
        next: [{ description: PLANTED, run: `photon project view ${PLANTED}` }]
      }
    )
    const stderr = collector()
    const output = new CliOutput({ color: false, json: false, stderr })
    output.warning(PLANTED)
    output.error(error)

    expect(stderr.value()).not.toContain(ESCAPE)
    expect(stderr.value()).toContain(`Warning: ${INERT}`)
    expect(stderr.value()).toContain(`Error: Project ${INERT} was not found.`)
    expect(stderr.value()).toContain(`Detail: ${INERT}`)
    expect(stderr.value()).toContain(`photon project view ${INERT}`)

    const json = collector()
    new CliOutput({ json: true, stdout: json }).error(error)
    expect(JSON.parse(json.value())).toMatchObject({
      error: {
        detail: PLANTED,
        message: `Project ${PLANTED} was not found.`,
        next: [{ description: PLANTED, run: `photon project view ${PLANTED}` }]
      }
    })
  })
})

describe('commands', () => {
  const project = {
    agentProfile: {
      avatarUrl: 'https://images.example.test/agent.png',
      firstName: 'Photon',
      lastName: null
    },
    createdAt: timestamp,
    createdByAccountId: 'pho_acc_00000000000000000000000002',
    createdByActorId: 'pho_acc_00000000000000000000000002',
    createdByActorKind: 'account',
    deletedAt: null,
    name: PLANTED,
    organizationId: TEST_ORGANIZATION_ID,
    projectId: 'pho_prj_00000000000000000000000001',
    slug: 'planted',
    updatedAt: timestamp
  }
  const options = {
    organizationScope: asOrganizationScope({
      listOrganizations: () =>
        Promise.resolve({
          acquisitionQuestionnaireExempt: false,
          organizations: [organizationFixture(TEST_ORGANIZATION_ID, PLANTED)],
          ownedOrganizationIds: [TEST_ORGANIZATION_ID]
        }),
      projects: { list: () => Promise.resolve({ projects: [project] }) }
    })
  }

  test.each([
    [['org', 'list'], { organizations: [{ name: PLANTED }] }],
    [['project', 'list'], { projects: [{ name: PLANTED }] }]
  ])(
    '%j prints a name inert in text and unchanged in JSON',
    async (args, document) => {
      const { configDirectory, remove } = await createAuthenticatedConfig()

      const text = await terminalInvoker(
        configDirectory,
        asProjectScope({}),
        options
      )(args)
      expect(text.exitCodes).toEqual([])
      expect(text.stdout).toContain(INERT)
      expect(`${text.stdout}${text.stderr}`).not.toContain(ESCAPE)

      const json = await cliInvoker(
        configDirectory,
        asProjectScope({}),
        options
      )(args)
      expect(JSON.parse(json.stdout)).toMatchObject(document)
      await remove()
    }
  )
})
