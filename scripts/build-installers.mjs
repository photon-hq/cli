import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INSTALLERS,
  readBuildConfig,
  readInstaller,
  renderInstaller
} from './build-config.mjs'

const buildConfig = await readBuildConfig(process.argv[2])
const artifactsDirectory = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'artifacts'
)

await mkdir(artifactsDirectory, { recursive: true })
await Promise.all(
  INSTALLERS.map(async (installer) => {
    await writeFile(
      join(artifactsDirectory, installer),
      renderInstaller(installer, await readInstaller(installer), buildConfig)
    )
    console.log(`Wrote ${installer} for ${buildConfig.environment}`)
  })
)
