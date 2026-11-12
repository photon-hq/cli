import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import {
  CliError,
  hasOwnNextSteps,
  normalizeCliError
} from '../src/core/errors.ts'
import { CliInput, type ReadableInput } from '../src/core/input.ts'
import { listenForInterrupt } from '../src/core/interrupt.ts'
import { collector, createAuthenticatedConfig } from './project-test-support.ts'

const inputStream = (
  value: string,
  isTTY: boolean
): Readable & ReadableInput => {
  const stream = Readable.from([value]) as Readable & ReadableInput
  stream.isTTY = isTTY
  return stream
}

const privateDocumentOptions = {
  fileDescription: 'private document',
  label: 'Private document',
  maximumBytes: 8,
  option: '--document-file'
} as const

describe('CLI input', () => {
  test.each([
    ['y\n', true],
    ['yes\n', true],
    ['n\n', false],
    ['anything else\n', false]
  ])('parses confirmation answer %j', async (answer, expected) => {
    const input = new CliInput({
      stderr: collector(true),
      stdin: inputStream(answer, true),
      stdout: collector(true)
    })

    await expect(input.confirm('Continue?')).resolves.toBe(expected)
  })

  test('rejects confirmation on non-interactive stdin', async () => {
    const input = new CliInput({ stdin: inputStream('', false) })

    await expect(input.confirm('Continue?')).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      exitCode: 2
    })
  })

  test('reports a stable error for a non-interactive selection', async () => {
    const input = new CliInput({ stdin: inputStream('', false) })
    const question = 'Which WhatsApp onboarding path should be used?'

    await expect(
      input.select(question, [{ label: 'BYON', value: 'byon' }], '--source')
    ).rejects.toMatchObject({
      code: 'ARGUMENT_VALIDATION',
      detail: `Photon can't ask "${question}": standard input is not a terminal. Pass the answer with --source.`,
      exitCode: 2
    })
  })

  test('leaves a non-interactive selection the command help step', async () => {
    const input = new CliInput({ stdin: inputStream('', false) })

    const failure = await input
      .select(
        'Which onboarding path?',
        [{ label: 'BYON', value: 'byon' }],
        '--source'
      )
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CliError)
    expect(hasOwnNextSteps(failure as CliError)).toBe(false)
  })

  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ] as const)(
    'ends an interactive selection interrupted by %s with exit code %i',
    async (signal, exitCode) => {
      const stdin = new PassThrough() as PassThrough & ReadableInput
      stdin.isTTY = true
      Object.assign(stdin, { setRawMode: () => stdin })
      const emitter = new EventEmitter()
      const interrupt = listenForInterrupt({
        exit: vi.fn(),
        on: (event, listener) => emitter.on(event, listener),
        removeListener: (event, listener) =>
          emitter.removeListener(event, listener)
      })
      const input = new CliInput({
        signal: interrupt.signal,
        stderr: Object.assign(new PassThrough(), { isTTY: true }),
        stdin,
        stdout: collector(true)
      })

      const selection = input.select(
        'Which onboarding path?',
        [{ label: 'BYON', value: 'byon' }],
        '--source'
      )
      emitter.emit(signal)

      expect(
        normalizeCliError(await selection.catch((error: unknown) => error))
      ).toMatchObject({ code: 'COMMAND_INTERRUPTED', exitCode })
    }
  )

  test.each([
    ['+14155550199\n', true],
    [' +14155550199\n', false],
    ['+14155550198\n', false]
  ])(
    'requires an exact confirmation value for %j',
    async (answer, expected) => {
      const stderr = collector(true)
      const input = new CliInput({
        stderr,
        stdin: inputStream(answer, true),
        stdout: collector(true)
      })

      await expect(input.confirmExact('+14155550199')).resolves.toBe(expected)
      expect(stderr.value()).toBe('Type +14155550199 to confirm: ')
    }
  )

  test('rejects exact confirmation on non-interactive stdin', async () => {
    const input = new CliInput({ stdin: inputStream('', false) })

    await expect(input.confirmExact('+14155550199')).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      exitCode: 2
    })
  })

  test('reads an invitation token from piped stdin without exposing it', async () => {
    const token = 'private-token-value'
    const stderr = collector(true)
    const input = new CliInput({
      stderr,
      stdin: inputStream(`${token}\n`, false)
    })

    await expect(input.readToken('-')).resolves.toBe(token)
    expect(stderr.value()).not.toContain(token)
  })

  test('aborts while waiting for piped input', async () => {
    const controller = new AbortController()
    const stream = new PassThrough()
    const stdin = stream as ReadableInput
    stdin.isTTY = false
    const input = new CliInput({ signal: controller.signal, stdin })

    const result = input.readToken('-')
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    stream.destroy()
  })

  test('requires --token-file for an invitation token, even with piped stdin', async () => {
    const stdin = inputStream('private-token-value\n', false)
    const input = new CliInput({ stdin })

    await expect(input.readToken(undefined)).rejects.toMatchObject({
      code: 'ARGUMENT_VALIDATION',
      detail: expect.stringContaining('--token-file'),
      exitCode: 2,
      message: 'The command contains invalid input.'
    })
    expect(stdin.readableFlowing).toBeNull()
  })

  test('prompts for bounded interactive input without writing the answer', async () => {
    const answer = 'SENTINEL-INTERACTIVE-ANSWER'
    const stderr = collector(true)
    const input = new CliInput({
      stderr,
      stdin: inputStream(`${answer}\n`, true),
      stdout: collector(true)
    })

    await expect(input.prompt('Profile field')).resolves.toBe(answer)
    expect(stderr.value()).toBe('Profile field: ')
    expect(stderr.value()).not.toContain(answer)
  })

  test.each([
    ['  replacement value  ', 'replacement value'],
    ['   ', undefined]
  ])('reads optional interactive input %j as %j', async (answer, expected) => {
    const stderr = collector(true)
    const input = new CliInput({
      stderr,
      stdin: inputStream(`${answer}\n`, true),
      stdout: collector(true)
    })

    await expect(input.promptOptional('Optional field')).resolves.toBe(expected)
    expect(stderr.value()).toBe('Optional field: ')
  })

  test('reads hidden interactive input and restores terminal mode', async () => {
    const secret = 'AB1234'
    const rawModes: boolean[] = []
    const stdin = inputStream('AB12X\u007f34\r', true)
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
      rawModes.push(mode)
    }
    const stderr = collector(true)
    const input = new CliInput({ stderr, stdin, stdout: collector(true) })

    await expect(input.promptSecret('OTP code', 128)).resolves.toBe(secret)
    expect(rawModes).toEqual([true, false])
    expect(stderr.value()).toBe('OTP code: ••••••\n')
    expect(stderr.value()).not.toContain(secret)
  })

  test('reads a bracketed-paste secret at its exact size limit', async () => {
    const stdin = Readable.from([
      '\x1b[20',
      '0~123',
      '456\x1b',
      '[201~',
      '\r'
    ]) as ReadableInput
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
    }
    const input = new CliInput({
      stderr: collector(true),
      stdin,
      stdout: collector(true)
    })

    await expect(input.promptSecret('OTP code', 6)).resolves.toBe('123456')
  })

  test('decodes extended terminal key sequences for hidden input', async () => {
    const stdin = inputStream(
      [49, 50, 51, 52, 53, 54, 13]
        .map((codePoint) => `\x1b[${codePoint.toString()}u`)
        .join(''),
      true
    )
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
    }
    const stderr = collector(true)
    const input = new CliInput({ stderr, stdin, stdout: collector(true) })

    await expect(input.promptSecret('OTP code', 6)).resolves.toBe('123456')
    expect(stderr.value()).toBe('OTP code: ••••••\n')
  })

  test('does not trap input after a standalone Escape byte', async () => {
    const stdin = inputStream('\x1b123456\r', true)
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
    }
    const input = new CliInput({
      stderr: collector(true),
      stdin,
      stdout: collector(true)
    })

    await expect(input.promptSecret('OTP code', 32)).resolves.toBe('123456')
  })

  test('preserves an interrupt after a standalone Escape byte', async () => {
    const stdin = inputStream('\x1b\u0003', true)
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
    }
    const input = new CliInput({
      stderr: collector(true),
      stdin,
      stdout: collector(true)
    })

    await expect(input.promptSecret('OTP code', 32)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  test.each([
    ['missing', undefined],
    ['ineffective', () => undefined]
  ] as const)(
    'refuses hidden input when raw mode is %s',
    async (_description, setRawMode) => {
      const secret = 'MUST-NOT-BE-READ'
      const stderr = collector(true)
      const stdin = inputStream(`${secret}\n`, true)
      stdin.isRaw = false
      if (setRawMode !== undefined) {
        stdin.setRawMode = setRawMode
      }
      const input = new CliInput({ stderr, stdin, stdout: collector(true) })

      await expect(input.promptSecret('OTP code', 128)).rejects.toMatchObject({
        code: 'ARGUMENT_VALIDATION',
        detail: expect.stringContaining('does not support hidden input'),
        exitCode: 2
      })
      expect(stderr.value()).not.toContain(secret)
    }
  )

  test('bounds private file and piped inputs without echoing their contents', async () => {
    const sentinel = 'SENTINEL-PRIVATE-CONTENTS'
    const { configDirectory } = await createAuthenticatedConfig()
    const documentPath = join(configDirectory, 'private.json')
    await writeFile(documentPath, sentinel, { mode: 0o600 })

    const readers = [
      async () =>
        await new CliInput({ stdin: inputStream('', false) }).readText(
          documentPath,
          privateDocumentOptions
        ),
      async () =>
        await new CliInput({ stdin: inputStream(sentinel, false) }).readText(
          '-',
          privateDocumentOptions
        )
    ]
    await Promise.all(
      readers.map(async (read) => {
        const result = read()
        await Promise.all([
          expect(result).rejects.toMatchObject({
            code: 'ARGUMENT_VALIDATION',
            detail: 'Private document is too large.'
          }),
          expect(result).rejects.not.toThrow(sentinel)
        ])
      })
    )
  })

  test('preserves exact secret bytes from a file and piped stdin', async () => {
    const secret = '  voice password with trailing newline  \n'
    const { configDirectory } = await createAuthenticatedConfig()
    const secretPath = join(configDirectory, 'voice-password')
    await writeFile(secretPath, secret, { mode: 0o600 })
    const options = {
      fileDescription: 'SIP password file',
      label: 'SIP password',
      maximumBytes: 128,
      option: '--sip-password-file'
    } as const

    await expect(
      new CliInput({ stdin: inputStream('', false) }).readExactSecret(
        secretPath,
        options
      )
    ).resolves.toBe(secret)
    await expect(
      new CliInput({ stdin: inputStream(secret, false) }).readExactSecret(
        '-',
        options
      )
    ).resolves.toBe(secret)
  })

  test('reads an exact hidden secret without including the prompt terminator', async () => {
    const secret = '  voice password  '
    const rawModes: boolean[] = []
    const stdin = inputStream(`${secret}\r`, true)
    stdin.isRaw = false
    stdin.setRawMode = (mode) => {
      stdin.isRaw = mode
      rawModes.push(mode)
    }
    const stderr = collector(true)
    const input = new CliInput({ stderr, stdin, stdout: collector(true) })

    await expect(
      input.readExactSecret(undefined, {
        fileDescription: 'SIP password file',
        label: 'SIP password',
        maximumBytes: 128,
        option: '--sip-password-file'
      })
    ).resolves.toBe(secret)
    expect(rawModes).toEqual([true, false])
    expect(stderr.value()).toBe(`SIP password: ${'•'.repeat(secret.length)}\n`)
    expect(stderr.value()).not.toContain(secret)
  })

  test.each([
    ['a terminal', true],
    ['a pipe', false]
  ])(
    'requires --document-file when standard input is %s, and leaves it unread',
    async (_description, isTTY) => {
      const stdin = inputStream('SENTINEL-PIPED-CONTENTS', isTTY)
      const input = new CliInput({ stdin })

      await expect(
        input.readText(undefined, privateDocumentOptions)
      ).rejects.toMatchObject({
        code: 'ARGUMENT_VALIDATION',
        detail:
          'Pass --document-file with a file, or --document-file - to read it from standard input.',
        exitCode: 2
      })
      expect(stdin.readableFlowing).toBeNull()
    }
  )
})
