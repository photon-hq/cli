import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { publicCommands } from './commands.ts'
import { type VerifiedFile, verifyFiles } from './files.ts'
import { latestReleaseSkip } from './latest.ts'
import { planPass, planProblems } from './plan.ts'
import {
  countsLine,
  type JobReport,
  jobMarkdown,
  type PassReport,
  passFailed,
  passReport,
  summaryMarkdown
} from './report.ts'
import { type Pass, processExecutor, runScenarios } from './runner.ts'
import { scenarios } from './scenarios.ts'

const COMMAND_TIMEOUT_MS = 180_000
const PASSES: readonly Pass[] = ['first', 'second']

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const writeSummary = async (lines: readonly string[]) => {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file !== undefined && file.length > 0) {
    await appendFile(file, `${lines.join('\n')}\n`)
  }
}

const check = async () => {
  const commands = await publicCommands()
  const problems = await planProblems(commands, scenarios)
  if (problems.length > 0) {
    fail(['The production test plan has problems:', ...problems].join('\n- '))
  }
  const declared = (kind: string) =>
    commands.filter(({ productionTest }) => productionTest?.kind === kind)
      .length
  process.stdout.write(
    `${commands.length.toString()} public commands: ${declared('run').toString()} run, ${declared('expect-error').toString()} expect an error, ${declared('skip').toString()} skipped.\n`
  )
}

const plan = async () => {
  const commands = await publicCommands()
  for (const pass of PASSES) {
    process.stdout.write(`${pass} pass:\n`)
    for (const step of await planPass(commands, scenarios, pass)) {
      process.stdout.write(
        `  [${step.scenario}]${step.cleanup ? ' (cleanup)' : ''} photon ${step.argv.join(' ')}\n`
      )
    }
  }
}

const files = async (args: string[]) => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      'npm-integrity': { type: 'string' },
      output: { type: 'string' }
    }
  })
  const directory = positionals[0] ?? fail('Usage: files <directory>')
  const verified = await verifyFiles(directory, {
    ...(values['npm-integrity'] === undefined
      ? {}
      : { npmIntegrity: values['npm-integrity'] })
  })
  for (const { against, name, sha256 } of verified) {
    process.stdout.write(`${sha256}  ${name}  (checked against ${against})\n`)
  }
  if (values.output !== undefined) {
    await writeFile(values.output, `${JSON.stringify(verified, null, 2)}\n`)
  }
}

// Prints {"run":true}, or {"reason":…,"run":false} when a run against npm's
// latest release is skipped. The workflow parses it, so stray output fails
// the run instead of skipping it.
const latest = (args: string[]) => {
  const reason = latestReleaseSkip(
    args[0] ?? fail('Usage: latest <npm latest version>')
  )
  process.stdout.write(
    `${JSON.stringify(reason === undefined ? { run: true } : { reason, run: false })}\n`
  )
}

const childEnvironment = (home: string): NodeJS.ProcessEnv => ({
  CI: 'true',
  HOME: home,
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state')
})

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')

const run = async (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      'fail-after': { type: 'string' },
      files: { type: 'string' },
      organization: { type: 'string' },
      photon: { type: 'string' },
      report: { type: 'string' },
      run: { type: 'string' },
      target: { type: 'string' }
    }
  })
  const executable = values.photon ?? fail('--photon <executable> is required')
  const organizationId =
    values.organization ?? fail('--organization <id> is required')
  const target = values.target ?? fail('--target <label> is required')
  const reportDirectory =
    values.report ?? fail('--report <directory> is required')
  const serviceKey = process.env.PHOTON_TEST_SERVICE_KEY ?? ''
  if (serviceKey.length === 0) {
    fail('PHOTON_TEST_SERVICE_KEY is not set.')
  }
  const commands = await publicCommands()
  const problems = await planProblems(commands, scenarios)
  if (problems.length > 0) {
    fail(['The production test plan has problems:', ...problems].join('\n- '))
  }
  const failAfter = values['fail-after']
  if (
    failAfter !== undefined &&
    !commands.some(({ path }) => path === failAfter)
  ) {
    fail(`--fail-after ${failAfter} is not a public command.`)
  }
  const verified: VerifiedFile[] =
    values.files === undefined
      ? []
      : JSON.parse(await readFile(values.files, 'utf8'))
  const startedAt = new Date().toISOString()
  const root = await mkdtemp(join(tmpdir(), 'photon-production-test-'))
  const passes: PassReport[] = []
  try {
    for (const pass of PASSES) {
      const home = join(root, pass)
      // Short enough for a project slug (63 characters) with the longest
      // label a scenario adds, and different for every job and pass.
      const namePrefix = `photon-cli-test-${createHash('sha256')
        .update(`${values.run ?? Date.now().toString()} ${target} ${pass}`)
        .digest('hex')
        .slice(0, 12)}`
      // biome-ignore lint/performance/noAwaitInLoops: the second pass starts only after the first one's teardown.
      await mkdir(home, { recursive: true })
      const planned = new Set(
        (await planPass(commands, scenarios, pass)).map(
          ({ command }) => command
        )
      )
      const invocations = await runScenarios({
        commands,
        executor: processExecutor({
          env: childEnvironment(home),
          executable,
          timeoutMs: COMMAND_TIMEOUT_MS
        }),
        ...(failAfter === undefined ? {} : { failAfter }),
        namePrefix,
        organizationId,
        pass,
        scenarios,
        serviceKey,
        workDirectory: join(home, 'files')
      })
      const report = passReport(pass, commands, planned, invocations)
      passes.push(report)
      process.stdout.write(
        `${target}, ${pass} pass, names starting ${namePrefix}: ${countsLine(report)}\n`
      )
    }
  } finally {
    await rm(root, { force: true, recursive: true })
  }
  const report: JobReport = {
    files: verified,
    finishedAt: new Date().toISOString(),
    organizationId,
    passes,
    schemaVersion: 1,
    startedAt,
    target
  }
  await mkdir(reportDirectory, { recursive: true })
  const name = slug(target)
  await writeFile(
    join(reportDirectory, `${name}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  )
  const markdown = jobMarkdown(report)
  await writeFile(
    join(reportDirectory, `${name}.md`),
    `${markdown.join('\n')}\n`
  )
  await writeSummary(summaryMarkdown([report]))
  if (passes.some(passFailed)) {
    process.exitCode = 1
  }
}

const [subcommand, ...rest] = process.argv.slice(2)
switch (subcommand) {
  case 'check':
    await check()
    break
  case 'files':
    await files(rest)
    break
  case 'latest':
    latest(rest)
    break
  case 'plan':
    await plan()
    break
  case 'run':
    await run(rest)
    break
  default:
    fail(
      'Usage: production-test check | plan | files <directory> | latest <version> | run'
    )
}
