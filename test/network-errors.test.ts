import { mkdtemp, rm } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server,
  type Socket
} from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { errors } from 'undici'
import { afterEach, describe, expect, test } from 'vitest'
import { transportCode } from '../src/core/api-problem.ts'
import type { ReadableInput } from '../src/core/input.ts'
import { NetworkError, withNetworkErrors } from '../src/core/network.ts'
import { runCli } from '../src/main.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

// Each attempt waits out its time limit or the SDK's backoff.
const SLOW_TEST_TIMEOUT_MS = 15_000

const servers: ReturnType<typeof createServer>[] = []
const tcpServers: { server: Server; sockets: Socket[] }[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true })
      )
  )
  await Promise.all(
    tcpServers.splice(0).map(
      async ({ server, sockets }) =>
        await new Promise<void>((resolve) => {
          for (const socket of sockets) {
            socket.destroy()
          }
          server.close(() => {
            resolve()
          })
        })
    )
  )
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => {
            resolve()
          })
        })
    )
  )
})

// A fake API that answers each request with the next handler; the last one
// answers every request after it.
const fakeApi = async (...handlers: Handler[]) => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    const handler = handlers[Math.min(requests.length, handlers.length) - 1]
    handler?.(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port.toString()}`,
    host: `127.0.0.1:${port.toString()}`,
    requests
  }
}

const listOrganizations = async (
  baseUrl: string,
  json: boolean,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}
) => {
  const { configDirectory } = await createAuthenticatedConfig(
    'user_ada',
    baseUrl
  )
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(['org', 'list', ...(json ? ['--json'] : [])], {
    baseUrl,
    configDirectory,
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout,
    ...options
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

describe('a request that times out', () => {
  // The SDK's 60-second limit, shortened so the test doesn't wait minutes.
  const timeoutMs = 1000

  test(
    'names the host and the time limit',
    async () => {
      const api = await fakeApi(() => undefined)

      const result = await listOrganizations(api.baseUrl, false, { timeoutMs })

      // The SDK retries the timed-out GET without a word, and the error is the
      // last attempt's.
      expect(api.requests).toEqual([
        'GET /v1/organizations',
        'GET /v1/organizations',
        'GET /v1/organizations'
      ])
      expect(result.stderr).toBe(
        [
          `Error: ${api.host} didn't answer within 1 second. (API_CONNECTION_ERROR)`,
          'Transport code: TimeoutError',
          'Docs: https://photon.codes/docs/cli/output#errors',
          ''
        ].join('\n')
      )
      expect(result.exitCodes).toEqual([1])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    'has the transport code TimeoutError in JSON',
    async () => {
      const api = await fakeApi(() => undefined)

      const result = await listOrganizations(api.baseUrl, true, { timeoutMs })

      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          code: 'API_CONNECTION_ERROR',
          docsUrl: 'https://photon.codes/docs/cli/output#errors',
          message: `${api.host} didn't answer within 1 second.`,
          retryable: true,
          transportCode: 'TimeoutError'
        }
      })
    },
    SLOW_TEST_TIMEOUT_MS
  )
})

