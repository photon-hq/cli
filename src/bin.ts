#!/usr/bin/env node

import { nodeVersionFailure } from './core/node-version.ts'

// The npm package's executable. The CLI in cli.ts imports what only Node.js 22
// has, and an older Node.js rejects those imports before any of the CLI's code
// runs. So this checks the version first and loads the CLI only on a version
// it runs on. The build bundles this file on its own, for an older Node.js to
// read, which is also why it doesn't await the import at the top level.
const failure = nodeVersionFailure(process.versions.node, process.argv.slice(2))
if (failure === undefined) {
  import('./cli.ts')
} else {
  process[failure.stream].write(failure.text)
  process.exitCode = 1
}
