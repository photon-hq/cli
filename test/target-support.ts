import { BUILD_CONFIG } from '../src/build-config.ts'

/**
 * Whether the tests run on the staging target. `pnpm test` (vitest.config.ts)
 * runs them on it; `pnpm test:production` (vitest.production.config.ts) runs
 * them on the production target, as the public repository does. A test that
 * needs the staging target's internal-only commands, its configuration or its
 * release runs only when this is true.
 */
export const stagingTarget = BUILD_CONFIG.environment === 'staging'
