import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import { validateBuildConfig } from '../src/config-validation.mjs'
import {
  buildConfigPlugin,
  isEntryPoint,
  readBuildConfig,
  resolveTarget
} from './build-config.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const licenseFilePattern = /^licen[cs]e(?:\.|$)/i

const packageRootFromInput = (input) => {
  const absoluteInput = resolve(projectRoot, input)
  const marker = `${sep}node_modules${sep}`
  const markerIndex = absoluteInput.lastIndexOf(marker)
  if (markerIndex === -1) {
    return
  }

  const packagePath = absoluteInput.slice(markerIndex + marker.length)
  const [first, second] = packagePath.split(sep)
  if (first === undefined) {
    return
  }
  const packageName = first.startsWith('@') ? `${first}/${second}` : first
  return {
    name: packageName,
    root: join(
      absoluteInput.slice(0, markerIndex + marker.length),
      ...packageName.split('/')
    )
  }
}

const licenseText = async (packageRoot) => {
  const candidates = (await readdir(packageRoot))
    .filter((name) => licenseFilePattern.test(name))
    .sort()
  const [licenseFile] = candidates
  return licenseFile === undefined
    ? 'License text is available from the package repository.'
    : (await readFile(join(packageRoot, licenseFile), 'utf8')).trim()
}

/**
 * Bundles the CLI for Node.js with the given build config embedded, and writes
 * bin.js, its source map and THIRD_PARTY_NOTICES.txt to outputDirectory.
 */
export const buildJavaScript = async ({ config, outputDirectory }) => {
  const { aliases, conditions } = resolveTarget(validateBuildConfig(config))
  const outputFile = join(outputDirectory, 'bin.js')

  const result = await build({
    // esbuild reports metafile inputs relative to its working folder, and
    // packageRootFromInput resolves them against projectRoot.
    absWorkingDir: projectRoot,
    alias: aliases,
    // Bundled CommonJS packages such as undici require Node's built-in modules,
    // and an ES module has no require of its own.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    },
    bundle: true,
    conditions,
    entryPoints: [join(projectRoot, 'src', 'bin.ts')],
    external: ['@napi-rs/keyring'],
    format: 'esm',
    legalComments: 'none',
    metafile: true,
    outfile: outputFile,
    platform: 'node',
    plugins: [buildConfigPlugin(config)],
    sourcemap: true,
    target: 'node22'
  })

  const packageRoots = new Map()
  for (const input of Object.keys(result.metafile.inputs)) {
    const entry = packageRootFromInput(input)
    if (entry !== undefined) {
      packageRoots.set(entry.name, entry.root)
    }
  }
  const keyringRoot = await realpath(
    join(projectRoot, 'node_modules', '@napi-rs', 'keyring')
  )
  packageRoots.set('@napi-rs/keyring', keyringRoot)
  const keyringManifest = JSON.parse(
    await readFile(join(keyringRoot, 'package.json'), 'utf8')
  )
  const optionalKeyringPackages = Object.keys(
    keyringManifest.optionalDependencies ?? {}
  )
  const optionalKeyringRoots = await Promise.all(
    optionalKeyringPackages.map(async (name) => {
      try {
        return [
          name,
          await realpath(join(dirname(keyringRoot), name.split('/').at(-1)))
        ]
      } catch {
        // Only native targets selected by supportedArchitectures are installed.
      }
    })
  )
  for (const entry of optionalKeyringRoots) {
    if (entry !== undefined) {
      packageRoots.set(entry[0], entry[1])
    }
  }

  const sections = await Promise.all(
    [...packageRoots]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, packageRoot]) => {
        const manifest = JSON.parse(
          await readFile(join(packageRoot, 'package.json'), 'utf8')
        )
        const repository =
          typeof manifest.repository === 'string'
            ? manifest.repository
            : manifest.repository?.url
        return [
          `${name} ${manifest.version}`,
          `License: ${manifest.license ?? 'See package'}`,
          ...(repository === undefined ? [] : [`Source: ${repository}`]),
          '',
          await licenseText(packageRoot)
        ].join('\n')
      })
  )

  await writeFile(
    join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'),
    [
      'Photon CLI third-party notices',
      '',
      'This file covers dependencies bundled into the JavaScript executable and the optional native credential adapter.',
      '',
      sections.join('\n\n---\n\n'),
      ''
    ].join('\n')
  )

  return { noticeCount: packageRoots.size, outputFile }
}

if (isEntryPoint(import.meta.url)) {
  const { noticeCount, outputFile } = await buildJavaScript({
    config: await readBuildConfig(process.argv[2]),
    outputDirectory: join(projectRoot, 'dist')
  })
  console.log(
    `Built ${relative(projectRoot, outputFile)} with ${noticeCount} third-party notices`
  )
}
