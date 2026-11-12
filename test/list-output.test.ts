import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError } from '@photon-ai/api'
import { afterEach, describe, expect, test } from 'vitest'
import type { PhotonPluginOptions } from '../src/app/plugin.ts'
import { API_ORIGIN } from '../src/auth/constants.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { OperationRepository } from '../src/operation/repository.ts'
import {
  OPERATION_DEFINITIONS,
  type OperationIntent,
  requestFingerprint
} from '../src/operation/types.ts'
import type { OrganizationScope } from '../src/organization/service.ts'
import type { ProjectScope } from '../src/project/service.ts'
import type { VoiceScope } from '../src/project/voice-service.ts'
import {
  asOrganizationScope,
  asProjectScope,
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timestamp = '2026-07-31T18:00:00.000Z'
const NEXT = 'next-token'
const SOURCE_FILE = /\.ts$/u
const HAND_WRITTEN_PAGE_TOKEN = /(?<!\.)\bnextPageToken\b/u

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((done) => {
          server.close(() => done())
        })
    )
  )
})

interface Streams {
  exitCodes: number[]
  stderr: string
  stdout: string
}

const run = async (
  args: string[],
  options: PhotonPluginOptions = {}
): Promise<Streams> => {
  const authenticated =
    options.configDirectory === undefined
      ? await createAuthenticatedConfig()
      : undefined
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(args, {
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    organizationScope: asOrganizationScope(),
    platform: 'linux',
    projectScope: asProjectScope({}),
    ...(authenticated === undefined
      ? {}
      : { configDirectory: authenticated.configDirectory }),
    ...options,
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return await sourceFiles(path)
      }
      return SOURCE_FILE.test(entry.name) ? [path] : []
    })
  )
  return nested.flat()
}

const project = (projectId: string, name = projectId) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/avatar.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  createdByAccountId: 'account_owner',
  createdByActorId: 'account_owner',
  createdByActorKind: 'account',
  deletedAt: null,
  flags: [],
  name,
  organizationId: 'pho_org_00000000000000000000000001',
  projectId,
  slug: name.toLowerCase().replaceAll(' ', '-'),
  updatedAt: timestamp
})

const resource = (
  type: string,
  abilities: string[],
  detail: Record<string, unknown>
) => ({
  abilities,
  createdAt: timestamp,
  detail,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: `resource_${type}`,
  state: 'active',
  type,
  updatedAt: timestamp
})

const smsResource = resource('voip_line', ['sms', 'pstn_voice'], {
  phoneNumber: '+14155550125'
})
const emailResource = resource('email_domain', ['email'], {
  domain: 'example.test',
  healthy: true
})
const imessageResource = resource('cosmos_line', ['imessage', 'pstn_voice'], {
  healthy: true,
  phoneNumber: '+14155550126'
})
const telegramResource = resource('telegram_bot', ['telegram'], {
  displayName: 'Alex Support',
  url: 'https://t.me/AlexSupportBot',
  username: 'AlexSupportBot'
})
const whatsappResource = resource('whatsapp_sender', ['whatsapp_business'], {
  account: { wabaId: '112233445566778' },
  displayName: 'Acme Support',
  displayNameStatus: 'APPROVED',
  phoneNumber: '+14155550199',
  phoneNumberId: '123456789012345',
  qualityRating: 'GREEN',
  qualityRatingObservedAt: '2026-08-19T21:04:58.000Z',
  voipResourceId: 'pho_res_00000000000000000000000123'
})

const assignment = {
  assignedPhoneNumber: '+14155550124',
  assignmentId: 'pho_asg_00000000000000000000000001',
  createdAt: timestamp,
  email: 'user@example.test',
  firstName: 'Ada',
  handle: '+14155550123',
  lastName: 'Lovelace',
  platform: 'imessage',
  projectId: 'pho_prj_00000000000000000000000001',
  updatedAt: timestamp
}

const destination = {
  apiVersion: '2026-07-01',
  createdAt: timestamp,
  deletedAt: null,
  description: 'Production messages',
  destinationId: 'pho_whd_01h455vb4pex5vsknk084sn02q',
  enabledEvents: ['message.created'],
  name: 'Production hook',
  projectId: 'pho_prj_00000000000000000000000001',
  status: 'enabled',
  updatedAt: timestamp,
  url: 'https://hooks.example.test/deliver'
}

