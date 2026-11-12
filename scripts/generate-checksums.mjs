import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const artifactsDirectory = join(projectRoot, 'artifacts')
const artifactNames = (await readdir(artifactsDirectory))
  .filter((name) => name.endsWith('.tar.gz') || name.endsWith('.zip'))
  .sort()

if (artifactNames.length === 0) {
  throw new Error('No release archives found in artifacts/')
}

const checksums = await Promise.all(
  artifactNames.map(async (artifactName) => {
    const contents = await readFile(join(artifactsDirectory, artifactName))
    const digest = createHash('sha256').update(contents).digest('hex')
    return `${digest}  ${artifactName}`
  })
)

await writeFile(
  join(artifactsDirectory, 'checksums.txt'),
  `${checksums.join('\n')}\n`
)

console.log(`Wrote checksums for ${artifactNames.length} artifacts`)
