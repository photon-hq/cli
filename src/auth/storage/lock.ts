import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from '../../core/errors.ts'
import {
  LOCK_ACQUISITION_TIMEOUT_MS,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS
} from '../constants.ts'
import { ensurePrivateDirectory, isMissingFileError } from './atomic-file.ts'

const LOCK_RETRY_MS = 100

interface LockOwner {
  id: string
  pid: number
}

const wait = async (
  durationMs: number,
  signal?: AbortSignal
): Promise<void> => {
  if (signal?.aborted) {
    throw signal.reason
  }

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
      'AUTH_STORAGE_UNSAFE',
      'Photon refused to use an unsafe authentication lock path.'
    )
  }

  const ownerPath = join(lockDirectory, 'owner.json')
  const observedOwnerId = await readOwnerId(ownerPath)
  if (observedOwnerId === undefined) {
    return false
  }
  if (Date.now() - lockStats.mtimeMs < LOCK_STALE_MS) {
    return false
  }
  if ((await readOwnerId(ownerPath)) !== observedOwnerId) {
    return false
  }

  await rm(lockDirectory, { recursive: true })
  return true
}

const lockUnavailable = (cause: unknown): CliError =>
  new CliError(
    'AUTH_STORAGE_UNAVAILABLE',
    'Photon could not acquire its authentication lock.',
    { cause }
  )

const acquireLock = async (
  configDirectory: string,
  signal?: AbortSignal
): Promise<{
  lockDirectory: string
  owner: LockOwner
  ownerPath: string
}> => {
  await ensurePrivateDirectory(configDirectory)
  const lockDirectory = join(configDirectory, 'auth.lock')
  const startedAt = Date.now()

  while (Date.now() - startedAt < LOCK_ACQUISITION_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw signal.reason
    }

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
        throw lockUnavailable(error)
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
      try {
        await rm(lockDirectory, { recursive: true })
      } catch {
        // Stale-lock recovery handles a directory that cannot be cleaned here.
      }
      throw lockUnavailable(error)
    }
  }

  throw new CliError(
    'AUTH_LOCK_TIMEOUT',
    'Another Photon process is updating credentials. Wait a moment and retry.'
  )
}

export const withAuthLock = async <Result>(
  configDirectory: string,
  action: () => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> => {
  const { lockDirectory, owner, ownerPath } = await acquireLock(
    configDirectory,
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
      await rm(lockDirectory, { recursive: true })
    }
  }
}
