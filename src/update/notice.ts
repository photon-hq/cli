import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import envPaths from 'env-paths'
import { z } from 'zod'
import { BUILD_CONFIG } from '../build-config.ts'
import { commandWords } from '../commands/moved.ts'
import {
  CliOutput,
  outputOptionsFromArgs,
  type WritableOutput
} from '../core/output.ts'
import { withEnvironmentProxy } from '../core/proxy.ts'
import { canShowNotice, isOn } from '../core/terminal.ts'
import { photonUserAgent, withUserAgent } from '../core/user-agent.ts'
import { CLI_NAME, CLI_VERSION } from '../meta.ts'
import {
  detectInstallation,
  noticeCommand,
  runningFile,
  runsThroughNpx
} from './installation.ts'
import { BINARY_ASSET, isNewerRelease } from './release.ts'
import { UpdateService } from './service.ts'

export const UPDATE_CHECK_ARGUMENT = '--photon-update-check'

const CHECK_INTERVAL_MS = 86_400_000
const STATE_FILE = 'update-check.json'

const stateSchema = z.object({
  checkedAt: z.number(),
  command: z.string().nullable().optional(),
  file: z.string(),
  latestVersion: z.string().optional(),
  notifiedAt: z.number().optional(),
  start: z.string().optional()
})

type NoticeState = z.infer<typeof stateSchema>

export interface NoticeOptions {
  args: readonly string[]
  env: NodeJS.ProcessEnv
  file?: string
  now?: () => number
  // A command that Ctrl-C, SIGTERM or SIGHUP ended shows no notice.
  signal?: AbortSignal | undefined
  startCheck?: () => void
  stateFile?: string
  stderr: WritableOutput
  stdout: WritableOutput
}

export const noticeAllowed = (
  options: Pick<NoticeOptions, 'args' | 'env' | 'stderr' | 'stdout'>
): boolean =>
  canShowNotice(options.stdout, options.stderr, {
    env: options.env,
    json: outputOptionsFromArgs(options.args).json
  }) && !isOn(options.env.PHOTON_NO_UPDATE_NOTIFIER)

const defaultStateFile = (): string =>
  join(envPaths(BUILD_CONFIG.stateNamespace, { suffix: '' }).cache, STATE_FILE)

const binaryPath = (): string | undefined =>
  BINARY_ASSET === undefined ? undefined : process.execPath

// Installs that run the same copy, such as a global pnpm install and a
// project's, are told apart by the folder the CLI was started from, which
// both of its commands (photon and pho) share. A standalone binary is its
// own file.
const startFolder = (binary: string | undefined): string | undefined =>
  binary === undefined ? dirname(process.argv[1] ?? '') : undefined

const ofInstall = (
  saved: NoticeState | undefined,
  file: string,
  start: string | undefined
): NoticeState | undefined =>
  saved?.file === file && saved.start === start ? saved : undefined

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const readState = async (path: string): Promise<NoticeState | undefined> =>
  stateSchema.safeParse(parseJson(await readFile(path, 'utf8').catch(() => '')))
    .data

const writeState = async (path: string, state: NoticeState): Promise<void> => {
  const temporary = `${path}.${process.pid.toString()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(state)}\n`)
    await rename(temporary, path)
  } catch {
    // The check is best effort: state that can't be saved only means the
    // next run checks again.
  }
}

const startBackgroundCheck = (): void => {
  const args =
    BINARY_ASSET === undefined
      ? [...process.execArgv, process.argv[1] ?? '', UPDATE_CHECK_ARGUMENT]
      : [UPDATE_CHECK_ARGUMENT]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => undefined)
  child.unref()
}

const isDue = (since: number | undefined, now: number): boolean =>
  since === undefined || now - since >= CHECK_INTERVAL_MS

const writeNotice = (
  options: NoticeOptions,
  latestVersion: string,
  command: string | null | undefined
): void => {
  const output = new CliOutput({
    env: options.env,
    json: false,
    stderr: options.stderr,
    stdout: options.stdout
  })
  output.progress('')
  output.progress(
    output.style(
      'yellow',
      `A new version of ${CLI_NAME} is available: ${CLI_VERSION} → ${latestVersion}`,
      'stderr'
    )
  )
  if (command !== null && command !== undefined) {
    output.progress(
      `To update, run: ${output.style('cyan', command, 'stderr')}`
    )
  }
}

export const prepareUpdateNotice = async (
  options: NoticeOptions
): Promise<() => Promise<void>> => {
  const nothing = (): Promise<void> => Promise.resolve()
  if (!noticeAllowed(options) || commandWords(options.args)[0] === 'update') {
    return nothing
  }
  const binary = binaryPath()
  const file = options.file ?? runningFile(binary)
  if (runsThroughNpx(file)) {
    return nothing
  }
  const start = startFolder(binary)
  const now = (options.now ?? Date.now)()
  const path = options.stateFile ?? defaultStateFile()
  const state = ofInstall(await readState(path), file, start)
  if (isDue(state?.checkedAt, now)) {
    await writeState(path, { ...state, checkedAt: now, file, start })
    ;(options.startCheck ?? startBackgroundCheck)()
  }
  const latestVersion = state?.latestVersion
  if (
    latestVersion === undefined ||
    !isNewerRelease(latestVersion, CLI_VERSION) ||
    !isDue(state?.notifiedAt, now)
  ) {
    return nothing
  }
  return async () => {
    if (options.signal?.aborted === true) {
      return
    }
    writeNotice(options, latestVersion, state?.command)
    await writeState(path, {
      ...(ofInstall(await readState(path), file, start) ?? {
        ...state,
        checkedAt: now,
        file,
        start
      }),
      notifiedAt: now
    })
  }
}

export const runUpdateCheck = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const binary = binaryPath()
  const file = runningFile(binary)
  const start = startFolder(binary)
  const service = new UpdateService({
    env,
    fetch: withUserAgent(
      withEnvironmentProxy(globalThis.fetch, env),
      photonUserAgent(env)
    ),
    progress: () => undefined,
    showOutput: false
  })
  const [result, installation] = await Promise.all([
    service.check(),
    detectInstallation({ binaryPath: binary, file })
  ])
  const path = defaultStateFile()
  await writeState(path, {
    ...ofInstall(await readState(path), file, start),
    checkedAt: Date.now(),
    command: noticeCommand(installation) ?? null,
    file,
    latestVersion: result.latestVersion,
    start
  })
}
