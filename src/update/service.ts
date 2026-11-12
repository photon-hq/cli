import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CliError } from '../core/errors.ts'
import { CLI_NAME, CLI_VERSION } from '../meta.ts'
import {
  detectInstallation,
  GLOBAL_INSTALL_ARGS,
  type Installation,
  manualUpdateSteps,
  realPath,
  runningFile
} from './installation.ts'
import {
  GLOBAL_COMMAND_DIRECTORY,
  PACKAGE_MANAGERS,
  type PackageManager
} from './package-managers.ts'
import { type ProcessRunner, runProcess } from './process.ts'
import {
  BINARY_ASSET,
  downloadBinaryArchive,
  isNewerRelease,
  latestBinaryVersion,
  latestPackageVersion,
  PHOTON_PACKAGE,
  type ReleaseSource
} from './release.ts'

export interface UpdateResult {
  currentVersion: string
  installer: PackageManager | 'standalone' | null
  latestVersion: string
  status: 'up-to-date' | 'update-available' | 'updated'
}

export interface UpdateDependencies {
  binary?: { asset: string; path: string } | undefined
  currentVersion?: string
  file?: string
  runProcess?: ProcessRunner
}

export interface UpdateServiceOptions
  extends ReleaseSource,
    UpdateDependencies {
  progress: (message: string) => void
  showOutput: boolean
}

const VERSION_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 600_000

const updateFailed = (detail: string, cause?: unknown): CliError =>
  new CliError('UPDATE_FAILED', 'Photon could not finish the update.', {
    cause,
    detail
  })

const lastLine = (text: string): string =>
  text.trim().split('\n').at(-1)?.trim() ?? ''

// Windows refuses to rename a file while another process, often an antivirus
// scanner, has it open. As graceful-fs does for npm, retry on EACCES, EBUSY
// and EPERM for up to a minute, waiting up to 100 ms between tries, as long
// as nothing has taken the destination.
const RENAME_RETRY_MS = 60_000
const HELD_FILE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

export interface RenameOptions {
  renameFile?: typeof rename | undefined
  signal?: AbortSignal | undefined
}

export const renameRetrying = async (
  from: string,
  to: string,
  { renameFile = rename, signal }: RenameOptions = {}
): Promise<void> => {
  const start = Date.now()
  for (let wait = 0; ; wait = Math.min(wait + 10, 100)) {
    signal?.throwIfAborted()
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each try waits for the one before it.
      await renameFile(from, to)
      return
    } catch (error) {
      const held =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        HELD_FILE_CODES.has(error.code)
      if (!held || existsSync(to) || Date.now() - start >= RENAME_RETRY_MS) {
        throw error
      }
      await delay(wait, undefined, { signal }).catch(() =>
        signal?.throwIfAborted()
      )
    }
  }
}

/**
 * Puts a new binary in place of the running one on Windows, which can rename a
 * running executable but not overwrite it. When the new one can't take its
 * place, the previous one goes back, even after an interrupt, since otherwise
 * there would be no binary at all; when that fails too, the error names where
 * the previous one is.
 */
export const swapRunningBinary = async (
  fresh: string,
  target: string,
  { renameFile, signal }: RenameOptions = {}
): Promise<void> => {
  const backup = `${target}.old`
  await rm(backup, { force: true }).catch(() => undefined)
  await renameRetrying(target, backup, { renameFile, signal })
  try {
    await renameRetrying(fresh, target, { renameFile, signal })
  } catch (error) {
    try {
      await renameRetrying(backup, target, { renameFile })
    } catch (restoreError) {
      // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
      throw new CliError(
        'UPDATE_FAILED',
        'Photon could not finish the update.',
        {
          cause: restoreError,
          detail: `Photon could not replace ${target} (${error instanceof Error ? error.message : String(error)}), nor put the previous version back. It is at ${backup}.`,
          next: [
            {
              description: `Rename ${backup} to ${basename(target)} to use the previous version again`
            }
          ]
        }
      )
    }
    throw error
  }
}

const defaultBinary = (): UpdateDependencies['binary'] =>
  BINARY_ASSET === undefined
    ? undefined
    : { asset: BINARY_ASSET, path: process.execPath }

export class UpdateService {
  readonly #binary: UpdateDependencies['binary']
  readonly #currentVersion: string
  readonly #file: string | undefined
  readonly #progress: (message: string) => void
  readonly #run: ProcessRunner
  readonly #showOutput: boolean
  readonly #source: ReleaseSource

  constructor(options: UpdateServiceOptions) {
    this.#binary = 'binary' in options ? options.binary : defaultBinary()
    this.#currentVersion = options.currentVersion ?? CLI_VERSION
    this.#file = options.file
    this.#progress = options.progress
    this.#run = options.runProcess ?? runProcess
    this.#showOutput = options.showOutput
    this.#source = {
      env: options.env,
      fetch: options.fetch,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
  }

