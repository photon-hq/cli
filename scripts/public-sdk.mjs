import nodeModule from 'node:module'

import { resolveTarget } from './build-config.mjs'

if (typeof nodeModule.registerHooks !== 'function') {
  throw new Error(
    `pnpm cli and pnpm dev need module.registerHooks, in Node.js 22.15 or later or 23.5 or later; this is Node.js ${process.version}.`
  )
}

// Source runs of the production target (`pnpm cli`, `pnpm dev`) load the
// public SDK, as production builds do.
const { aliases } = resolveTarget({ environment: 'production' })

nodeModule.registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      Object.hasOwn(aliases, specifier) ? aliases[specifier] : specifier,
      context
    )
})
