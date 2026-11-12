import { createHash } from 'node:crypto'
import { z } from 'zod'
import { BUILD_CONFIG } from '../build-config.ts'
import { firstReleaseVersion, packageIdentity } from '../config-validation.mjs'
import { CliError } from '../core/errors.ts'

declare const PHOTON_BINARY_ASSET: string | undefined

export const PHOTON_PACKAGE = packageIdentity(BUILD_CONFIG)

export const BINARY_ASSET =
  typeof PHOTON_BINARY_ASSET === 'string' ? PHOTON_BINARY_ASSET : undefined

export interface ReleaseSource {
  env: NodeJS.ProcessEnv
  fetch: typeof globalThis.fetch
  signal?: AbortSignal | undefined
}

type Failure = (detail: string, cause?: unknown) => CliError

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u
const TRAILING_SLASHES = /\/+$/u
const WHITESPACE = /\s+/u
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u
const BINARY_MODE_MARKER = /^\*/u
const LOOKUP_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 300_000
const FIRST_RELEASE = firstReleaseVersion(BUILD_CONFIG)

const packumentSchema = z.object({
  'dist-tags': z.record(z.string(), z.string())
})

const versionParts = (version: string): number[] | undefined =>
  VERSION_PATTERN.exec(version)?.slice(1).map(Number)

const compareParts = (left: number[], right: number[]): number => {
  for (const [index, part] of left.entries()) {
    const difference = part - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export const isNewerRelease = (
  candidate: string,
  current: string,
  firstRelease = FIRST_RELEASE
): boolean => {
  const next = versionParts(candidate)
  const first = versionParts(firstRelease) ?? []
  const installed = versionParts(current) ?? []
  return (
    next !== undefined &&
    compareParts(next, first) >= 0 &&
    compareParts(next, installed) > 0
  )
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const lookupFailed =
  (url: string): Failure =>
  (detail, cause) =>
    new CliError(
      'UPDATE_CHECK_FAILED',
      'Photon could not check for a newer version.',
      { cause, detail: `${url}: ${detail}`, retryable: true }
    )

const request = async (
  source: ReleaseSource,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  failure: Failure
): Promise<Response> => {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (source.signal !== undefined) {
    signals.push(source.signal)
  }
  let response: Response
  try {
    response = await source.fetch(url, {
      ...init,
      signal: AbortSignal.any(signals)
    })
  } catch (error) {
    if (source.signal?.aborted === true) {
      throw error
    }
    throw failure(messageOf(error), error)
  }
  if (!(response.ok || init.redirect === 'manual')) {
    await response.body?.cancel()
    throw failure(`HTTP ${response.status.toString()}`)
  }
  return response
}

const registryUrl = (env: NodeJS.ProcessEnv): string =>
  (
    env.npm_config_registry ||
    env.NPM_CONFIG_REGISTRY ||
    PHOTON_PACKAGE.registry
  ).replace(TRAILING_SLASHES, '')

export const releaseUrl = (env: NodeJS.ProcessEnv, path: string): string =>
  `${(env.PHOTON_INSTALLER_GITHUB_BASE_URL || 'https://github.com').replace(TRAILING_SLASHES, '')}/${BUILD_CONFIG.releaseRepository}/releases/${path}`

export const latestPackageVersion = async (
  source: ReleaseSource
): Promise<string> => {
  const url = `${registryUrl(source.env)}/${PHOTON_PACKAGE.name.replace('/', '%2f')}`
  const failure = lookupFailed(url)
  const response = await request(
    source,
    url,
    { headers: { accept: 'application/vnd.npm.install-v1+json' } },
    LOOKUP_TIMEOUT_MS,
    failure
  )
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (source.signal?.aborted === true) {
      throw error
    }
    throw failure(
      error instanceof SyntaxError
        ? 'the response is not JSON'
        : messageOf(error),
      error
    )
  }
  const version =
    packumentSchema.safeParse(body).data?.['dist-tags'][PHOTON_PACKAGE.tag]
  if (version === undefined || versionParts(version) === undefined) {
    throw failure(`no version is tagged "${PHOTON_PACKAGE.tag}"`)
  }
  return version
}

export const latestBinaryVersion = async (
  source: ReleaseSource
): Promise<string> => {
  const url = releaseUrl(source.env, 'latest')
  const failure = lookupFailed(url)
  const response = await request(
    source,
    url,
    { redirect: 'manual' },
    LOOKUP_TIMEOUT_MS,
    failure
  )
  await response.body?.cancel()
  const tag = response.headers.get('location')?.split('/').at(-1) ?? ''
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (versionParts(version) === undefined) {
    throw failure(
      `HTTP ${response.status.toString()} named no release tag: "${tag}"`
    )
  }
  return version
}

export const downloadBinaryArchive = async (
  source: ReleaseSource,
  version: string,
  asset: string
): Promise<Buffer> => {
  const base = releaseUrl(source.env, `download/v${version}`)
  const download = async (file: string): Promise<Buffer> => {
    const failure: Failure = (detail, cause) =>
      new CliError(
        'UPDATE_FAILED',
        `Photon could not download version ${version}.`,
        { cause, detail: `${base}/${file}: ${detail}`, retryable: true }
      )
    const response = await request(
      source,
      `${base}/${file}`,
      {},
      DOWNLOAD_TIMEOUT_MS,
      failure
    )
    try {
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (source.signal?.aborted === true) {
        throw error
      }
      throw failure(messageOf(error), error)
    }
  }
  const checksums = await download('checksums.txt')
  const archive = await download(asset)
  const expected = checksums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(WHITESPACE))
    .find(([, name]) => name?.replace(BINARY_MODE_MARKER, '') === asset)?.[0]
  const actual = createHash('sha256').update(archive).digest('hex')
  if (
    expected === undefined ||
    !CHECKSUM_PATTERN.test(expected) ||
    expected !== actual
  ) {
    throw new CliError(
      'UPDATE_CHECKSUM_MISMATCH',
      `The download of version ${version} failed its checksum check, so nothing was changed.`,
      {
        detail: `${asset}: checksums.txt lists ${expected ?? 'no checksum'}, the download is ${actual}.`
      }
    )
  }
  return archive
}
