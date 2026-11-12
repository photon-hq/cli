import type { Stats } from 'node:fs'
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  MAXIMUM_AVATAR_BYTES,
  prepareAvatarFile,
  uploadAvatarFile
} from '../src/core/avatar.ts'

const directories: string[] = []

interface StatCapableFileHandle {
  stat: () => Promise<Stats>
}

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-avatar-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

describe('avatar file validation', () => {
  test.each([
    {
      contentType: 'image/jpeg',
      name: 'avatar.data',
      signature: [255, 216, 255, 224]
    },
    {
      contentType: 'image/png',
      name: 'avatar.bin',
      signature: [137, 80, 78, 71, 13, 10, 26, 10]
    },
    {
      contentType: 'image/webp',
      name: 'avatar.unknown',
      signature: [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]
    }
  ] as const)(
    'detects $contentType from its signature',
    async ({ contentType, name, signature }) => {
      const directory = await temporaryDirectory()
      const filePath = join(directory, name)
      await writeFile(filePath, Buffer.from(signature), { mode: 0o600 })

      await expect(prepareAvatarFile(filePath)).resolves.toMatchObject({
        contentType,
        fileName: name
      })
    }
  )

  test('rejects unsupported signatures', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'avatar.png')
    await writeFile(filePath, 'not an image', { mode: 0o600 })

    await expect(prepareAvatarFile(filePath)).rejects.toMatchObject({
      code: 'AVATAR_FILE_INVALID',
      exitCode: 2
    })
  })

  test('rejects paths that are not regular files', async () => {
    const directory = await temporaryDirectory()

    await expect(prepareAvatarFile(directory)).rejects.toMatchObject({
      code: 'AVATAR_FILE_INVALID',
      message: 'Avatar path must reference a regular file.'
    })
  })

  test('rejects a file that grows beyond the limit after stat', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'growing.webp')
    await writeFile(
      filePath,
      Buffer.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
      { mode: 0o600 }
    )
    const probe = await open(filePath, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(
      probe
    ) as StatCapableFileHandle
    const originalStat = fileHandlePrototype.stat
    await probe.close()
    const statSpy = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (
        this: StatCapableFileHandle
      ): Promise<Stats> {
        const stats = await originalStat.call(this)
        await appendFile(filePath, Buffer.alloc(MAXIMUM_AVATAR_BYTES))
        return stats
      })

    try {
      await expect(prepareAvatarFile(filePath)).rejects.toMatchObject({
        code: 'AVATAR_FILE_INVALID',
        message: 'Avatar file cannot exceed 5 MiB.'
      })
    } finally {
      statSpy.mockRestore()
    }
  })
})

describe('avatar upload', () => {
  test('names the host and the time limit when the upload times out', async () => {
    const neverAnswers = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason)
          })
        })
    )

    await expect(
      uploadAvatarFile(
        {
          formFields: { key: 'avatar' },
          uploadUrl: 'https://uploads.example.test/avatars'
        },
        {
          blob: new Blob(['avatar']),
          contentType: 'image/png',
          digest: 'digest',
          fileName: 'avatar.png'
        },
        {
          fetch: neverAnswers,
          protocolErrorCode: 'ACCOUNT_PROTOCOL_ERROR',
          timeoutMs: 1000
        }
      )
    ).rejects.toMatchObject({
      code: 'AVATAR_UPLOAD_FAILED',
      detail: "uploads.example.test didn't answer within 1 second.",
      transportCode: 'TimeoutError'
    })
  })
})
