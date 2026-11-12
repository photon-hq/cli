import { CLI_ERROR_REFERENCE_URL, lastFlagValue } from './output-basics.ts'

/** The oldest Node.js major version the CLI runs on: package.json's engines. */
export const REQUIRED_NODE_MAJOR = 22

export interface NodeVersionFailure {
  stream: 'stderr' | 'stdout'
  text: string
}

// What to print on a Node.js older than the CLI needs, in the CLI's error
// format: the error's line on stderr, or with --json its JSON object on
// stdout. Undefined when the version is new enough.
export const nodeVersionFailure = (
  version: string,
  args: readonly string[]
): NodeVersionFailure | undefined => {
  if (Number(version.split('.')[0]) >= REQUIRED_NODE_MAJOR) {
    return
  }
  const code = 'NODE_VERSION_UNSUPPORTED'
  const message = `Photon CLI needs Node.js ${REQUIRED_NODE_MAJOR} or newer, and this is Node.js ${version}.`
  return lastFlagValue(args, 'json')
    ? {
        stream: 'stdout',
        text: `${JSON.stringify({
          // biome-ignore assist/source/useSortedKeys: Every CLI error lists its fields in this order.
          error: {
            code,
            message,
            retryable: false,
            docsUrl: CLI_ERROR_REFERENCE_URL
          }
        })}\n`
      }
    : { stream: 'stderr', text: `Error: ${message} (${code})\n` }
}
