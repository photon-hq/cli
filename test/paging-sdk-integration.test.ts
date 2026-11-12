import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const projectId = 'pho_prj_00000000000000000000000001'
const organizationId = 'pho_org_00000000000000000000000001'
const servers: ReturnType<typeof createServer>[] = []

const destination = (index: number) => ({
  apiVersion: '2026-07-01',
  createdAt: timestamp,
  deletedAt: null,
  description: null,
  destinationId: `pho_whd_01h455vb4pex5vsknk084s${index.toString().padStart(4, '0')}`,
  enabledEvents: ['message.created'],
  name: `Hook ${index.toString()}`,
  projectId,
  status: 'enabled',
  updatedAt: timestamp,
  url: `https://hooks.example.test/${index.toString()}`
})

const invoice = (index: number) => ({
  currency: 'USD',
  invoiceId: `invoice_${index.toString()}`,
  issuedAt: timestamp,
  kind: 'subscription',
  number: `INV-${index.toString()}`,
  paymentActionRequired: false,
  paymentDueAt: null,
  paymentOverdue: false,
  paymentStatus: 'paid',
  pdfUrl: null,
  status: 'finalized',
  subjects: [],
  totalCents: 1000
})

const connection = (index: number) => ({
  application: {
    applicationType: 'web',
    clientId: `client_${index.toString()}`,
    createdAt: timestamp,
    description: null,
    id: `connect_app_${index.toString()}`,
    isFirstParty: false,
    name: `App ${index.toString()}`,
    redirectUris: [{ default: true, uri: 'https://app.example.test/callback' }],
    scopes: ['account:read'],
    updatedAt: timestamp,
    usesPkce: true
  },
  authorizationId: `authorized_connect_app_${index.toString()}`,
  grantedScopes: ['account:read'],
  oauthResource: null
})

const writeJson = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

// One page of `total` items, as the API pages them: `<prefix><offset>` is the
// token for the page that starts at offset, or with `before`, for the page that
// ends there. With no page size the API's own default, 20, applies.
const page = (
  total: number,
  prefix: string,
  tokens: { after: string | null; before?: string | null },
  pageSize: string | null
) => {
  const size = pageSize === null ? 20 : Number(pageSize)
  const offset = (token: string) => Number(token.slice(prefix.length))
  const before = tokens.before ?? null
  let start = tokens.after === null ? 0 : offset(tokens.after)
  let end = Math.min(start + size, total)
  if (before !== null) {
    end = offset(before)
    start = Math.max(0, end - size)
  }
  return {
    indexes: Array.from({ length: end - start }, (_, index) => start + index),
    next: end < total ? `${prefix}${end.toString()}` : null,
    previous: start > 0 ? `${prefix}${start.toString()}` : null
  }
}

interface FakeApi {
  readonly requests: URL[]
  readonly run: (
    args: string[]
  ) => Promise<{ exitCodes: number[]; stderr: string; stdout: string }>
}

// A fake API that pages webhook destinations, invoices and OAuth connections
// the way Photon does, each list holding `total` items.
const fakeApi = async (total: number): Promise<FakeApi> => {
  const requests: URL[] = []
  let origin = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    requests.push(url)
    const query = url.searchParams
    if (url.pathname === `/v1/projects/${projectId}/webhooks/destinations`) {
      const { indexes, next } = page(
        total,
        'page-',
        { after: query.get('pageToken') },
        query.get('pageSize')
      )
      writeJson(response, {
        destinations: indexes.map(destination),
        ...(next === null ? {} : { nextPageToken: next })
      })
      return
    }
    if (url.pathname === `/v1/projects/${projectId}`) {
      writeJson(response, {
        agentProfile: {
          avatarUrl: 'https://images.example.test/avatar.png',
          firstName: 'Photon',
          lastName: null
        },
        createdAt: timestamp,
        createdByAccountId: 'user_ada',
        createdByActorId: 'user_ada',
        createdByActorKind: 'account',
        deletedAt: null,
        flags: [],
        name: 'Alpha',
        organizationId,
        projectId,
        slug: 'alpha',
        updatedAt: timestamp
      })
      return
    }
    if (
      url.pathname === `/v1/organizations/${organizationId}/billing/invoices`
    ) {
      const { indexes, next } = page(
        total,
        'invoice-cursor-',
        { after: query.get('cursor') },
        query.get('limit')
      )
      writeJson(response, { invoices: indexes.map(invoice), nextCursor: next })
      return
    }
    if (url.pathname === '/v1/account/oauth/authorized-applications') {
      const { indexes, next, previous } = page(
        total,
        'connect_cursor_',
        { after: query.get('after'), before: query.get('before') },
        query.get('limit')
      )
      writeJson(response, {
        authorizedApplications: indexes.map(connection),
        listMetadata: { after: next, before: previous }
      })
      return
    }
    writeJson(response, { code: 'NOT_FOUND' }, 404)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
  const authenticated = await createAuthenticatedConfig('user_ada', origin)
  return {
    requests,
    run: async (args) => {
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
  vi.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
  )
})

