import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { lazy } from 'gunshi'
import { describe, expect, it } from 'vitest'
import {
  type CommandOption,
  type PublicCommand,
  publicCommands
} from '../scripts/production-test/commands.ts'
import {
  CHECKSUMS_FILE,
  MANIFEST_FILE,
  verifyFiles
} from '../scripts/production-test/files.ts'
import {
  FIRST_TESTED_MAJOR,
  latestReleaseSkip
} from '../scripts/production-test/latest.ts'
import { planPass, planProblems } from '../scripts/production-test/plan.ts'
import {
  counts,
  failureLines,
  type JobReport,
  passFailed,
  passReport,
  summaryMarkdown
} from '../scripts/production-test/report.ts'
import {
  argvProblems,
  type ExecutionResult,
  type Executor,
  type Invocation,
  type Pass,
  parseError,
  processExecutor,
  redact,
  runScenarios,
  type Scenario
} from '../scripts/production-test/runner.ts'
import { scenarios } from '../scripts/production-test/scenarios.ts'
import {
  expectError,
  runs,
  skip,
  tested
} from '../src/commands/production-test.ts'
import { photonKey } from './key-support.ts'

const ORGANIZATION = 'pho_org_test'
const SERVICE_KEY = photonKey('ask', 'live_0123456789abcdef')
const ROOT = join(import.meta.dirname, '..')
const PRODUCTION_TEST_COMMAND = join(
  ROOT,
  'scripts',
  'production-test',
  'index.ts'
)
const execFileAsync = promisify(execFile)

const option = (
  name: string,
  type = 'string',
  extra: Partial<CommandOption> = {}
): CommandOption => ({
  global: false,
  multiple: false,
  name,
  negatable: false,
  required: false,
  type,
  ...extra
})

const globals = [
  option('json', 'boolean', { global: true }),
  option('org', 'string', { global: true })
]

const fixtureCommands: PublicCommand[] = [
  {
    options: [...globals, option('name', 'string', { required: true })],
    path: 'thing create',
    productionTest: runs
  },
  {
    options: [
      ...globals,
      option('id', 'positional', { required: true }),
      option('force', 'boolean')
    ],
    path: 'thing delete',
    productionTest: runs
  },
  { options: globals, path: 'thing list', productionTest: runs },
  {
    options: [...globals, option('force', 'boolean')],
    path: 'thing buy',
    productionTest: expectError('ENTITLEMENT_REQUIRED', 'card_required')
  },
  {
    options: globals,
    path: 'thing wipe',
    productionTest: skip('it cannot be undone')
  }
]

const ok = (json: unknown): ExecutionResult => ({
  exitCode: 0,
  stderr: '',
  stdout: `${JSON.stringify(json)}\n`
})

const refusal = (error: Record<string, string>): ExecutionResult => ({
  exitCode: 1,
  stderr: '',
  stdout: `${JSON.stringify({ error })}\n`
})

// A fake Photon that keeps its things in memory and records every call.
const fakePhoton = (
  buy: ExecutionResult = refusal({
    code: 'ENTITLEMENT_REQUIRED',
    reason: 'card_required',
    requestId: 'req_buy'
  })
) => {
  const things = new Map<string, string>()
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = []
  let next = 0
  const executor: Executor = {
    dryRun: false,
    run: async (argv, stdin) => {
      calls.push({ argv, stdin })
      const [, verb, value] = argv
      const name = argv[argv.indexOf('--name') + 1] ?? ''
      if (verb === 'create') {
        next += 1
        const id = `thing_${next.toString()}`
        things.set(id, name)
        return await Promise.resolve(
          ok({ thing: { id, name, secret: 'pho_sk_live_secretvalue' } })
        )
      }
      if (verb === 'list') {
        return await Promise.resolve(
          ok({ things: [...things].map(([id, n]) => ({ id, name: n })) })
        )
      }
      if (verb === 'delete') {
        things.delete(value ?? '')
        return await Promise.resolve(ok({ deleted: true }))
      }
      return await Promise.resolve(buy)
    }
  }
  return { calls, executor, things }
}

