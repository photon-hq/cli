import type { CliBuildConfig } from '../src/config-validation.mjs'

export const BUILD_TARGETS: readonly CliBuildConfig['environment'][]
export function isEntryPoint(moduleUrl: string): boolean
export function resolveTarget(config: Pick<CliBuildConfig, 'environment'>): {
  aliases: Record<string, string>
  conditions: string[]
}
export function hostArchive(
  config: Pick<CliBuildConfig, 'executableName'>
): string
export function readBuildConfig(
  target?: string,
  directory?: string
): Promise<CliBuildConfig>
export function readPackageConfig(
  directory?: string,
  target?: string
): Promise<CliBuildConfig>