describe('a connection that never finishes its TLS handshake', () => {
  // A port that accepts each connection and never answers it, so a TLS
  // handshake never finishes.
  const silentServer = async () => {
    const sockets: Socket[] = []
    const server = createTcpServer((socket) => {
      sockets.push(socket)
      socket.on('error', () => undefined)
    })
    tcpServers.push({ server, sockets })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    return `127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
  }

  test(
    "names the host and Node.js's 10-second connect limit",
    async () => {
      const host = await silentServer()
      const fetch = withNetworkErrors(globalThis.fetch, { timeoutMs: 60_000 })

      const error = await fetch(`https://${host}/v1/organizations`, {
        signal: AbortSignal.timeout(60_000)
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(NetworkError)
      expect(error).toMatchObject({
        code: 'TimeoutError',
        message: `${host} didn't answer within 10 seconds.`
      })
      expect(transportCode(error)).toBe('TimeoutError')
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // Node's fetch rejects as in the test above; the CLI runs here against that
  // rejection so the test doesn't wait out three 10-second attempts.
  const connectTimeout = async (): Promise<Response> => {
    await Promise.resolve()
    throw new TypeError('fetch failed', {
      cause: new errors.ConnectTimeoutError()
    })
  }

  test('says so in text', async () => {
    const api = await fakeApi(() => undefined)

    const result = await listOrganizations(api.baseUrl, false, {
      fetch: connectTimeout
    })

    expect(result.stderr).toBe(
      [
        `Error: ${api.host} didn't answer within 10 seconds. (API_CONNECTION_ERROR)`,
        'Transport code: TimeoutError',
        'Docs: https://photon.codes/docs/cli/output#errors',
        ''
      ].join('\n')
    )
    expect(result.exitCodes).toEqual([1])
  })

  test('has the transport code TimeoutError in JSON', async () => {
    const api = await fakeApi(() => undefined)

    const result = await listOrganizations(api.baseUrl, true, {
      fetch: connectTimeout
    })

    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'API_CONNECTION_ERROR',
        docsUrl: 'https://photon.codes/docs/cli/output#errors',
        message: `${api.host} didn't answer within 10 seconds.`,
        retryable: true,
        transportCode: 'TimeoutError'
      }
    })
  })
})

describe('a request the caller cancels', () => {
  test('fails with the cancellation, not a NetworkError', async () => {
    const controller = new AbortController()
    const api = await fakeApi(() => {
      controller.abort(new DOMException('Command interrupted.', 'AbortError'))
    })
    const fetch = withNetworkErrors(globalThis.fetch, { timeoutMs: 60_000 })

    const cancelled = await fetch(`${api.baseUrl}/v1/organizations`, {
      signal: controller.signal
    }).catch((error: unknown) => error)

    expect(cancelled).not.toBeInstanceOf(NetworkError)
    expect(cancelled).toMatchObject({
      message: 'Command interrupted.',
      name: 'AbortError'
    })
  })
})

const runCommand = async (
  args: string[],
  options: NonNullable<Parameters<typeof runCli>[1]>
) => {
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    ...options,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const nonTtyStdin = (contents: string): ReadableInput => {
  const stream = Readable.from([contents]) as ReadableInput
  stream.isTTY = false
  return stream
}

describe('a sign-in request that times out', () => {
  const timeoutMs = 1000

  test(
    'names the host and the time limit for login --service-key',
    async () => {
      const api = await fakeApi(() => undefined)
      const configDirectory = await mkdtemp(join(tmpdir(), 'photon-login-'))
      directories.push(configDirectory)

      const result = await runCommand(
        ['login', '--service-key', '--insecure-storage', '--json'],
        {
          baseUrl: api.baseUrl,
          configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          stdin: nonTtyStdin(
            `${photonKey('ask', '01h455vb4pex5vsknk084sn02s_QWNjb3VudFNlcnZpY2VLZXk')}\n`
          ),
          timeoutMs
        }
      )

      expect(api.requests).toEqual(['GET /v1/account'])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'AUTH_TEMPORARILY_UNAVAILABLE',
          detail: `${api.host} didn't answer within 1 second.`,
          transportCode: 'TimeoutError'
        }
      })
      expect(result.exitCodes).toEqual([1])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    'names the host and the time limit for a session refresh',
    async () => {
      const api = await fakeApi(() => undefined)
      const { configDirectory } = await createAuthenticatedConfig(
        'user_ada',
        api.baseUrl
      )

      const result = await runCommand(['org', 'list', '--json'], {
        baseUrl: api.baseUrl,
        configDirectory,
        // Two hours on, the stored access token has expired.
        now: () => TEST_NOW + 2 * 3_600_000,
        timeoutMs
      })

      expect(api.requests).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'AUTH_TEMPORARILY_UNAVAILABLE',
          detail: `${api.host} didn't answer within 1 second.`,
          transportCode: 'TimeoutError'
        }
      })
      expect(result.exitCodes).toEqual([1])
    },
    SLOW_TEST_TIMEOUT_MS
  )
})
