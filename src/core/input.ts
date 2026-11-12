import { open } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import { select as clackSelect, isCancel } from '@clack/prompts'
import { argumentValidationError, CliError } from './errors.ts'
import type { WritableOutput } from './output.ts'
import { inert } from './presenter.ts'
import { promptBlocker } from './terminal.ts'

const DEFAULT_MAXIMUM_TEXT_INPUT_BYTES = 4096
const BRACKETED_PASTE_SEQUENCES = ['\x1b[200~', '\x1b[201~'] as const
const ESCAPE_CHARACTER = '\x1b'
const KITTY_KEY_SEQUENCE_PATTERN = /^\[(\d+)(?:;[0-9:]*)*u$/u
const MAXIMUM_TERMINAL_CONTROL_SEQUENCE_BYTES = 64
const NEWLINE_PATTERN = /[\r\n]/u
const SECRET_INPUT_DELETIONS: readonly string[] = ['\b', '\u007f']
const SECRET_INPUT_TERMINATORS: readonly string[] = ['\r', '\n', '\u0004']
const TERMINAL_CONTROL_INTRODUCERS: readonly string[] = ['[', 'O']
const TERMINAL_SEQUENCE_FINAL_PATTERN = /^[\x40-\x7e]$/u
const XTERM_KEY_SEQUENCE_PATTERN = /^\[27;\d+;(\d+)~$/u

export interface ReadableInput extends NodeJS.ReadableStream {
  isRaw?: boolean
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
}

export type ConfirmationHandler = (message: string) => Promise<boolean>

export interface SelectionOption<Value extends string> {
  hint?: string
  label: string
  value: Value
}

export type SelectionHandler = <Value extends string>(
  message: string,
  options: readonly SelectionOption<Value>[]
) => Promise<Value>

interface CliInputOptions {
  beforeQuestion?: () => void
  confirm?: ConfirmationHandler
  env?: NodeJS.ProcessEnv
  json?: boolean
  noInput?: boolean
  select?: SelectionHandler
  signal?: AbortSignal
  stderr?: WritableOutput
  stdin?: ReadableInput
  stdout?: WritableOutput
}

/** What a command that reads a file or standard input takes it from. */
export interface TextSource {
  fileDescription: string
  label: string
  maximumBytes: number
  /** The option that names the file, or `-` for standard input. */
  option: string
}

/**
 * The error a confirmation raises when Photon can't ask, given why. A command
 * passes its own, which names what it would have done and the flag that
 * confirms it.
 */
export type BlockedConfirmation = (reason: string) => CliError

/** The path that names standard input instead of a file. */
export const STANDARD_INPUT_PATH = '-'

const argumentError = (message: string, cause?: unknown): CliError =>
  argumentValidationError(message, { cause })

const confirmationError = (reason: string): CliError =>
  new CliError(
    'CONFIRMATION_REQUIRED',
    `Photon can't ask for confirmation: ${reason}.`,
    { exitCode: 2 }
  )

const selectionError = (
  question: string,
  reason: string,
  answerOption: string
): CliError =>
  argumentError(
    `Photon can't ask "${question}": ${reason}. Pass the answer with ${answerOption}.`
  )

const questionError = (label: string, reason: string): CliError =>
  argumentError(`Photon can't ask for ${label}: ${reason}.`)

const missingSourceError = (
  source: Pick<TextSource, 'option'>,
  reason?: string
): CliError =>
  argumentError(
    `Pass ${source.option} with a file, or ${source.option} ${STANDARD_INPUT_PATH} to read it from standard input.${
      reason === undefined ? '' : ` Photon can't ask for it: ${reason}.`
    }`
  )

const trimBoundedInput = (
  value: string,
  label: string,
  maximumBytes: number
): string => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw argumentError(`${label} cannot be empty.`)
  }
  if (Buffer.byteLength(trimmed, 'utf8') > maximumBytes) {
    throw argumentError(`${label} is too large.`)
  }
  return trimmed
}

const exactBoundedInput = (
  value: string,
  label: string,
  maximumBytes: number
): string => {
  if (value.length === 0) {
    throw argumentError(`${label} cannot be empty.`)
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw argumentError(`${label} is too large.`)
  }
  return value
}

const decodeExactUtf8 = (value: Uint8Array, label: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch (error) {
    throw argumentError(`${label} must contain valid UTF-8.`, error)
  }
}

const consumeSecretCharacter = (
  characters: string[],
  character: string,
  maximumBytes: number,
  label: string
): boolean => {
  if (SECRET_INPUT_TERMINATORS.includes(character)) {
    return true
  }
  if (character === '\u0003') {
    throw new DOMException('cancelled', 'AbortError')
  }
  if (SECRET_INPUT_DELETIONS.includes(character)) {
    characters.pop()
    return false
  }
  characters.push(character)
  if (Buffer.byteLength(characters.join(''), 'utf8') > maximumBytes) {
    throw argumentError(`${label} is too large.`)
  }
  return false
}

interface SecretChunkResult {
  complete: boolean
  pendingControlSequence: string
}

interface TerminalControlResult {
  character?: string
  pendingControlSequence: string
}

const codePointCharacter = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return
  }
  const codePoint = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(codePoint) || codePoint > 0x10_ff_ff) {
    return
  }
  return String.fromCodePoint(codePoint)
}

const terminalKeyCharacter = (sequence: string): string | undefined =>
  codePointCharacter(KITTY_KEY_SEQUENCE_PATTERN.exec(sequence.slice(1))?.[1]) ??
  codePointCharacter(XTERM_KEY_SEQUENCE_PATTERN.exec(sequence.slice(1))?.[1])

const terminalSequenceComplete = (sequence: string): boolean =>
  sequence.length > 2 &&
  TERMINAL_SEQUENCE_FINAL_PATTERN.test(sequence.at(-1) ?? '')

const consumeTerminalControlCharacter = (
  pendingControlSequence: string,
  character: string,
  label: string
): TerminalControlResult => {
  if (
    pendingControlSequence === ESCAPE_CHARACTER &&
    !TERMINAL_CONTROL_INTRODUCERS.includes(character)
  ) {
    return { character, pendingControlSequence: '' }
  }
  const sequence = `${pendingControlSequence}${character}`
  if (
    Buffer.byteLength(sequence, 'utf8') >
    MAXIMUM_TERMINAL_CONTROL_SEQUENCE_BYTES
  ) {
    throw argumentError(`${label} contains an invalid terminal key.`)
  }
  if (BRACKETED_PASTE_SEQUENCES.some((candidate) => candidate === sequence)) {
    return { pendingControlSequence: '' }
  }
  if (
    BRACKETED_PASTE_SEQUENCES.some((candidate) =>
      candidate.startsWith(sequence)
    ) ||
    !terminalSequenceComplete(sequence)
  ) {
    return { pendingControlSequence: sequence }
  }
  const decodedCharacter = terminalKeyCharacter(sequence)
  return decodedCharacter === undefined
    ? { pendingControlSequence: '' }
    : { character: decodedCharacter, pendingControlSequence: '' }
}

const secretMaskUpdate = (
  previousLength: number,
  currentLength: number
): string => {
  if (currentLength > previousLength) {
    return '•'.repeat(currentLength - previousLength)
  }
  return '\b \b'.repeat(previousLength - currentLength)
}

const consumeSecretChunk = (
  characters: string[],
  chunk: string,
  initialControlSequence: string,
  maximumBytes: number,
  label: string
): SecretChunkResult => {
  let pendingControlSequence = initialControlSequence
  for (const character of chunk) {
    if (pendingControlSequence.length > 0) {
      const {
        character: decodedCharacter,
        pendingControlSequence: nextControlSequence
      } = consumeTerminalControlCharacter(
        pendingControlSequence,
        character,
        label
      )
      pendingControlSequence = nextControlSequence
      if (decodedCharacter === undefined) {
        continue
      }
      if (
        consumeSecretCharacter(
          characters,
          decodedCharacter,
          maximumBytes,
          label
        )
      ) {
        return { complete: true, pendingControlSequence: '' }
      }
      continue
    }
    if (character === ESCAPE_CHARACTER) {
      pendingControlSequence = character
      continue
    }
    if (consumeSecretCharacter(characters, character, maximumBytes, label)) {
      return { complete: true, pendingControlSequence: '' }
    }
  }
  return { complete: false, pendingControlSequence }
}

export class CliInput {
  readonly #beforeQuestion: () => void
  readonly #confirmationHandler: ConfirmationHandler | undefined
  readonly #env: NodeJS.ProcessEnv
  readonly #json: boolean
  readonly #noInput: boolean
  readonly #signal: AbortSignal | undefined
  readonly #selectionHandler: SelectionHandler | undefined
  readonly #stderr: WritableOutput
  readonly #stdin: ReadableInput
  readonly #stdout: WritableOutput

  constructor(options: CliInputOptions = {}) {
    this.#beforeQuestion = options.beforeQuestion ?? (() => undefined)
    this.#confirmationHandler = options.confirm
    this.#env = options.env ?? process.env
    this.#json = options.json ?? false
    this.#noInput = options.noInput ?? false
    this.#selectionHandler = options.select
    this.#signal = options.signal
    this.#stderr = options.stderr ?? process.stderr
    this.#stdin = options.stdin ?? process.stdin
    this.#stdout = options.stdout ?? process.stdout
  }

  /** Why Photon may not ask a question, or `undefined` when it may. */
  get blocker(): string | undefined {
    return promptBlocker(
      { stderr: this.#stderr, stdin: this.#stdin, stdout: this.#stdout },
      { env: this.#env, json: this.#json, noInput: this.#noInput }
    )
  }

  get interactive(): boolean {
    return this.blocker === undefined
  }

  /**
   * Fails as reading would when a value has no file or `-` and Photon can't
   * ask for it, or never asks for it (`asks` false). A command checks this
   * before its confirmation, so a rerun needs only `--yes`, and still reads
   * the value after the confirmation.
   */
  requireSource(
    filePath: string | undefined,
    option: string,
    asks = true
  ): void {
    if (filePath !== undefined) {
      return
    }
    if (!asks) {
      throw missingSourceError({ option })
    }
    const reason = this.blocker
    if (reason !== undefined) {
      throw missingSourceError({ option }, reason)
    }
  }

  async confirm(
    message: string,
    blocked: BlockedConfirmation = confirmationError
  ): Promise<boolean> {
    if (this.#confirmationHandler !== undefined) {
      this.#beforeQuestion()
      return await this.#confirmationHandler(message)
    }
    const reason = this.blocker
    if (reason !== undefined) {
      throw blocked(reason)
    }

    this.#beforeQuestion()
    this.#stderr.write(`${message} [y/N] `)
    const answer = (await this.#readLine()).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  /**
   * Asks the person to pick one of `options`. Where Photon can't ask, the
   * error names `answerOption`, the option that gives the answer instead.
   */
  async select<Value extends string>(
    message: string,
    options: readonly SelectionOption<Value>[],
    answerOption: string
  ): Promise<Value> {
    if (options.length === 0) {
      throw new TypeError('A selection prompt requires at least one option.')
    }
    if (this.#selectionHandler !== undefined) {
      return await this.#selectionHandler(message, options)
    }
    const reason = this.blocker
    if (reason !== undefined) {
      throw selectionError(message, reason, answerOption)
    }
    const clackOptions: {
      hint?: string
      label: string
      value: string
    }[] = []
    for (const option of options) {
      clackOptions.push(
        option.hint === undefined
          ? { label: option.label, value: option.value }
          : {
              hint: option.hint,
              label: option.label,
              value: option.value
            }
      )
    }
    const value = await clackSelect<string>({
      input: this.#stdin as Readable,
      message,
      options: clackOptions,
      output: this.#stderr as Writable,
      ...(this.#signal === undefined ? {} : { signal: this.#signal })
    })
    if (isCancel(value)) {
      throw this.#signal?.reason ?? new DOMException('cancelled', 'AbortError')
    }
    return value as Value
  }

  /**
   * Asks the person to type `expectedValue`, after `question` when given,
   * and answers whether they typed it exactly, as it is or as it was shown.
   */
  async confirmExact(
    expectedValue: string,
    options: { blocked?: BlockedConfirmation; question?: string } = {}
  ): Promise<boolean> {
    const reason = this.blocker
    if (reason !== undefined) {
      throw (options.blocked ?? confirmationError)(reason)
    }

    this.#beforeQuestion()
    if (options.question !== undefined) {
      this.#stderr.write(`${options.question}\n`)
    }
    const shown = inert(expectedValue)
    const label = `Type ${shown} to confirm`
    this.#stderr.write(`${label}: `)
    const answer = await this.#readLine(DEFAULT_MAXIMUM_TEXT_INPUT_BYTES, label)
    return answer === expectedValue || answer === shown
  }

  async prompt(label: string): Promise<string> {
    const reason = this.blocker
    if (reason !== undefined) {
      throw questionError(label, reason)
    }
    this.#stderr.write(`${label}: `)
    return trimBoundedInput(
      await this.#readLine(DEFAULT_MAXIMUM_TEXT_INPUT_BYTES, label),
      label,
      DEFAULT_MAXIMUM_TEXT_INPUT_BYTES
    )
  }

  async promptOptional(
    label: string,
    maximumBytes = DEFAULT_MAXIMUM_TEXT_INPUT_BYTES
  ): Promise<string | undefined> {
    const reason = this.blocker
    if (reason !== undefined) {
      throw questionError(label, reason)
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError(
        'Maximum optional input size must be a positive integer.'
      )
    }

    this.#stderr.write(`${label}: `)
    const value = (await this.#readLine(maximumBytes, label)).trim()
    return value.length === 0 ? undefined : value
  }

  async promptSecret(
    label: string,
    maximumBytes = DEFAULT_MAXIMUM_TEXT_INPUT_BYTES
  ): Promise<string> {
    const reason = this.blocker
    if (reason !== undefined) {
      throw questionError(label, reason)
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError(
        'Maximum secret input size must be a positive integer.'
      )
    }

    const previousRawMode = this.#stdin.isRaw === true
    try {
      this.#stdin.setRawMode?.(true)
    } catch {
      // Some terminal adapters identify as TTYs without supporting raw mode.
    }
    const rawModeEnabled = this.#stdin.isRaw === true
    if (!rawModeEnabled) {
      throw argumentError(
        `${label} cannot be entered securely because this terminal does not support hidden input.`
      )
    }

    try {
      this.#stderr.write(`${label}: `)
      return trimBoundedInput(
        await this.#readSecretLine(maximumBytes, label),
        label,
        maximumBytes
      )
    } finally {
      this.#stdin.setRawMode?.(previousRawMode)
      this.#stderr.write('\n')
    }
  }

  async readToken(tokenFile: string | undefined): Promise<string> {
    return await this.readText(tokenFile, {
      fileDescription: 'invitation token file',
      label: 'Invitation token',
      maximumBytes: DEFAULT_MAXIMUM_TEXT_INPUT_BYTES,
      option: '--token-file'
    })
  }

  /**
   * Reads a secret without trimming or otherwise normalizing its bytes, from
   * the file named, from standard input when the file is `-`, or else from a
   * hidden question. File and piped input therefore preserve spaces and
   * trailing newlines exactly; a terminal's Enter key only ends the question.
   */
  async readExactSecret(
    filePath: string | undefined,
    options: TextSource
  ): Promise<string> {
    if (
      !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 1
    ) {
      throw new TypeError(
        'Maximum exact secret input size must be a positive integer.'
      )
    }
    if (filePath === STANDARD_INPUT_PATH) {
      const value = await this.#readAllBytes(
        options.maximumBytes,
        options.label
      )
      return exactBoundedInput(
        decodeExactUtf8(value, options.label),
        options.label,
        options.maximumBytes
      )
    }
    if (filePath !== undefined) {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(filePath, 'r')
        const stats = await handle.stat()
        if (!stats.isFile()) {
          throw argumentError(
            `The ${options.fileDescription} path must reference a regular file.`
          )
        }
        if (stats.size > options.maximumBytes) {
          throw argumentError(`${options.label} is too large.`)
        }
        const value = await handle.readFile()
        return exactBoundedInput(
          decodeExactUtf8(value, options.label),
          options.label,
          options.maximumBytes
        )
      } catch (error) {
        if (error instanceof CliError) {
          throw error
        }
        throw argumentError(
          `Could not read the ${options.fileDescription}.`,
          error
        )
      } finally {
        await handle?.close()
      }
    }

    const reason = this.blocker
    if (reason !== undefined) {
      throw missingSourceError(options, reason)
    }

    const previousRawMode = this.#stdin.isRaw === true
    try {
      this.#stdin.setRawMode?.(true)
    } catch {
      // Some terminal adapters identify as TTYs without supporting raw mode.
    }
    if (this.#stdin.isRaw !== true) {
      throw argumentError(
        `${options.label} cannot be entered securely because this terminal does not support hidden input. Pass ${options.option} with a file, or ${options.option} ${STANDARD_INPUT_PATH} to read it from standard input.`
      )
    }
    try {
      this.#stderr.write(`${options.label}: `)
      return exactBoundedInput(
        await this.#readSecretLine(options.maximumBytes, options.label),
        options.label,
        options.maximumBytes
      )
    } finally {
      this.#stdin.setRawMode?.(previousRawMode)
      this.#stderr.write('\n')
    }
  }

  /**
   * Reads text from the file named, or from standard input when the file is
   * `-`. Standard input is never read unless it was asked for.
   */
  async readText(
    filePath: string | undefined,
    options: TextSource
  ): Promise<string> {
    if (
      !Number.isSafeInteger(options.maximumBytes) ||
      options.maximumBytes < 1
    ) {
      throw new TypeError('Maximum text input size must be a positive integer.')
    }
    if (filePath === undefined) {
      throw missingSourceError(options)
    }
    if (filePath === STANDARD_INPUT_PATH) {
      return trimBoundedInput(
        await this.#readAll(options.maximumBytes, options.label),
        options.label,
        options.maximumBytes
      )
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(filePath, 'r')
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw argumentError(
          `The ${options.fileDescription} path must reference a regular file.`
        )
      }
      if (stats.size > options.maximumBytes) {
        throw argumentError(`${options.label} is too large.`)
      }
      return trimBoundedInput(
        await handle.readFile({ encoding: 'utf8' }),
        options.label,
        options.maximumBytes
      )
    } catch (error) {
      if (error instanceof CliError) {
        throw error
      }
      throw argumentError(
        `Could not read the ${options.fileDescription}.`,
        error
      )
    } finally {
      await handle?.close()
    }
  }

  async #readAll(maximumBytes: number, label: string): Promise<string> {
    return (await this.#readAllBytes(maximumBytes, label)).toString('utf8')
  }

  async #readAllBytes(maximumBytes: number, label: string): Promise<Buffer> {
    this.#signal?.throwIfAborted()
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalBytes = 0

      const cleanup = (): void => {
        this.#stdin.removeListener('data', onData)
        this.#stdin.removeListener('end', onEnd)
        this.#stdin.removeListener('error', onError)
        this.#signal?.removeEventListener('abort', onAbort)
        this.#stdin.pause?.()
      }
      const fail = (error: unknown): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(this.#signal?.reason)
      const onData = (chunk: string | Buffer): void => {
        try {
          this.#signal?.throwIfAborted()
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.byteLength
          if (totalBytes > maximumBytes) {
            throw argumentError(`${label} is too large.`)
          }
          chunks.push(buffer)
        } catch (error) {
          fail(error)
        }
      }
      const onEnd = (): void => {
        cleanup()
        resolve(Buffer.concat(chunks))
      }
      const onError = (error: Error): void => fail(error)

      this.#stdin.on('data', onData)
      this.#stdin.once('end', onEnd)
      this.#stdin.once('error', onError)
      this.#signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#signal?.throwIfAborted()
      } catch (error) {
        fail(error)
        return
      }
      this.#stdin.resume?.()
    })
  }

  async #readLine(
    maximumBytes = DEFAULT_MAXIMUM_TEXT_INPUT_BYTES,
    label = 'Input'
  ): Promise<string> {
    this.#signal?.throwIfAborted()
    return await new Promise<string>((resolve, reject) => {
      let input = ''

      const cleanup = (): void => {
        this.#stdin.removeListener('data', onData)
        this.#stdin.removeListener('end', onEnd)
        this.#stdin.removeListener('error', onError)
        this.#signal?.removeEventListener('abort', onAbort)
        this.#stdin.pause?.()
      }
      const complete = (): void => {
        cleanup()
        resolve(input)
      }
      const fail = (error: unknown): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(this.#signal?.reason)
      const onData = (chunk: string | Buffer): void => {
        try {
          this.#signal?.throwIfAborted()
          input += chunk.toString()
          if (Buffer.byteLength(input, 'utf8') > maximumBytes) {
            throw argumentError(`${label} is too large.`)
          }
          const newlineIndex = input.search(NEWLINE_PATTERN)
          if (newlineIndex !== -1) {
            input = input.slice(0, newlineIndex)
            complete()
          }
        } catch (error) {
          fail(error)
        }
      }
      const onEnd = (): void => complete()
      const onError = (error: Error): void => fail(error)

      this.#stdin.on('data', onData)
      this.#stdin.once('end', onEnd)
      this.#stdin.once('error', onError)
      this.#signal?.addEventListener('abort', onAbort, { once: true })
      this.#stdin.resume?.()
    })
  }

  async #readSecretLine(maximumBytes: number, label: string): Promise<string> {
    this.#signal?.throwIfAborted()
    return await new Promise<string>((resolve, reject) => {
      const characters: string[] = []
      let pendingControlSequence = ''

      const cleanup = (): void => {
        this.#stdin.removeListener('data', onData)
        this.#stdin.removeListener('end', onEnd)
        this.#stdin.removeListener('error', onError)
        this.#signal?.removeEventListener('abort', onAbort)
        this.#stdin.pause?.()
      }
      const complete = (): void => {
        cleanup()
        resolve(characters.join(''))
      }
      const fail = (error: unknown): void => {
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(this.#signal?.reason)
      const onData = (chunk: string | Buffer): void => {
        try {
          this.#signal?.throwIfAborted()
          const previousLength = characters.length
          const {
            complete: inputComplete,
            pendingControlSequence: nextControlSequence
          } = consumeSecretChunk(
            characters,
            chunk.toString(),
            pendingControlSequence,
            maximumBytes,
            label
          )
          this.#stderr.write(
            secretMaskUpdate(previousLength, characters.length)
          )
          pendingControlSequence = nextControlSequence
          if (inputComplete) {
            complete()
          }
        } catch (error) {
          fail(error)
        }
      }
      const onEnd = (): void => {
        if (pendingControlSequence.length > 0) {
          fail(
            argumentError(
              `${label} contains an incomplete terminal control sequence.`
            )
          )
          return
        }
        complete()
      }
      const onError = (error: Error): void => fail(error)

      this.#stdin.on('data', onData)
      this.#stdin.once('end', onEnd)
      this.#stdin.once('error', onError)
      this.#signal?.addEventListener('abort', onAbort, { once: true })
      this.#stdin.resume?.()
    })
  }
}