const WEBHOOK_LIST = ['project', 'webhook', 'list', '--project', projectId]
const INVOICE_LIST = [
  'project',
  'billing',
  'invoice',
  'list',
  '--project',
  projectId
]
const CONNECTION_LIST = ['account', 'oauth', 'connection', 'list']

describe('lists that page', () => {
  test('webhook list returns --limit items and the token for the rest', async () => {
    const api = await fakeApi(5)

    const first = await api.run([...WEBHOOK_LIST, '--limit', '2', '--json'])
    expect(first.exitCodes).toEqual([])
    expect(JSON.parse(first.stdout)).toEqual({
      destinations: [destination(0), destination(1)],
      nextPageToken: 'page-2'
    })
    expect(first.stderr).toBe('')

    const rest = await api.run([
      ...WEBHOOK_LIST,
      '--page-token',
      'page-2',
      '--json'
    ])
    expect(rest.exitCodes).toEqual([])
    expect(JSON.parse(rest.stdout)).toEqual({
      destinations: [2, 3, 4].map(destination)
    })
    expect(
      api.requests.map((url) => [
        url.searchParams.get('pageSize'),
        url.searchParams.get('pageToken')
      ])
    ).toEqual([
      ['2', null],
      ['30', 'page-2']
    ])
  })

  test('webhook list returns 30 items with no --limit, and says how to get the rest', async () => {
    const api = await fakeApi(45)

    const json = await api.run([...WEBHOOK_LIST, '--json'])
    const document = JSON.parse(json.stdout) as {
      destinations: unknown[]
      nextPageToken: string
    }
    expect(document.destinations).toHaveLength(30)
    expect(document.nextPageToken).toBe('page-30')

    const text = await api.run(WEBHOOK_LIST)
    expect(text.exitCodes).toEqual([])
    expect(text.stdout.trim().split('\n')).toHaveLength(31)
    expect(text.stderr).toContain(
      `More results: ${CLI_NAME} project webhook list --project ${projectId} --page-token page-30\n`
    )
  })

  test('an empty webhook list exits 0', async () => {
    const api = await fakeApi(0)

    const json = await api.run([...WEBHOOK_LIST, '--json'])
    expect(json).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: `${JSON.stringify({ destinations: [] })}\n`
    })
    const text = await api.run(WEBHOOK_LIST)
    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toBe('')
    expect(text.stderr).toContain('No webhook destinations found.\n')
  })

  test("invoice list takes --limit and --page-token, and keeps the API's nextCursor", async () => {
    const api = await fakeApi(5)

    const first = await api.run([...INVOICE_LIST, '--limit', '2', '--json'])
    expect(first.exitCodes, first.stdout).toEqual([])
    expect(JSON.parse(first.stdout)).toMatchObject({
      invoices: [{ invoiceId: 'invoice_0' }, { invoiceId: 'invoice_1' }],
      nextCursor: 'invoice-cursor-2'
    })
    expect(Object.keys(JSON.parse(first.stdout))).toEqual([
      'invoices',
      'nextCursor'
    ])

    const rest = await api.run([
      ...INVOICE_LIST,
      '--page-token',
      'invoice-cursor-2',
      '--json'
    ])
    expect(JSON.parse(rest.stdout)).toMatchObject({
      invoices: [
        { invoiceId: 'invoice_2' },
        { invoiceId: 'invoice_3' },
        { invoiceId: 'invoice_4' }
      ],
      nextCursor: null
    })

    const text = await api.run([...INVOICE_LIST, '--limit', '2'])
    expect(text.exitCodes).toEqual([])
    expect(text.stderr).toContain(
      `More results: ${CLI_NAME} project billing invoice list --limit 2 --project ${projectId} --page-token invoice-cursor-2\n`
    )

    expect(
      api.requests
        .filter((url) => url.pathname.endsWith('/billing/invoices'))
        .map((url) => [
          url.searchParams.get('limit'),
          url.searchParams.get('cursor')
        ])
    ).toEqual([
      ['2', null],
      ['30', 'invoice-cursor-2'],
      ['2', null]
    ])
  })

  test('invoice list returns 30 invoices with no --limit, and exits 0 when empty', async () => {
    const full = await fakeApi(45)
    const listed = JSON.parse(
      (await full.run([...INVOICE_LIST, '--json'])).stdout
    ) as { invoices: unknown[]; nextCursor: string }
    expect(listed.invoices).toHaveLength(30)
    expect(listed.nextCursor).toBe('invoice-cursor-30')

    const empty = await fakeApi(0)
    expect(await empty.run([...INVOICE_LIST, '--json'])).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: `${JSON.stringify({ invoices: [], nextCursor: null })}\n`
    })
  })

  test("OAuth connection list takes --limit and --page-token, and keeps the API's listMetadata", async () => {
    const api = await fakeApi(5)

    const first = await api.run([...CONNECTION_LIST, '--limit', '2', '--json'])
    expect(first.exitCodes).toEqual([])
    expect(JSON.parse(first.stdout)).toMatchObject({
      authorizedApplications: [
        { application: { id: 'connect_app_0' } },
        { application: { id: 'connect_app_1' } }
      ],
      listMetadata: { after: 'connect_cursor_2', before: null }
    })
    expect(Object.keys(JSON.parse(first.stdout))).toEqual([
      'authorizedApplications',
      'listMetadata'
    ])

    const rest = await api.run([
      ...CONNECTION_LIST,
      '--page-token',
      'connect_cursor_2',
      '--json'
    ])
    expect(JSON.parse(rest.stdout)).toMatchObject({
      authorizedApplications: [
        { application: { id: 'connect_app_2' } },
        { application: { id: 'connect_app_3' } },
        { application: { id: 'connect_app_4' } }
      ],
      listMetadata: { after: null, before: 'connect_cursor_2' }
    })

    const text = await api.run([...CONNECTION_LIST, '--limit', '2'])
    expect(text.exitCodes).toEqual([])
    expect(text.stderr).toBe(
      `More results: ${CLI_NAME} account oauth connection list --limit 2 --page-token connect_cursor_2\n`
    )

    const back = await api.run([
      ...CONNECTION_LIST,
      '--before',
      'connect_cursor_4',
      '--limit',
      '2',
      '--json'
    ])
    expect(JSON.parse(back.stdout)).toMatchObject({
      authorizedApplications: [
        { application: { id: 'connect_app_2' } },
        { application: { id: 'connect_app_3' } }
      ],
      listMetadata: { after: 'connect_cursor_4', before: 'connect_cursor_2' }
    })
    const backText = await api.run([
      ...CONNECTION_LIST,
      '--before',
      'connect_cursor_4',
      '--limit',
      '2'
    ])
    expect(backText.exitCodes).toEqual([])
    expect(backText.stderr).toBe('')

    const all = await api.run([...CONNECTION_LIST, '--json'])
    expect(JSON.parse(all.stdout)).toMatchObject({
      listMetadata: { after: null }
    })
    expect(
      api.requests.map((url) => [
        url.searchParams.get('limit'),
        url.searchParams.get('after'),
        url.searchParams.get('before')
      ])
    ).toEqual([
      ['2', null, null],
      ['30', 'connect_cursor_2', null],
      ['2', null, null],
      ['2', null, 'connect_cursor_4'],
      ['2', null, 'connect_cursor_4'],
      ['30', null, null]
    ])
  })

  test('OAuth connection list still takes --after, warning with --page-token first', async () => {
    const api = await fakeApi(5)

    const json = await api.run([
      ...CONNECTION_LIST,
      '--after',
      'connect_cursor_2',
      '--limit',
      '2',
      '--json'
    ])
    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toMatchObject({
      authorizedApplications: [
        { application: { id: 'connect_app_2' } },
        { application: { id: 'connect_app_3' } }
      ],
      listMetadata: { after: 'connect_cursor_4' }
    })
    expect(json.stderr).toBe(
      `Warning: "${CLI_NAME} account oauth connection list --after" is now "${CLI_NAME} account oauth connection list --page-token".\n`
    )

    const text = await api.run([
      ...CONNECTION_LIST,
      '--after',
      'connect_cursor_2',
      '--limit',
      '2'
    ])
    expect(text.stderr).toContain(
      `More results: ${CLI_NAME} account oauth connection list --limit 2 --page-token connect_cursor_4\n`
    )
    expect(api.requests.map((url) => url.searchParams.get('after'))).toEqual([
      'connect_cursor_2',
      'connect_cursor_2'
    ])

    const help: string[] = []
    help.push(await printed([...CONNECTION_LIST, '--help', '--no-color']))
    expect(help.join('\n')).toContain('--page-token')
    expect(help.join('\n')).not.toContain('--after')
  })

  test('OAuth connection list takes one of --page-token, --before and --after', async () => {
    const api = await fakeApi(5)
    for (const options of [
      ['--page-token', 'connect_cursor_2', '--before', 'connect_cursor_4'],
      ['--after', 'connect_cursor_2', '--before', 'connect_cursor_4'],
      ['--after', 'connect_cursor_2', '--page-token', 'connect_cursor_2']
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each run is checked on its own.
      const result = await api.run([...CONNECTION_LIST, ...options, '--json'])
      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
    }
    expect(api.requests).toEqual([])
  })

  test('OAuth connection list returns 30 connections with no --limit, and exits 0 when empty', async () => {
    const full = await fakeApi(45)
    const listed = JSON.parse(
      (await full.run([...CONNECTION_LIST, '--json'])).stdout
    ) as { authorizedApplications: unknown[]; listMetadata: { after: string } }
    expect(listed.authorizedApplications).toHaveLength(30)
    expect(listed.listMetadata.after).toBe('connect_cursor_30')

    const empty = await fakeApi(0)
    expect(await empty.run([...CONNECTION_LIST, '--json'])).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: `${JSON.stringify({ authorizedApplications: [], listMetadata: { after: null, before: null } })}\n`
    })
  })
})
