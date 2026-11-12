import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { type AddressInfo, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from 'vitest'
import { hostArchive, readBuildConfig } from '../scripts/build-config.mjs'
import { buildJavaScript } from '../scripts/build-javascript.mjs'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { packageIdentity } from '../src/config-validation.mjs'
import { runCli } from '../src/main.ts'
import { UPDATE_CHECK_ARGUMENT } from '../src/update/notice.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  organizationFixture,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD_TIMEOUT_MS = 60_000
const SLOW_TEST_TIMEOUT_MS = 15_000
const execFileAsync = promisify(execFile)
// Never resolves: .test is reserved, so a direct request fails on this machine.
const UNREACHABLE_ORIGIN = 'https://api.photon.test'
const SERVICE_KEY = photonKey('ask', '0aaaaaaaaaaaaaaaaaaaaaaaaa_proxytest')
const NEWEST_VERSION = '99.0.0'

const accountResponse = {
  accountId: 'account_123',
  createdAt: '2026-07-01T00:00:00.000Z',
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  onboarded: true,
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/ada.png',
  updatedAt: '2026-07-03T00:00:00.000Z'
}

const servers: ReturnType<typeof createServer>[] = []
const sockets: Socket[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolveClose) => {
          server.closeAllConnections()
          server.close(() => {
            resolveClose()
          })
        })
    )
  )
})

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(
      async (directory) => await rm(directory, { force: true, recursive: true })
    )
  )
})

const listen = async (server: ReturnType<typeof createServer>) => {
  servers.push(server)
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return (server.address() as AddressInfo).port
}

// A proxy that records every request it gets. It tunnels CONNECT to this
// machine and refuses every other destination, so no test request leaves it.
// With refuseTunnels it refuses every CONNECT, as a proxy that blocks a host
// does.
const recordingProxy = async ({ refuseTunnels = false } = {}) => {
  const seen: string[] = []
  const tunnelPorts = new Set<number>()
  const server = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
    response.writeHead(502)
    response.end()
  })
  server.on('connect', (request: IncomingMessage, client: Socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    sockets.push(client)
    client.on('error', () => undefined)
    const [host, port] = (request.url ?? '').split(':')
    if (refuseTunnels || host !== '127.0.0.1') {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const upstream = connect(Number(port), host, () => {
      tunnelPorts.add(upstream.localPort ?? 0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(client)
      client.pipe(upstream)
    })
    sockets.push(upstream)
    upstream.on('error', () => client.destroy())
  })
  const port = await listen(server)
  return { seen, tunnelPorts, url: `http://127.0.0.1:${port.toString()}` }
}

// Ports on this machine that nothing listens on, so a connection to one is
// refused. They are held together, so no two are the same.
const closedPorts = async (count: number): Promise<number[]> => {
  const held = Array.from({ length: count }, () => createServer())
  const ports = await Promise.all(
    held.map(
      async (server) =>
        await new Promise<number>((resolveListen) => {
          server.listen(0, '127.0.0.1', () => {
            resolveListen((server.address() as AddressInfo).port)
          })
        })
    )
  )
  await Promise.all(
    held.map(
      async (server) =>
        await new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose()
          })
        })
    )
  )
  return ports
}

// A proxy whose name never resolves: .test is reserved.
const UNRESOLVABLE_PROXY = 'http://proxy.photon.test:3128'

const writeJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

// A fake API that records the client port of every request it answers.
const fakeApi = async () => {
  const clientPorts: number[] = []
  const server = createServer((request, response) => {
    clientPorts.push(request.socket.remotePort ?? 0)
    if (request.url === '/v1/account') {
      writeJson(response, accountResponse)
      return
    }
    writeJson(response, {
      acquisitionQuestionnaireExempt: false,
      organizations: [organizationFixture()],
      ownedOrganizationIds: ['org_1']
    })
  })
  const port = await listen(server)
  return { baseUrl: `http://127.0.0.1:${port.toString()}`, clientPorts }
}

