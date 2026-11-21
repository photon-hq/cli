// Remove this default when the generated SDK carries its own build pin (ENG-4926).
export const DEFAULT_PHOTON_API_VERSION = '2026-07-01'

export const photonApiVersionOverride = (
  env: NodeJS.ProcessEnv
): string | undefined => {
  const value = env.PHOTON_API_VERSION?.trim()
  return value === undefined || value === '' ? undefined : value
}
