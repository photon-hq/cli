import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { transportCode } from './api-problem.ts'
import { CliError } from './errors.ts'
import { NetworkError, withNetworkErrors } from './network.ts'

export type AvatarContentType = 'image/jpeg' | 'image/png' | 'image/webp'

export const MAXIMUM_AVATAR_BYTES = 5 * 1024 * 1024
const MAXIMUM_AVATAR_READ_BYTES = MAXIMUM_AVATAR_BYTES + 1

export interface AvatarFile {
  blob: Blob
  contentType: AvatarContentType
  digest: string
  fileName: string
}

export interface PreparedAvatarFile extends AvatarFile {
  encodedContents: string
}

export interface AvatarUploadTarget {
  formFields: Record<string, string>
  uploadUrl: string
}

interface AvatarUploadOptions {
  fetch?: typeof globalThis.fetch
  protocolErrorCode: string
  signal?: AbortSignal
  timeoutMs: number
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const RIFF_SIGNATURE = Buffer.from('RIFF')
const WEBP_SIGNATURE = Buffer.from('WEBP')
const SIGNATURE_BYTES = 12

const avatarFileError = (message: string, cause?: unknown): CliError =>
  new CliError('AVATAR_FILE_INVALID', message, {
    cause,
    exitCode: 2
  })

const readAvatarContents = async (
  handle: Awaited<ReturnType<typeof open>>
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(MAXIMUM_AVATAR_READ_BYTES)
  let offset = 0
  while (offset < buffer.length) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded reads must preserve file order.
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    )
    if (bytesRead === 0) {
      break
    }
    offset += bytesRead
  }
  if (offset > MAXIMUM_AVATAR_BYTES) {
    throw avatarFileError('Avatar file cannot exceed 5 MiB.')
  }
  return buffer.subarray(0, offset)
}

const startsWith = (buffer: Buffer, signature: Buffer): boolean =>
  buffer.subarray(0, signature.byteLength).equals(signature)

const detectContentType = (signature: Buffer): AvatarContentType => {
  if (startsWith(signature, PNG_SIGNATURE)) {
    return 'image/png'
  }
  if (startsWith(signature, JPEG_SIGNATURE)) {
    return 'image/jpeg'
  }
  if (
    startsWith(signature, RIFF_SIGNATURE) &&
    signature.subarray(8, 12).equals(WEBP_SIGNATURE)
  ) {
    return 'image/webp'
  }
  throw avatarFileError('Avatar must be a JPEG, PNG, or WebP image.')
}

export const prepareAvatarFile = async (
  filePath: string
): Promise<PreparedAvatarFile> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw avatarFileError('Avatar path must reference a regular file.')
    }
    if (stats.size > MAXIMUM_AVATAR_BYTES) {
      throw avatarFileError('Avatar file cannot exceed 5 MiB.')
    }
    const contents = await readAvatarContents(handle)
    const contentType = detectContentType(contents.subarray(0, SIGNATURE_BYTES))
    const digest = createHash('sha256').update(contents).digest('hex')
    return {
      blob: new Blob([contents], { type: contentType }),
      contentType,
      digest,
      encodedContents: contents.toString('base64'),
      fileName: basename(filePath)
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw avatarFileError('Could not read the avatar file.', error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

const validatedUploadUrl = (value: string, errorCode: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // biome-ignore lint/style/useErrorCause: avatar upload URLs can contain credentials and are intentionally omitted.
    throw new CliError(
      errorCode,
      'Photon returned an invalid avatar upload URL. Please retry.',
      { debugSafe: false }
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new CliError(
      errorCode,
      'Photon returned an insecure avatar upload URL. Please retry.',
      { debugSafe: false }
    )
  }
  return url
}

export const uploadAvatarFile = async (
  target: AvatarUploadTarget,
  file: AvatarFile,
  options: AvatarUploadOptions
): Promise<void> => {
  const uploadUrl = validatedUploadUrl(
    target.uploadUrl,
    options.protocolErrorCode
  )
  const form = new FormData()
  for (const [name, value] of Object.entries(target.formFields)) {
    form.append(name, value)
  }
  form.append('file', file.blob, file.fileName)

  try {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal])
    const response = await withNetworkErrors(
      options.fetch ?? globalThis.fetch,
      { timeoutMs: options.timeoutMs }
    )(uploadUrl, {
      body: form,
      method: 'POST',
      signal
    })
    if (!response.ok) {
      throw new CliError(
        'AVATAR_UPLOAD_FAILED',
        'The avatar file could not be uploaded.',
        {
          debugSafe: false,
          detail: `The storage provider returned HTTP ${response.status.toString()}.`,
          httpStatus: response.status,
          retryable: response.status >= 500 || response.status === 429
        }
      )
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof CliError) {
      throw error
    }
    // biome-ignore lint/style/useErrorCause: storage errors can expose presigned URLs and form values.
    throw new CliError(
      'AVATAR_UPLOAD_FAILED',
      'The avatar file could not be uploaded.',
      {
        debugSafe: false,
        detail:
          error instanceof NetworkError
            ? error.message
            : 'No final response was received from the storage provider.',
        retryable: true,
        transportCode: transportCode(error)
      }
    )
  }
}