const thingScenario: Scenario = {
  name: 'things',
  passes: ['first', 'second'],
  async run(context) {
    const created = await context.photon([
      'thing',
      'create',
      '--name',
      context.name('thing')
    ])
    const id = context.value(created, 'thing.id')
    context.defer(['thing', 'delete', id, '--force'])
    const listed = await context.photon(['thing', 'list'])
    context.check(listed, 'the thing is listed', (json) =>
      JSON.stringify(json).includes(id)
    )
    await context.part('purchase', async () => {
      await context.refused(['thing', 'buy', '--force'])
    })
  }
}

const leftoverScenario: Scenario = {
  name: 'nothing left behind',
  passes: ['first', 'second'],
  async run(context) {
    const listed = await context.photon(['thing', 'list'])
    context.check(
      listed,
      'no thing is left',
      (json) => !JSON.stringify(json).includes(context.namePrefix)
    )
  }
}

const runFixture = async (
  executor: Executor,
  extra: { failAfter?: string; pass?: Pass } = {}
): Promise<Invocation[]> =>
  await runScenarios({
    commands: fixtureCommands,
    executor,
    ...(extra.failAfter === undefined ? {} : { failAfter: extra.failAfter }),
    namePrefix: 'photon-cli-test-1',
    organizationId: ORGANIZATION,
    pass: extra.pass ?? 'first',
    scenarios: [thingScenario, leftoverScenario],
    serviceKey: SERVICE_KEY
  })

const outcomes = (invocations: readonly Invocation[]) =>
  invocations.map(({ argv, cleanup, outcome }) => ({
    argv: argv.slice(0, 2).join(' '),
    cleanup,
    outcome
  }))

// Tests run the internal build, which adds staging-only commands; `pnpm
// test:production-plan` checks that every production command declares one.
const declaredCommands = async (): Promise<PublicCommand[]> =>
  (await publicCommands()).filter(
    ({ productionTest }) => productionTest !== undefined
  )

describe('production test declarations', () => {
  it('fits the plan to every declared command', async () => {
    const commands = await declaredCommands()
    expect(commands.length).toBeGreaterThan(100)
    expect(await planProblems(commands, scenarios)).toEqual([])
  })

  it('fails a command whose definition declares no production test', async () => {
    const declared = tested(
      runs,
      lazy(() => () => undefined, { args: {}, name: 'declared' })
    )
    const undeclared = lazy(() => () => undefined, {
      args: {},
      name: 'undeclared'
    })
    const commands = await publicCommands({ declared, undeclared })
    expect(
      commands.map(({ path, productionTest }) => [path, productionTest])
    ).toEqual([
      ['complete', runs],
      ['declared', runs],
      ['undeclared', undefined]
    ])
    expect(await planProblems(commands, [])).toContain(
      'undeclared declares no production test'
    )
    const report = passReport('first', commands, new Set(), [])
    expect(
      report.commands.find(({ command }) => command === 'undeclared')
    ).toMatchObject({
      note: 'its definition declares no production test',
      status: 'failed'
    })
    expect(passFailed(report)).toBe(true)
  })

  it('reports every declared command in a dry run of the whole plan', async () => {
    const commands = await declaredCommands()
    const declared = (kind: string) =>
      commands.filter(({ productionTest }) => productionTest?.kind === kind)
        .length
    const invocations = await planPass(commands, scenarios, 'first')
    const report = passReport(
      'first',
      commands,
      new Set(invocations.map(({ command }) => command)),
      invocations
    )
    expect(report.commands).toHaveLength(commands.length)
    expect(counts(report)).toEqual({
      'expected error': declared('expect-error'),
      failed: 0,
      passed: declared('run'),
      skipped: declared('skip')
    })
  })

  it('keeps every name a scenario makes short enough for a project slug', async () => {
    const commands = await declaredCommands()
    const prefix = 'photon-cli-test-0123456789ab'
    const invocations = await runScenarios({
      commands,
      executor: {
        dryRun: true,
        run: async () => await Promise.resolve(ok({}))
      },
      namePrefix: prefix,
      organizationId: ORGANIZATION,
      pass: 'first',
      scenarios,
      serviceKey: SERVICE_KEY
    })
    const names = invocations.flatMap(({ argv }) =>
      argv.filter((token) => token.startsWith(prefix))
    )
    expect(names.length).toBeGreaterThan(5)
    expect(names.filter((name) => name.length > 63)).toEqual([])
  })

  it('signs in with the key on stdin in both passes, never as an argument', async () => {
    const commands = await declaredCommands()
    const passes = await Promise.all(
      (['first', 'second'] as const).map(
        async (pass) => await planPass(commands, scenarios, pass)
      )
    )
    for (const invocations of passes) {
      expect(
        invocations.find(({ command }) => command === 'login')?.argv
      ).toEqual(['login', '--service-key', '--insecure-storage'])
      expect(JSON.stringify(invocations)).not.toContain('<key>')
    }
  })
})

