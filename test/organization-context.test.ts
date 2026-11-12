import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { OrganizationContextRepository } from '../src/organization/context-repository.ts'
import {
  OrganizationContextService,
  type OrganizationContextSource
} from '../src/organization/context-service.ts'
import { ProjectFolderRepository } from '../src/project/folder-repository.ts'
import { createAuthenticatedConfig } from './project-test-support.ts'

const API_ORIGIN = 'https://api.example.test'
// Highest first.
const ORDER: OrganizationContextSource[] = [
  'flag',
  'environment',
  'folder',
  'stored',
  'default'
]
const ORGANIZATIONS: Record<OrganizationContextSource, string> = {
  default: 'pho_org_00000000000000000000000015',
  environment: 'pho_org_00000000000000000000000012',
  flag: 'pho_org_00000000000000000000000011',
  folder: 'pho_org_00000000000000000000000013',
  stored: 'pho_org_00000000000000000000000014'
}
const SECOND_ORGANIZATION = 'pho_org_00000000000000000000000016'

const temporaryFolders = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...temporaryFolders].map(
      async (folder) => await rm(folder, { force: true, recursive: true })
    )
  )
  temporaryFolders.clear()
})

// A service where only the given sources hold an organization.
const serviceWith = async (
  sources: readonly OrganizationContextSource[]
): Promise<OrganizationContextService> => {
  const has = (source: OrganizationContextSource): boolean =>
    sources.includes(source)
  const authenticated = await createAuthenticatedConfig()
  const cwd = await mkdtemp(join(tmpdir(), 'photon-folder-'))
  temporaryFolders.add(cwd)
  const folder = new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd })
  if (has('folder')) {
    await folder.save({
      organizationId: ORGANIZATIONS.folder,
      projectId: 'pho_prj_00000000000000000000000001'
    })
  }
  const service = new OrganizationContextService({
    authRepository: new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    }),
    env: has('environment')
      ? { PHOTON_ORGANIZATION_ID: ORGANIZATIONS.environment }
      : {},
    ...(has('flag') ? { explicitOrganizationId: ORGANIZATIONS.flag } : {}),
    folder,
    listOrganizationIds: () =>
      Promise.resolve(
        has('default')
          ? [ORGANIZATIONS.default]
          : [ORGANIZATIONS.default, SECOND_ORGANIZATION]
      ),
    repository: new OrganizationContextRepository({
      apiOrigin: API_ORIGIN,
      configDirectory: authenticated.configDirectory
    })
  })
  if (has('stored')) {
    await service.activate(ORGANIZATIONS.stored)
  }
  return service
}

describe('the organization a command acts on', () => {
  test.each(ORDER.map((source) => [source]))(
    'comes from %s alone',
    async (source) => {
      await expect(
        (await serviceWith([source])).resolve()
      ).resolves.toMatchObject({
        organizationId: ORGANIZATIONS[source],
        source
      })
    }
  )

  test.each(
    ORDER.flatMap((higher, index) =>
      ORDER.slice(index + 1).map((lower) => [higher, lower])
    )
  )('takes %s over %s', async (higher, lower) => {
    const service = await serviceWith([higher, lower])

    await expect(service.resolve()).resolves.toMatchObject({
      organizationId: ORGANIZATIONS[higher],
      source: higher
    })
  })

  test('ignores a blank PHOTON_ORGANIZATION_ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const cwd = await mkdtemp(join(tmpdir(), 'photon-folder-'))
    temporaryFolders.add(cwd)
    const service = new OrganizationContextService({
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      env: { PHOTON_ORGANIZATION_ID: '  ' },
      folder: new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }),
      listOrganizationIds: () => Promise.resolve([ORGANIZATIONS.default]),
      repository: new OrganizationContextRepository({
        apiOrigin: API_ORIGIN,
        configDirectory: authenticated.configDirectory
      })
    })

    await expect(service.resolve()).resolves.toMatchObject({
      source: 'default'
    })
  })
})
