import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { photonKey } from './key-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  organizationFixture,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const BASE_URL = 'https://api.example.test'
const timestamp = '2026-07-31T18:00:00.000Z'
const apiKeyId = photonKey('sk', '01h455vb4pex5vsknk084sn02q')
const signingSecret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

const project = {
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
  name: 'Support line',
  organizationId: 'pho_org_00000000000000000000000001',
  projectId: 'pho_prj_00000000000000000000000001',
  slug: 'support-line',
  updatedAt: timestamp
}

const destination = {
  apiVersion: '2026-07-01',
  createdAt: timestamp,
  deletedAt: null,
  description: null,
  destinationId: 'pho_whd_01h455vb4pex5vsknk084sn02q',
  enabledEvents: ['message.created'],
  name: 'Production hook',
  projectId: 'pho_prj_00000000000000000000000001',
  status: 'enabled',
  updatedAt: timestamp,
  url: 'https://hooks.example.test/deliver'
}

const invitation = (organizationId: string) => ({
  acceptedAt: null,
  acceptedByAccountId: null,
  allProjects: true,
  createdAt: timestamp,
  email: 'member@example.test',
  expiresAt: '2026-08-07T18:00:00.000Z',
  invitationId: 'pho_oinv_00000000000000000000000001',
  invitedByAccountId: 'account_owner',
  organizationId,
  role: 'member',
  status: 'pending',
  updatedAt: timestamp
})

// A fake Photon API: each route answers one fixed response.
const ROUTES: Record<string, { body: unknown; status?: number }> = {
  'DELETE /v1/projects/pho_prj_00000000000000000000000001': {
    body: { ...project, deletedAt: timestamp }
  },
  [`DELETE /v1/projects/pho_prj_00000000000000000000000001/api-keys/${apiKeyId}`]:
    {
      body: {
        apiKey: {
          apiKeyId,
          createdAt: timestamp,
          createdByAccountId: 'account_owner',
          expiresAt: null,
          name: 'Deploy key',
          permissions: ['project:read'],
          permissionsUpdatedAt: null,
          projectId: 'pho_prj_00000000000000000000000001',
          revokedAt: timestamp
        }
      }
    },
  'GET /v1/organizations': {
    body: {
      acquisitionQuestionnaireExempt: false,
      organizations: [organizationFixture()],
      ownedOrganizationIds: ['pho_org_00000000000000000000000001']
    }
  },
  'GET /v1/organizations/pho_org_00000000000000000000000002': {
    body: organizationFixture('pho_org_00000000000000000000000002', 'Beta')
  },
  'GET /v1/projects/pho_prj_00000000000000000000000001': { body: project },
  'POST /v1/organizations/pho_org_00000000000000000000000001/invitations': {
    body: invitation('pho_org_00000000000000000000000001'),
    status: 201
  },
  'POST /v1/organizations/pho_org_00000000000000000000000002/invitations': {
    body: invitation('pho_org_00000000000000000000000002'),
    status: 201
  },
  'POST /v1/projects/pho_prj_00000000000000000000000001/webhooks/destinations':
    {
      body: { destination, signingSecret },
      status: 201
    }
}

interface InvokeOptions {
  answer?: boolean
  env?: NodeJS.ProcessEnv
  stderrIsTerminal?: boolean
}

interface Invocation {
  // stderr writes, questions and requests, in the order they happened.
  events: string[]
  requests: string[]
  stderr: string
  stdout: string
}

const invoker =
  (configDirectory: string) =>
  async (args: string[], options: InvokeOptions = {}): Promise<Invocation> => {
    const events: string[] = []
    const stdout = collector()
    const stderr = collector(options.stderrIsTerminal)
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      const route = `${request.method} ${new URL(request.url).pathname}`
      events.push(`request ${route}`)
      const response = ROUTES[route]
      return Promise.resolve(
        response === undefined
          ? Response.json({ code: 'NOT_FOUND' }, { status: 404 })
          : Response.json(response.body, { status: response.status ?? 200 })
      )
    }
    await runCli(args, {
      baseUrl: BASE_URL,
      configDirectory,
      // Each test's own folder, where "link" saves .photon/project.json.
      cwd: configDirectory,
      ...(options.answer === undefined
        ? {}
        : {
            confirm: (message: string) => {
              events.push(`question ${message}`)
              return Promise.resolve(options.answer === true)
            }
          }),
      deviceScope: unusedDeviceScope(),
      env: options.env ?? {},
      fetch,
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (exitCode) => events.push(`exit ${exitCode.toString()}`),
      stderr: {
        ...stderr,
        write: (chunk) => {
          events.push(`stderr ${chunk}`)
          return stderr.write(chunk)
        }
      },
      stdout
    })
    return {
      events,
      requests: events.filter((event) => event.startsWith('request ')),
      stderr: stderr.value(),
      stdout: stdout.value()
    }
  }

