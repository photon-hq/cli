import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const projectId = 'pho_prj_00000000000000000000000001'
const RESOURCES = `/v1/projects/${projectId}/platforms/resources`
const servers: ReturnType<typeof createServer>[] = []

const sender = (index: number, state = 'active') => ({
  abilities: ['whatsapp_business'],
  createdAt: timestamp,
  detail: {
    account: { wabaId: '112233445566778' },
    displayName: `Sender ${index.toString()}`,
    displayNameStatus: 'APPROVED',
    phoneNumber: `+1415555010${index.toString()}`,
    phoneNumberId: `12345678901234${index.toString()}`,
    qualityRating: 'GREEN',
    qualityRatingObservedAt: timestamp
  },
  projectId,
  resourceId: `pho_res_01h455vb4pex5vsknk084sn0${index.toString()}a`,
  ...(state === 'active' ? {} : { retiredAt: timestamp }),
  state,
  type: 'whatsapp_sender',
  updatedAt: timestamp
})

// Three active senders and one retired, in the order Photon keeps them.
const SENDERS = [sender(1), sender(2, 'retired'), sender(3), sender(4)]

const writeJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

// A fake Photon that filters the project's resources by ability and state
// and pages what is left, as Photon's resource list does: `page-<offset>` is
// the token for the page that starts at offset. With `filtersState` false it
// ignores the state it is asked for.
const fakeApi = async ({ filtersState = true } = {}) => {
  const requests: URL[] = []
  let origin = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    requests.push(url)
    if (url.pathname !== RESOURCES) {
      writeJson(response, { code: 'NOT_FOUND' }, 404)
      return
    }
    const query = url.searchParams
    const ability = query.get('ability')
    const state = query.get('state')
    const matching = SENDERS.filter(
      (resource) =>
        (ability === null || resource.abilities.includes(ability)) &&
        (state === null || !filtersState || resource.state === state)
    )
    const token = query.get('pageToken')
    const start = token === null ? 0 : Number(token.slice('page-'.length))
    const end = start + Number(query.get('pageSize') ?? '20')
    writeJson(response, {
      resources: matching.slice(start, end),
      ...(end < matching.length
        ? { nextPageToken: `page-${end.toString()}` }
        : {})
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
  const authenticated = await createAuthenticatedConfig('user_ada', origin)
  return {
    requests,
    run: async (args: string[]) => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      await runCli(args, {
        baseUrl: origin,
        configDirectory: authenticated.configDirectory,
        now: () => TEST_NOW,
        platform: 'linux',
        setExitCode: (exitCode) => exitCodes.push(exitCode),
        stderr,
        stdout
      })
      return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
    }
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
  )
})

const NUMBER_LIST = [
  'project',
  'platform',
  'whatsapp-business',
  'number',
  'list',
  '--limit',
  '2',
  '--project',
  projectId
]

describe('whatsapp-business number list', () => {
  test('asks Photon for active senders only and prints its page as sent', async () => {
    const api = await fakeApi()

    const json = await api.run([...NUMBER_LIST, '--json'])
    expect(json.exitCodes, json.stderr).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual({
      nextPageToken: 'page-2',
      resources: [sender(1), sender(3)]
    })
    expect(json.stderr).toBe('')

    const text = await api.run(NUMBER_LIST)
    expect(text.exitCodes, text.stderr).toEqual([])
    expect(text.stdout).toContain(sender(1).detail.phoneNumber)
    expect(text.stdout).toContain(sender(3).detail.phoneNumber)
    expect(text.stdout).not.toContain(sender(2).detail.phoneNumber)
    expect(text.stderr).toContain(
      `More results: ${CLI_NAME} project platform whatsapp-business number list --limit 2 --project ${projectId} --page-token page-2\n`
    )

    expect(api.requests.map((url) => [url.pathname, url.search])).toEqual([
      [RESOURCES, '?ability=whatsapp_business&pageSize=2&state=active'],
      [RESOURCES, '?ability=whatsapp_business&pageSize=2&state=active']
    ])
  })

  test('fails as a protocol error when Photon lists a sender that is not active', async () => {
    const api = await fakeApi({ filtersState: false })

    const json = await api.run([...NUMBER_LIST, '--json'])
    expect(json.exitCodes).toEqual([1])
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_PROTOCOL_ERROR',
        detail: `Photon listed resource ${sender(2).resourceId}, which is not active, when asked for active senders only.`
      }
    })
  })
})