const invoke = async (
  args: string[],
  baseUrl: string,
  env: NodeJS.ProcessEnv
) => {
  const { configDirectory } = await createAuthenticatedConfig(
    'user_ada',
    baseUrl
  )
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli([...args, '--json'], {
    baseUrl,
    configDirectory,
    deviceScope: unusedDeviceScope(),
    env,
    now: () => TEST_NOW,
    platform: 'linux',
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

describe('proxy variables on Node.js', () => {
  test.each(['HTTP_PROXY', 'http_proxy'])(
    'send every request through %s',
    async (name) => {
      const proxy = await recordingProxy()
      const api = await fakeApi()
      const env = { [name]: proxy.url }

      const organizations = await invoke(['org', 'list'], api.baseUrl, env)
      const account = await invoke(['whoami'], api.baseUrl, env)

      expect(organizations.stderr).toBe('')
      expect(account.stderr).toBe('')
      expect(proxy.seen).toContain(`CONNECT ${new URL(api.baseUrl).host}`)
      expect(api.clientPorts).toHaveLength(2)
      for (const port of api.clientPorts) {
        expect(proxy.tunnelPorts).toContain(port)
      }
    }
  )

  test(
    'send an HTTPS request through HTTPS_PROXY',
    async () => {
      const proxy = await recordingProxy()

      const result = await invoke(['org', 'list'], UNREACHABLE_ORIGIN, {
        HTTPS_PROXY: proxy.url
      })

      expect(proxy.seen).toEqual([
        'CONNECT api.photon.test:443',
        'CONNECT api.photon.test:443',
        'CONNECT api.photon.test:443'
      ])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'API_CONNECTION_ERROR',
          message: 'api.photon.test could not be reached.'
        }
      })
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // localhost has two addresses here, so Node's error is an AggregateError
  // with one refused connection for each.
  test.each(['127.0.0.1', 'localhost'])(
    'name a proxy at %s that refuses the connection, without its credentials',
    async (hostname) => {
      const [port] = await closedPorts(1)
      const proxyHost = `${hostname}:${String(port)}`

      const result = await invoke(['org', 'list'], UNREACHABLE_ORIGIN, {
        HTTPS_PROXY: `http://ada:hunter2@${proxyHost}`
      })

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'API_CONNECTION_ERROR',
          message: `The proxy ${proxyHost} could not be reached.`,
          transportCode: 'ECONNREFUSED'
        }
      })
      expect(result.stderr).not.toContain('hunter2')
      expect(result.stdout).not.toContain('hunter2')
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    "name a proxy whose name doesn't resolve",
    async () => {
      const result = await invoke(['org', 'list'], UNREACHABLE_ORIGIN, {
        HTTPS_PROXY: UNRESOLVABLE_PROXY
      })

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'API_CONNECTION_ERROR',
          message: 'The proxy proxy.photon.test:3128 could not be reached.',
          transportCode: 'ENOTFOUND'
        }
      })
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    'name the server, not the proxy, when NO_PROXY sends the request to it directly',
    async () => {
      const [proxyPort, serverPort] = await closedPorts(2)
      const serverHost = `127.0.0.1:${String(serverPort)}`

      const result = await invoke(['org', 'list'], `http://${serverHost}`, {
        HTTP_PROXY: `http://127.0.0.1:${String(proxyPort)}`,
        NO_PROXY: '127.0.0.1'
      })

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'API_CONNECTION_ERROR',
          message: `${serverHost} could not be reached.`,
          transportCode: 'ECONNREFUSED'
        }
      })
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    "name the server when it has the name of a proxy that doesn't resolve",
    async () => {
      const result = await invoke(
        ['org', 'list'],
        'https://proxy.photon.test',
        {
          HTTPS_PROXY: UNRESOLVABLE_PROXY,
          NO_PROXY: 'proxy.photon.test'
        }
      )

      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'API_CONNECTION_ERROR',
          message: 'proxy.photon.test could not be reached.',
          transportCode: 'ENOTFOUND'
        }
      })
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test('read a proxy without a scheme as an HTTP proxy', async () => {
    const proxy = await recordingProxy()
    const api = await fakeApi()

    const result = await invoke(['org', 'list'], api.baseUrl, {
      HTTP_PROXY: new URL(proxy.url).host
    })

    expect(result.stderr).toBe('')
    expect(proxy.seen).toEqual([`CONNECT ${new URL(api.baseUrl).host}`])
  })

  test.each(['NO_PROXY', 'no_proxy'])(
    'reach a host that %s lists directly',
    async (name) => {
      const proxy = await recordingProxy()
      const api = await fakeApi()

      const result = await invoke(['org', 'list'], api.baseUrl, {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        [name]: '127.0.0.1'
      })

      expect(result.stderr).toBe('')
      expect(api.clientPorts).toHaveLength(1)
      expect(proxy.seen).toEqual([])
    }
  )
})

