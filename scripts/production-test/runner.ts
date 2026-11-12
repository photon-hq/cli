import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ProductionTest } from '../../src/commands/production-test.ts'
import type { PublicCommand } from './commands.ts'

export type Pass = 'first' | 'second'

export interface CommandError {
  code?: string
  message?: string
  reason?: string
  // The billing operation a refused plan purchase names.
  remoteOperationId?: string
  requestId?: string
}

export interface Invocation {
  argv: readonly string[]
  cleanup: boolean
  command: string
  error?: CommandError
  exitCode?: number
  note?: string
  outcome: 'expected error' | 'failed' | 'passed'
  scenario: string
}

export interface ExecutionResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface Executor {
  readonly dryRun: boolean
  run: (argv: readonly string[], stdin?: string) => Promise<ExecutionResult>
}

// json is the parsed JSON output, or the plain text of a command run with
// json: false. Neither leaves the process.
export interface Output {
  readonly command: string
  readonly invocation: Invocation
  readonly json: unknown
}

export interface PhotonOptions {
  // false runs the command without --json and keeps its output as text.
  json?: boolean
  // false leaves out --org, for the checks that read a stored selection.
  org?: boolean
  stdin?: string
}

export interface ScenarioContext {
  check: (
    output: Output,
    description: string,
    predicate: (json: unknown) => boolean
  ) => void
  defer: (argv: readonly string[]) => void
  readonly dryRun: boolean
  file: (name: string, contents: Uint8Array) => Promise<string>
  name: (label: string) => string
  readonly namePrefix: string
  readonly organizationId: string
  // A group of steps with its own deferred cleanups: a failed step ends the
  // part, and the scenario goes on with the next one.
  part: (
    name: string,
    run: () => Promise<void>,
    options?: { passes?: readonly Pass[] }
  ) => Promise<void>
  readonly pass: Pass
  photon: (argv: readonly string[], options?: PhotonOptions) => Promise<Output>
  // json is the refusal's error: its code, reason, request ID and message.
  refused: (argv: readonly string[]) => Promise<Output>
  select: (
    output: Output,
    description: string,
    selector: (json: unknown) => unknown
  ) => string
  readonly serviceKey: string
  sleep: (milliseconds: number) => Promise<void>
  value: (output: Output, path: string) => string
}

export interface Scenario {
  name: string
  passes: readonly Pass[]
  // A pass stops when a required scenario fails, as when sign-in fails.
  required?: boolean
  run: (context: ScenarioContext) => Promise<void>
}

export interface RunOptions {
  commands: readonly PublicCommand[]
  executor: Executor
  failAfter?: string
  namePrefix: string
  organizationId: string
  pass: Pass
  scenarios: readonly Scenario[]
  serviceKey: string
  // Where file() writes; a run without one can't use files.
  workDirectory?: string
}

class StepFailure extends Error {
  readonly invocation: Invocation

  constructor(invocation: Invocation, options?: ErrorOptions) {
    super(invocation.note ?? invocation.error?.code ?? 'failed', options)
    this.invocation = invocation
  }
}

const INDEX_PATTERN = /^\d+$/u

const MAXIMUM_MESSAGE_LENGTH = 300
const SECRET_PATTERN =
  /(pho_[a-z]+_|whsec_|sk_live_|sk_test_)[A-Za-z0-9._~-]+|(https?:\/\/\S*[?&](sig|signature|token|key|code)=)\S+/gu

export const redact = (text: string): string =>
  text
    .replace(
      SECRET_PATTERN,
      (match, prefix?: string, url?: string) =>
        `${prefix ?? url ?? match.slice(0, 4)}[REDACTED]`
    )
    .slice(0, MAXIMUM_MESSAGE_LENGTH)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const ERROR_FIELDS = [
  'code',
  'reason',
  'remoteOperationId',
  'requestId'
] as const

const errorOf = (error: Record<string, unknown>): CommandError => {
  const fields: CommandError = {}
  for (const field of ERROR_FIELDS) {
    const value = optionalString(error[field])
    if (value !== undefined) {
      fields[field] = value
    }
  }
  const message = optionalString(error.message)
  return message === undefined
    ? fields
    : { ...fields, message: redact(message) }
}

