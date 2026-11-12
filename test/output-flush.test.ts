import { Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { CliOutput, writeFailureSurfaced } from '../src/core/output.ts'
import { collector, lateFailingStdout } from './project-test-support.ts'

const writeFailure = Object.assign(
  new Error('ENOSPC: no space left on device, write'),
  { code: 'ENOSPC', syscall: 'write' }
)
const nextTurn = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('output that must reach stdout before its record is deleted', () => {
  test('fails when the write fails after write() returned', async () => {
    const output = new CliOutput({ json: true, stdout: lateFailingStdout() })

    await expect(
      output.successAndFlush({ secret: 'one-time' }, [])
    ).rejects.toMatchObject({ code: 'ENOSPC' })
  })

  test('waits for the write callback before it resolves', async () => {
    let finishWrite: (() => void) | undefined
    const stdout = new Writable({
      write: (_chunk, _encoding, callback) => {
        finishWrite = () => callback()
      }
    })
    const output = new CliOutput({ json: true, stdout })
    let flushed = false

    const flushing = output.successAndFlush({ ok: true }, []).then(() => {
      flushed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(flushed).toBe(false)

    finishWrite?.()
    await flushing
    expect(flushed).toBe(true)
  })
})

describe('a failed write to stdout that no command reported', () => {
  test('is one error line on stderr', () => {
    const stderr = collector()

    new CliOutput({ json: false, stderr }).writeFailure(writeFailure)

    expect(stderr.value()).toBe(
      'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)\n'
    )
  })

  test('is no message when the reader closed the pipe', () => {
    const stderr = collector()

    new CliOutput({ json: false, stderr }).writeFailure(
      Object.assign(new Error('EPIPE: broken pipe, write'), {
        code: 'EPIPE',
        syscall: 'write'
      })
    )

    expect(stderr.value()).toBe('')
  })

  test('adds the cause chain with --debug', () => {
    const stderr = collector()

    new CliOutput({ debug: true, json: false, stderr }).writeFailure(
      writeFailure
    )

    const lines = stderr.value().split('\n')
    expect(lines[0]).toBe(
      'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)'
    )
    expect(lines).toContain('Debug:')
    expect(stderr.value()).toContain(
      'Error: ENOSPC: no space left on device, write'
    )
  })

  test('is one JSON error line on stderr with --json', () => {
    const stderr = collector()

    new CliOutput({ json: true, stderr }).writeFailure(writeFailure)

    expect(stderr.value().trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'OUTPUT_WRITE_FAILED',
        message: 'Photon could not write the result to standard output.'
      }
    })
  })

  test('is left to the command once it reached successAndFlush', async () => {
    const stdout = lateFailingStdout()
    const output = new CliOutput({ json: true, stdout })
    expect(writeFailureSurfaced(stdout)).toBe(false)

    await expect(output.successAndFlush({ ok: true }, [])).rejects.toThrow()

    expect(writeFailureSurfaced(stdout)).toBe(true)
  })

  test('is not left to the command after a plain write', async () => {
    const stdout = lateFailingStdout()

    new CliOutput({ json: true, stdout }).success({ ok: true }, [])
    await nextTurn()
    await nextTurn()

    expect(writeFailureSurfaced(stdout)).toBe(false)
  })
})

describe('help and version text', () => {
  test.each([false, true])(
    'goes to stdout as Gunshi rendered it, with --json %s',
    (json) => {
      const stdout = collector()

      new CliOutput({ json, stdout }).usage('USAGE:\n  photon <COMMAND>\n')

      expect(stdout.value()).toBe('USAGE:\n  photon <COMMAND>\n\n')
    }
  )
})
