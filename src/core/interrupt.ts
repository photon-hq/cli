import type { CliExitCode } from './errors.ts'

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
} as const satisfies Record<string, CliExitCode>

export type InterruptSignal = keyof typeof SIGNAL_EXIT_CODES

const INTERRUPT_SIGNALS: readonly InterruptSignal[] = [
  'SIGHUP',
  'SIGINT',
  'SIGTERM'
]

export interface InterruptSource {
  exit: (code: number) => void
  on: (event: InterruptSignal, listener: () => void) => unknown
  removeListener: (event: InterruptSignal, listener: () => void) => unknown
}

export interface InterruptListener {
  dispose: () => void
  signal: AbortSignal
}

class CommandInterruption extends DOMException {
  readonly signal: InterruptSignal

  constructor(signal: InterruptSignal) {
    super('Command interrupted.', 'AbortError')
    this.signal = signal
  }
}

/**
 * The exit code of an interrupted command: 128 plus the number of the signal
 * that interrupted it. A Ctrl-C that a prompt reads as a key raises no signal
 * and counts as SIGINT.
 */
export const interruptedExitCode = (error: unknown): CliExitCode => {
  const visited = new Set<unknown>()
  let current = error
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof CommandInterruption) {
      return SIGNAL_EXIT_CODES[current.signal]
    }
    visited.add(current)
    current = current.cause
  }
  return SIGNAL_EXIT_CODES.SIGINT
}

/**
 * Turns Ctrl-C (SIGINT), SIGTERM and SIGHUP into an abort signal the running
 * command can wind down on, so each ends the command the same way.
 *
 * The listeners stay registered after the first signal. Libraries that restore
 * the terminal on exit (the spinner's cursor) end the process themselves as
 * soon as they are the only ones listening for a signal, which cut the command
 * off before it could report the interruption or record what to replay. Any
 * signal after the first ends the process at once with 128 plus that signal's
 * number, for a command that does not wind down.
 */
export const listenForInterrupt = (
  source: InterruptSource
): InterruptListener => {
  const controller = new AbortController()
  const listeners = INTERRUPT_SIGNALS.map((signal) => {
    const interrupt = (): void => {
      if (controller.signal.aborted) {
        source.exit(SIGNAL_EXIT_CODES[signal])
        return
      }
      controller.abort(new CommandInterruption(signal))
    }
    source.on(signal, interrupt)
    return { interrupt, signal }
  })
  return {
    dispose: () => {
      for (const { interrupt, signal } of listeners) {
        source.removeListener(signal, interrupt)
      }
    },
    signal: controller.signal
  }
}
