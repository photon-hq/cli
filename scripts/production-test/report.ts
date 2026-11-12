import type { ProductionTest } from '../../src/commands/production-test.ts'
import type { PublicCommand } from './commands.ts'
import type { VerifiedFile } from './files.ts'
import type { CommandError, Invocation, Pass } from './runner.ts'

export type CommandStatus = 'expected error' | 'failed' | 'passed' | 'skipped'

export const STATUSES: readonly CommandStatus[] = [
  'passed',
  'expected error',
  'skipped',
  'failed'
]

export interface CommandResult {
  command: string
  error?: CommandError
  note?: string
  runs: number
  status: CommandStatus
  test: string
}

export interface PassReport {
  commands: CommandResult[]
  pass: Pass
  problems: string[]
}

export interface JobReport {
  files: VerifiedFile[]
  finishedAt: string
  organizationId: string
  passes: PassReport[]
  schemaVersion: 1
  startedAt: string
  target: string
}

export const testText = (test: ProductionTest | undefined): string => {
  if (test === undefined) {
    return 'none'
  }
  if (test.kind === 'expect-error') {
    return `expect-error ${test.code} ${test.reason}`
  }
  return test.kind === 'skip' ? `skip ${test.reason}` : 'run'
}

const NOT_REACHED = 'not reached: an earlier step failed'

const failure = (
  base: Omit<CommandResult, 'status'>,
  note: string | undefined,
  error?: CommandError
): CommandResult => ({
  ...base,
  ...(error === undefined ? {} : { error }),
  ...(note === undefined ? {} : { note }),
  status: 'failed'
})

const resultOf = (
  command: PublicCommand,
  invocations: readonly Invocation[]
): CommandResult => {
  const test = command.productionTest
  const base = {
    command: command.path,
    runs: invocations.length,
    test: testText(test)
  }
  if (test === undefined) {
    return failure(base, 'its definition declares no production test')
  }
  if (test.kind === 'skip') {
    return invocations.length === 0
      ? { ...base, note: test.reason, status: 'skipped' }
      : failure(base, 'it declares skip, but a scenario ran it')
  }
  const failed = invocations.find(({ outcome }) => outcome === 'failed')
  if (failed !== undefined) {
    return failure(base, failed.note, failed.error)
  }
  if (invocations.length === 0) {
    return failure(base, NOT_REACHED)
  }
  if (test.kind === 'expect-error') {
    return invocations.every(({ outcome }) => outcome === 'expected error')
      ? { ...base, status: 'expected error' }
      : failure(base, 'a scenario ran it without expecting the error')
  }
  return { ...base, status: 'passed' }
}

// planned: the commands this pass's scenarios run when every step passes.
export const passReport = (
  pass: Pass,
  commands: readonly PublicCommand[],
  planned: ReadonlySet<string>,
  invocations: readonly Invocation[]
): PassReport => ({
  commands: commands
    .filter(
      ({ path, productionTest }) =>
        pass === 'first' ||
        planned.has(path) ||
        (productionTest?.kind !== 'skip' &&
          invocations.some(({ command }) => command === path))
    )
    .map((command) =>
      resultOf(
        command,
        invocations.filter(({ command: path }) => path === command.path)
      )
    ),
  pass,
  problems: invocations
    .filter(
      ({ command, outcome }) =>
        outcome === 'failed' && !commands.some(({ path }) => path === command)
    )
    .map(({ argv, note }) => note ?? `unknown command: ${argv.join(' ')}`)
})

export const passFailed = (report: PassReport): boolean =>
  report.problems.length > 0 ||
  report.commands.some(({ status }) => status === 'failed')

export const counts = (report: PassReport): Record<CommandStatus, number> => {
  const result: Record<CommandStatus, number> = {
    'expected error': 0,
    failed: 0,
    passed: 0,
    skipped: 0
  }
  for (const { status } of report.commands) {
    result[status] += 1
  }
  return result
}

export const PASS_TITLES: Record<Pass, string> = {
  first: 'First pass: every public command',
  second:
    'Second pass: the commands that change something, again, signed in with a stored key in a new config directory'
}

const cell = (text: string): string =>
  text.replaceAll('|', '\\|').replaceAll('\n', ' ')

const detailOf = (result: CommandResult): string => {
  const parts = [
    result.note,
    result.error?.code === undefined
      ? undefined
      : `${result.error.code}${result.error.reason === undefined ? '' : ` (${result.error.reason})`}`,
    result.error?.requestId === undefined
      ? undefined
      : `request ${result.error.requestId}`,
    result.status === 'failed' ? result.error?.message : undefined
  ]
  return cell(parts.filter((part) => part !== undefined).join('; '))
}

// The commands that failed first, then the ones an earlier failure kept
// from running, on one line.
export const failureLines = (report: PassReport): string[] => {
  const failed = report.commands.filter(({ status }) => status === 'failed')
  const unreached = failed
    .filter(({ note }) => note === NOT_REACHED)
    .map(({ command }) => `\`${command}\``)
  return [
    ...failed
      .filter(({ note }) => note !== NOT_REACHED)
      .map((result) => `- \`${result.command}\`: ${detailOf(result)}`),
    ...report.problems.map((problem) => `- ${cell(problem)}`),
    ...(unreached.length === 0
      ? []
      : [
          `- Not reached, because an earlier step failed: ${unreached.join(', ')}`
        ])
  ]
}

export const countsLine = (report: PassReport): string => {
  const values = counts(report)
  return STATUSES.map(
    (status) => `${values[status].toString()} ${status}`
  ).join(', ')
}

export const jobMarkdown = (report: JobReport): string[] => [
  `# Production test: ${report.target}`,
  '',
  `Organization \`${report.organizationId}\`, ${report.startedAt} to ${report.finishedAt}.`,
  '',
  '## Files tested',
  '',
  ...report.files.map(
    ({ against, name, sha256 }) =>
      `- \`${name}\`: SHA-256 \`${sha256}\`, checked against ${against}`
  ),
  '',
  ...report.passes.flatMap((pass) => [
    `## ${PASS_TITLES[pass.pass]}`,
    '',
    countsLine(pass),
    '',
    ...(passFailed(pass) ? ['Failed:', '', ...failureLines(pass), ''] : []),
    '| Command | Test | Result | Detail |',
    '| --- | --- | --- | --- |',
    ...pass.commands.map(
      (result) =>
        `| \`${result.command}\` | ${cell(result.test)} | ${result.status} | ${detailOf(result)} |`
    ),
    ''
  ])
]

export const summaryMarkdown = (reports: readonly JobReport[]): string[] => [
  '# Production test',
  '',
  '| Target | Pass | Result |',
  '| --- | --- | --- |',
  ...reports.flatMap((report) =>
    report.passes.map(
      (pass) => `| ${report.target} | ${pass.pass} | ${countsLine(pass)} |`
    )
  ),
  '',
  ...reports.flatMap((report) =>
    report.passes
      .filter(passFailed)
      .flatMap((pass) => [
        `## Failed: ${report.target}, ${pass.pass} pass`,
        '',
        ...failureLines(pass),
        ''
      ])
  )
]
