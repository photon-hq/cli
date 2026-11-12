import { describe, expect, test, vi } from 'vitest'
import { CliOutput } from '../src/core/output.ts'
import { collector } from './project-test-support.ts'

const ESCAPE = '\u001B['

describe('CLI color output', () => {
  test('uses ANSI styles only for TTY human output by default', () => {
    const terminal = collector(true)
    const piped = collector(false)
    const terminalOutput = new CliOutput({
      env: {},
      json: false,
      stdout: terminal
    })
    const pipedOutput = new CliOutput({
      env: {},
      json: false,
      stdout: piped
    })

    expect(
      terminalOutput.style('cyan', 'pho_prj_00000000000000000000000001')
    ).toContain(ESCAPE)
    expect(
      pipedOutput.style('cyan', 'pho_prj_00000000000000000000000001')
    ).toBe('pho_prj_00000000000000000000000001')
  })

  test('honors explicit and environment color opt-outs', () => {
    const terminal = collector(true)
    const disabled = [
      new CliOutput({ color: false, env: {}, json: false, stdout: terminal }),
      new CliOutput({ env: { NO_COLOR: '1' }, json: false, stdout: terminal }),
      new CliOutput({ env: { NO_COLORS: '1' }, json: false, stdout: terminal }),
      new CliOutput({ env: { TERM: 'dumb' }, json: false, stdout: terminal }),
      new CliOutput({ env: {}, json: true, stdout: terminal })
    ]

    for (const output of disabled) {
      expect(output.style('green', 'success')).toBe('success')
    }
  })

  test('ignores empty NO_COLOR compatibility variables', () => {
    const terminal = collector(true)

    for (const env of [{ NO_COLOR: '' }, { NO_COLORS: '' }]) {
      const output = new CliOutput({ env, json: false, stdout: terminal })
      expect(output.style('green', 'success')).toContain(ESCAPE)
    }
  })

  test('honors FORCE_COLOR for non-TTY streams unless explicitly disabled', () => {
    const piped = collector(false)
    const forced = new CliOutput({
      env: { FORCE_COLOR: '1', NO_COLOR: '1' },
      json: false,
      stdout: piped
    })
    const explicitlyDisabled = new CliOutput({
      color: false,
      env: { FORCE_COLOR: '1' },
      json: false,
      stdout: piped
    })

    expect(forced.style('yellow', 'warning')).toContain(ESCAPE)
    expect(explicitlyDisabled.style('yellow', 'warning')).toBe('warning')
  })

  test('keeps color out of JSON payloads', () => {
    const stdout = collector(true)
    const output = new CliOutput({
      env: { FORCE_COLOR: '1' },
      json: true,
      stdout
    })

    output.success(
      { projectId: 'pho_prj_00000000000000000000000001' },
      output.style('cyan', 'pho_prj_00000000000000000000000001')
    )

    expect(stdout.value()).not.toContain(ESCAPE)
    expect(JSON.parse(stdout.value())).toEqual({
      projectId: 'pho_prj_00000000000000000000000001'
    })
  })

  test('uses an Ora spinner in an interactive terminal', async () => {
    vi.useFakeTimers()
    const stderr = collector(true)
    const output = new CliOutput({
      color: false,
      json: false,
      stderr,
      stdout: collector(true)
    })
    let finishAction: () => void = () => {
      throw new Error('The loading action was not initialized.')
    }
    const action = new Promise<string>((resolve) => {
      finishAction = () => resolve('done')
    })

    try {
      const result = output.withLoading('Purchasing', async () => action)

      const firstFrame = stderr.value()
      expect(firstFrame).toContain('Purchasing')
      await vi.advanceTimersByTimeAsync(100)
      expect(stderr.value()).not.toBe(firstFrame)

      finishAction()
      await expect(result).resolves.toBe('done')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('leaves the terminal able to raise Ctrl-C while a spinner runs', async () => {
    // In raw mode the terminal no longer turns Ctrl-C into SIGINT.
    const setRawMode = vi.fn()
    const stdin = process.stdin as {
      isTTY?: boolean | undefined
      setRawMode?: ((mode: boolean) => unknown) | undefined
    }
    const original = { isTTY: stdin.isTTY, setRawMode: stdin.setRawMode }
    stdin.isTTY = true
    stdin.setRawMode = setRawMode
    const output = new CliOutput({
      color: false,
      json: false,
      stderr: collector(true)
    })

    try {
      await expect(
        output.withLoading('Purchasing', async () => 'done')
      ).resolves.toBe('done')
      expect(setRawMode).not.toHaveBeenCalled()
    } finally {
      stdin.isTTY = original.isTTY
      stdin.setRawMode = original.setRawMode
    }
  })

  test('uses Ora static text for non-interactive human output', async () => {
    const stderr = collector()
    const output = new CliOutput({ color: false, json: false, stderr })

    await expect(
      output.withLoading('Purchasing', async () => 'done')
    ).resolves.toBe('done')

    expect(stderr.value()).toBe('- Purchasing\n')
  })

  test('can suppress loading output outside an interactive terminal', async () => {
    const stderr = collector()
    const output = new CliOutput({ color: false, json: false, stderr })

    await expect(
      output.withLoading('Purchasing', async () => 'done', {
        nonInteractive: 'silent'
      })
    ).resolves.toBe('done')

    expect(stderr.value()).toBe('')
  })

  test('suppresses Ora loading output in JSON mode', async () => {
    const stderr = collector(true)
    const output = new CliOutput({ json: true, stderr })

    await expect(
      output.withLoading('Purchasing', async () => 'done')
    ).resolves.toBe('done')

    expect(stderr.value()).toBe('')
  })
})
