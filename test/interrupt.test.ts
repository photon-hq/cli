import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  type InterruptSignal,
  interruptedExitCode,
  listenForInterrupt
} from '../src/core/interrupt.ts'

const createSource = () => {
  const emitter = new EventEmitter()
  const exit = vi.fn()
  return {
    emitter,
    exit,
    source: {
      exit,
      on: (event: InterruptSignal, listener: () => void) =>
        emitter.on(event, listener),
      removeListener: (event: InterruptSignal, listener: () => void) =>
        emitter.removeListener(event, listener)
    }
  }
}

describe('interrupt listener', () => {
  test('aborts the command on the first Ctrl-C', () => {
    const { emitter, exit, source } = createSource()
    const interrupt = listenForInterrupt(source)

    expect(interrupt.signal.aborted).toBe(false)
    emitter.emit('SIGINT')

    expect(interrupt.signal.aborted).toBe(true)
    expect(interrupt.signal.reason).toMatchObject({ name: 'AbortError' })
    expect(exit).not.toHaveBeenCalled()
  })

  test('keeps listening while the command winds down', () => {
    // A library that restores the terminal on exit ends the process when it
    // is the only listener left, so this one must not remove itself.
    const { emitter, source } = createSource()
    listenForInterrupt(source)

    emitter.emit('SIGINT')

    expect(emitter.listenerCount('SIGINT')).toBe(1)
  })

  test('ends the process on a second Ctrl-C', () => {
    const { emitter, exit, source } = createSource()
    listenForInterrupt(source)

    emitter.emit('SIGINT')
    emitter.emit('SIGINT')

    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
  })

  test('stops listening once the command has finished', () => {
    const { emitter, source } = createSource()
    const interrupt = listenForInterrupt(source)

    interrupt.dispose()
    emitter.emit('SIGINT')

    expect(emitter.listenerCount('SIGINT')).toBe(0)
    expect(interrupt.signal.aborted).toBe(false)
  })

  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ] as const)('aborts the command on %s and exits %i', (signal, exitCode) => {
    const { emitter, exit, source } = createSource()
    const interrupt = listenForInterrupt(source)

    emitter.emit(signal)

    expect(interrupt.signal.aborted).toBe(true)
    expect(interrupt.signal.reason).toMatchObject({
      name: 'AbortError',
      signal
    })
    expect(interruptedExitCode(interrupt.signal.reason)).toBe(exitCode)
    expect(exit).not.toHaveBeenCalled()
  })

  test('keeps listening for every signal while the command winds down', () => {
    const { emitter, source } = createSource()
    listenForInterrupt(source)

    emitter.emit('SIGTERM')

    expect(emitter.listenerCount('SIGINT')).toBe(1)
    expect(emitter.listenerCount('SIGTERM')).toBe(1)
    expect(emitter.listenerCount('SIGHUP')).toBe(1)
  })

  test('ends a GitHub Actions cancel, SIGINT then SIGTERM, with 143', () => {
    const { emitter, exit, source } = createSource()
    listenForInterrupt(source)

    emitter.emit('SIGINT')
    emitter.emit('SIGTERM')

    expect(exit).toHaveBeenCalledExactlyOnceWith(143)
  })

  test('ends the process with 128 plus the number of any signal after the first', () => {
    const { emitter, exit, source } = createSource()
    listenForInterrupt(source)

    emitter.emit('SIGTERM')
    emitter.emit('SIGHUP')

    expect(exit).toHaveBeenCalledExactlyOnceWith(129)
  })

  test('stops listening for every signal once the command has finished', () => {
    const { emitter, source } = createSource()
    const interrupt = listenForInterrupt(source)

    interrupt.dispose()

    expect(emitter.eventNames()).toEqual([])
  })
})

describe('interrupted exit code', () => {
  test('is 130 for a Ctrl-C a prompt reads as a key, with no signal', () => {
    expect(
      interruptedExitCode(new DOMException('cancelled', 'AbortError'))
    ).toBe(130)
  })

  test('finds the signal behind an error that wraps the interruption', () => {
    const { emitter, source } = createSource()
    const interrupt = listenForInterrupt(source)
    emitter.emit('SIGTERM')

    expect(
      interruptedExitCode(
        new Error('The request was aborted.', {
          cause: interrupt.signal.reason
        })
      )
    ).toBe(143)
  })
})