const signedIn = async () => {
  const { configDirectory } = await createAuthenticatedConfig(
    'user_ada',
    BASE_URL
  )
  return { folder: configDirectory, invoke: invoker(configDirectory) }
}

const webhookCreate = [
  'project',
  'webhook',
  'create',
  '--name',
  'Production hook',
  '--url',
  'https://hooks.example.test/deliver',
  '--api-version',
  '2026-07-01',
  '--event',
  'message.created'
]
const createRequest =
  'request POST /v1/projects/pho_prj_00000000000000000000000001/webhooks/destinations'
const environment = { PHOTON_PROJECT_ID: 'pho_prj_00000000000000000000000001' }
const environmentLine =
  'Project: pho_prj_00000000000000000000000001, from PHOTON_PROJECT_ID\n'
const folderLine = (folder: string): string =>
  `Project: pho_prj_00000000000000000000000001, from ${join(folder, '.photon', 'project.json')}\n`

const lineBefore = (
  invocation: Invocation,
  line: string,
  event: string
): boolean => {
  const lineAt = invocation.events.indexOf(`stderr ${line}`)
  return lineAt !== -1 && lineAt < invocation.events.indexOf(event)
}

describe('the project and organization a command acts on', () => {
  test('names the project and its source before the first write request', async () => {
    const { folder, invoke } = await signedIn()

    const fromFlag = await invoke([
      ...webhookCreate,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    const fromEnvironment = await invoke(webhookCreate, { env: environment })
    await invoke(['link', '--project', 'pho_prj_00000000000000000000000001'])
    const fromFolder = await invoke(webhookCreate)

    expect(fromFlag.stderr).not.toContain('Project:')
    expect(fromFlag.requests).toEqual([createRequest])
    expect(fromEnvironment.stderr).toBe(`${environmentLine}${fromFlag.stderr}`)
    expect(lineBefore(fromEnvironment, environmentLine, createRequest)).toBe(
      true
    )
    expect(fromFolder.stderr).toBe(`${folderLine(folder)}${fromFlag.stderr}`)
    expect(lineBefore(fromFolder, folderLine(folder), createRequest)).toBe(true)
  })

  test('keeps --json stdout byte for byte what it is with --project', async () => {
    const { invoke } = await signedIn()

    const fromFlag = await invoke([
      ...webhookCreate,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--json'
    ])
    const fromEnvironment = await invoke([...webhookCreate, '--json'], {
      env: environment
    })

    expect(fromFlag.stdout).not.toBe('')
    expect(fromEnvironment.stdout).toBe(fromFlag.stdout)
    expect(fromEnvironment.stderr).toBe(`${environmentLine}${fromFlag.stderr}`)
  })

  test('prints the same line when stderr is not a terminal', async () => {
    const { invoke } = await signedIn()

    const fromFlag = await invoke([
      ...webhookCreate,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    const notTerminal = await invoke(webhookCreate, {
      env: environment,
      stderrIsTerminal: false
    })
    const terminal = await invoke(webhookCreate, {
      env: environment,
      stderrIsTerminal: true
    })

    expect(notTerminal.stderr).toBe(`${environmentLine}${fromFlag.stderr}`)
    expect(lineBefore(notTerminal, environmentLine, createRequest)).toBe(true)
    expect(terminal.stderr.startsWith(environmentLine)).toBe(true)
  })

  test('costs no request, and names a project the command already read', async () => {
    const { invoke } = await signedIn()

    const fromFlag = await invoke([
      ...webhookCreate,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    const fromEnvironment = await invoke(webhookCreate, { env: environment })
    await invoke(['link', '--project', 'pho_prj_00000000000000000000000001'])
    await invoke(['org', 'use', 'pho_org_00000000000000000000000002'])
    const fromFolder = await invoke(webhookCreate)
    expect(fromEnvironment.requests).toEqual(fromFlag.requests)
    expect(fromFolder.requests).toEqual(fromFlag.requests)

    // project delete names its project as an argument, so no line says where
    // the project came from.
    const deleted = await invoke([
      'project',
      'delete',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    expect(deleted.stderr).toBe('')
    expect(deleted.requests).toEqual([
      'request GET /v1/projects/pho_prj_00000000000000000000000001',
      'request DELETE /v1/projects/pho_prj_00000000000000000000000001'
    ])
  })

  test('names the project before a confirmation question, --project included', async () => {
    const { folder, invoke } = await signedIn()
    const revoke = ['project', 'api-key', 'revoke', apiKeyId]
    const question = `question Revoke API key ${apiKeyId} from project pho_prj_00000000000000000000000001?`
    const flagLine =
      'Project: pho_prj_00000000000000000000000001, from --project\n'

    const fromFlag = await invoke(
      [...revoke, '--project', 'pho_prj_00000000000000000000000001'],
      {
        answer: false
      }
    )
    const fromEnvironment = await invoke(revoke, {
      answer: false,
      env: environment
    })
    await invoke(['link', '--project', 'pho_prj_00000000000000000000000001'])
    const fromFolder = await invoke(revoke, { answer: false })

    for (const [result, line] of [
      [fromFlag, flagLine],
      [fromEnvironment, environmentLine],
      [fromFolder, folderLine(folder)]
    ] as const) {
      expect(result.stderr).toBe(`${line}Cancelled.\n`)
      expect(result.stdout).toBe('')
      expect(lineBefore(result, line, question)).toBe(true)
      expect(result.requests).toEqual([])
    }

    const revoked = await invoke(revoke, { answer: true, env: environment })
    expect(revoked.stderr).toBe(environmentLine)
    expect(lineBefore(revoked, environmentLine, question)).toBe(true)
    expect(revoked.requests).toEqual([
      `request DELETE /v1/projects/pho_prj_00000000000000000000000001/api-keys/${apiKeyId}`
    ])
  })

  test('names the organization and its source before the first organization write', async () => {
    const { invoke } = await signedIn()
    const memberInvite = [
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member'
    ]
    const onlyLine =
      'Organization: pho_org_00000000000000000000000001, from your only organization\n'
    const storedOrganizationLine = `Organization: pho_org_00000000000000000000000002, from the organization saved with ${CLI_NAME} org use\n`

    const fromFlag = await invoke([
      ...memberInvite,
      '--org',
      'pho_org_00000000000000000000000002'
    ])
    const fromOnly = await invoke(memberInvite)
    await invoke(['org', 'use', 'pho_org_00000000000000000000000002'])
    const fromStored = await invoke(memberInvite)

    expect(fromFlag.stderr).toBe('')
    expect(fromFlag.requests).toEqual([
      'request POST /v1/organizations/pho_org_00000000000000000000000002/invitations'
    ])
    expect(fromOnly.stderr).toBe(onlyLine)
    expect(
      lineBefore(
        fromOnly,
        onlyLine,
        'request POST /v1/organizations/pho_org_00000000000000000000000001/invitations'
      )
    ).toBe(true)
    expect(fromStored.stderr).toBe(storedOrganizationLine)
    expect(
      lineBefore(
        fromStored,
        storedOrganizationLine,
        'request POST /v1/organizations/pho_org_00000000000000000000000002/invitations'
      )
    ).toBe(true)
    expect(fromStored.requests).toEqual(fromFlag.requests)
  })

  test('names the folder file as the source of the organization, ahead of org use', async () => {
    const { folder, invoke } = await signedIn()
    const memberInvite = [
      'org',
      'member',
      'invite',
      '--email',
      'member@example.test',
      '--role',
      'member'
    ]
    const folderOrganizationLine = `Organization: pho_org_00000000000000000000000001, from ${join(folder, '.photon', 'project.json')}\n`

    await invoke(['link', '--project', 'pho_prj_00000000000000000000000001'])
    const used = await invoke([
      'org',
      'use',
      'pho_org_00000000000000000000000002'
    ])
    const fromFolder = await invoke(memberInvite)

    expect(used.stderr).toBe(
      `Warning: ${join(folder, '.photon', 'project.json')} still selects organization pho_org_00000000000000000000000001.\n`
    )
    expect(fromFolder.stderr).toBe(folderOrganizationLine)
    expect(fromFolder.requests).toEqual([
      'request POST /v1/organizations/pho_org_00000000000000000000000001/invitations'
    ])
  })
})
