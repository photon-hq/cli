import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createPhotonCommandServices } from '../src/app/services.ts'
import { AuthRepository } from '../src/auth/storage/repository.ts'
import { ProjectContextService } from '../src/project/context-service.ts'
import { ProjectFolderRepository } from '../src/project/folder-repository.ts'
import { createAuthenticatedConfig } from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const API_ORIGIN = 'https://api.example.test'
const PROJECT = {
  organizationId: 'pho_org_00000000000000000000000001',
  projectId: 'pho_prj_00000000000000000000000101'
}
const OTHER_PROJECT_ID = 'pho_prj_00000000000000000000000102'
const FLAG_PROJECT_ID = 'pho_prj_00000000000000000000000104'
const ENVIRONMENT_PROJECT_ID = 'pho_prj_00000000000000000000000105'

const temporaryFolders = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...temporaryFolders].map(
      async (folder) => await rm(folder, { force: true, recursive: true })
    )
  )
  temporaryFolders.clear()
})

const temporaryFolder = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'photon-folder-'))
  temporaryFolders.add(folder)
  return folder
}

const buildOrigin = async (build: 'production' | 'staging'): Promise<string> =>
  (
    JSON.parse(
      await readFile(
        new URL(`../config/cli.${build}.json`, import.meta.url),
        'utf8'
      )
    ) as { apiOrigin: string }
  ).apiOrigin

const contextService = async (
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; explicitProjectId?: string } = {}
): Promise<ProjectContextService> => {
  const authenticated = await createAuthenticatedConfig()
  return new ProjectContextService({
    authRepository: new AuthRepository({
      configDirectory: authenticated.configDirectory,
      platform: 'linux'
    }),
    env: options.env ?? {},
    ...(options.explicitProjectId === undefined
      ? {}
      : { explicitProjectId: options.explicitProjectId }),
    folder: new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd })
  })
}

describe('active project context', () => {
  test('maps an invalid API base URL to an argument error', () => {
    expect(() =>
      createPhotonCommandServices({
        baseUrl: 'not a URL',
        color: false,
        json: true
      })
    ).toThrow(
      expect.objectContaining({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
    )
  })

  test('reports missing authentication before a missing project selection', async () => {
    const configDirectory = await temporaryFolder()
    const service = new ProjectContextService({
      authRepository: new AuthRepository({
        configDirectory,
        platform: 'linux'
      }),
      env: {},
      folder: new ProjectFolderRepository({
        apiOrigin: API_ORIGIN,
        cwd: await temporaryFolder()
      })
    })

    await expect(service.resolve()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
      exitCode: 4
    })
  })

  test('signed in with no project, names --project and PHOTON_PROJECT_ID', async () => {
    const service = await contextService(await temporaryFolder())

    const error = await service.resolve().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'PROJECT_NOT_SELECTED', exitCode: 2 })
    expect((error as Error).message).toContain('--project')
    expect((error as Error).message).toContain('PHOTON_PROJECT_ID')
  })

  test('takes --project over PHOTON_PROJECT_ID and the folder file', async () => {
    const cwd = await temporaryFolder()
    await new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }).save(
      PROJECT
    )

    await expect(
      (
        await contextService(cwd, {
          env: { PHOTON_PROJECT_ID: ENVIRONMENT_PROJECT_ID },
          explicitProjectId: FLAG_PROJECT_ID
        })
      ).resolve()
    ).resolves.toEqual({ projectId: FLAG_PROJECT_ID, source: 'flag' })
    await expect(
      (
        await contextService(cwd, { explicitProjectId: FLAG_PROJECT_ID })
      ).resolve()
    ).resolves.toEqual({ projectId: FLAG_PROJECT_ID, source: 'flag' })
  })

  test('takes PHOTON_PROJECT_ID over the folder file, and ignores it when blank', async () => {
    const cwd = await temporaryFolder()
    await new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }).save(
      PROJECT
    )

    await expect(
      (
        await contextService(cwd, {
          env: { PHOTON_PROJECT_ID: ` ${ENVIRONMENT_PROJECT_ID} ` }
        })
      ).resolve()
    ).resolves.toEqual({
      projectId: ENVIRONMENT_PROJECT_ID,
      source: 'environment'
    })
    await expect(
      (
        await contextService(cwd, { env: { PHOTON_PROJECT_ID: '  ' } })
      ).resolve()
    ).resolves.toEqual({
      path: join(cwd, '.photon', 'project.json'),
      projectId: PROJECT.projectId,
      source: 'folder'
    })
  })

  test('no longer reads the per-account selection files', async () => {
    const authenticated = await createAuthenticatedConfig()
    const digest = createHash('sha256')
      .update(`${API_ORIGIN}\0user_ada`)
      .digest('hex')
    await mkdir(join(authenticated.configDirectory, 'project-contexts'))
    await writeFile(
      join(authenticated.configDirectory, 'project-contexts', `${digest}.json`),
      JSON.stringify({
        apiOrigin: API_ORIGIN,
        identityId: 'user_ada',
        projectId: PROJECT.projectId,
        schemaVersion: 1,
        selectedAt: '2026-07-31T18:00:00.000Z'
      })
    )
    const service = new ProjectContextService({
      authRepository: new AuthRepository({
        configDirectory: authenticated.configDirectory,
        platform: 'linux'
      }),
      env: {},
      folder: new ProjectFolderRepository({
        apiOrigin: API_ORIGIN,
        cwd: await temporaryFolder()
      })
    })

    await expect(service.resolveOptional()).resolves.toBeUndefined()
  })
})