const runBuild = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = ''
): Promise<{
  exitCode: number | null
  home: string
  stderr: string
  stdout: string
}> => {
  const home = await mkdtemp(join(tmpdir(), 'photon-proxy-home-'))
  temporaryDirectories.push(home)
  const child = spawn(command, args, {
    env: {
      HOME: home,
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      ...env
    },
    stdio: 'pipe'
  })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stdin.end(input)
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.on('close', resolveExit)
  })
  return { exitCode, home, stderr, stdout }
}

const runLogin = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) =>
  await runBuild(
    command,
    [...args, 'login', '--service-key', '--insecure-storage', '--json'],
    env,
    SERVICE_KEY
  )

// What the background update check found, read where env-paths keeps it
// under the HOME and XDG_CACHE_HOME that runBuild sets.
const updateState = async (home: string, namespace: string) =>
  JSON.parse(
    await readFile(
      process.platform === 'darwin'
        ? join(home, 'Library', 'Caches', namespace, 'update-check.json')
        : join(home, 'cache', namespace, 'update-check.json'),
      'utf8'
    )
  ) as unknown

// A self-signed certificate for 127.0.0.1, which the release builds trust
// through NODE_EXTRA_CA_CERTS.
const createCertificate = async (directory: string) => {
  const certificate = join(directory, 'certificate.pem')
  const key = join(directory, 'key.pem')
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ])
  return { certificate, key }
}

