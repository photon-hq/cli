import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { resolveTarget } from '../scripts/build-config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Bundles `src/cli.ts` for one target with esbuild, with its metafile, into
 * `outfile` or, without one, into memory.
 */
export const bundle = async (
  environment: 'production' | 'staging',
  outfile = ''
) => {
  const { aliases, conditions } = resolveTarget({ environment })
  return await build({
    alias: aliases,
    bundle: true,
    conditions,
    entryPoints: [join(root, 'src', 'cli.ts')],
    external: ['@napi-rs/keyring'],
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'node',
    target: 'node22',
    ...(outfile === '' ? { outfile: 'bin.js', write: false } : { outfile })
  })
}
