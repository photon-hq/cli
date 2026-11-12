// The release rules the public repository can run: it has the production
// configuration only, and its package.json is the production package.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const VALIDATED_PRODUCTION = /Validated package\.json for production/
const UNKNOWN_TARGET = /Unknown build target "beta"/
const PACKAGE_NAME = /@photon-hq\/cli-staging/
const STABLE_VERSION = /Public releases are stable 3\.x versions/

const publicPackage = {
  bin: { pho: './dist/bin.js', photon: './dist/bin.js' },
  name: '@photon-ai/cli',
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org',
    tag: 'latest'
  },
  version: '3.0.0'
}

// What `node scripts/build-config.mjs` reads, in a folder with no staging
// configuration, as in the public repository.
const publicTree = async (manifest) => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-public-package-'))
  await Promise.all(
    [
      'config/cli.production.json',
      'scripts/build-config.mjs',
      'scripts/install.ps1',
      'scripts/install.sh',
      'src/config-validation.mjs'
    ].map(async (path) => {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await copyFile(join(root, path), join(directory, path))
    })
  )
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
  return directory
}

const checkPackage = async (manifest, ...args) => {
  const directory = await publicTree(manifest)
  try {
    const { stdout } = await execute(
      process.execPath,
      [join(directory, 'scripts', 'build-config.mjs'), ...args],
      { cwd: directory }
    )
    return stdout
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

test('the production package check passes the public package without the staging configuration', async () => {
  assert.match(
    await checkPackage(publicPackage, 'production'),
    VALIDATED_PRODUCTION
  )
})

test('the production package check refuses a package the public release cannot publish', async () => {
  await assert.rejects(
    checkPackage(
      { ...publicPackage, name: '@photon-hq/cli-staging' },
      'production'
    ),
    PACKAGE_NAME
  )
  await assert.rejects(
    checkPackage({ ...publicPackage, version: '0.3.0' }, 'production'),
    STABLE_VERSION
  )
  await assert.rejects(checkPackage(publicPackage, 'beta'), UNKNOWN_TARGET)
})
