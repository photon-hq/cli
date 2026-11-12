import { configDefaults, defineConfig } from 'vitest/config'

import { resolveTarget } from './scripts/build-config.mjs'

const { aliases } = resolveTarget({ environment: 'production' })

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    exclude: [...configDefaults.exclude, 'test/internal/**'],
    setupFiles: ['test/setup-terminal-env.ts']
  }
})
