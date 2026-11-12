import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MANIFEST_FILE = 'release-manifest.json'
export const CHECKSUMS_FILE = 'checksums.txt'
const SIDECAR_SUFFIX = '.sha256'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const CHECKSUMS_LINE = /^([0-9a-f]{64}) [ *](.+)$/u
const WHITESPACE = /\s+/u

export interface VerifiedFile {
  // What its checksum was checked against.
  against: string
  name: string
  sha256: string
}

interface Expected {
  against: string
  integrity?: string
  sha256?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

// A candidate release's record of its npm packages, as buildspace's
// package-stage writes it: each staging and production tarball's file name,
// SHA-256 and npm integrity.
export const manifestChecksums = (contents: string): Map<string, Expected> => {
  const manifest: unknown = JSON.parse(contents)
  const packages =
    isRecord(manifest) && Array.isArray(manifest.packages)
      ? manifest.packages.filter(isRecord)
      : []
  const checksums = new Map<string, Expected>()
  for (const entry of packages.flatMap((pkg) => [
    pkg.staging,
    pkg.production
  ])) {
    const file = isRecord(entry) ? text(entry.file) : undefined
    if (isRecord(entry) && file !== undefined) {
      const sha256 = text(entry.sha256)
      const integrity = text(entry.integrity)
      checksums.set(file, {
        against: MANIFEST_FILE,
        ...(integrity === undefined ? {} : { integrity }),
        ...(sha256 === undefined ? {} : { sha256 })
      })
    }
  }
  return checksums
}

// A release's checksums.txt, as sha256sum writes it: one "<sha256>  <file>"
// line per file, or "<sha256> *<file>" in binary mode.
export const checksumsList = (contents: string): Map<string, Expected> => {
  const checksums = new Map<string, Expected>()
  for (const [index, line] of contents.split('\n').entries()) {
    if (line.length > 0) {
      const match = CHECKSUMS_LINE.exec(line)
      const sha256 = match?.[1]
      const file = match?.[2]
      if (sha256 === undefined || file === undefined) {
        throw new Error(
          `${CHECKSUMS_FILE} line ${(index + 1).toString()} isn't "<sha256>  <file>".`
        )
      }
      if (checksums.has(file)) {
        throw new Error(`${CHECKSUMS_FILE} lists ${file} twice.`)
      }
      checksums.set(file, { against: CHECKSUMS_FILE, sha256 })
    }
  }
  return checksums
}

// A binary's own <file>.sha256, as shasum and sha256sum write it.
export const sidecarChecksum = (contents: string, name: string): string => {
  const sha256 = contents.trim().split(WHITESPACE, 1)[0] ?? ''
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`${name} doesn't start with a SHA-256.`)
  }
  return sha256
}

const digest = (
  contents: Buffer,
  algorithm: 'sha256' | 'sha512',
  encoding: 'base64' | 'hex'
): string => createHash(algorithm).update(contents).digest(encoding)

// Checks every file in the directory before anything runs it: a binary
// against its .sha256, a release's archive or npm tarball against its
// checksums.txt, a candidate's npm tarball against the release's manifest,
// and a tarball taken from the registry against the integrity npm published
// for it. A file with nothing to check it against fails.
export const verifyFiles = async (
  directory: string,
  options: { npmIntegrity?: string } = {}
): Promise<VerifiedFile[]> => {
  const names = (await readdir(directory)).sort()
  const manifest = names.includes(MANIFEST_FILE)
    ? manifestChecksums(await readFile(join(directory, MANIFEST_FILE), 'utf8'))
    : new Map<string, Expected>()
  const checksums = names.includes(CHECKSUMS_FILE)
    ? checksumsList(await readFile(join(directory, CHECKSUMS_FILE), 'utf8'))
    : new Map<string, Expected>()
  const tested = names.filter(
    (name) =>
      name !== MANIFEST_FILE &&
      name !== CHECKSUMS_FILE &&
      !name.endsWith(SIDECAR_SUFFIX)
  )
  if (tested.length === 0) {
    throw new Error(`${directory} has no files to test.`)
  }
  const expectedFor = async (name: string): Promise<Expected | undefined> => {
    const sidecar = `${name}${SIDECAR_SUFFIX}`
    if (names.includes(sidecar)) {
      return {
        against: sidecar,
        sha256: sidecarChecksum(
          await readFile(join(directory, sidecar), 'utf8'),
          sidecar
        )
      }
    }
    if (checksums.has(name)) {
      return checksums.get(name)
    }
    if (manifest.has(name)) {
      return manifest.get(name)
    }
    if (name.endsWith('.tgz') && options.npmIntegrity !== undefined) {
      return { against: 'the npm registry', integrity: options.npmIntegrity }
    }
  }
  return await Promise.all(
    tested.map(async (name) => {
      const expected = await expectedFor(name)
      if (expected?.sha256 === undefined && expected?.integrity === undefined) {
        throw new Error(`${name} has no checksum to check it against.`)
      }
      const contents = await readFile(join(directory, name))
      const sha256 = digest(contents, 'sha256', 'hex')
      if (expected.sha256 !== undefined && sha256 !== expected.sha256) {
        throw new Error(
          `${name} has SHA-256 ${sha256}, but ${expected.against} says ${expected.sha256}.`
        )
      }
      const integrity = `sha512-${digest(contents, 'sha512', 'base64')}`
      if (
        expected.integrity !== undefined &&
        integrity !== expected.integrity
      ) {
        throw new Error(
          `${name} has integrity ${integrity}, but ${expected.against} says ${expected.integrity}.`
        )
      }
      return { against: expected.against, name, sha256 }
    })
  )
}
