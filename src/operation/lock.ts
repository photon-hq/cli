import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LOCK_ACQUISITION_TIMEOUT_MS,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS
} from '../auth/constants.ts'
import {
  ensurePrivateDirectory,
  isMissingFileError
} from '../auth/storage/atomic-file.ts'
import { CliError } from '../core/errors.ts'
import { CLI_NAME } from '../meta.ts'

const LOCK_RETRY_MS = 100
const SAFE_LOCK_KEY_PATTERN = /^[a-f0-9-]{1,128}$/u

interface LockOwner {
  id: string
  pid: number
}

const wait = async (
  durationMs: number,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(complete, durationMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const readOwnerId = async (ownerPath: string): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof parsed.id === 'string'
    ) {
      return parsed.id
    }
  } catch {
    // A missing or partially written owner file cannot establish ownership.
  }
}

const ownsLock = async (ownerPath: string, ownerId: string): Promise<boolean> =>
  (await readOwnerId(ownerPath)) === ownerId

type StaleLockState = 'active' | 'missing' | 'recoverable'

const revalidateStaleLock = async (
  lockDirectory: string,
  ownerPath: string,
  observedOwnerId: string | undefined
): Promise<StaleLockState> => {
  let refreshedStats: Stats
  try {
    refreshedStats = await lstat(lockDirectory)
  } catch (error) {
    if (isMissingFileError(error)) {
      return 'missing'
    }
    throw error
  }
  if (refreshedStats.isSymbolicLink() || !refreshedStats.isDirectory()) {
    throw new CliError(
      'OPERATION_STORAGE_UNSAFE',
      'Photon refused to recover an unsafe operation lock path.'
    )
  }
  if (Date.now() - refreshedStats.mtimeMs < LOCK_STALE_MS) {
    return 'active'
  }
  return (await readOwnerId(ownerPath)) === observedOwnerId
    ? 'recoverable'
    : 'active'
}

const recoverStaleLock = async (lockDirectory: string): Promise<boolean> => {
  let lockStats: Stats
  try {
    lockStats = await lstat(lockDirectory)
  } catch (error) {
    if (isMissingFileError(error)) {
      return true
    }
    throw error
  }
  if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
    throw new CliError(
      'OPERATION_STORAGE_UNSAFE',
      'Photon refused to use an unsafe operation lock path.'
    )
  }

  const ownerPath = join(lockDirectory, 'owner.json')
  const observedOwnerId = await readOwnerId(ownerPath)
  if (Date.now() - lockStats.mtimeMs < LOCK_STALE_MS) {
    return false
  }
  const refreshedState = await revalidateStaleLock(
    lockDirectory,
    ownerPath,
    observedOwnerId
  )
  if (refreshedState === 'active') {
    return false
  }
  if (refreshedState === 'missing') {
    return true
  }
  await rm(lockDirectory, { force: true, recursive: true })
  return true
}

const lockFailure = (cause: unknown): CliError =>
  new CliError(
    'OPERATION_STORAGE_UNAVAILABLE',
    'Photon could not acquire the local operation lock.',
    { cause }
  )

const acquireLock = async (
  lockRoot: string,
  lockKey: string,
  operationId: string,
  signal?: AbortSignal
): Promise<{
  lockDirectory: string
  owner: LockOwner
  ownerPath: string
}> => {
  if (!SAFE_LOCK_KEY_PATTERN.test(lockKey)) {
    throw new CliError(
      'OPERATION_STORAGE_UNSAFE',
      'Photon refused to use an invalid operation lock identifier.'
    )
  }
  await ensurePrivateDirectory(lockRoot)
  const lockDirectory = join(lockRoot, `${lockKey}.lock`)
  const startedAt = Date.now()

  while (Date.now() - startedAt < LOCK_ACQUISITION_TIMEOUT_MS) {
    signal?.throwIfAborted()
    try {
      // biome-ignore lint/performance/noAwaitInLoops: lock acquisition is intentionally serialized.
      await mkdir(lockDirectory, { mode: 0o700 })
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw lockFailure(error)
      }
      if (await recoverStaleLock(lockDirectory)) {
        continue
      }
      await wait(LOCK_RETRY_MS, signal)
      continue
    }

    const owner: LockOwner = { id: randomUUID(), pid: process.pid }
    const ownerPath = join(lockDirectory, 'owner.json')
    try {
      await writeFile(ownerPath, JSON.stringify(owner), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      return { lockDirectory, owner, ownerPath }
    } catch (error) {
      await rm(lockDirectory, { recursive: true }).catch(() => undefined)
      throw lockFailure(error)
    }
  }

  throw new CliError(
    'OPERATION_LOCK_TIMEOUT',
    'Another Photon process is running this operation.',
    {
      next: [
        {
          description:
            'Wait for the other process to finish, then check whether the operation is still unresolved',
          run: `${CLI_NAME} operation view ${operationId}`
        }
      ],
      operationId,
      retryable: true
    }
  )
}

export const withOperationLock = async <Result>(
  lockRoot: string,
  lockKey: string,
  operationId: string,
  action: () => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  const { lockDirectory, owner, ownerPath } = await acquireLock(
    lockRoot,
    lockKey,
    operationId,
    signal
  )
  const heartbeat = setInterval(() => {
    ownsLock(ownerPath, owner.id)
      .then(async (owned) => {
        if (owned) {
          const now = new Date()
          await utimes(lockDirectory, now, now)
        }
      })
      .catch(() => undefined)
  }, LOCK_HEARTBEAT_MS)
  heartbeat.unref()

  try {
    return await action()
  } finally {
    clearInterval(heartbeat)
    if (await ownsLock(ownerPath, owner.id)) {
      await rm(lockDirectory, { force: true, recursive: true })
    }
  }
}