  async check(): Promise<UpdateResult> {
    const latestVersion =
      this.#binary === undefined
        ? await latestPackageVersion(this.#source)
        : await latestBinaryVersion(this.#source)
    return {
      currentVersion: this.#currentVersion,
      installer: null,
      latestVersion,
      status: isNewerRelease(latestVersion, this.#currentVersion)
        ? 'update-available'
        : 'up-to-date'
    }
  }

  async update(installer?: PackageManager): Promise<UpdateResult> {
    const result = await this.check()
    if (result.status === 'up-to-date') {
      return result
    }
    const file = this.#file ?? runningFile(this.#binary?.path)
    const installation = await detectInstallation({
      binaryPath: this.#binary?.path,
      file,
      managers: installer === undefined ? PACKAGE_MANAGERS : [installer],
      runProcess: this.#run,
      signal: this.#source.signal
    })
    if (installation.kind === 'global') {
      await this.#updateWithManager(installation, result.latestVersion)
      return { ...result, installer: installation.manager, status: 'updated' }
    }
    if (
      installer !== undefined &&
      (installation.kind === 'binary' || installation.kind === 'unknown')
    ) {
      throw new CliError(
        'INSTALLER_MISMATCH',
        `This ${CLI_NAME} is not a global ${installer} install, so ${CLI_NAME} update changed nothing.`,
        {
          detail: `It runs from ${file}.`,
          exitCode: 2,
          next: [
            {
              description: 'Let it find how it was installed',
              run: `${CLI_NAME} update`
            }
          ]
        }
      )
    }
    if (installation.kind === 'binary' && this.#binary !== undefined) {
      await this.#replaceBinary(
        installation.path,
        this.#binary.asset,
        result.latestVersion
      )
      return { ...result, installer: 'standalone', status: 'updated' }
    }
    throw this.#manualUpdate(installation, result)
  }

  #manualUpdate(installation: Installation, result: UpdateResult): CliError {
    const messages: Record<Installation['kind'], string> = {
      binary: `Photon can't tell how this ${CLI_NAME} was installed, so it changed nothing.`,
      global: `Photon can't tell how this ${CLI_NAME} was installed, so it changed nothing.`,
      npx: `This ${CLI_NAME} runs through npx, so there is no install to update.`,
      project: `This ${CLI_NAME} is a project dependency, so ${CLI_NAME} update leaves it to the project.`,
      unknown: `Photon can't tell how this ${CLI_NAME} was installed, so it changed nothing.`
    }
    return new CliError('MANUAL_UPDATE_REQUIRED', messages[installation.kind], {
      detail: `Photon CLI ${result.latestVersion} is available; this is ${result.currentVersion}.`,
      next: manualUpdateSteps(installation)
    })
  }

  async #version(command: string, args: readonly string[]): Promise<string> {
    const result = await this.#run(command, [...args, '--version'], {
      env: { ...this.#source.env, PHOTON_NO_UPDATE_NOTIFIER: '1' },
      signal: this.#source.signal,
      timeoutMs: VERSION_TIMEOUT_MS
    })
    return result.exitCode === 0 ? lastLine(result.stdout) : ''
  }

  async #updateWithManager(
    { entry, manager }: Extract<Installation, { kind: 'global' }>,
    version: string
  ): Promise<void> {
    const args = [
      ...GLOBAL_INSTALL_ARGS[manager],
      `${PHOTON_PACKAGE.name}@${version}`
    ]
    const command = [manager, ...args].join(' ')
    if (this.#showOutput) {
      this.#progress(`Running ${command}`)
    }
    const result = await this.#run(manager, args, {
      cwd: GLOBAL_COMMAND_DIRECTORY,
      env: this.#source.env,
      showOutput: this.#showOutput,
      signal: this.#source.signal,
      timeoutMs: INSTALL_TIMEOUT_MS
    })
    if (result.timedOut === true) {
      throw updateFailed(
        `${command} did not finish within ${String(INSTALL_TIMEOUT_MS / 60_000)} minutes, so Photon stopped it.`
      )
    }
    if (result.exitCode !== 0) {
      throw updateFailed(
        `${command} failed (exit code ${String(result.exitCode)}). ${lastLine(result.stderr)}`.trim()
      )
    }
    const installed = await this.#version(process.execPath, [entry])
    if (installed !== version) {
      throw updateFailed(
        `${command} finished, but ${entry} reports ${installed || 'no version'} instead of ${version}.`
      )
    }
  }

  async #replaceBinary(
    path: string,
    asset: string,
    version: string
  ): Promise<void> {
    const archive = await downloadBinaryArchive(this.#source, version, asset)
    const target = realPath(path)
    const windows = process.platform === 'win32'
    let staging: string
    try {
      staging = await mkdtemp(join(dirname(target), `.${CLI_NAME}-update-`))
    } catch (error) {
      throw updateFailed(`Photon can't write to ${dirname(target)}.`, error)
    }
    try {
      const archivePath = join(staging, asset)
      const binaryName = `${CLI_NAME}${windows ? '.exe' : ''}`
      const fresh = join(staging, binaryName)
      await writeFile(archivePath, archive)
      const tar = windows
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
      const extracted = await this.#run(
        tar,
        [
          asset.endsWith('.zip') ? '-xf' : '-xzf',
          archivePath,
          '-C',
          staging,
          binaryName
        ],
        { signal: this.#source.signal }
      )
      if (extracted.exitCode !== 0) {
        throw updateFailed(
          `Photon could not unpack ${asset}. ${lastLine(extracted.stderr)}`.trim()
        )
      }
      if (!windows) {
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission modes are bit masks.
        await chmod(fresh, (await stat(target)).mode & 0o777)
      }
      const installed = await this.#version(fresh, [])
      if (installed !== version) {
        throw updateFailed(
          `The downloaded ${binaryName} reports ${installed || 'no version'} instead of ${version}, so nothing was changed.`
        )
      }
      if (!windows) {
        await rename(fresh, target)
        return
      }
      await swapRunningBinary(fresh, target, { signal: this.#source.signal })
    } catch (error) {
      throw error instanceof CliError ||
        (error instanceof Error && error.name === 'AbortError')
        ? error
        : updateFailed(`Photon could not replace ${target}.`, error)
    } finally {
      await rm(staging, { force: true, recursive: true }).catch(() => undefined)
    }
  }
}
