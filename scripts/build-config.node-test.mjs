import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  validateBuildConfig,
  validatePackageConfig
} from '../src/config-validation.mjs'
import {
  readBuildConfig,
  readPackageConfig,
  resolveTarget
} from './build-config.mjs'

const staging = JSON.parse(
  await readFile(new URL('../config/cli.staging.json', import.meta.url), 'utf8')
)
const UNKNOWN_TARGET = /Unknown build target "beta"/
const root = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const production = {
  aliases: ['pho'],
  apiOrigin: 'https://api.example.test',
  apiTokenVariable: 'PHOTON_API_TOKEN',
  appOrigin: 'https://app.example.test',
  environment: 'production',
  executableName: 'photon',
  keychainService: 'photon-cli-v3-production',
  packageRegistry: 'https://registry.npmjs.org',
  releaseChannel: 'latest',
  releaseRepository: 'photon-hq/cli',
  stateNamespace: 'photon-v3-production'
}

test('production and staging keep separate state', () => {
  validateBuildConfig(production, 'production')
  validateBuildConfig(staging, 'staging')
  assert.notEqual(staging.stateNamespace, production.stateNamespace)
  assert.notEqual(staging.keychainService, production.keychainService)
  assert.notEqual(staging.apiTokenVariable, production.apiTokenVariable)
})

test('incomplete production, legacy state and staging/channel mistakes fail closed', () => {
  for (const patch of [
    { apiOrigin: null },
    { apiOrigin: staging.apiOrigin },
    { appOrigin: staging.appOrigin },
    { apiOrigin: 'https://user:secret@api.example.test' },
    { releaseChannel: 'staging' },
    { releaseChannel: 'beta' },
    { releaseChannel: 'next' },
    { stateNamespace: 'photon' },
    { keychainService: 'photon-cli' },
    { apiTokenVariable: 'PHOTON_STAGING_API_TOKEN' },
    { executableName: 'photon-staging' },
    { aliases: [] },
    { packageRegistry: null },
    { packageRegistry: 'https://registry.example.test' }
  ]) {
    assert.throws(() => validateBuildConfig({ ...production, ...patch }))
  }
  assert.throws(() =>
    validateBuildConfig({ ...staging, releaseChannel: 'latest' })
  )
  assert.throws(() =>
    validateBuildConfig({
      ...staging,
      packageRegistry: 'https://registry.npmjs.org'
    })
  )
  assert.throws(() => validateBuildConfig(staging, 'production'))
})

test('the public package publishes stable 3.x versions to latest with both commands', () => {
  const manifest = {
    bin: { pho: './dist/bin.js', photon: './dist/bin.js' },
    name: '@photon-ai/cli',
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org',
      tag: 'latest'
    },
    version: '3.0.0'
  }
  validatePackageConfig(manifest, production)
  for (const version of ['3.0.0-beta.1', '3.0.0-rc.1', '2.3.0', '4.0.0']) {
    assert.throws(() =>
      validatePackageConfig({ ...manifest, version }, production)
    )
  }
  for (const tag of ['beta', 'next', 'legacy']) {
    assert.throws(() =>
      validatePackageConfig(
        { ...manifest, publishConfig: { ...manifest.publishConfig, tag } },
        production
      )
    )
  }
  assert.throws(() =>
    validatePackageConfig(
      { ...manifest, bin: { photon: './dist/bin.js' } },
      production
    )
  )
})

test('the staging package stays on GitHub Packages under its own name', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  )
  validatePackageConfig(manifest, staging)
  assert.throws(() =>
    validatePackageConfig({ ...manifest, name: '@photon-ai/cli' }, staging)
  )
  assert.throws(() =>
    validatePackageConfig(
      {
        ...manifest,
        publishConfig: { ...manifest.publishConfig, tag: 'latest' }
      },
      staging
    )
  )
})

test('production is the default target and staging is opt-in', async () => {
  const target = await readBuildConfig()
  assert.equal(target.environment, 'production')
  assert.equal(target.apiOrigin, 'https://api.photon.codes')
  assert.deepEqual(await readBuildConfig('staging'), staging)
  assert.deepEqual(await readPackageConfig(), staging)
  await assert.rejects(readBuildConfig('beta'), UNKNOWN_TARGET)
})

test('only staging builds resolve internal-only code and the internal SDK', async () => {
  assert.deepEqual(resolveTarget(staging), {
    aliases: {},
    conditions: ['photon-internal']
  })
  const { aliases, conditions } = resolveTarget(production)
  assert.deepEqual(aliases, { '@photon-ai/api': '@photon-ai/api-public' })
  assert.deepEqual(conditions, [])
  const { compilerOptions } = JSON.parse(
    await readFile(new URL('../tsconfig.public.json', import.meta.url), 'utf8')
  )
  assert.deepEqual(compilerOptions.customConditions, conditions)
  for (const [name, replacement] of Object.entries(aliases)) {
    assert.ok(
      compilerOptions.paths[name]?.[0]?.startsWith(
        `./node_modules/${replacement}/`
      )
    )
  }
})

test('the JavaScript build writes the same files from any working folder', async () => {
  const output = await mkdtemp(join(tmpdir(), 'photon-build-'))
  const folders = [root, join(root, 'scripts'), dirname(root)]
  try {
    const builds = await Promise.all(
      folders.map(async (folder, index) => {
        const outputDirectory = join(output, String(index))
        // esbuild takes its working folder from the process, so each folder
        // gets a process of its own.
        await execute(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            [
              `import { readBuildConfig } from ${JSON.stringify(new URL('build-config.mjs', import.meta.url).href)}`,
              `import { buildJavaScript } from ${JSON.stringify(new URL('build-javascript.mjs', import.meta.url).href)}`,
              `await buildJavaScript({ config: await readBuildConfig('staging'), outputDirectory: ${JSON.stringify(outputDirectory)} })`
            ].join('\n')
          ],
          { cwd: folder }
        )
        return await Promise.all(
          ['bin.js', 'cli.js', 'cli.js.map', 'THIRD_PARTY_NOTICES.txt'].map(
            (name) => readFile(join(outputDirectory, name), 'utf8')
          )
        )
      })
    )
    assert.deepEqual(builds[1], builds[0])
    assert.deepEqual(builds[2], builds[0])
  } finally {
    await rm(output, { force: true, recursive: true })
  }
})

test('the docs reference export writes the same file when started through a symlink', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'photon-docs-'))
  const script = join(root, 'scripts', 'export-docs.ts')
  const link = join(folder, 'export-docs.ts')
  const reference = join(folder, 'artifacts', 'docs-reference.json')
  // export-docs.ts reads the revision with git, and runs here outside the
  // repository.
  const env = {
    ...process.env,
    GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
  }
  const exportReference = async (path) => {
    await rm(reference, { force: true })
    execFileSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), path],
      {
        cwd: folder,
        env
      }
    )
    return await readFile(reference, 'utf8')
  }
  try {
    await symlink(script, link)
    const direct = await exportReference(script)
    assert.equal(await exportReference(link), direct)
  } finally {
    await rm(folder, { force: true, recursive: true })
  }
})
