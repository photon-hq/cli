import config from '#build-config' with { type: 'json' }
import { validateBuildConfig } from './config-validation.mjs'

// Node, Bun and direct source execution share validation and committed
// defaults. '#build-config' is the staging configuration in internal builds and
// the production one everywhere else (package.json "imports").
export const BUILD_CONFIG = validateBuildConfig(config)