const voiceProfile = {
  configuration: {
    inbound: { credentials: null, destinationUri: 'sips:agent@example.test' },
    outbound: null
  },
  createdAt: timestamp,
  isDefault: false,
  lineCount: 0,
  mediaEncryption: 'auto',
  name: 'Production agent',
  profileId: 'pho_vpf_01h455vb4pex5vsknk084sn02q',
  projectId: 'pho_prj_00000000000000000000000001',
  protocol: 'sip',
  updatedAt: timestamp,
  version: 1
}

const notConnected = (): ApiError =>
  new ApiError('No connected account', {
    body: {
      code: 'WHATSAPP_WABA_NOT_CONNECTED',
      detail: 'No connected account'
    },
    headers: new Headers(),
    status: 404
  })

const resourceScope = (
  resources: unknown[],
  nextPageToken?: string
): ProjectScope =>
  asProjectScope({
    platforms: {
      listOperations: () => Promise.resolve({ operations: [] }),
      listResources: () =>
        Promise.resolve({
          resources,
          ...(nextPageToken === undefined ? {} : { nextPageToken })
        })
    }
  } as never)

const voiceScope = (profiles: unknown[], nextPageToken?: string) =>
  ({
    listVoiceProfiles: () =>
      Promise.resolve({
        profiles,
        ...(nextPageToken === undefined ? {} : { nextPageToken })
      })
  }) as unknown as VoiceScope

const projectListScope = (
  projects: unknown[],
  nextPageToken?: string
): OrganizationScope =>
  asOrganizationScope({
    projects: {
      list: () =>
        Promise.resolve({
          projects,
          ...(nextPageToken === undefined ? {} : { nextPageToken })
        })
    }
  } as never)

interface ListCase {
  args: string[]
  document: object
  message: string
  options: PhotonPluginOptions
}

const PROJECT = ['--project', 'pho_prj_00000000000000000000000001']

