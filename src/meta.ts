import { SDK_VERSION as BUNDLED_SDK_VERSION } from '#sdk-version'
import packageJson from '../package.json' with { type: 'json' }

import { BUILD_CONFIG } from './build-config.ts'

export const CLI_NAME = BUILD_CONFIG.executableName
export const CLI_VERSION = packageJson.version
export const CLI_DESCRIPTION =
  'Photon CLI for Node.js and standalone binaries, built with Gunshi.'
export const SDK_VERSION = BUNDLED_SDK_VERSION