describe('production test runner', () => {
  it('runs reads and writes, deferring each delete to the end of its scenario', async () => {
    const photon = fakePhoton()
    const invocations = await runFixture(photon.executor)
    expect(outcomes(invocations)).toEqual([
      { argv: 'thing create', cleanup: false, outcome: 'passed' },
      { argv: 'thing list', cleanup: false, outcome: 'passed' },
      { argv: 'thing buy', cleanup: false, outcome: 'expected error' },
      { argv: 'thing delete', cleanup: true, outcome: 'passed' },
      { argv: 'thing list', cleanup: false, outcome: 'passed' }
    ])
    expect(photon.things.size).toBe(0)
    expect(
      photon.calls.every(
        ({ argv }) =>
          argv.includes('--json') &&
          argv.at(-1) === ORGANIZATION &&
          argv.at(-2) === '--org'
      )
    ).toBe(true)
  })

  it('still deletes what a scenario made after a forced failure, and shows nothing left', async () => {
    const photon = fakePhoton()
    const invocations = await runFixture(photon.executor, {
      failAfter: 'thing create'
    })
    expect(outcomes(invocations)).toEqual([
      { argv: 'thing create', cleanup: false, outcome: 'passed' },
      { argv: 'thing list', cleanup: false, outcome: 'failed' },
      { argv: 'thing delete', cleanup: true, outcome: 'passed' },
      { argv: 'thing list', cleanup: false, outcome: 'passed' }
    ])
    expect(invocations[1]?.note).toBe(
      'forced failure after thing create (--fail-after)'
    )
    expect(photon.things.size).toBe(0)
    const report = passReport('first', fixtureCommands, new Set(), invocations)
    expect(
      report.commands.map(({ command, status }) => [command, status])
    ).toEqual([
      ['thing create', 'passed'],
      ['thing delete', 'passed'],
      ['thing list', 'failed'],
      ['thing buy', 'failed'],
      ['thing wipe', 'skipped']
    ])
  })

  it('fails a purchase refused for another reason, or one that goes through', async () => {
    const other = await runFixture(
      fakePhoton(
        refusal({
          code: 'ENTITLEMENT_REQUIRED',
          reason: 'billing_restricted',
          requestId: 'req_other'
        })
      ).executor
    )
    expect(other.find(({ command }) => command === 'thing buy')).toMatchObject({
      error: { reason: 'billing_restricted', requestId: 'req_other' },
      note: 'ENTITLEMENT_REQUIRED (card_required) was expected',
      outcome: 'failed'
    })
    const bought = await runFixture(fakePhoton(ok({ bought: true })).executor)
    expect(bought.find(({ command }) => command === 'thing buy')).toMatchObject(
      {
        note: 'succeeded, but ENTITLEMENT_REQUIRED (card_required) was expected',
        outcome: 'failed'
      }
    )
    expect(bought.at(-1)?.command).toBe('thing list')
  })

  it('passes a refusal on, so the next step can read the operation it names', async () => {
    const photon = fakePhoton(
      refusal({
        code: 'BILLING_OPERATION_REJECTED',
        reason: 'payment_method_required',
        remoteOperationId: 'pho_bop_1'
      })
    )
    const viewed: string[] = []
    await runScenarios({
      commands: [
        ...fixtureCommands.filter(({ path }) => path !== 'thing buy'),
        {
          options: [...globals, option('force', 'boolean')],
          path: 'thing buy',
          productionTest: expectError(
            'BILLING_OPERATION_REJECTED',
            'payment_method_required'
          )
        }
      ],
      executor: photon.executor,
      namePrefix: 'photon-cli-test-1',
      organizationId: ORGANIZATION,
      pass: 'first',
      scenarios: [
        {
          name: 'plan',
          passes: ['first'],
          async run(context) {
            const refused = await context.refused(['thing', 'buy', '--force'])
            viewed.push(context.value(refused, 'remoteOperationId'))
          }
        }
      ],
      serviceKey: SERVICE_KEY
    })
    expect(viewed).toEqual(['pho_bop_1'])
  })

  it('redacts the key itself, whatever its shape', async () => {
    const key = 'plain-key-without-a-prefix'
    const invocations = await runScenarios({
      commands: fixtureCommands,
      executor: {
        dryRun: false,
        run: async () =>
          await Promise.resolve(
            refusal({
              code: 'AUTH_SERVICE_KEY_REJECTED',
              message: `bad ${key}`
            })
          )
      },
      namePrefix: 'photon-cli-test-1',
      organizationId: ORGANIZATION,
      pass: 'first',
      scenarios: [thingScenario],
      serviceKey: key
    })
    expect(invocations[0]?.error?.message).toBe('bad [REDACTED]')
    expect(JSON.stringify(invocations)).not.toContain(key)
  })

  it('stops the pass when a required scenario fails', async () => {
    const photon = fakePhoton()
    const invocations = await runScenarios({
      commands: fixtureCommands,
      executor: photon.executor,
      namePrefix: 'photon-cli-test-1',
      organizationId: ORGANIZATION,
      pass: 'first',
      scenarios: [
        {
          name: 'sign in',
          passes: ['first'],
          required: true,
          async run(context) {
            await context.refused(['thing', 'list'])
          }
        },
        thingScenario
      ],
      serviceKey: SERVICE_KEY
    })
    expect(outcomes(invocations)).toEqual([
      { argv: 'thing list', cleanup: false, outcome: 'failed' }
    ])
  })

  it('keeps no command output and redacts secrets in error messages', async () => {
    const photon = fakePhoton(
      refusal({
        code: 'ENTITLEMENT_REQUIRED',
        message: `Key ${SERVICE_KEY} and https://example.com/a?token=abc123 were refused`,
        reason: 'card_required'
      })
    )
    const invocations = await runFixture(photon.executor)
    const text = JSON.stringify(
      passReport('first', fixtureCommands, new Set(), invocations)
    )
    expect(text).not.toContain('pho_sk_live_secretvalue')
    expect(text).not.toContain(SERVICE_KEY)
    expect(text).not.toContain('abc123')
    expect(
      redact(`Key ${SERVICE_KEY} and https://example.com/a?token=abc123`)
    ).toBe('Key pho_ask_[REDACTED] and https://example.com/a?token=[REDACTED]')
  })

  it('reads the code, reason and request ID of a JSON error, and nothing else', () => {
    expect(
      parseError(
        [
          'warning: something printed first',
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              details: { secret: SERVICE_KEY },
              message: 'No project.',
              reason: 'project_not_found',
              requestId: 'req_1'
            }
          })
        ].join('\n')
      )
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'No project.',
      reason: 'project_not_found',
      requestId: 'req_1'
    })
    expect(parseError('Segmentation fault')).toEqual({
      message: 'The command printed no JSON error.'
    })
  })

  it('checks a step against its command options', () => {
    const [create, remove] = fixtureCommands
    if (create === undefined || remove === undefined) {
      throw new Error('fixture commands are missing')
    }
    expect(argvProblems(create, ['thing', 'create', '--name', 'a'])).toEqual([])
    expect(argvProblems(create, ['thing', 'create', '--colour=red'])).toEqual([
      'thing create has no option --colour',
      'thing create needs --name'
    ])
    expect(argvProblems(create, ['thing', 'create', '--name'])).toEqual([
      '--name needs a value'
    ])
    expect(argvProblems(remove, ['thing', 'delete', 'a', 'b'])).toEqual([
      'thing delete takes 1 positional arguments, not 2'
    ])
    expect(argvProblems(remove, ['thing', 'delete', 'a', '--', '-x'])).toEqual(
      []
    )
  })

  it('runs a real process with the key on stdin and its own environment', async () => {
    const executor = processExecutor({
      env: { PATH: process.env.PATH, PHOTON_TEST_ONLY: 'yes' },
      executable: process.execPath,
      timeoutMs: 10_000
    })
    const result = await executor.run(
      [
        '-e',
        'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>console.log(JSON.stringify({stdin:s,only:process.env.PHOTON_TEST_ONLY,key:process.env.PHOTON_TEST_SERVICE_KEY??null})))'
      ],
      'secret\n'
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      key: null,
      only: 'yes',
      stdin: 'secret\n'
    })
  })

  it('reports a process that exits before reading its stdin', async () => {
    const executor = processExecutor({
      env: { PATH: process.env.PATH },
      executable: process.execPath,
      timeoutMs: 10_000
    })
    const result = await executor.run(
      ['-e', 'process.exit(3)'],
      'x'.repeat(4 * 1024 * 1024)
    )
    expect(result.exitCode).toBe(3)
  })
})

