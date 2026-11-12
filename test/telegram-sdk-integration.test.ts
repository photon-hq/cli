import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

interface CapturedRequest {
  body: string
  headers: IncomingHttpHeaders
  method: string
  pathname: string
  search: string
}

const servers: ReturnType<typeof createServer>[] = []
const timestamp = '2026-07-31T18:00:00.000Z'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const RELEASE_OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02r'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=setup_token-1'
const OPERATIONS_PATH =
  '/v1/projects/pho_prj_00000000000000000000000001/platforms/operations'
const RESOURCES_PATH =
  '/v1/projects/pho_prj_00000000000000000000000001/platforms/resources'
const BOTS_PATH =
  '/v1/projects/pho_prj_00000000000000000000000001/platforms/telegram/bots'

const setup = (state: string) => ({
  cancellable: state === 'pending',
  createdAt: timestamp,
  ...(state === 'succeeded' ? {} : { detail: { setupUrl: SETUP_URL } }),
  operationId: OPERATION_ID,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType: 'telegram_bot',
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const release = {
  cancellable: false,
  createdAt: timestamp,
  operationId: RELEASE_OPERATION_ID,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000031',
  resourceType: 'telegram_bot',
  state: 'succeeded',
  type: 'resource.release',
  updatedAt: timestamp
}

const bot = {
  abilities: ['telegram'],
  createdAt: timestamp,
  detail: {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000031',
  state: 'active',
  type: 'telegram_bot',
  updatedAt: timestamp
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const writeJson = (
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    'content-type':
      status >= 400 ? 'application/problem+json' : 'application/json',
    ...headers
  })
  response.end(JSON.stringify(body))
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
    )
  )
})

describe('generated Telegram SDK integration', () => {
  test('uses SDK wire shapes to connect, continue, list, view and disconnect', async () => {
    const captured: CapturedRequest[] = []
    let connects = 0
    let setupReads = 0
    const routes: Record<string, (response: ServerResponse) => void> = {
      [`POST ${BOTS_PATH}`]: (response) => {
        connects += 1
        if (connects === 1) {
          writeJson(response, setup('pending'), 202, {
            location: `${OPERATIONS_PATH}/${OPERATION_ID}`,
            'retry-after': '5'
          })
          return
        }
        writeJson(
          response,
          {
            code: 'TELEGRAM_PROVISION_IN_PROGRESS',
            detail:
              'This project already has an unfinished Telegram bot connection.',
            operationId: OPERATION_ID,
            operationUrl: `${OPERATIONS_PATH}/${OPERATION_ID}`,
            status: 409,
            title: 'Telegram Provision In Progress',
            type: 'https://photon.codes/problems/telegram-provision-in-progress'
          },
          409
        )
      },
      [`GET ${OPERATIONS_PATH}/${OPERATION_ID}`]: (response) => {
        setupReads += 1
        writeJson(
          response,
          setupReads < 3
            ? { operation: setup('running') }
            : { operation: setup('succeeded'), resource: bot }
        )
      },
      [`GET ${OPERATIONS_PATH}`]: (response) => {
        writeJson(response, { operations: [setup('pending')] })
      },
      [`GET ${RESOURCES_PATH}`]: (response) => {
        writeJson(response, { resources: [bot] })
      },
      [`GET ${RESOURCES_PATH}/${bot.resourceId}`]: (response) => {
        writeJson(response, bot)
      },
      [`DELETE ${RESOURCES_PATH}/${bot.resourceId}`]: (response) => {
        writeJson(response, release, 202, { 'retry-after': '5' })
      }
    }
    let origin = ''
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', origin)
      const method = request.method ?? 'GET'
      captured.push({
        body: await readBody(request),
        headers: request.headers,
        method,
        pathname: url.pathname,
        search: url.search
      })
      const route = routes[`${method} ${url.pathname}`]
      if (route === undefined) {
        writeJson(response, { code: 'NOT_FOUND', status: 404 }, 404)
        return
      }
      route(response)
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
    const authenticated = await createAuthenticatedConfig('user_ada', origin)
    const clock = instantPollClock()
    const invoke = async (
      args: string[],
      json = true
    ): Promise<{ stderr: string; stdout: string }> => {
      const stdout = collector()
      const stderr = collector()
      await runCli(
        [
          'project',
          'platform',
          'telegram',
          ...args,
          '--project',
          'pho_prj_00000000000000000000000001',
          ...(json ? ['--json'] : [])
        ],
        {
          baseUrl: origin,
          browserLauncher: () => Promise.resolve(),
          clock,
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          stderr,
          stdout
        }
      )
      return { stderr: stderr.value(), stdout: stdout.value() }
    }
    const requestsTo = (method: string, pathname: string): CapturedRequest[] =>
      captured.filter(
        (request) => request.method === method && request.pathname === pathname
      )

    const started = await invoke([
      'connect',
      '--idempotency-key',
      'key-1',
      '--no-wait'
    ])
    expect(started.stderr).toBe('')
    expect(JSON.parse(started.stdout)).toEqual({
      operation: setup('pending')
    })
    const [connectRequest] = requestsTo('POST', BOTS_PATH)
    expect(connectRequest?.body).toBe('{}')
    expect(connectRequest?.headers['idempotency-key']).toBe('key-1')
    expect(connectRequest?.headers.authorization).toBe(
      'Bearer project-access-token'
    )

    // A second key is refused while the first setup is unfinished. The CLI
    // reads the setup the refusal names and waits for it.
    const continued = await invoke(
      ['connect', '--idempotency-key', 'key-2', '--no-browser'],
      false
    )
    expect(continued.stderr).toBe('')
    expect(continued.stdout).toContain(
      'Continuing the Telegram bot setup already in progress.'
    )
    expect(continued.stdout).toContain(SETUP_URL)
    expect(continued.stdout).toContain('Connected @AlexSupportBot.')
    expect(requestsTo('POST', BOTS_PATH)).toHaveLength(2)
    expect(clock.sleeps).toEqual([5000])

    // Diagnostics show the requests and responses. The setup link grants the
    // authority to connect a bot, so its token must not appear in them.
    const debugged = await invoke(['list', '--debug'])
    expect(debugged.stderr).toContain(OPERATIONS_PATH)
    expect(debugged.stderr).toContain('https://t.me/PhotonManagerBot')
    expect(debugged.stderr).not.toContain('setup_token')

    const listed = await invoke(['list'])
    expect(JSON.parse(listed.stdout)).toEqual({
      provisioning: [setup('pending')],
      resources: [bot]
    })
    expect(requestsTo('GET', RESOURCES_PATH).at(-1)?.search).toBe(
      '?ability=telegram&pageSize=30'
    )
    expect(
      new URLSearchParams(requestsTo('GET', OPERATIONS_PATH).at(-1)?.search)
    ).toEqual(
      new URLSearchParams({
        pageSize: '200',
        state: 'pending,running',
        type: 'resource.provision'
      })
    )

    const viewed = await invoke(['view', bot.resourceId])
    expect(JSON.parse(viewed.stdout)).toEqual(bot)

    const disconnected = await invoke(['disconnect', bot.resourceId, '--yes'])
    expect(disconnected.stderr).toBe('')
    expect(JSON.parse(disconnected.stdout)).toEqual({ operation: release })
    expect(
      requestsTo('DELETE', `${RESOURCES_PATH}/${bot.resourceId}`)
    ).toHaveLength(1)
    await authenticated.remove()
  })
})
