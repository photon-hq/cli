import { spawn } from 'node:child_process'
import { CliError } from '../../core/errors.ts'
import { CLI_NAME } from '../../meta.ts'
import { KEYCHAIN_SERVICE } from '../constants.ts'
import type { CredentialBackendKind } from '../types.ts'
import {
  atomicWritePrivateFile,
  readPrivateFile,
  safeUnlink
} from './atomic-file.ts'

export interface CredentialBackend {
  delete: (signal?: AbortSignal) => Promise<boolean>
  readonly kind: CredentialBackendKind
  readonly locator?: string
  /** The file that holds the credential, for the file backend. */
  readonly path?: string
  probe: (signal?: AbortSignal) => Promise<void>
  read: (signal?: AbortSignal) => Promise<string | undefined>
  write: (value: string, signal?: AbortSignal) => Promise<void>
}

interface CommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

const abortReason = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ??
  new DOMException('The credential-store operation was aborted.', 'AbortError')

const runCommand = async (
  executable: string,
  args: string[],
  options: { input?: string; signal?: AbortSignal } = {}
): Promise<CommandResult> => {
  if (options.signal?.aborted) {
    throw abortReason(options.signal)
  }

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const onAbort = (): void => {
      child.kill()
      fail(abortReason(options.signal))
    }
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.once('error', fail)
    child.once('error', fail)
    child.once('close', (exitCode) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8')
      })
    })

    child.stdin.end(options.input)
  })
}

const storageUnavailable = (message: string, cause?: unknown): CliError =>
  new CliError('AUTH_STORAGE_UNAVAILABLE', message, {
    cause
  })

const commandFailure = (operation: string, result: CommandResult): Error => {
  const detail = result.stderr.trim()
  return new Error(
    `${operation} failed with exit code ${result.exitCode}${detail.length === 0 ? '' : `: ${detail}`}`
  )
}

export class FileCredentialBackend implements CredentialBackend {
  readonly kind = 'file' as const
  readonly locator?: string
  readonly path: string

  constructor(filePath: string, locator?: string) {
    this.path = filePath
    if (locator !== undefined) {
      this.locator = locator
    }
  }

  async probe(): Promise<void> {
    await readPrivateFile(this.path)
  }

  async read(): Promise<string | undefined> {
    return await readPrivateFile(this.path)
  }

  async write(value: string): Promise<void> {
    await atomicWritePrivateFile(this.path, value)
  }

  async delete(): Promise<boolean> {
    return await safeUnlink(this.path)
  }
}

export class KeychainCredentialBackend implements CredentialBackend {
  readonly kind = 'keychain' as const
  readonly locator: string

  constructor(locator: string) {
    this.locator = locator
  }

  async #entry(): Promise<
    InstanceType<typeof import('@napi-rs/keyring')['AsyncEntry']>
  > {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring')
      return new AsyncEntry(KEYCHAIN_SERVICE, this.locator)
    } catch (error) {
      throw storageUnavailable(
        `The operating-system credential manager is unavailable. Repair it, or run ${CLI_NAME} logout --force and then ${CLI_NAME} login.`,
        error
      )
    }
  }

  async probe(signal?: AbortSignal): Promise<void> {
    try {
      const entry = await this.#entry()
      await entry.getPassword(signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        `The operating-system credential manager is unavailable. Repair it, or run ${CLI_NAME} logout --force and then ${CLI_NAME} login.`,
        error
      )
    }
  }

  async read(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const entry = await this.#entry()
      return (await entry.getPassword(signal)) ?? undefined
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        `Photon could not read the operating-system credential manager. Repair it, or run ${CLI_NAME} logout --force before ${CLI_NAME} login --insecure-storage.`,
        error
      )
    }
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    try {
      const entry = await this.#entry()
      await entry.setPassword(value, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        'Photon could not write to the operating-system credential manager.',
        error
      )
    }
  }

  async delete(signal?: AbortSignal): Promise<boolean> {
    try {
      const entry = await this.#entry()
      return Boolean(await entry.deleteCredential(signal))
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        'Photon could not remove the operating-system credential.',
        error
      )
    }
  }
}

export class SecretServiceCredentialBackend implements CredentialBackend {
  readonly kind = 'secret-service' as const
  readonly locator: string

  constructor(locator: string) {
    this.locator = locator
  }

  #args(command: 'clear' | 'lookup'): string[] {
    return [command, 'service', KEYCHAIN_SERVICE, 'account', this.locator]
  }

  async probe(signal?: AbortSignal): Promise<void> {
    try {
      const result = await runCommand('secret-tool', this.#args('lookup'), {
        ...(signal === undefined ? {} : { signal })
      })
      const missingCredential =
        result.exitCode === 1 && result.stderr.trim().length === 0
      if (result.exitCode !== 0 && !missingCredential) {
        throw commandFailure('Secret Service lookup', result)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        `Linux Secret Service is unavailable. Install libsecret tools and unlock a keyring, or run ${CLI_NAME} logout --force and then ${CLI_NAME} login.`,
        error
      )
    }
  }

  async read(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const result = await runCommand('secret-tool', this.#args('lookup'), {
        ...(signal === undefined ? {} : { signal })
      })
      if (result.exitCode === 1 && result.stderr.trim().length === 0) {
        return
      }
      if (result.exitCode !== 0) {
        throw commandFailure('Secret Service lookup', result)
      }
      return result.stdout.trimEnd()
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        `Photon could not read Linux Secret Service. Repair it, or run ${CLI_NAME} logout --force before ${CLI_NAME} login --insecure-storage.`,
        error
      )
    }
  }

  async write(value: string, signal?: AbortSignal): Promise<void> {
    try {
      const result = await runCommand(
        'secret-tool',
        [
          'store',
          '--label=Photon CLI session',
          'service',
          KEYCHAIN_SERVICE,
          'account',
          this.locator
        ],
        {
          input: value,
          ...(signal === undefined ? {} : { signal })
        }
      )
      if (result.exitCode !== 0) {
        throw commandFailure('Secret Service store', result)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        'Photon could not write to Linux Secret Service.',
        error
      )
    }
  }

  async delete(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await runCommand('secret-tool', this.#args('clear'), {
        ...(signal === undefined ? {} : { signal })
      })
      if (result.exitCode === 0) {
        return true
      }
      if (result.exitCode === 1 && result.stderr.trim().length === 0) {
        return false
      }
      throw commandFailure('Secret Service clear', result)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof CliError) {
        throw error
      }
      throw storageUnavailable(
        'Photon could not remove the Linux Secret Service credential.',
        error
      )
    }
  }
}

export const defaultSecureBackendKind = (
  platform: NodeJS.Platform
): CredentialBackendKind => {
  if (platform === 'darwin' || platform === 'win32') {
    return 'keychain'
  }
  if (platform === 'linux') {
    return 'secret-service'
  }
  throw storageUnavailable(
    'This operating system has no supported secure credential manager.'
  )
}