describe('production test files', () => {
  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex')
  const integrity = (text: string) =>
    `sha512-${createHash('sha512').update(text).digest('base64')}`
  const directoryWith = async (files: Record<string, string>) => {
    const directory = await mkdtemp(join(tmpdir(), 'photon-production-files-'))
    await Promise.all(
      Object.entries(files).map(
        async ([name, contents]) =>
          await writeFile(join(directory, name), contents)
      )
    )
    return directory
  }

  it('checks a binary against its .sha256 and a candidate tarball against the release manifest', async () => {
    const manifest = {
      packages: [
        {
          production: {
            file: 'photon-ai-cli-3.0.0.tgz',
            integrity: integrity('package'),
            sha256: sha256('package')
          }
        }
      ]
    }
    const directory = await directoryWith({
      [MANIFEST_FILE]: JSON.stringify(manifest),
      'photon-ai-cli-3.0.0.tgz': 'package',
      'photon-linux-x64': 'binary',
      'photon-linux-x64.sha256': `${sha256('binary')}  dist/photon-linux-x64\n`
    })
    expect(await verifyFiles(directory)).toEqual([
      {
        against: MANIFEST_FILE,
        name: 'photon-ai-cli-3.0.0.tgz',
        sha256: sha256('package')
      },
      {
        against: 'photon-linux-x64.sha256',
        name: 'photon-linux-x64',
        sha256: sha256('binary')
      }
    ])
  })

  it('checks a registry tarball against the integrity npm published', async () => {
    const directory = await directoryWith({
      'photon-ai-cli-3.0.0.tgz': 'package'
    })
    expect(
      await verifyFiles(directory, { npmIntegrity: integrity('package') })
    ).toEqual([
      {
        against: 'the npm registry',
        name: 'photon-ai-cli-3.0.0.tgz',
        sha256: sha256('package')
      }
    ])
    await expect(
      verifyFiles(directory, { npmIntegrity: integrity('other') })
    ).rejects.toThrow('but the npm registry says')
  })

  it('refuses a file whose checksum differs or that has none', async () => {
    await expect(
      verifyFiles(
        await directoryWith({
          'photon-linux-x64': 'binary',
          'photon-linux-x64.sha256': `${sha256('other')}  photon-linux-x64\n`
        })
      )
    ).rejects.toThrow('but photon-linux-x64.sha256 says')
    await expect(
      verifyFiles(await directoryWith({ 'photon-linux-x64': 'binary' }))
    ).rejects.toThrow('photon-linux-x64 has no checksum to check it against.')
  })

  it("checks a release's archive and npm tarball against its checksums.txt", async () => {
    const directory = await directoryWith({
      [CHECKSUMS_FILE]: [
        `${sha256('package')}  photon-ai-cli-3.0.0.tgz`,
        `${sha256('other archive')}  photon-darwin-arm64.tar.gz`,
        `${sha256('archive')} *photon-linux-x64.tar.gz`,
        ''
      ].join('\n'),
      'photon-ai-cli-3.0.0.tgz': 'package',
      'photon-linux-x64.tar.gz': 'archive'
    })
    expect(await verifyFiles(directory)).toEqual([
      {
        against: CHECKSUMS_FILE,
        name: 'photon-ai-cli-3.0.0.tgz',
        sha256: sha256('package')
      },
      {
        against: CHECKSUMS_FILE,
        name: 'photon-linux-x64.tar.gz',
        sha256: sha256('archive')
      }
    ])
  })

  it('refuses a file checksums.txt lists differently or not at all, and a malformed checksums.txt', async () => {
    await expect(
      verifyFiles(
        await directoryWith({
          [CHECKSUMS_FILE]: `${sha256('other')}  photon-linux-x64.tar.gz\n`,
          'photon-linux-x64.tar.gz': 'archive'
        })
      )
    ).rejects.toThrow(`but ${CHECKSUMS_FILE} says`)
    await expect(
      verifyFiles(
        await directoryWith({
          [CHECKSUMS_FILE]: `${sha256('package')}  photon-ai-cli-3.0.0.tgz\n`,
          'photon-linux-x64.tar.gz': 'archive'
        })
      )
    ).rejects.toThrow(
      'photon-linux-x64.tar.gz has no checksum to check it against.'
    )
    await expect(
      verifyFiles(
        await directoryWith({
          [CHECKSUMS_FILE]: `${sha256('archive')}  photon-linux-x64.tar.gz\nnot a line\n`,
          'photon-linux-x64.tar.gz': 'archive'
        })
      )
    ).rejects.toThrow(`${CHECKSUMS_FILE} line 2 isn't`)
    await expect(
      verifyFiles(
        await directoryWith({
          [CHECKSUMS_FILE]: `${sha256('archive')}  photon-linux-x64.tar.gz\n${sha256('other')}  photon-linux-x64.tar.gz\n`,
          'photon-linux-x64.tar.gz': 'archive'
        })
      )
    ).rejects.toThrow(`${CHECKSUMS_FILE} lists photon-linux-x64.tar.gz twice.`)
  })
})