// Reads only the error's code, reason, request ID, message and remote
// operation ID from the last JSON error in the output. The rest of the output
// can hold secrets the commands print, so it is never kept.
export const parseError = (output: string): CommandError => {
  for (const line of output.split('\n').reverse()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isRecord(parsed) && isRecord(parsed.error)) {
      return errorOf(parsed.error)
    }
  }
  return { message: 'The command printed no JSON error.' }
}

const parseOutput = (stdout: string): unknown => {
  const text = stdout.trim()
  if (text.length === 0) {
    return
  }
  return JSON.parse(text.split('\n').at(-1) ?? '')
}

const readPath = (json: unknown, path: string): unknown => {
  let value = json
  for (const key of path.split('.')) {
    if (Array.isArray(value) && INDEX_PATTERN.test(key)) {
      value = value[Number(key)]
    } else if (isRecord(value)) {
      value = value[key]
    } else {
      return
    }
  }
  return value
}

const optionName = (token: string): string =>
  token.slice(2).split('=', 1)[0] ?? ''

// The command an argv runs: its longest leading words that name a public
// command.
export const commandOf = (
  commands: readonly PublicCommand[],
  argv: readonly string[]
): PublicCommand | undefined => {
  const end = argv.findIndex((token) => token.startsWith('-'))
  const words = end === -1 ? [...argv] : argv.slice(0, end)
  return words
    .map((_, index) => words.slice(0, words.length - index).join(' '))
    .map((path) => commands.find((candidate) => candidate.path === path))
    .find((command) => command !== undefined)
}

const positionalProblems = (
  command: PublicCommand,
  given: readonly string[]
): string[] => {
  const positionals = command.options.filter(
    ({ type }) => type === 'positional'
  )
  const variadic = positionals.some(({ multiple }) => multiple)
  const needed = positionals.filter(({ required }) => required).length
  return [
    ...(!variadic && given.length > positionals.length
      ? [
          `${command.path} takes ${positionals.length.toString()} positional arguments, not ${given.length.toString()}`
        ]
      : []),
    ...(given.length < needed
      ? [`${command.path} needs ${needed.toString()} positional arguments`]
      : [])
  ]
}

// Checks an argv against the command's metadata: every option exists, takes a
// value when it needs one, and the positionals fit.
export const argvProblems = (
  command: PublicCommand,
  argv: readonly string[]
): string[] => {
  const problems: string[] = []
  const words = command.path.split(' ').length
  const options = command.options.filter(({ type }) => type !== 'positional')
  const given: string[] = []
  const seen = new Set<string>()
  for (let index = words; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '--') {
      break
    }
    if (!token.startsWith('-')) {
      given.push(token)
      continue
    }
    const name = optionName(token)
    const option =
      options.find((candidate) => candidate.name === name) ??
      options.find(
        (candidate) => candidate.negatable && `no-${candidate.name}` === name
      )
    if (option === undefined) {
      problems.push(`${command.path} has no option --${name}`)
      continue
    }
    seen.add(option.name)
    if (option.type !== 'boolean' && !token.includes('=')) {
      index += 1
      if (index >= argv.length) {
        problems.push(`--${name} needs a value`)
      }
    }
  }
  for (const option of options) {
    if (option.required && !seen.has(option.name)) {
      problems.push(`${command.path} needs --${option.name}`)
    }
  }
  return [...problems, ...positionalProblems(command, given)]
}

export const passScenarios = (scenarios: readonly Scenario[], pass: Pass) =>
  scenarios.filter(({ passes }) => passes.includes(pass))

const textOf = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (typeof value === 'number') {
    return value.toString()
  }
}

export class ScenarioRun implements ScenarioContext {
  readonly dryRun: boolean
  readonly invocations: Invocation[] = []
  readonly namePrefix: string
  readonly organizationId: string
  readonly pass: Pass
  readonly serviceKey: string
  readonly #frames: (readonly string[])[][] = []
  readonly #options: RunOptions
  readonly #stdout = new WeakMap<Invocation, string>()
  // --fail-after: the step after that command's first run fails without
  // running, once the command's output has been read and whatever it made is
  // deferred for deletion.
  #forcedAfter: string | undefined
  #forced = false
  #scenario = ''

  constructor(options: RunOptions) {
    this.#options = options
    this.dryRun = options.executor.dryRun
    this.namePrefix = options.namePrefix
    this.organizationId = options.organizationId
    this.pass = options.pass
    this.serviceKey = options.serviceKey
  }

  name(label: string): string {
    return `${this.namePrefix}-${label}`
  }