describe('proxy variables in the release builds', () => {
  let binary = ''
  let bundle = ''
  let certificate = ''
  // An HTTPS API on this machine that the builds below are pointed at. It
  // also answers as the package registry and the release repository that the
  // update check and photon update read.
  let localApi: Server | undefined
  let localApiHost = ''
  const localApiRequests: string[] = []
  let archive = ''
  let registryPath = ''
  let releasesPath = ''
  let stateNamespace = ''

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'photon-proxy-builds-'))
    temporaryDirectories.push(directory)
    const { certificate: certificateFile, key } =
      await createCertificate(directory)
    certificate = certificateFile
    const server = createHttpsServer(
      { cert: await readFile(certificateFile), key: await readFile(key) },
      (request, response) => {
        const url = request.url ?? ''
        localApiRequests.push(`${request.method ?? ''} ${url}`)
        if (url === registryPath) {
          writeJson(response, {
            'dist-tags': { [packageIdentity(BUILD_CONFIG).tag]: NEWEST_VERSION }
          })
          return
        }
        if (url === `${releasesPath}/latest`) {
          response.writeHead(302, {
            location: `https://${localApiHost}${releasesPath}/tag/v${NEWEST_VERSION}`
          })
          response.end()
          return
        }
        if (url.startsWith(`${releasesPath}/download/`)) {
          // An empty checksums.txt, so photon update stops before it changes
          // anything.
          response.writeHead(200)
          response.end()
          return
        }
        writeJson(response, {
          ...accountResponse,
          accountId: `pho_acc_0${'a'.repeat(25)}`
        })
      }
    )
    localApi = server
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', resolveListen)
    })
    localApiHost = `127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
    // This target's builds, made by the release build code, with the local
    // API as their API origin.
    const config = {
      ...(await readBuildConfig(BUILD_CONFIG.environment)),
      apiOrigin: `https://${localApiHost}`
    }
    archive = hostArchive(config)
    registryPath = `/${packageIdentity(config).name.replace('/', '%2f')}`
    releasesPath = `/${config.releaseRepository}/releases`
    ;({ stateNamespace } = config)

    // Laid out as the npm package is: its package.json makes bin.js an ES module.
    const packageDirectory = join(directory, 'package')
    await mkdir(packageDirectory)
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ type: 'module' })
    )
    bundle = (
      await buildJavaScript({
        config,
        outputDirectory: join(packageDirectory, 'dist')
      })
    ).outputFile

    binary = join(directory, config.executableName)
    const binaryBuild = pathToFileURL(
      join(root, 'scripts', 'build-local-binary.mjs')
    ).href
    await execFileAsync(join(root, 'node_modules', '.bin', 'bun'), [
      '--eval',
      `const { buildLocalBinary } = await import(${JSON.stringify(binaryBuild)})
await buildLocalBinary(${JSON.stringify({ config, outfile: binary })})`
    ])
  }, BUILD_TIMEOUT_MS)

  beforeEach(() => {
    localApiRequests.length = 0
  })

  afterAll(async () => {
    localApi?.closeAllConnections()
    await new Promise<void>((resolveClose) => {
      if (localApi === undefined) {
        resolveClose()
        return
      }
      localApi.close(() => {
        resolveClose()
      })
    })
  })

  test(
    "send the npm package's requests through HTTPS_PROXY",
    async () => {
      const proxy = await recordingProxy()

      const result = await runLogin(process.execPath, [bundle], {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(proxy.seen).toEqual([`CONNECT ${localApiHost}`])
      expect(localApiRequests).toEqual(['GET /v1/account'])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    'let the npm package reach a NO_PROXY host directly',
    async () => {
      const proxy = await recordingProxy()

      const result = await runLogin(process.execPath, [bundle], {
        HTTPS_PROXY: proxy.url,
        NO_PROXY: '127.0.0.1',
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(proxy.seen).toEqual([])
      expect(localApiRequests).toEqual(['GET /v1/account'])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    "send the standalone binary's requests through HTTPS_PROXY",
    async () => {
      const proxy = await recordingProxy()

      const result = await runLogin(binary, [], {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(proxy.seen).toEqual([`CONNECT ${localApiHost}`])
      expect(localApiRequests).toEqual(['GET /v1/account'])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    'let the standalone binary reach a NO_PROXY host directly',
    async () => {
      const proxy = await recordingProxy()

      const result = await runLogin(binary, [], {
        HTTPS_PROXY: proxy.url,
        NO_PROXY: '127.0.0.1',
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(proxy.seen).toEqual([])
      expect(localApiRequests).toEqual(['GET /v1/account'])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // The 502 is the proxy's answer to CONNECT, not the API's, so both builds
  // name the host they couldn't reach.
  test.each([
    ['npm package', 'UND_ERR_ABORTED'],
    ['standalone binary', 'ERR_PROXY_TUNNEL']
  ] as const)(
    "say the %s couldn't reach the API when the proxy refuses the tunnel",
    async (build, transportCode) => {
      const proxy = await recordingProxy({ refuseTunnels: true })
      const [command, args] =
        build === 'npm package' ? [process.execPath, [bundle]] : [binary, []]

      const result = await runLogin(command, args, {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'AUTH_TEMPORARILY_UNAVAILABLE',
          detail: `${localApiHost} could not be reached.`,
          transportCode
        }
      })
      expect(new Set(proxy.seen)).toEqual(new Set([`CONNECT ${localApiHost}`]))
      expect(localApiRequests).toEqual([])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  const buildCommand = (
    build: 'npm package' | 'standalone binary'
  ): [string, string[]] =>
    build === 'npm package' ? [process.execPath, [bundle]] : [binary, []]

  test.each([
    ['npm package', 'refuses the connection', 'ECONNREFUSED'],
    ['standalone binary', 'refuses the connection', 'ECONNREFUSED'],
    ['npm package', "doesn't resolve", 'ENOTFOUND'],
    ['standalone binary', "doesn't resolve", 'ENOTFOUND']
  ] as const)(
    'let the %s name a proxy that %s',
    async (build, _failure, transportCode) => {
      const [port] = await closedPorts(1)
      const proxy =
        transportCode === 'ENOTFOUND'
          ? new URL(UNRESOLVABLE_PROXY)
          : new URL(`http://127.0.0.1:${String(port)}`)

      const result = await runLogin(...buildCommand(build), {
        HTTPS_PROXY: proxy.href,
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'AUTH_TEMPORARILY_UNAVAILABLE',
          detail: `The proxy ${proxy.host} could not be reached.`,
          transportCode
        }
      })
      expect(localApiRequests).toEqual([])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // Bun reads ALL_PROXY too, when the variable for the URL's scheme is unset.
  test(
    'let the standalone binary name the ALL_PROXY proxy when it refuses the connection',
    async () => {
      const [port] = await closedPorts(1)

      const result = await runLogin(binary, [], {
        ALL_PROXY: `http://127.0.0.1:${String(port)}`,
        NODE_EXTRA_CA_CERTS: certificate
      })

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'AUTH_TEMPORARILY_UNAVAILABLE',
          detail: `The proxy 127.0.0.1:${String(port)} could not be reached.`,
          transportCode: 'ECONNREFUSED'
        }
      })
      expect(localApiRequests).toEqual([])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // Bun's error for a refused connection doesn't say where it connected, so
  // the standalone binary reads NO_PROXY as Bun does to tell the two apart.
  // Bun ignores a trailing dot on a NO_PROXY entry.
  test.each([
    ['npm package', '127.0.0.1', '127.0.0.1'],
    ['standalone binary', '127.0.0.1', '127.0.0.1'],
    ['standalone binary', 'localhost.', 'localhost']
  ] as const)(
    'let the %s name the server, not the proxy, when NO_PROXY=%s sends a request to it directly',
    async (build, noProxy, hostname) => {
      const [proxyPort, serverPort] = await closedPorts(2)
      const server = `https://${hostname}:${String(serverPort)}`
      const [command, args] = buildCommand(build)

      const result = await runBuild(
        command,
        [...args, 'update', '--check', '--json'],
        {
          HTTPS_PROXY: `http://127.0.0.1:${String(proxyPort)}`,
          NO_PROXY: noProxy,
          NODE_EXTRA_CA_CERTS: certificate,
          npm_config_registry: server,
          PHOTON_INSTALLER_GITHUB_BASE_URL: server
        }
      )

      expect(result.exitCode).toBe(1)
      const { error } = JSON.parse(result.stdout) as {
        error: { code: string; detail: string }
      }
      expect(error.code).toBe('UPDATE_CHECK_FAILED')
      expect(error.detail.startsWith(`${server}/`)).toBe(true)
      expect(error.detail).not.toContain('proxy')
    },
    SLOW_TEST_TIMEOUT_MS
  )

  // The npm package looks up its newest version in the package registry, and
  // the standalone binary in the release repository.
  const updateSources = () => ({
    npm_config_registry: `https://${localApiHost}`,
    PHOTON_INSTALLER_GITHUB_BASE_URL: `https://${localApiHost}`
  })

  test.each(['npm package', 'standalone binary'] as const)(
    "send the %s's background update check through HTTPS_PROXY",
    async (build) => {
      const proxy = await recordingProxy()
      const [command, args, lookup] =
        build === 'npm package'
          ? [process.execPath, [bundle], registryPath]
          : [binary, [], `${releasesPath}/latest`]

      const result = await runBuild(command, [...args, UPDATE_CHECK_ARGUMENT], {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate,
        ...updateSources()
      })

      expect(result.exitCode, result.stderr).toBe(0)
      expect(proxy.seen).toEqual([`CONNECT ${localApiHost}`])
      expect(localApiRequests).toEqual([`GET ${lookup}`])
      await expect(
        updateState(result.home, stateNamespace)
      ).resolves.toMatchObject({ latestVersion: NEWEST_VERSION })
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    "send the npm package's photon update lookup through HTTPS_PROXY",
    async () => {
      const proxy = await recordingProxy()

      const result = await runBuild(
        process.execPath,
        [bundle, 'update', '--check', '--json'],
        {
          HTTPS_PROXY: proxy.url,
          NODE_EXTRA_CA_CERTS: certificate,
          ...updateSources()
        }
      )

      expect(result.exitCode, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        latestVersion: NEWEST_VERSION,
        status: 'update-available'
      })
      expect(proxy.seen).toEqual([`CONNECT ${localApiHost}`])
      expect(localApiRequests).toEqual([`GET ${registryPath}`])
    },
    SLOW_TEST_TIMEOUT_MS
  )

  test(
    "send the standalone binary's photon update downloads through HTTPS_PROXY",
    async () => {
      const proxy = await recordingProxy()

      const result = await runBuild(binary, ['update', '--json'], {
        HTTPS_PROXY: proxy.url,
        NODE_EXTRA_CA_CERTS: certificate,
        ...updateSources()
      })

      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'UPDATE_CHECKSUM_MISMATCH' }
      })
      expect(new Set(proxy.seen)).toEqual(new Set([`CONNECT ${localApiHost}`]))
      expect(localApiRequests).toEqual([
        `GET ${releasesPath}/latest`,
        `GET ${releasesPath}/download/v${NEWEST_VERSION}/checksums.txt`,
        `GET ${releasesPath}/download/v${NEWEST_VERSION}/${archive}`
      ])
    },
    SLOW_TEST_TIMEOUT_MS
  )
})
