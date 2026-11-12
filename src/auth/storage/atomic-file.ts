import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  rename,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CliError } from '../../core/errors.ts'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const GROUP_OR_WORLD_PERMISSION_MASK = 0o077

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined

export const isMissingFileError = (error: unknown): boolean =>
  errorCode(error) === 'ENOENT'

const storageError = (
  code: string,
  message: string,
  cause?: unknown
): CliError => new CliError(code, message, { cause })

export const ensurePrivateDirectory = async (
  directory: string
): Promise<void> => {
  await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true })

  const stats = await lstat(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw storageError(
      'AUTH_STORAGE_UNSAFE',
      'The Photon configuration path is not a regular directory.'
    )
  }

  if (process.platform !== 'win32') {
    await chmod(directory, PRIVATE_DIRECTORY_MODE)
  }
}

const assertSafeExistingFile = async (
  filePath: string,
  requirePrivateMode: boolean
): Promise<boolean> => {
  let stats: Stats
  try {
    stats = await lstat(filePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw storageError(
      'AUTH_STORAGE_UNAVAILABLE',
      'Photon could not inspect its credential storage.',
      error
    )
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw storageError(
      'AUTH_STORAGE_UNSAFE',
      'Photon refused to use a symlink or non-regular credential file.'
    )
  }

  if (
    requirePrivateMode &&
    process.platform !== 'win32' &&
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission modes are bit masks.
    (stats.mode & GROUP_OR_WORLD_PERMISSION_MASK) !== 0
  ) {
    throw storageError(
      'AUTH_STORAGE_PERMISSIONS',
      'Photon credentials are accessible by other users. Set the file mode to 0600 and retry.'
    )
  }

  return true
}

export const readPrivateFile = async (
  filePath: string,
  options: { requirePrivateMode?: boolean } = {}
): Promise<string | undefined> => {
  const requirePrivateMode = options.requirePrivateMode ?? true
  if (!(await assertSafeExistingFile(filePath, requirePrivateMode))) {
    return
  }

  const readFlags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : // biome-ignore lint/suspicious/noBitwiseOperators: file-open flags are bit masks.
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, readFlags)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw storageError(
        'AUTH_STORAGE_UNSAFE',
        'Photon refused to read a non-regular credential file.'
      )
    }
    return await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    if (isMissingFileError(error)) {
      return
    }
    throw storageError(
      'AUTH_STORAGE_UNAVAILABLE',
      'Photon could not read its credential storage.',
      error
    )
  } finally {
    await handle?.close()
  }
}

const flushDirectory = async (directory: string): Promise<void> => {
  if (process.platform === 'win32') {
    return
  }

  let handle: FileHandle | undefined
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch {
    // Some filesystems do not support syncing directory handles. The file
    // itself is still flushed before the atomic rename.
  } finally {
    await handle?.close()
  }
}

export const atomicWritePrivateFile = async (
  filePath: string,
  contents: string
): Promise<void> => {
  const directory = dirname(filePath)
  await ensurePrivateDirectory(directory)
  await assertSafeExistingFile(filePath, false)

  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`
  )
  let handle: FileHandle | undefined
  try {
    handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE)
    await handle.writeFile(contents, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, filePath)
    if (process.platform !== 'win32') {
      await chmod(filePath, PRIVATE_FILE_MODE)
    }
    await flushDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw storageError(
      'AUTH_PERSISTENCE_FAILED',
      'Photon could not safely persist the authenticated session. Re-login may be required.',
      error
    )
  }
}

export const safeUnlink = async (filePath: string): Promise<boolean> => {
  if (!(await assertSafeExistingFile(filePath, false))) {
    return false
  }

  try {
    await unlink(filePath)
    await flushDirectory(dirname(filePath))
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw storageError(
      'AUTH_STORAGE_UNAVAILABLE',
      'Photon could not remove its local credentials.',
      error
    )
  }
}