  async file(name: string, contents: Uint8Array): Promise<string> {
    const directory = this.#options.workDirectory
    if (this.dryRun) {
      return `<file ${name}>`
    }
    if (directory === undefined) {
      throw new Error(`no directory to write ${name} to`)
    }
    await mkdir(directory, { recursive: true })
    const path = join(directory, name)
    await writeFile(path, contents)
    return path
  }

  async sleep(milliseconds: number): Promise<void> {
    if (!this.dryRun) {
      await delay(milliseconds)
    }
  }

  async photon(
    argv: readonly string[],
    options: PhotonOptions = {}
  ): Promise<Output> {
    const invocation = await this.#invoke(argv, options, false)
    if (invocation.outcome === 'failed') {
      throw new StepFailure(invocation)
    }
    return {
      command: invocation.command,
      invocation,
      json: this.#output(invocation, options.json !== false)
    }
  }

  async refused(argv: readonly string[]): Promise<Output> {
    const invocation = await this.#invoke(argv, {}, false)
    if (invocation.outcome === 'failed' && invocation.exitCode === undefined) {
      throw new StepFailure(invocation)
    }
    const expected = this.#declaration(invocation.command)
    if (expected?.kind !== 'expect-error') {
      invocation.outcome = 'failed'
      invocation.note = `${invocation.command} doesn't declare an expected error`
      throw new StepFailure(invocation)
    }
    const output = {
      command: invocation.command,
      invocation,
      json: invocation.error
    }
    if (this.dryRun) {
      invocation.outcome = 'expected error'
      return output
    }
    if (invocation.exitCode === 0) {
      this.#stdout.delete(invocation)
      invocation.outcome = 'failed'
      invocation.note = `succeeded, but ${expected.code} (${expected.reason}) was expected`
      throw new StepFailure(invocation)
    }
    if (
      invocation.error?.code === expected.code &&
      invocation.error.reason === expected.reason
    ) {
      invocation.outcome = 'expected error'
      return output
    }
    invocation.note = `${expected.code} (${expected.reason}) was expected`
    throw new StepFailure(invocation)
  }

  defer(argv: readonly string[]): void {
    const frame = this.#frames.at(-1)
    if (frame === undefined) {
      throw new Error('defer runs only inside a scenario')
    }
    frame.push(argv)
  }

  select(
    output: Output,
    description: string,
    selector: (json: unknown) => unknown
  ): string {
    if (this.dryRun) {
      return `<${output.command}: ${description}>`
    }
    let value: unknown
    try {
      value = selector(output.json)
    } catch {
      value = undefined
    }
    return (
      textOf(value) ?? this.#fail(output, `its output has no ${description}`)
    )
  }

  value(output: Output, path: string): string {
    return this.select(output, path, (json) => readPath(json, path))
  }

  check(
    output: Output,
    description: string,
    predicate: (json: unknown) => boolean
  ): void {
    if (this.dryRun) {
      return
    }
    let passed = false
    try {
      passed = predicate(output.json)
    } catch {
      passed = false
    }
    if (!passed) {
      this.#fail(output, `check failed: ${description}`)
    }
  }

  async part(
    name: string,
    run: () => Promise<void>,
    options: { passes?: readonly Pass[] } = {}
  ): Promise<void> {
    if (options.passes !== undefined && !options.passes.includes(this.pass)) {
      return
    }
    const scenario = this.#scenario
    this.#scenario = `${scenario} / ${name}`
    try {
      await this.#inFrame(run)
    } catch (error) {
      this.#stopped(error)
    } finally {
      this.#scenario = scenario
    }
  }

  async run(scenario: Scenario): Promise<boolean> {
    this.#scenario = scenario.name
    const first = this.invocations.length
    try {
      await this.#inFrame(async () => await scenario.run(this))
    } catch (error) {
      this.#stopped(error)
    }
    return this.invocations
      .slice(first)
      .every(({ cleanup, outcome }) => cleanup || outcome !== 'failed')
  }

