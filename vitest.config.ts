import { defineConfig } from 'vitest/config'

// Tests run the internal (staging) build: '#internal' resolves to
// src/internal/index.ts. Setting conditions replaces Vite's defaults, so they
// are listed again after the internal one.
export default defineConfig({
  ssr: {
    resolve: {
      conditions: [
        'photon-internal',
        'module',
        'node',
        'development|production'
      ]
    }
  },
  test: {
    setupFiles: ['test/setup-terminal-env.ts']
  }
})
