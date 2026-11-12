#!/usr/bin/env node

import { CliError } from './core/errors.ts'
import { listenForInterrupt } from './core/interrupt.ts'
import {
  CliOutput,
  outputOptionsFromArgs,
  writeFailureSurfaced
} from './core/output.ts'
import { isTerminal } from './core/terminal.ts'
import { runCli } from './main.ts'
import {
  prepareUpdateNotice,
  runUpdateCheck,
  UPDATE_CHECK_ARGUMENT
} from './update/notice.ts'

let reportedWriteFailure = false

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EIO' && isTerminal(stream)) {
      return
    }
    process.exitCode ||= 1
    if (
      stream !== process.stdout ||
      reportedWriteFailure ||
      writeFailureSurfaced(stream)
    ) {
      return
    }
    reportedWriteFailure = true
    new CliOutput(outputOptionsFromArgs(process.argv.slice(2))).writeFailure(
      error
    )
  })
}

const main = async (): Promise<void> => {
  if (process.argv[2] === UPDATE_CHECK_ARGUMENT) {
    await runUpdateCheck().catch(() => undefined)
    return
  }
  const args = process.argv.slice(2)
  const interrupt = listenForInterrupt(process)
  const showUpdateNotice = await prepareUpdateNotice({
    args,
    env: process.env,
    signal: interrupt.signal,
    stderr: process.stderr,
    stdout: process.stdout
  }).catch(() => () => Promise.resolve())
  try {
    await runCli(args, { signal: interrupt.signal })
  } finally {
    interrupt.dispose()
  }
  await showUpdateNotice().catch(() => undefined)
}

main().catch((error: unknown) => {
  const args = process.argv.slice(2)
  new CliOutput({
    ...outputOptionsFromArgs(args)
  }).error(
    new CliError(
      'CLI_BOOTSTRAP_FAILED',
      'Photon could not start the requested command.',
      {
        cause: error,
        next: [
          { description: 'Retry with --debug for diagnostic information.' }
        ]
      }
    )
  )
  process.exitCode = 1
})
