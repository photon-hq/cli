export interface CliBuildConfig {
  aliases: string[]
  apiOrigin: string
  apiTokenVariable: 'PHOTON_API_TOKEN' | 'PHOTON_STAGING_API_TOKEN'
  appOrigin: string
  environment: 'staging' | 'production'
  executableName: string
  keychainService: string
  packageRegistry: string
  releaseChannel: 'staging' | 'latest'
  releaseRepository: string
  stateNamespace: string
}

export interface CliPackageIdentity {
  access: 'public' | 'restricted'
  name: string
  registry: string
  tag: CliBuildConfig['releaseChannel']
}

export function firstReleaseVersion(
  config: Pick<CliBuildConfig, 'environment'>
): string
export function packageIdentity(
  config: Pick<CliBuildConfig, 'environment' | 'packageRegistry'>
): CliPackageIdentity
export function validateBuildConfig(
  config: unknown,
  expectedEnvironment?: string
): CliBuildConfig
export function validatePackageConfig(
  manifest: unknown,
  config: CliBuildConfig
): void
