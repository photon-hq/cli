import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = join(projectRoot, 'dist')

if (dirname(outputDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean unexpected path: ${outputDirectory}`)
}

await rm(outputDirectory, { force: true, recursive: true })