describe('production test of the latest release', () => {
  it("skips while npm's latest is a 1.0 release, and runs from 3.x on, prereleases included", () => {
    expect(FIRST_TESTED_MAJOR).toBe(3)
    expect(latestReleaseSkip('2.3.0')).toBe(
      "npm's latest @photon-ai/cli is 2.3.0, a 1.0 release. The production test covers 3.x and later, so no command ran."
    )
    expect(latestReleaseSkip('2.99.99')).toBeDefined()
    expect(latestReleaseSkip('2.3.1-rc.1')).toBeDefined()
    for (const version of ['3.0.0-rc.1', '3.0.0', '3.0.1', '3.2.0', '10.0.0']) {
      expect(latestReleaseSkip(version), version).toBeUndefined()
    }
    expect(() => latestReleaseSkip('')).toThrow(
      'npm\'s latest version "" isn\'t a version.'
    )
  })

  it('prints its decision as JSON for the workflow', async () => {
    const decision = async (version: string): Promise<unknown> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', PRODUCTION_TEST_COMMAND, 'latest', version],
        { cwd: ROOT }
      )
      return JSON.parse(stdout)
    }
    expect(await decision('2.3.0')).toEqual({
      reason: latestReleaseSkip('2.3.0'),
      run: false
    })
    expect(await decision('3.0.0')).toEqual({ run: true })
  })
})

