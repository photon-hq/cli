import { setTimeout as delay } from 'node:timers/promises'
import {
  interruptedExitCode,
  listenForInterrupt
} from '../../src/core/interrupt.ts'
import { CliOutput } from '../../src/core/output.ts'

/**
 * A command whose spinner runs on a terminal that reports 0 columns, as one
 * can while its window is minimized, for the milliseconds its argument names
 * or until a signal interrupts it. What the terminal receives goes to
 * standard output.
 */
const terminal = {
  clearLine: () => true,
  columns: 0,
  cursorTo: () => true,
  isTTY: true,
  moveCursor: () => true,
  write: (chunk: string) => process.stdout.write(chunk)
}
const interrupt = listenForInterrupt(process)
const output = new CliOutput({
  color: false,
  env: {},
  json: false,
  stderr: terminal,
  stdout: terminal
})
try {
  await output.withLoading('Waiting for browser authorization', async () => {
    await delay(Number(process.argv[2]), undefined, {
      signal: interrupt.signal
    })
  })
} catch (error) {
  if (!interrupt.signal.aborted) {
    throw error
  }
  process.exitCode = interruptedExitCode(error)
} finally {
  interrupt.dispose()
}
