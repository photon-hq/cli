// biome-ignore-all lint/performance/noAwaitInLoops: Fixture login and persistence are intentionally sequenced.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import envPaths from 'env-paths'
import { afterEach, expect, test, vi } from 'vitest'
import { KEYCHAIN_SERVICE } from '../src/auth/constants.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

test('default state uses the selected v3 namespace and ignores legacy config overrides', () => {
  vi.stubEnv('PHOTON_CONFIG_DIR', '/legacy-config-must-not-be-used')
  vi.stubEnv('DASHBOARD_CONFIG_DIR', '/legacy-dashboard-must-not-be-used')
  const repository = new AuthRepository()
  expect(repository.paths.configDirectory).toBe(
    envPaths(BUILD_CONFIG.stateNamespace, { suffix: '' }).config
  )
  expect(repository.paths.configDirectory).not.toBe(
    envPaths('photon', { suffix: '' }).config
  )
  expect(KEYCHAIN_SERVICE).toBe(`photon-cli-v3-${BUILD_CONFIG.environment}`)
})

test('logout in one environment preserves another session and both legacy formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'photon-environments-'))
  directories.push(root)
  const legacy = join(root, 'photon')
  await mkdir(join(legacy, 'credentials'), { recursive: true })
  const v2 = join(legacy, 'credentials/production.json')
  const oldPrivate = join(legacy, 'auth.json')
  await writeFile(v2, 'old-dashboard-token')
  await writeFile(oldPrivate, 'old-private-session')
  const repositories = ['staging', 'production'].map(
    (environment) =>
      new AuthRepository({
        apiOrigin: `https://api.${environment}.example.test`,
        configDirectory: join(root, `photon-v3-${environment}`),
        platform: 'linux'
      })
  )
  for (const [index, repository] of repositories.entries()) {
    const backend = await repository.prepareLoginBackend(true, undefined)
    const metadata = repository.createMetadata(backend, {
      email: 'user@example.test',
      id: 'same-user',
      name: 'User'
    })
    const credentials = repository.createCredential(
      `access-${index}`,
      `refresh-${index}`,
      new Date(Date.now() + 300_000)
    )
    await repository.withLock(() =>
      repository.persistSessionLocked(credentials, metadata, backend.backend)
    )
  }
  const [staging, production] = repositories
  if (!(staging && production)) {
    throw new Error('Missing fixture')
  }
  const productionBefore = await readFile(production.paths.credentials, 'utf8')
  await staging.withLock(() => staging.removeSessionLocked(true))
  expect(await staging.loadMetadata()).toBeUndefined()
  expect(await readFile(production.paths.credentials, 'utf8')).toBe(
    productionBefore
  )
  expect(await production.loadMetadata()).toBeDefined()
  expect(await readFile(v2, 'utf8')).toBe('old-dashboard-token')
  expect(await readFile(oldPrivate, 'utf8')).toBe('old-private-session')
})
