import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  ONLY_ORGANIZATION_LINE,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const CREATED_PROJECT_ID = 'pho_prj_00000000000000000000000002'

const currentProject = (projectId: string) => ({
  agentProfile: {
    avatarUrl: 'https://images.example.test/avatar.png',
    firstName: 'Photon',
    lastName: null
  },
  createdAt: timestamp,
  deletedAt: null,
  flags: [],
  name: 'Alpha Project',
  organizationId: ORGANIZATION_ID,
  projectId,
  slug: 'alpha-project',
  updatedAt: timestamp
})

const earlierProject = (projectId: string) => ({
  ...currentProject(projectId),
  createdByAccountId: 'pho_acc_00000000000000000000000001',
  createdByActorId: 'pho_acc_00000000000000000000000001',
  createdByActorKind: 'account'
})

const servers: ReturnType<typeof createServer>[] = []

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

const startApi = async (project: (projectId: string) => object) => {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost')
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (pathname === '/v1/organizations') {
      reply(200, {
        acquisitionQuestionnaireExempt: false,
        organizations: [
          {
            avatarUrl: null,
            createdAt: timestamp,
            name: 'Acme',
            organizationId: ORGANIZATION_ID,
            updatedAt: timestamp,
            version: '1'
          }
        ],
        ownedOrganizationIds: [ORGANIZATION_ID]
      })
      return
    }
    if (pathname === `/v1/organizations/${ORGANIZATION_ID}/projects`) {
      if (request.method === 'POST') {
        reply(201, project(CREATED_PROJECT_ID))
        return
      }
      reply(200, { projects: [project(PROJECT_ID)] })
      return
    }
    if (pathname === `/v1/projects/${PROJECT_ID}`) {
      reply(200, project(PROJECT_ID))
      return
    }
    reply(404, { code: 'NOT_FOUND' })
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port.toString()}`
  const { configDirectory } = await createAuthenticatedConfig(
    'user_ada',
    origin
  )
  return async (args: string[]) => {
    const stdout = collector()
    const stderr = collector()
    const exitCodes: number[] = []
    await runCli([...args, '--json'], {
      baseUrl: origin,
      configDirectory,
      cwd: configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (code) => exitCodes.push(code),
      stderr,
      stdout
    })
    return {
      configDirectory,
      document: JSON.parse(stdout.value()) as Record<string, unknown>,
      exitCodes,
      stderr: stderr.value()
    }
  }
}

describe('a Project response', () => {
  test.each([
    { fields: 'without its creator fields', project: currentProject },
    { fields: 'with its creator fields', project: earlierProject }
  ])(
    '$fields passes the SDK validation of project list, view, create and link',
    async ({ project }) => {
      const invoke = await startApi(project)

      const listed = await invoke(['project', 'list'])
      expect(listed.exitCodes, JSON.stringify(listed.document)).toEqual([])
      expect(listed.document).toEqual({ projects: [project(PROJECT_ID)] })

      const viewed = await invoke(['project', 'view', '--project', PROJECT_ID])
      expect(viewed.exitCodes, JSON.stringify(viewed.document)).toEqual([])
      expect(viewed.document).toEqual(project(PROJECT_ID))

      const created = await invoke([
        'project',
        'create',
        '--slug',
        'alpha-project',
        '--name',
        'Alpha Project'
      ])
      expect(created.exitCodes, JSON.stringify(created.document)).toEqual([])
      expect(created.stderr).toBe(ONLY_ORGANIZATION_LINE)
      expect(created.document).toMatchObject({ projectId: CREATED_PROJECT_ID })

      const linked = await invoke(['link', '--project', PROJECT_ID])
      expect(linked.exitCodes, JSON.stringify(linked.document)).toEqual([])
      expect(linked.document).toMatchObject({
        path: join(linked.configDirectory, '.photon', 'project.json'),
        project: { projectId: PROJECT_ID },
        source: 'folder'
      })
      expect([listed, viewed, linked].map(({ stderr }) => stderr)).toEqual([
        '',
        '',
        ''
      ])
    }
  )
})
