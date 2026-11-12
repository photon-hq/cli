import { argumentValidationError } from '../core/errors.ts'
import type { ReadableInput } from '../core/input.ts'
import { ID_FORMATS } from '../core/photon-id.ts'
import { isTerminal } from '../core/terminal.ts'

const ACCOUNT_SERVICE_KEY_PREFIX = 'pho_ask_'
const TYPE_ID_SUFFIX_LENGTH = 26
const ACCOUNT_SERVICE_KEY_ID_LENGTH =
  ACCOUNT_SERVICE_KEY_PREFIX.length + TYPE_ID_SUFFIX_LENGTH
const MAXIMUM_ACCOUNT_SERVICE_KEY_BYTES = 512
const MAXIMUM_STDIN_BYTES = MAXIMUM_ACCOUNT_SERVICE_KEY_BYTES + 2
const ACCOUNT_SERVICE_KEY_ID_PATTERN = ID_FORMATS.accountServiceKey.pattern
const BASE64URL_TAIL_PATTERN = /^[A-Za-z0-9_-]+$/u

export interface ParsedAccountServiceKey {
  credential: string
  serviceKeyId: string
}

export interface AccountServiceKeyInputOptions {
  signal?: AbortSignal
  stdin?: ReadableInput
}

const invalidCredential = () =>
  argumentValidationError(
    'Account service key input must be one complete canonical pho_ask_ credential.'
  )

export const isAccountServiceKeyId = (value: string): boolean =>
  ACCOUNT_SERVICE_KEY_ID_PATTERN.test(value)

export const parseAccountServiceKey = (
  credential: string
): ParsedAccountServiceKey | undefined => {
  if (
    credential.length === 0 ||
    Buffer.byteLength(credential, 'utf8') > MAXIMUM_ACCOUNT_SERVICE_KEY_BYTES
  ) {
    return
  }
  const serviceKeyId = credential.slice(0, ACCOUNT_SERVICE_KEY_ID_LENGTH)
  if (
    !isAccountServiceKeyId(serviceKeyId) ||
    credential[ACCOUNT_SERVICE_KEY_ID_LENGTH] !== '_'
  ) {
    return
  }
  const tail = credential.slice(ACCOUNT_SERVICE_KEY_ID_LENGTH + 1)
  if (!BASE64URL_TAIL_PATTERN.test(tail)) {
    return
  }
  return { credential, serviceKeyId }
}

const terminalLineEndingRemoved = (value: string): string => {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2)
  }
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ??
  new DOMException('Account service key input was interrupted.', 'AbortError')

export class AccountServiceKeyInput {
  readonly #signal: AbortSignal | undefined
  readonly #stdin: ReadableInput

  constructor(options: AccountServiceKeyInputOptions = {}) {
    this.#signal = options.signal
    this.#stdin = options.stdin ?? process.stdin
  }

  async read(): Promise<ParsedAccountServiceKey> {
    if (isTerminal(this.#stdin)) {
      throw argumentValidationError(
        'Account service keys must be piped through non-interactive stdin.'
      )
    }
    const bytes = await this.#readBounded()
    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw argumentValidationError(
        'Account service key input must be valid UTF-8.',
        { cause: error }
      )
    }
    const parsed = parseAccountServiceKey(terminalLineEndingRemoved(decoded))
    if (parsed === undefined) {
      throw invalidCredential()
    }
    return parsed
  }

  async #readBounded(): Promise<Uint8Array> {
    this.#signal?.throwIfAborted()
    return await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      let totalBytes = 0

      const cleanup = (): void => {
        this.#stdin.removeListener('data', onData)
        this.#stdin.removeListener('end', onEnd)
        this.#stdin.removeListener('error', onError)
        this.#signal?.removeEventListener('abort', onAbort)
        this.#stdin.pause?.()
      }
      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(abortReason(this.#signal))
      const onData = (chunk: Buffer | string): void => {
        try {
          this.#signal?.throwIfAborted()
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.byteLength
          if (totalBytes > MAXIMUM_STDIN_BYTES) {
            throw argumentValidationError(
              'Account service key input is too large.'
            )
          }
          chunks.push(buffer)
        } catch (error) {
          fail(error)
        }
      }
      const onEnd = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(Buffer.concat(chunks, totalBytes))
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
}
