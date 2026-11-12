import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBuildConfig } from './build-config.mjs'
import { buildLocalBinary } from './build-local-binary.mjs'

const buildConfig = await readBuildConfig(process.argv[2])

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const artifactsDirectory = join(projectRoot, 'artifacts')
const noticesPath = join(projectRoot, 'dist', 'THIRD_PARTY_NOTICES.txt')

const targets = [
  {
    archive: `${buildConfig.executableName}-darwin-arm64.tar.gz`,
    bunTarget: 'bun-darwin-arm64',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-darwin-x64.tar.gz`,
    bunTarget: 'bun-darwin-x64-baseline',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-linux-arm64.tar.gz`,
    bunTarget: 'bun-linux-arm64',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-linux-x64.tar.gz`,
    bunTarget: 'bun-linux-x64-baseline',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-linux-arm64-musl.tar.gz`,
    bunTarget: 'bun-linux-arm64-musl',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-linux-x64-musl.tar.gz`,
    bunTarget: 'bun-linux-x64-musl-baseline',
    windows: false
  },
  {
    archive: `${buildConfig.executableName}-windows-arm64.zip`,
    bunTarget: 'bun-windows-arm64',
    windows: true
  },
  {
    archive: `${buildConfig.executableName}-windows-x64.zip`,
    bunTarget: 'bun-windows-x64-baseline',
    windows: true
  }
]

async function run(command) {
  const process = Bun.spawn({
    cmd: command,
    stderr: 'inherit',
    stdout: 'inherit'
  })
  const exitCode = await process.exited

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(' ')}`)
  }
}

await rm(artifactsDirectory, { force: true, recursive: true })
await mkdir(artifactsDirectory, { recursive: true })

async function buildTarget(target) {
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'photon-'))
  const binaryName = `${buildConfig.executableName}${target.windows ? '.exe' : ''}`
  const binaryPath = join(stagingDirectory, binaryName)

  try {
    await buildLocalBinary({
      config: buildConfig,
      outfile: binaryPath,
      target
    })

    if (target.windows) {
      await copyFile(
        noticesPath,
        join(stagingDirectory, 'THIRD_PARTY_NOTICES.txt')
      )
      await run([
        'zip',
        '-j',
        join(artifactsDirectory, target.archive),
        binaryPath,
        join(stagingDirectory, 'THIRD_PARTY_NOTICES.txt')
      ])
    } else {
      await chmod(binaryPath, 0o755)
      await copyFile(
        noticesPath,
        join(stagingDirectory, 'THIRD_PARTY_NOTICES.txt')
      )
      await run([
        'tar',
        '-C',
        stagingDirectory,
        '-czf',
        join(artifactsDirectory, target.archive),
        binaryName,
        'THIRD_PARTY_NOTICES.txt'
      ])
    }

    console.log(`Built ${target.archive}`)
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true })
  }
}

await Promise.all(targets.map((target) => buildTarget(target)))