describe('production test report', () => {
  it('lists what failed first and what it kept from running on one line', async () => {
    const invocations = await runScenarios({
      commands: fixtureCommands,
      executor: {
        dryRun: false,
        run: async () =>
          await Promise.resolve(
            refusal({
              code: 'AUTH_SERVICE_KEY_REJECTED',
              requestId: 'req_login'
            })
          )
      },
      namePrefix: 'photon-cli-test-1',
      organizationId: ORGANIZATION,
      pass: 'first',
      scenarios: [thingScenario],
      serviceKey: SERVICE_KEY
    })
    expect(
      failureLines(passReport('first', fixtureCommands, new Set(), invocations))
    ).toEqual([
      '- `thing create`: AUTH_SERVICE_KEY_REJECTED; request req_login',
      '- Not reached, because an earlier step failed: `thing delete`, `thing list`, `thing buy`'
    ])
  })

  it('lists the failing commands with their request IDs in the summary', async () => {
    const invocations = await runFixture(
      fakePhoton(
        refusal({
          code: 'ENTITLEMENT_REQUIRED',
          reason: 'billing_restricted',
          requestId: 'req_other'
        })
      ).executor
    )
    const report: JobReport = {
      files: [],
      finishedAt: '2026-01-01T00:01:00.000Z',
      organizationId: ORGANIZATION,
      passes: [passReport('first', fixtureCommands, new Set(), invocations)],
      schemaVersion: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      target: 'Linux npm 3.0.0'
    }
    expect(summaryMarkdown([report])).toEqual([
      '# Production test',
      '',
      '| Target | Pass | Result |',
      '| --- | --- | --- |',
      '| Linux npm 3.0.0 | first | 3 passed, 0 expected error, 1 skipped, 1 failed |',
      '',
      '## Failed: Linux npm 3.0.0, first pass',
      '',
      '- `thing buy`: ENTITLEMENT_REQUIRED (card_required) was expected; ENTITLEMENT_REQUIRED (billing_restricted); request req_other',
      ''
    ])
  })
})
