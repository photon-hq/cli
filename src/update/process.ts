import { type ChildProcess, spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

export interface ProcessResult {
  exitCode: number | null
  stderr: string
  stdout: string
  timedOut?: true
}

export interface ProcessOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  showOutput?: boolean
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions
) => Promise<ProcessResult>

const OUTPUT_LIMIT = 16_384
const STDERR = 2
const DRAIN_MS = 1000
const FORCE_KILL_AFTER_MS = 5000
const PLAIN_WORD = /^[\w@./:+=-]+$/u
const TASKKILL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'taskkill.exe'
)

// On Windows, npm, pnpm and Yarn are .cmd files, which only cmd.exe runs. Node
// hands cmd.exe one command line and escapes nothing in it (DEP0190), so a
// command found on PATH runs as a line of plain words, and nothing else does.
const commandLine = (
  command: string,
  args: readonly string[]
): string | undefined => {
  if (process.platform !== 'win32' || isAbsolute(command)) {
    return
  }
  const words = [command, ...args]
  const unsafe = words.find((word) => !PLAIN_WORD.test(word))
  if (unsafe !== undefined) {
    throw new Error(`${JSON.stringify(unsafe)} cannot be passed to cmd.exe.`)
  }
  return words.join(' ')
}

// Stops a command that is still running. On POSIX it gets SIGTERM, which a
// package manager passes on to what it started, and SIGKILL if it is still
// running some seconds later. On Windows taskkill ends the whole tree: ending
// cmd.exe alone leaves what it runs going, and a command started without a
// console (all of its output piped) never sees Ctrl-C.
const stop = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_AFTER_MS)
    force.unref()
    child.once('exit', () => clearTimeout(force))
    return
  }
  spawn(TASKKILL, ['/pid', String(child.pid), '/t', '/f'], {
    stdio: 'ignore',
    windowsHide: true
  })
    .on('error', () => child.kill())
    .on('exit', (code) => {
      if (code !== 0) {
        child.kill()
      }
    })
}

export const runProcess: ProcessRunner = async (command, args, options = {}) =>
  await new Promise((done, fail) => {
    const { signal } = options
    const interrupted = (): void =>
      fail(
        signal?.reason ?? new DOMException('Command interrupted.', 'AbortError')
      )
    if (signal?.aborted === true) {
      interrupted()
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const line = commandLine(command, args)
    const child = spawn(line ?? command, line === undefined ? [...args] : [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: line !== undefined,
      stdio:
        options.showOutput === true
          ? ['ignore', STDERR, STDERR]
          : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    // Whatever the command started may hold its output open after it ends, so
    // the output is let go a moment after the command exits, once what it
    // wrote has been read, or as soon as it is stopped.
    const release = (): void => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const end = (): void => {
      stop(child)
      release()
    }
    let drain: NodeJS.Timeout | undefined
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            end()
          }, options.timeoutMs)
    signal?.addEventListener('abort', end, { once: true })
    const settle = (): void => {
      clearTimeout(timer)
      clearTimeout(drain)
      signal?.removeEventListener('abort', end)
    }
    child.on('exit', () => {
      clearTimeout(timer)
      drain = setTimeout(release, DRAIN_MS)
    })
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-OUTPUT_LIMIT)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-OUTPUT_LIMIT)
    })
    child.on('error', (error) => {
      settle()
      if (signal?.aborted === true) {
        interrupted()
        return
      }
      done({ exitCode: null, stderr: error.message, stdout })
    })
    child.on('close', (exitCode, exitSignal) => {
      settle()
      if (signal?.aborted === true || exitSignal === 'SIGINT') {
        interrupted()
        return
      }
      done({ exitCode, stderr, stdout, ...(timedOut ? { timedOut } : {}) })
    })
  })
