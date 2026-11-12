// biome-ignore-all lint/suspicious/noMisplacedAssertion: These assertions validate runtime configuration and package inputs.
import assert from 'node:assert/strict'

const releaseVersion = /^3\.\d+\.\d+$/
const stagingHost = /(^|[.-])staging([.-]|$)/i
const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

const origin = (value, field) => {
  assert.equal(typeof value, 'string', `${field} is required`)
  const url = new URL(value)
  assert.ok(
    url.protocol === 'https:' && url.origin === value,
    `${field} must be a canonical HTTPS origin without credentials or a path`
  )
  return url
}

export const validateBuildConfig = (config, expectedEnvironment) => {
  assert.ok(config && typeof config === 'object', 'CLI config is required')
  assert.ok(
    ['staging', 'production'].includes(config.environment),
    'Invalid environment'
  )
  if (expectedEnvironment !== undefined) {
    assert.equal(
      config.environment,
      expectedEnvironment,
      'Unexpected CLI environment'
    )
  }
  const fields = [
    'environment',
    'releaseChannel',
    'apiOrigin',
    'appOrigin',
    'executableName',
    'aliases',
    'stateNamespace',
    'keychainService',
    'apiTokenVariable',
    'releaseRepository',
    'packageRegistry'
  ]
  assert.ok(
    Object.keys(config).every((key) => fields.includes(key)),
    'Unknown CLI config field; configuration must not contain credentials'
  )
  const api = origin(config.apiOrigin, 'apiOrigin')
  const app = origin(config.appOrigin, 'appOrigin')
  origin(config.packageRegistry, 'packageRegistry')
  const production = config.environment === 'production'
  assert.ok(
    config.releaseChannel === (production ? 'latest' : 'staging'),
    'Release channel does not match environment'
  )
  assert.equal(config.executableName, production ? 'photon' : 'photon-staging')
  assert.deepEqual(config.aliases, production ? ['pho'] : [])
  assert.equal(config.stateNamespace, `photon-v3-${config.environment}`)
  assert.equal(config.keychainService, `photon-cli-v3-${config.environment}`)
  assert.equal(
    config.apiTokenVariable,
    production ? 'PHOTON_API_TOKEN' : 'PHOTON_STAGING_API_TOKEN'
  )
  assert.match(config.releaseRepository, repositoryPattern)
  if (production) {
    assert.equal(config.releaseRepository, 'photon-hq/cli')
    assert.equal(config.packageRegistry, 'https://registry.npmjs.org')
    assert.ok(
      !(stagingHost.test(api.hostname) || stagingHost.test(app.hostname)),
      'Production cannot default to staging'
    )
  } else {
    assert.notEqual(
      config.packageRegistry,
      'https://registry.npmjs.org',
      'Staging cannot publish to public npm'
    )
  }
  return config
}

export const firstReleaseVersion = (config) =>
  config.environment === 'production' ? '3.0.0' : '0.0.0'

export const packageIdentity = (config) =>
  config.environment === 'production'
    ? {
        access: 'public',
        name: '@photon-ai/cli',
        registry: config.packageRegistry,
        tag: 'latest'
      }
    : {
        access: 'restricted',
        name: '@photon-hq/cli-staging',
        registry: config.packageRegistry,
        tag: 'staging'
      }

export const validatePackageConfig = (manifest, config) => {
  const identity = packageIdentity(config)
  assert.deepEqual(
    manifest.bin,
    Object.fromEntries(
      [config.executableName, ...config.aliases].map((name) => [
        name,
        './dist/bin.js'
      ])
    ),
    'Package executables must match CLI configuration'
  )
  assert.equal(manifest.name, identity.name)
  assert.equal(manifest.publishConfig?.registry, identity.registry)
  assert.equal(manifest.publishConfig?.access, identity.access)
  assert.equal(manifest.publishConfig?.tag, identity.tag)
  if (config.environment === 'production') {
    assert.match(
      manifest.version,
      releaseVersion,
      'Public releases are stable 3.x versions'
    )
  }
}