const emptyLists: [string, ListCase][] = [
  [
    'project webhook list',
    {
      args: ['project', 'webhook', 'list', ...PROJECT],
      document: { destinations: [] },
      message: 'No webhook destinations found.',
      options: {
        projectScope: asProjectScope({
          listWebhookDestinations: () => Promise.resolve({ destinations: [] })
        })
      }
    }
  ],
  [
    'project platform sms list',
    {
      args: ['project', 'platform', 'sms', 'list', ...PROJECT],
      document: { provisioning: [], resources: [] },
      message: 'No SMS resources found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform email list',
    {
      args: ['project', 'platform', 'email', 'list', ...PROJECT],
      document: { provisioning: [], resources: [] },
      message: 'No email domains found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform imessage list',
    {
      args: ['project', 'platform', 'imessage', 'list', ...PROJECT],
      document: { provisioning: [], resources: [] },
      message: 'No iMessage resources found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform voice list',
    {
      args: ['project', 'platform', 'voice', 'list', ...PROJECT],
      document: { resources: [] },
      message: 'No PSTN voice resources found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform telegram list',
    {
      args: ['project', 'platform', 'telegram', 'list', ...PROJECT],
      document: { provisioning: [], resources: [] },
      message: 'No Telegram bots found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform imessage assignment list',
    {
      args: [
        'project',
        'platform',
        'imessage',
        'assignment',
        'list',
        ...PROJECT
      ],
      document: { assignments: [] },
      message: 'No iMessage assignments found.',
      options: {
        projectScope: asProjectScope({
          platforms: {
            imessage: {
              assignments: {
                list: () => Promise.resolve({ assignments: [] })
              }
            }
          }
        } as never)
      }
    }
  ],
  [
    'project platform whatsapp-business account list',
    {
      args: [
        'project',
        'platform',
        'whatsapp-business',
        'account',
        'list',
        ...PROJECT
      ],
      document: { accounts: [] },
      message: 'No WhatsApp Business accounts found.',
      options: {
        projectScope: asProjectScope({
          platforms: {
            getWhatsappBusinessAccount: () => Promise.reject(notConnected())
          }
        })
      }
    }
  ],
  [
    'project platform whatsapp-business number list',
    {
      args: [
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'list',
        ...PROJECT
      ],
      document: { resources: [] },
      message: 'No active WhatsApp Business numbers found.',
      options: { projectScope: resourceScope([]) }
    }
  ],
  [
    'project platform voice profile list',
    {
      args: ['project', 'platform', 'voice', 'profile', 'list', ...PROJECT],
      document: { profiles: [] },
      message: 'No Voice profiles found.',
      options: { voiceScope: voiceScope([]) }
    }
  ],
  [
    'project platform list',
    {
      args: ['project', 'platform', 'list', ...PROJECT],
      document: { platforms: [] },
      message: 'No platforms found.',
      options: {
        projectScope: asProjectScope({
          platforms: {
            listProjectPlatforms: () => Promise.resolve({ platforms: [] })
          }
        } as never)
      }
    }
  ],
  [
    'project api-key list',
    {
      args: ['project', 'api-key', 'list', ...PROJECT],
      document: { apiKeys: [] },
      message: 'No live project API keys found.',
      options: {
        projectScope: asProjectScope({
          listProjectApiKeys: () => Promise.resolve({ apiKeys: [] })
        })
      }
    }
  ],
  [
    'project list',
    {
      args: ['project', 'list'],
      document: { projects: [] },
      message: 'No projects found.',
      options: { organizationScope: projectListScope([]) }
    }
  ],
  [
    'operation list',
    {
      args: ['operation', 'list'],
      document: { operations: [] },
      message: 'No unresolved operations found.',
      options: {}
    }
  ]
]

interface PagedCase {
  args: string[]
  next: string
  options: PhotonPluginOptions
}

const pagedLists: [string, PagedCase][] = [
  [
    'project list',
    {
      args: ['project', 'list', '--limit', '1'],
      next: 'project list --limit 1 --org pho_org_00000000000000000000000001',
      options: {
        organizationScope: projectListScope(
          [project('pho_prj_00000000000000000000000001')],
          NEXT
        )
      }
    }
  ],
  [
    'project webhook list',
    {
      args: ['project', 'webhook', 'list', '--limit', '1', ...PROJECT],
      next: 'project webhook list --limit 1 --project pho_prj_00000000000000000000000001',
      options: {
        projectScope: asProjectScope({
          listWebhookDestinations: () =>
            Promise.resolve({
              destinations: [destination],
              nextPageToken: NEXT
            })
        } as never)
      }
    }
  ],
  [
    'project platform sms list',
    {
      args: ['project', 'platform', 'sms', 'list', '--limit', '1', ...PROJECT],
      next: 'project platform sms list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([smsResource], NEXT) }
    }
  ],
  [
    'project platform email list',
    {
      args: [
        'project',
        'platform',
        'email',
        'list',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform email list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([emailResource], NEXT) }
    }
  ],
  [
    'project platform imessage list',
    {
      args: [
        'project',
        'platform',
        'imessage',
        'list',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform imessage list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([imessageResource], NEXT) }
    }
  ],
  [
    'project platform voice list',
    {
      args: [
        'project',
        'platform',
        'voice',
        'list',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform voice list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([imessageResource], NEXT) }
    }
  ],
  [
    'project platform telegram list',
    {
      args: [
        'project',
        'platform',
        'telegram',
        'list',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform telegram list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([telegramResource], NEXT) }
    }
  ],
  [
    'project platform imessage assignment list',
    {
      args: [
        'project',
        'platform',
        'imessage',
        'assignment',
        'list',
        '--include-released',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform imessage assignment list --include-released --limit 1 --project pho_prj_00000000000000000000000001',
      options: {
        projectScope: asProjectScope({
          platforms: {
            imessage: {
              assignments: {
                list: () =>
                  Promise.resolve({
                    assignments: [assignment],
                    nextPageToken: NEXT
                  })
              }
            }
          }
        } as never)
      }
    }
  ],
  [
    'project platform whatsapp-business number list',
    {
      args: [
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'list',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform whatsapp-business number list --limit 1 --project pho_prj_00000000000000000000000001',
      options: { projectScope: resourceScope([whatsappResource], NEXT) }
    }
  ],
  [
    'project platform voice profile list',
    {
      args: [
        'project',
        'platform',
        'voice',
        'profile',
        'list',
        '--additional',
        '--limit',
        '1',
        ...PROJECT
      ],
      next: 'project platform voice profile list --limit 1 --additional --project pho_prj_00000000000000000000000001',
      options: { voiceScope: voiceScope([voiceProfile], NEXT) }
    }
  ]
]

const storeOutcomeUnknownOperations = async (
  configDirectory: string,
  count: number
): Promise<void> => {
  const repository = new OperationRepository({
    apiOrigin: API_ORIGIN,
    authRepository: new AuthRepository({ configDirectory, platform: 'linux' }),
    now: () => TEST_NOW
  })
  const identity = await repository.identity()
  const intent: OperationIntent = {
    kind: 'project.update',
    name: 'Renamed',
    projectId: 'pho_prj_00000000000000000000000001'
  }
  for (let index = 0; index < count; index += 1) {
    const at = new Date(TEST_NOW + index * 1000).toISOString()
    // biome-ignore lint/performance/noAwaitInLoops: the journal takes one write at a time, as the CLI writes it.
    await repository.create({
      ...identity,
      attemptCount: 1,
      createdAt: at,
      expiresAt: new Date(TEST_NOW + 86_400_000).toISOString(),
      idempotencyKey: `key-${index.toString()}`,
      intent,
      operationId: `op_${randomUUID()}`,
      replayable: true,
      replayPolicy: OPERATION_DEFINITIONS[intent.kind].replayPolicy,
      requestFingerprint: requestFingerprint(intent),
      status: 'outcome-unknown',
      updatedAt: at
    })
  }
}

const writeJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const startProjectApi = async (): Promise<string> => {
  const projects = [
    ...Array.from({ length: 40 }, (_, index) =>
      project(
        `project_acme_${(index + 1).toString()}`,
        `Acme ${(index + 1).toString()}`
      )
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      project(
        `project_other_${(index + 1).toString()}`,
        `Other ${(index + 1).toString()}`
      )
    )
  ]
  let origin = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname === '/v1/organizations') {
      writeJson(response, {
        acquisitionQuestionnaireExempt: false,
        organizations: [
          {
            avatarUrl: null,
            createdAt: timestamp,
            name: 'Acme',
            organizationId: 'pho_org_00000000000000000000000001',
            updatedAt: timestamp,
            version: '1'
          }
        ],
        ownedOrganizationIds: ['pho_org_00000000000000000000000001']
      })
      return
    }
    if (
      url.pathname ===
      '/v1/organizations/pho_org_00000000000000000000000001/projects'
    ) {
      const query = url.searchParams.get('query') ?? ''
      const matching = projects.filter(({ name }) =>
        name.toLowerCase().includes(query.toLowerCase())
      )
      const offset = Number(url.searchParams.get('pageToken') ?? '0')
      const pageSize = Number(url.searchParams.get('pageSize'))
      const end = offset + pageSize
      writeJson(response, {
        projects: matching.slice(offset, end),
        ...(end < matching.length ? { nextPageToken: end.toString() } : {})
      })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 'NOT_FOUND' }))
  })
  servers.push(server)
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port.toString()}`
  return origin
}

describe('list output', () => {
  test('no list command adds nextPageToken to its output by hand', async () => {
    const files = (
      await Promise.all(
        [
          'src/commands',
          ...(stagingTarget ? ['src/internal/commands'] : []),
          'src/operation'
        ].map(async (directory) => await sourceFiles(join(root, directory)))
      )
    ).flat()
    const contents = await Promise.all(
      files.map(async (file) => ({
        file: relative(root, file),
        lines: (await readFile(file, 'utf8')).split('\n')
      }))
    )
    const handWritten = contents.flatMap(({ file, lines }) =>
      lines.flatMap((line, index) =>
        HAND_WRITTEN_PAGE_TOKEN.test(line)
          ? [`${file}:${(index + 1).toString()}: ${line.trim()}`]
          : []
      )
    )

    expect(files.length).toBeGreaterThan(0)
    expect(handWritten).toEqual([])
  })

  test.each(emptyLists)(
    '%s says its empty message on stderr and leaves stdout empty',
    async (_name, { args, document, message, options }) => {
      const text = await run(args, options)
      expect(text).toEqual({
        exitCodes: [],
        stderr: `${message}\n`,
        stdout: ''
      })

      const json = await run([...args, '--json'], options)
      expect(json.exitCodes).toEqual([])
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toEqual(document)
    }
  )

  test.each(pagedLists)(
    '%s ends with the next page command on stderr',
    async (_name, { args, next, options }) => {
      const text = await run(args, options)
      expect(text.exitCodes).toEqual([])
      expect(text.stdout).not.toBe('')
      expect(text.stdout).not.toContain('More results')
      expect(text.stderr).toBe(
        `More results: ${CLI_NAME} ${next} --page-token ${NEXT}\n`
      )

      const json = await run([...args, '--json'], options)
      expect(json.exitCodes).toEqual([])
      expect(json.stderr).toBe('')
      expect(JSON.parse(json.stdout)).toMatchObject({ nextPageToken: NEXT })
    }
  )

  test('operation list ends with the next page command, and that command lists the rest', async () => {
    const authenticated = await createAuthenticatedConfig()
    await storeOutcomeUnknownOperations(authenticated.configDirectory, 2)
    const options = { configDirectory: authenticated.configDirectory }
    const args = [
      'operation',
      'list',
      '--limit',
      '1',
      '--status',
      'outcome-unknown',
      '--status',
      'failed'
    ]

    const json = await run([...args, '--json'], options)
    const { nextPageToken, operations } = JSON.parse(json.stdout) as {
      nextPageToken: string
      operations: unknown[]
    }
    expect(operations).toHaveLength(1)
    expect(json.stderr).toBe('')

    const text = await run(args, options)
    const nextCommand = `${CLI_NAME} operation list --limit 1 --status outcome-unknown --status failed --page-token ${nextPageToken}`
    expect(text.stderr).toBe(`More results: ${nextCommand}\n`)

    const rest = await run(
      nextCommand.split(' ').slice(1).concat('--json'),
      options
    )
    expect(JSON.parse(rest.stdout)).toEqual({
      operations: [expect.objectContaining({ status: 'outcome-unknown' })]
    })
  })

  test('writes in the project from PHOTON_PROJECT_ID, replaces --page-token and keeps the other options', async () => {
    const result = await run(
      [
        'project',
        'webhook',
        'list',
        '--page-token',
        'old-token',
        '--limit',
        '1',
        '--no-color'
      ],
      {
        env: { PHOTON_PROJECT_ID: 'pho_prj_00000000000000000000000111' },
        projectScope: asProjectScope({
          listWebhookDestinations: () =>
            Promise.resolve({
              destinations: [destination],
              nextPageToken: NEXT
            })
        } as never)
      }
    )

    expect(result.stderr).toBe(
      `More results: ${CLI_NAME} project webhook list --no-color --limit 1 --project pho_prj_00000000000000000000000111 --page-token ${NEXT}\n`
    )
  })

  test('quotes an option value the shell would split', async () => {
    const result = await run(
      ['project', 'list', '--search', "Acme's line", '--limit', '1'],
      {
        organizationScope: projectListScope(
          [project('pho_prj_00000000000000000000000001')],
          NEXT
        )
      }
    )

    expect(result.stderr).toBe(
      `More results: ${CLI_NAME} project list --search 'Acme'\\''s line' --limit 1 --org pho_org_00000000000000000000000001 --page-token ${NEXT}\n`
    )
  })

  test('joins a value that starts with a dash to its option', async () => {
    const result = await run(
      ['project', 'list', '--search=-acme', '--limit', '1'],
      {
        organizationScope: projectListScope(
          [project('pho_prj_00000000000000000000000001')],
          NEXT
        )
      }
    )

    expect(result.stderr).toBe(
      `More results: ${CLI_NAME} project list --search=-acme --limit 1 --org pho_org_00000000000000000000000001 --page-token ${NEXT}\n`
    )
  })

  test('pages through 40 matching projects with the printed command', async () => {
    const origin = await startProjectApi()
    const authenticated = await createAuthenticatedConfig('user_ada', origin)
    const options: PhotonPluginOptions = {
      baseUrl: origin,
      configDirectory: authenticated.configDirectory,
      organizationScope: undefined as never,
      projectScope: undefined as never
    }

    const first = await run(['project', 'list', '--search', 'acme'], options)
    const firstRows = first.stdout.trimEnd().split('\n').slice(1)
    expect(firstRows).toHaveLength(30)
    expect(first.stdout).not.toContain('Other')
    const nextCommand = `${CLI_NAME} project list --search acme --org pho_org_00000000000000000000000001 --page-token 30`
    expect(first.stderr).toBe(`More results: ${nextCommand}\n`)

    const second = await run(nextCommand.split(' ').slice(1), options)
    const secondRows = second.stdout.trimEnd().split('\n').slice(1)
    expect(secondRows).toHaveLength(10)
    expect(secondRows[0]).toContain('Acme 31')
    expect(secondRows.at(-1)).toContain('Acme 40')
    expect(second.stderr).toBe('')
    expect(second.exitCodes).toEqual([])
  })
})
