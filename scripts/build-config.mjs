import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import productionConfig from '../config/cli.production.json' with {
  type: 'json'
}

import {
  firstReleaseVersion,
  validateBuildConfig,
  validatePackageConfig
} from '../src/config-validation.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export const BUILD_TARGETS = ['production', 'staging']

// Whether the module at moduleUrl is the script that Node or Bun was started
// with. It compares real paths, as the es-main package does: Node keeps a
// symlinked path in process.argv[1], and import.meta.url is the real path.
export const isEntryPoint = (moduleUrl) =>
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))

// Source imports the SDK as '@photon-ai/api', which package.json installs as
// the internal SDK (an npm alias). Internal (staging) builds use it as it is and
// resolve '#internal' and '#build-config' through the "photon-internal"
// condition of package.json "imports". Production builds swap in the public
// SDK, installed as '@photon-ai/api-public', and resolve both imports to their
// public files, so they contain no internal-only code. tsconfig.public.json
// maps the SDK the same way for the public type check.
export const resolveTarget = (config) =>
  config.environment === 'staging'
    ? { aliases: {}, conditions: ['photon-internal'] }
    : {
        aliases: { '@photon-ai/api': '@photon-ai/api-public' },
        conditions: []
      }

// Bun.build has no alias option, so the Bun builds take the aliases as a plugin.
export const bunAliasPlugin = (aliases) => ({
  name: 'aliases',
  setup: (build) => {
    for (const [name, replacement] of Object.entries(aliases)) {
      const path = Bun.resolveSync(replacement, root)
      build.onResolve(
        { filter: new RegExp(`^${RegExp.escape(name)}$`) },
        () => ({
          path
        })
      )
    }
  }
})

// A build embeds the config it is given. '#build-config' still resolves to the
// target's file through package.json "imports", and this plugin, which esbuild
// and Bun both accept, loads that file's contents from the config. The bundle
// keeps the JSON's line breaks, so the committed file's own text is used when
// it holds the same config, and a release build stays byte for byte the same.
export const buildConfigPlugin = (config) => ({
  name: 'build-config',
  setup: (build) => {
    build.onLoad(
      {
        filter: new RegExp(
          String.raw`[\\/]config[\\/]cli\.${config.environment}\.json$`
        )
      },
      async ({ path }) => {
        const committed = await readFile(path, 'utf8')
        return {
          contents: isDeepStrictEqual(JSON.parse(committed), config)
            ? committed
            : JSON.stringify(config, null, 2),
          loader: 'json'
        }
      }
    )
  }
})

// The release archive a binary built on this machine ships in, which
// `photon update` downloads to replace it.
export const hostArchive = (config) => {
  const system = process.platform === 'win32' ? 'windows' : process.platform
  const musl =
    process.platform === 'linux' &&
    process.report.getReport().header.glibcVersionRuntime === undefined
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz'
  return `${config.executableName}-${system}-${process.arch}${musl ? '-musl' : ''}.${extension}`
}

export const readBuildConfig = async (
  target = 'production',
  directory = root
) => {
  if (!BUILD_TARGETS.includes(target)) {
    throw new Error(
      `Unknown build target "${target}"; use ${BUILD_TARGETS.join(' or ')}`
    )
  }
  return validateBuildConfig(
    JSON.parse(
      await readFile(join(directory, `config/cli.${target}.json`), 'utf8')
    ),
    target
  )
}

const INSTALLER_DEFAULTS = {
  'install.ps1': ({ firstVersion, program, repository }) => [
    `$Program = '${program}'`,
    `$DefaultRepository = '${repository}'`,
    `$FirstVersion = '${firstVersion}'`
  ],
  'install.sh': ({ firstVersion, program, repository }) => [
    `program="${program}"`,
    `default_repository="${repository}"`,
    `first_version="${firstVersion}"`
  ]
}

export const INSTALLERS = Object.keys(INSTALLER_DEFAULTS)

const committedInstallerConfig = validateBuildConfig(
  productionConfig,
  'production'
)

const installerDefaults = (installer, config) =>
  INSTALLER_DEFAULTS[installer]({
    firstVersion: firstReleaseVersion(config),
    program: config.executableName,
    repository: config.releaseRepository
  })

// The committed installers carry the production defaults, since they install
// from photon-hq/cli. A staging release ships copies with its own defaults.
export const renderInstaller = (installer, text, config) => {
  const committed = installerDefaults(installer, committedInstallerConfig)
  const target = installerDefaults(installer, config)
  const lines = text.split('\n')
  for (const [index, line] of committed.entries()) {
    const matches = lines.flatMap((candidate, lineNumber) =>
      candidate.trim() === line ? [lineNumber] : []
    )
    if (matches.length !== 1) {
      throw new Error(`${installer} must contain the line ${line} once`)
    }
    const [position] = matches
    lines[position] = lines[position].replace(line, target[index])
  }
  return lines.join('\n')
}

export const readInstaller = async (installer, directory = root) =>
  await readFile(join(directory, 'scripts', installer), 'utf8')

// This repository's npm package is the staging build's. The production
// package is built from the public repository, whose check:config passes
// 'production'.
export const readPackageConfig = async (
  directory = root,
  target = 'staging'
) => {
  const config = await readBuildConfig(target, directory)
  validatePackageConfig(
    JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
    config
  )
  const production = await readBuildConfig('production', directory)
  const installers = await Promise.all(
    INSTALLERS.map(async (installer) => [
      installer,
      await readInstaller(installer, directory)
    ])
  )
  for (const [installer, text] of installers) {
    if (renderInstaller(installer, text, production) !== text) {
      throw new Error(
        `${installer} defaults must match the production configuration`
      )
    }
  }
  return config
}

if (isEntryPoint(import.meta.url)) {
  const packaged = await readPackageConfig(root, process.argv[2])
  const configs =
    packaged.environment === 'production'
      ? [packaged]
      : [await readBuildConfig('production'), packaged]
  for (const config of configs) {
    console.log(
      `Validated ${config.environment} / ${config.releaseChannel} (${config.executableName})`
    )
  }
  console.log(
    `Validated package.json for ${packaged.environment} and the installers for production`
  )
}
