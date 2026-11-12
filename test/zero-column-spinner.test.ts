import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { CliOutput } from '../src/core/output.ts'

const ROOT = join(import.meta.dirname, '..')
const COMMAND = join(import.meta.dirname, 'support', 'zero-column-spinner.ts')
const MESSAGE = 'A message wider than 80 columns, narrower than 120'.padEnd(
  100,
  '.'
)
const MOST_CALLS = 10_000
const DEADLINE_MS = 5000
const TEST_TIMEOUT_MS = 15_000

/** What a spinner does to a terminal of the given width over 400 ms. */
const draw = async (columns: number): Promise<string[]> => {
  const calls: string[] = []
  const record = (call: string) => {
    calls.push(call)
    if (calls.length > MOST_CALLS) {
      throw new Error(
        `The spinner wrote to a terminal of ${columns.toString()} columns more than ${MOST_CALLS.toString()} times.`
      )
    }
  }
  const terminal = {
    clearLine: (direction: number) => record(`clearLine(${direction})`),
    columns,
    cursorTo: (x: number) => record(`cursorTo(${x})`),
    isTTY: true,
    moveCursor: (dx: number, dy: number) => record(`moveCursor(${dx}, ${dy})`),
    write: record
  }
  const output = new CliOutput({
    color: false,
    env: {},
    json: false,
    stderr: terminal,
    stdout: terminal
  })
  await output.withLoading(MESSAGE, async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
  return calls
}

/**
 * Runs the spinner command for the given milliseconds, sends it `signal` once
 * its spinner has drawn, and kills it if it hasn't ended by the deadline or
 * the test ends first.
 */
const run = async (milliseconds: number, signal?: NodeJS.Signals) => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', COMMAND, milliseconds.toString()],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  let terminal = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const drawn = terminal.includes('Waiting')
    terminal += chunk
    if (signal !== undefined && !drawn && terminal.includes('Waiting')) {
      child.kill(signal)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const deadline = setTimeout(() => child.kill('SIGKILL'), DEADLINE_MS)
  const [exitCode, endedBy] = (await once(child, 'close')) as [
    number | null,
    NodeJS.Signals | null
  ]
  clearTimeout(deadline)
  return { endedBy, exitCode, stderr, terminal }
}

describe('a spinner on a terminal that reports 0 columns', () => {
  test('draws as it would on a terminal of 80 columns', async () => {
    vi.useFakeTimers()
    try {
      const drawn = await draw(0)
      expect(drawn).toEqual(await draw(80))
      expect(drawn).not.toEqual(await draw(120))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe.skipIf(process.platform === 'win32')(
  'a command whose spinner runs on a terminal that reports 0 columns',
  () => {
    test.each([
      ['finishes', undefined, 0],
      ['ends on Ctrl-C', 'SIGINT', 130],
      ['ends on SIGTERM', 'SIGTERM', 143]
    ] as const)(
      '%s',
      async (_name, signal, exitCode) => {
        const result = await run(signal === undefined ? 300 : 60_000, signal)

        expect(result.terminal).toContain('Waiting for browser authorization')
        expect(result, result.stderr).toMatchObject({ endedBy: null, exitCode })
      },
      TEST_TIMEOUT_MS
    )
  }
)