describe('the folder file', () => {
  test('saves the project and its organization, and its subfolders use it', async () => {
    const cwd = await temporaryFolder()
    const subfolder = join(cwd, 'apps', 'web')
    await mkdir(subfolder, { recursive: true })
    const path = join(cwd, '.photon', 'project.json')

    await expect(
      new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }).save(PROJECT)
    ).resolves.toEqual({ ...PROJECT, path })

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      apiOrigin: API_ORIGIN,
      organizationId: PROJECT.organizationId,
      projectId: PROJECT.projectId,
      schemaVersion: 1
    })
    await expect(
      new ProjectFolderRepository({
        apiOrigin: API_ORIGIN,
        cwd: subfolder
      }).find()
    ).resolves.toEqual({ ...PROJECT, path })
  })

  test.each([
    ['no .gitignore', undefined, '.photon/\n'],
    [
      'one without a trailing newline',
      'node_modules',
      'node_modules\n.photon/\n'
    ],
    [
      'one that already lists .photon/',
      'dist/\n.photon/\n',
      'dist/\n.photon/\n'
    ],
    [
      'one with Windows line breaks that lists .photon/',
      'dist/\r\n.photon/\r\n',
      'dist/\r\n.photon/\r\n'
    ],
    ['one that lists /.photon', 'dist/\n/.photon\n', 'dist/\n/.photon\n']
  ])(
    "adds .photon/ to the folder's .gitignore once, with %s",
    async (_case, before, after) => {
      const cwd = await temporaryFolder()
      const gitignore = join(cwd, '.gitignore')
      if (before !== undefined) {
        await writeFile(gitignore, before)
      }
      const folder = new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd })

      await expect(folder.ignoreInGit()).resolves.toBe(before !== after)
      await expect(folder.ignoreInGit()).resolves.toBe(false)
      await expect(readFile(gitignore, 'utf8')).resolves.toBe(after)
    }
  )

  test.for([
    ['production', 'staging'],
    ['staging', 'production']
  ] as const)(
    'a file a %s build saved selects nothing in a %s build, and stays',
    async ([savedBy, readBy], { skip }) => {
      skip(!stagingTarget)
      const savedOrigin = await buildOrigin(savedBy)
      const readOrigin = await buildOrigin(readBy)
      expect(savedOrigin).not.toBe(readOrigin)
      const cwd = await temporaryFolder()
      await new ProjectFolderRepository({ apiOrigin: savedOrigin, cwd }).save(
        PROJECT
      )
      const other = new ProjectFolderRepository({ apiOrigin: readOrigin, cwd })

      await expect(other.find()).resolves.toBeUndefined()
      await expect(other.clear()).resolves.toBeUndefined()
      await expect(
        new ProjectFolderRepository({ apiOrigin: savedOrigin, cwd }).find()
      ).resolves.toMatchObject(PROJECT)
    }
  )

  test('the nearest of two files wins', async () => {
    const cwd = await temporaryFolder()
    const apps = join(cwd, 'apps')
    const web = join(apps, 'web')
    await mkdir(web, { recursive: true })
    await new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }).save(
      PROJECT
    )
    await new ProjectFolderRepository({
      apiOrigin: API_ORIGIN,
      cwd: apps
    }).save({ ...PROJECT, projectId: OTHER_PROJECT_ID })

    await expect(
      new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd: web }).find()
    ).resolves.toEqual({
      ...PROJECT,
      path: join(apps, '.photon', 'project.json'),
      projectId: OTHER_PROJECT_ID
    })
    await expect(
      new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd }).find()
    ).resolves.toEqual({
      ...PROJECT,
      path: join(cwd, '.photon', 'project.json')
    })
  })

  test('passes over a file another build saved, to the nearest one this build saved', async ({
    skip
  }) => {
    skip(!stagingTarget)
    const production = await buildOrigin('production')
    const staging = await buildOrigin('staging')
    const cwd = await temporaryFolder()
    const subfolder = join(cwd, 'apps')
    await mkdir(subfolder)
    await new ProjectFolderRepository({ apiOrigin: production, cwd }).save(
      PROJECT
    )
    await new ProjectFolderRepository({
      apiOrigin: staging,
      cwd: subfolder
    }).save({ ...PROJECT, projectId: OTHER_PROJECT_ID })
    const folder = new ProjectFolderRepository({
      apiOrigin: production,
      cwd: subfolder
    })
    const path = join(cwd, '.photon', 'project.json')

    await expect(folder.find()).resolves.toEqual({ ...PROJECT, path })
    await expect(folder.clear()).resolves.toBe(path)
    await expect(
      new ProjectFolderRepository({ apiOrigin: staging, cwd: subfolder }).find()
    ).resolves.toMatchObject({ projectId: OTHER_PROJECT_ID })
  })

  test('removes its temporary file when the save fails', async () => {
    const cwd = await temporaryFolder()
    const path = join(cwd, '.photon', 'project.json')
    await mkdir(path, { recursive: true })

    const error = await new ProjectFolderRepository({
      apiOrigin: API_ORIGIN,
      cwd
    })
      .save(PROJECT)
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'PROJECT_CONTEXT_UNAVAILABLE' })
    expect((error as Error).message).toContain(path)
    await expect(readdir(join(cwd, '.photon'))).resolves.toEqual([
      'project.json'
    ])
  })

  test('names a malformed file by its path, and clear removes it', async () => {
    const cwd = await temporaryFolder()
    const path = join(cwd, '.photon', 'project.json')
    await mkdir(join(cwd, '.photon'))
    await writeFile(path, '{not-json}\n')
    const folder = new ProjectFolderRepository({ apiOrigin: API_ORIGIN, cwd })

    const error = await folder.find().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'PROJECT_CONTEXT_CORRUPT' })
    expect((error as Error).message).toContain(path)
    await expect(folder.clear()).resolves.toBe(path)
    await expect(folder.find()).resolves.toBeUndefined()
  })

  test('removes the file on a project delete only when it names that project', async () => {
    const cwd = await temporaryFolder()
    const service = await contextService(cwd)
    await service.activate(PROJECT)

    await expect(service.clearIfActive(OTHER_PROJECT_ID)).resolves.toBe(false)
    await expect(service.resolve()).resolves.toMatchObject({
      projectId: PROJECT.projectId
    })
    await expect(service.clearIfActive(PROJECT.projectId)).resolves.toBe(true)
    await expect(service.resolve()).rejects.toMatchObject({
      code: 'PROJECT_NOT_SELECTED',
      exitCode: 2
    })
  })

  test('maps invalid values at the file boundary', async () => {
    const folder = new ProjectFolderRepository({
      apiOrigin: API_ORIGIN,
      cwd: await temporaryFolder()
    })

    const error = await folder
      .save({ ...PROJECT, projectId: 'project invalid' })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
    expect(
      (error as Error & { cause: { issues: { message: string }[] } }).cause
        .issues[0]?.message
    ).toBe('Project ID must be a canonical pho_prj_ identifier.')
  })
})
