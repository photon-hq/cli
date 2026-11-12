import { mkdir, rm } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateBuildConfig } from '../src/config-validation.mjs'
import {
  buildConfigPlugin,
  bunAliasPlugin,
  hostArchive,
  isEntryPoint,
  readBuildConfig,
  resolveTarget
} from './build-config.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function run(command) {
  const child = Bun.spawn({
    cmd: command,
    stderr: 'inherit',
    stdout: 'inherit'
  })
  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(' ')}`)
  }
}

/**
 * Compiles the standalone binary to outfile with the given build config
 * embedded, for this machine or for target, a release target from
 * build-binaries.mjs. Runs on Bun.
 */
export const buildLocalBinary = async ({ config, outfile, target }) => {
  const { aliases, conditions } = resolveTarget(validateBuildConfig(config))

  await mkdir(dirname(outfile), { recursive: true })
  await rm(outfile, { force: true })

  const result = await Bun.build({
    bytecode: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      outfile,
      ...(target === undefined ? {} : { target: target.bunTarget })
    },
    conditions,
    define: {
      PHOTON_BINARY_ASSET: JSON.stringify(
        target?.archive ?? hostArchive(config)
      )
    },
    entrypoints: [join(projectRoot, 'src', 'bin.ts')],
    minify: true,
    plugins: [bunAliasPlugin(aliases), buildConfigPlugin(config)],
    sourcemap: 'linked'
  })

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    throw new Error(
      `Bun failed to build ${target?.bunTarget ?? 'the standalone binary'}`
    )
  }

  // Bun appends its payload after the Mach-O linker signature. Re-sign the final
  // executable so macOS does not terminate it with an invalid-signature error.
  const darwin =
    target === undefined
      ? platform() === 'darwin'
      : target.bunTarget.includes('darwin')
  if (darwin) {
    if (platform() !== 'darwin') {
      throw new Error(
        'Darwin release binaries must be built on macOS so they can be code signed'
      )
    }
    await run(['codesign', '--force', '--sign', '-', outfile])
  }
}

if (isEntryPoint(import.meta.url)) {
  const config = await readBuildConfig(process.argv[2])
  const outfile = join(
    projectRoot,
    'dist',
    `${config.executableName}${platform() === 'win32' ? '.exe' : ''}`
  )
  await buildLocalBinary({ config, outfile })
  console.log(`Built ${outfile}`)
}