  // Deferred steps run last first, after the steps of their frame, whether
  // those passed or not.
  async #inFrame(run: () => Promise<void>): Promise<void> {
    const frame: (readonly string[])[] = []
    this.#frames.push(frame)
    try {
      await run()
    } finally {
      this.#frames.pop()
      while (frame.length > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: cleanups run one at a time, last deferred first.
        await this.#invoke(frame.pop() ?? [], {}, true)
      }
    }
  }

  #stopped(error: unknown): void {
    if (error instanceof StepFailure) {
      return
    }
    this.invocations.push({
      argv: [],
      cleanup: false,
      command: '',
      note: `${this.#scenario} stopped: ${redact(this.#withoutKey(error instanceof Error ? error.message : String(error)))}`,
      outcome: 'failed',
      scenario: this.#scenario
    })
  }

  // The key itself, whatever its shape, on top of redact()'s patterns.
  #withoutKey(text: string): string {
    return this.serviceKey.length === 0
      ? text
      : text.replaceAll(this.serviceKey, '[REDACTED]')
  }

  #declaration(command: string): ProductionTest | undefined {
    return this.#options.commands.find(({ path }) => path === command)
      ?.productionTest
  }

  #fail(output: Output, note: string): never {
    output.invocation.outcome = 'failed'
    output.invocation.note = note
    throw new StepFailure(output.invocation)
  }

  #output(invocation: Invocation, json: boolean): unknown {
    if (this.dryRun) {
      return
    }
    const stdout = this.#stdout.get(invocation) ?? ''
    this.#stdout.delete(invocation)
    if (!json) {
      return stdout
    }
    try {
      return parseOutput(stdout)
    } catch (error) {
      invocation.outcome = 'failed'
      invocation.note = 'its output is not JSON'
      throw new StepFailure(invocation, { cause: error })
    }
  }

  async #invoke(
    argv: readonly string[],
    options: PhotonOptions,
    cleanup: boolean
  ): Promise<Invocation> {
    const command = commandOf(this.#options.commands, argv)
    const invocation: Invocation = {
      argv,
      cleanup,
      command: command === undefined ? argv.join(' ') : command.path,
      outcome: 'passed',
      scenario: this.#scenario
    }
    this.invocations.push(invocation)
    if (command === undefined) {
      invocation.outcome = 'failed'
      invocation.note = 'no public command has these words'
      return invocation
    }
    if (this.#forcedAfter !== undefined && !cleanup) {
      invocation.outcome = 'failed'
      invocation.note = `forced failure after ${this.#forcedAfter} (--fail-after)`
      this.#forcedAfter = undefined
      return invocation
    }
    const result = await this.#options.executor.run(
      [
        ...argv,
        ...(options.json === false ? [] : ['--json']),
        ...(options.org === false
          ? []
          : ['--org', this.#options.organizationId])
      ],
      options.stdin
    )
    invocation.exitCode = result.exitCode
    if (result.exitCode !== 0) {
      invocation.outcome = 'failed'
      invocation.error = parseError(
        this.#withoutKey(`${result.stdout}\n${result.stderr}`)
      )
      return invocation
    }
    if (!cleanup) {
      this.#stdout.set(invocation, result.stdout)
    }
    if (
      !(cleanup || this.#forced) &&
      this.#options.failAfter === command.path
    ) {
      this.#forced = true
      this.#forcedAfter = command.path
    }
    return invocation
  }
}

export const runScenarios = async (
  options: RunOptions
): Promise<Invocation[]> => {
  const run = new ScenarioRun(options)
  for (const scenario of passScenarios(options.scenarios, options.pass)) {
    // biome-ignore lint/performance/noAwaitInLoops: scenarios run in order, each on the session the first one opens.
    if (!(await run.run(scenario)) && scenario.required === true) {
      break
    }
  }
  return run.invocations
}

export const dryRunExecutor: Executor = {
  dryRun: true,
  run: async () =>
    await Promise.resolve({ exitCode: 0, stderr: '', stdout: '' })
}

export interface ProcessExecutorOptions {
  env: NodeJS.ProcessEnv
  executable: string
  timeoutMs: number
}

export const processExecutor = ({
  env,
  executable,
  timeoutMs
}: ProcessExecutorOptions): Executor => ({
  dryRun: false,
  run: async (argv, stdin) =>
    await new Promise<ExecutionResult>((resolve) => {
      const child = spawn(executable, [...argv], {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({
          exitCode: 127,
          stderr: JSON.stringify({
            error: { code: 'SPAWN_FAILED', message: error.message }
          }),
          stdout: ''
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          exitCode: code ?? 1,
          stderr: timedOut
            ? JSON.stringify({
                error: { code: 'TIMED_OUT', message: 'The command timed out.' }
              })
            : Buffer.concat(stderr).toString('utf8'),
          stdout: Buffer.concat(stdout).toString('utf8')
        })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdin ?? '')
    })
})
