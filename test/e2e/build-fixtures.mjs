#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hostArchive, readBuildConfig } from '../../scripts/build-config.mjs'

// Builds this branch as production releases 3.0.0 and 3.0.1, the way
// photon-hq/cli will publish them: a binary archive for this machine with
// checksums.txt per release, and an @photon-ai/cli npm package per version.
// 3.0.2 is 3.0.0 with a corrupted archive, and 2.2.0 stands in for 1.0.
export const RELEASED = ['3.0.0', '3.0.1']
export const CORRUPTED = '3.0.2'
export const LEGACY = '2.2.0'

export const fixturesDirectory = (env = process.env) =>
  env.PHOTON_E2E_FIXTURES ?? join(tmpdir(), 'photon-e2e-fixtures')

const root = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
// The release archives are packed on the macOS runner, so their files belong
// to its runner:staff, 501:20. GNU tar gives the Linux fixtures that owner too.
const RELEASE_OWNER = ['--numeric-owner', '--owner=501', '--group=20']
const tar = windows
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

// On Windows npm is a .cmd file, which only cmd.exe runs, given one line.
const run = (command, args) =>
  windows
    ? execFileSync(
        [command, ...args]
          .map((word) => (word.includes(' ') ? `"${word}"` : word))
          .join(' '),
        { cwd: root, shell: true, stdio: 'inherit' }
      )
    : execFileSync(command, args, { cwd: root, stdio: 'inherit' })

const checksums = async (release, files) => {
  const lines = await Promise.all(
    files.map(async (file) => {
      const digest = createHash('sha256')
        .update(await readFile(join(release, file)))
        .digest('hex')
      return `${digest}  ${file}`
    })
  )
  await writeFile(join(release, 'checksums.txt'), `${lines.join('\n')}\n`)
}

const build = async (output) => {
  const config = await readBuildConfig('production')
  const asset = hostArchive(config)
  const binary = `${config.executableName}${windows ? '.exe' : ''}`
  const manifestPath = join(root, 'package.json')
  const manifest = await readFile(manifestPath, 'utf8')
  await rm(output, { force: true, recursive: true })
  await mkdir(join(output, 'packages'), { recursive: true })
  try {
    for (const version of RELEASED) {
      // biome-ignore lint/performance/noAwaitInLoops: each release rebuilds dist/ from package.json, so they build one at a time.
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...JSON.parse(manifest),
          bin: { pho: './dist/bin.js', photon: './dist/bin.js' },
          name: '@photon-ai/cli',
          version
        })
      )
      run('node', ['scripts/build-javascript.mjs', 'production'])
      run('npm', [
        'pack',
        '--ignore-scripts',
        '--pack-destination',
        join(output, 'packages')
      ])
      run('bun', ['run', 'scripts/build-local-binary.mjs', 'production'])
      const release = join(output, 'releases', `v${version}`)
      const staging = await mkdtemp(join(tmpdir(), 'photon-archive-'))
      await mkdir(release, { recursive: true })
      await copyFile(join(root, 'dist', binary), join(staging, binary))
      await copyFile(
        join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'),
        join(staging, 'THIRD_PARTY_NOTICES.txt')
      )
      run(tar, [
        windows ? '-a' : '-z',
        ...(process.platform === 'linux' ? RELEASE_OWNER : []),
        '-c',
        '-f',
        join(release, asset),
        '-C',
        staging,
        binary,
        'THIRD_PARTY_NOTICES.txt'
      ])
      await rm(staging, { force: true, recursive: true })
      await checksums(release, [asset])
    }
  } finally {
    await writeFile(manifestPath, manifest)
  }
  const corrupted = join(output, 'releases', `v${CORRUPTED}`)
  await cp(join(output, 'releases', `v${RELEASED[0]}`), corrupted, {
    recursive: true
  })
  await appendFile(join(corrupted, asset), 'corrupted')
  const legacy = join(output, 'releases', `v${LEGACY}`)
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'photon-linux-x64'), 'Photon CLI 1.0')
  await checksums(legacy, ['photon-linux-x64'])
  await writeFile(join(output, 'releases', 'latest'), `v${RELEASED[0]}`)
  console.log(`Built release fixtures for ${asset} in ${output}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(process.argv[2] ?? fixturesDirectory())
}
