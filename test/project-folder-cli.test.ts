import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { commandMetadata } from '../scripts/export-docs.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { CLI_ERROR_REFERENCE_URL } from '../src/core/output-basics.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'
import {
  collector,
  createAuthenticatedConfig,
  organizationFixture,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'
import { stagingTarget } from './target-support.ts'

const BASE_URL = 'https://api.example.test'
const PRODUCTION_URL = 'https://api.photon.codes'
const timestamp = '2026-07-31T18:00:00.000Z'
const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const OTHER_ORGANIZATION_ID = 'pho_org_00000000000000000000000002'
const PROJECT_A = 'pho_prj_00000000000000000000000001'
const PROJECT_B = 'pho_prj_00000000000000000000000002'
const CREATED_PROJECT = 'pho_prj_00000000000000000000000003'
const PROJECT_PATH_PATTERN = /^\/v1\/projects\/(pho_prj_[0-9a-z]+)$/u
const LINK_PROJECT_OPTION =
  /--project <project>\s+Project ID to save for this folder/u

const projectResource = (projectId: string) => ({
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
  name: `Project ${projectId.slice(-1)}`,
  organizationId: ORGANIZATION_ID,
  projectId,
  slug: `project-${projectId.slice(-1)}`,
  updatedAt: timestamp
})

interface Invocation {
  exitCodes: number[]
  requests: string[]
  stderr: string
  stdout: string
}

interface InvokeOptions {
  baseUrl?: string
  cwd: string
  env?: NodeJS.ProcessEnv
  // Answers a request the routes below don't, such as a project create.
  respond?: (route: string) => Response | undefined
}

// A fake Photon API: reads any project, and lists one organization.
const route = (method: string, pathname: string): Response | undefined => {
  const project = PROJECT_PATH_PATTERN.exec(pathname)?.[1]
  if (method === 'GET' && project !== undefined) {
    return Response.json(projectResource(project))
  }
  if (method === 'GET' && pathname === '/v1/organizations') {
    return Response.json({
      acquisitionQuestionnaireExempt: false,
      organizations: [organizationFixture()],
      ownedOrganizationIds: [ORGANIZATION_ID]
    })
  }
}

const invoker =
  (configDirectory: string) =>
  async (args: string[], options: InvokeOptions): Promise<Invocation> => {
    const requests: string[] = []
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []
    const fetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      requests.push(`${request.method} ${pathname}`)
      return Promise.resolve(
        options.respond?.(`${request.method} ${pathname}`) ??
          route(request.method, pathname) ??
          Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      )
    }
    await runCli(args, {
      baseUrl: options.baseUrl ?? BASE_URL,
      configDirectory,
      cwd: options.cwd,
      deviceScope: unusedDeviceScope(),
      env: options.env ?? {},
      fetch,
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })
    return {
      exitCodes,
      requests,
      stderr: stderr.value(),
      stdout: stdout.value()
    }
  }

const signedIn = async (baseUrl = BASE_URL) =>
  invoker(
    (await createAuthenticatedConfig('user_ada', baseUrl)).configDirectory
  )

const temporaryFolders = new Set<string>()

afterEach(async () => {
  vi.restoreAllMocks()
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

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false
  )

const folderFile = (folder: string): string =>
  join(folder, '.photon', 'project.json')

interface CommandNode {
  readonly subCommands?:
    | ReadonlyMap<string, CommandNode>
    | Readonly<Record<string, CommandNode>>
}

const leafCommands = (path: string[], command: CommandNode): string[][] => {
  const children =
    command.subCommands instanceof Map
      ? [...command.subCommands]
      : Object.entries(command.subCommands ?? {})
  return children.length === 0
    ? [path]
    : children.flatMap(([name, child]) => leafCommands([...path, name], child))
}

const help = async (args: string[]): Promise<string> => {
  const lines: string[] = []
  lines.push(await printed([...args, '--help', '--no-color']))
  return lines.join('\n')
}

describe('help', () => {
  test.each(
    Object.entries(photonCommands).flatMap(([name, command]) =>
      leafCommands([name], command as CommandNode)
        .map((path) => [path.join(' ')])
        .filter(([path]) => path !== 'link')
    )
  )('%s names --project and PHOTON_PROJECT_ID', async (command) => {
    const text = await help(command.split(' '))

    expect(text).toContain('--project <project>')
    expect(text).toContain('PHOTON_PROJECT_ID')
  })

  test('link names --project as the project it saves, which PHOTON_PROJECT_ID does not stand in for', async () => {
    const text = await help(['link'])

    expect(text).toMatch(LINK_PROJECT_OPTION)
    expect(text).not.toContain('PHOTON_PROJECT_ID')
  })
})

describe('the project each folder acts on', () => {
  test("two folders saved to different projects each act on their own, and a subfolder uses its parent's file", async () => {
    const invoke = await signedIn()
    const tree = await temporaryFolder()
    const first = join(tree, 'first')
    const second = join(tree, 'second')
    const subfolder = join(first, 'apps', 'web')
    await mkdir(subfolder, { recursive: true })
    await mkdir(second)

    await invoke(['link', '--project', PROJECT_A], { cwd: first })
    await invoke(['link', '--project', PROJECT_B], { cwd: second })
    const inFirst = await invoke(['project', 'view', '--json'], { cwd: first })
    const inSecond = await invoke(['project', 'view', '--json'], {
      cwd: second
    })
    const inSubfolder = await invoke(['project', 'view', '--json'], {
      cwd: subfolder
    })

    expect(inFirst.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
    expect(inSecond.requests).toEqual([`GET /v1/projects/${PROJECT_B}`])
    expect(inSubfolder.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
    expect(
      [inFirst, inSecond, inSubfolder].map(
        ({ stdout }) => (JSON.parse(stdout) as { projectId: string }).projectId
      )
    ).toEqual([PROJECT_A, PROJECT_B, PROJECT_A])
  })

  test('signed in with no project, a command that needs one exits 2 with PROJECT_NOT_SELECTED', async () => {
    const invoke = await signedIn()

    const result = await invoke(['project', 'view', '--json'], {
      cwd: await temporaryFolder()
    })

    expect(result.exitCodes).toEqual([2])
    expect(result.requests).toEqual([])
    const { error } = JSON.parse(result.stdout) as {
      error: { code: string; message: string }
    }
    expect(error.code).toBe('PROJECT_NOT_SELECTED')
    expect(error.message).toContain('--project')
    expect(error.message).toContain('PHOTON_PROJECT_ID')
  })

  test.each([
    ['no .gitignore', undefined, '.photon/\n'],
    [
      'a .gitignore without a trailing newline',
      'node_modules',
      'node_modules\n.photon/\n'
    ],
    [
      'a .gitignore that already lists .photon/',
      'dist/\n.photon/\n',
      'dist/\n.photon/\n'
    ]
  ])(
    'link saves the project and its organization, with %s, and unlink removes it',
    async (_case, before, after) => {
      const invoke = await signedIn()
      const cwd = await temporaryFolder()
      const gitignore = join(cwd, '.gitignore')
      if (before !== undefined) {
        await writeFile(gitignore, before)
      }

      const used = await invoke(['link', '--project', PROJECT_A], { cwd })
      const usedAgain = await invoke(
        ['link', '--project', PROJECT_A, '--json'],
        { cwd }
      )

      expect(used.exitCodes).toEqual([])
      expect(used.stderr).toBe('')
      expect(used.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
      expect(used.stdout).toBe(
        [
          `Linked this folder to project Project 1 (${PROJECT_A}).`,
          `Saved to ${folderFile(cwd)}.`,
          ...(before === after ? [] : ['Added .photon/ to .gitignore.']),
          ''
        ].join('\n')
      )
      expect(JSON.parse(await readFile(folderFile(cwd), 'utf8'))).toEqual({
        apiOrigin: BASE_URL,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_A,
        schemaVersion: 1
      })
      await expect(readFile(gitignore, 'utf8')).resolves.toBe(after)
      expect(JSON.parse(usedAgain.stdout)).toMatchObject({
        gitignore: 'listed',
        path: folderFile(cwd),
        project: { organizationId: ORGANIZATION_ID, projectId: PROJECT_A },
        source: 'folder'
      })

      const cleared = await invoke(['unlink', '--json'], { cwd })
      expect(cleared.stderr).toBe('')
      expect(JSON.parse(cleared.stdout)).toEqual({
        cleared: true,
        path: folderFile(cwd)
      })
      await expect(exists(join(cwd, '.photon'))).resolves.toBe(false)
      const again = await invoke(['unlink', '--json'], { cwd })
      expect(JSON.parse(again.stdout)).toEqual({ cleared: false })
    }
  )

  test.each([
    ['before', ['--project', PROJECT_A, 'link']],
    ['after', ['link', '--project', PROJECT_A]]
  ])('link takes --project %s the command name', async (_case, args) => {
    const invoke = await signedIn()
    const cwd = await temporaryFolder()

    const result = await invoke(args, { cwd })

    expect(result.exitCodes).toEqual([])
    expect(result.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
    expect(JSON.parse(await readFile(folderFile(cwd), 'utf8'))).toMatchObject({
      projectId: PROJECT_A
    })
  })

  test.each([
    ['with only PHOTON_PROJECT_ID set', ['link', '--json']],
    ['with the project as a positional argument', ['link', PROJECT_A, '--json']]
  ])(
    'link without --project, %s, exits 2 naming --project, and sends and saves nothing',
    async (_case, args) => {
      const invoke = await signedIn()
      const cwd = await temporaryFolder()

      const result = await invoke(args, {
        cwd,
        env: { PHOTON_PROJECT_ID: PROJECT_A }
      })

      expect(result.exitCodes).toEqual([2])
      expect(result.requests).toEqual([])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'ARGUMENT_VALIDATION',
          issues: [{ message: "Option '--project' is required" }]
        }
      })
      await expect(exists(join(cwd, '.photon'))).resolves.toBe(false)
    }
  )

  test('replaying a project create --link writes no folder file and prints the link step', async () => {
    const invoke = await signedIn()
    const cwd = await temporaryFolder()
    const create = [
      'project',
      'create',
      '--name',
      'Created',
      '--link',
      '--slug'
    ]
    const unavailable = (requested: string) =>
      requested.startsWith('POST ')
        ? Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 })
        : undefined

    const created = (requested: string) =>
      requested.startsWith('POST ')
        ? Response.json(projectResource(CREATED_PROJECT), { status: 201 })
        : undefined
    const failedOperation = async (slug: string): Promise<string> => {
      const failed = await invoke([...create, slug, '--json'], {
        cwd,
        respond: unavailable
      })
      expect(failed.exitCodes).toEqual([1])
      return (
        JSON.parse(failed.stdout) as {
          error: { operationId: string }
        }
      ).error.operationId
    }
    const step = `${CLI_NAME} link --project ${CREATED_PROJECT}`

    const replayedJson = await invoke(
      [
        'operation',
        'replay',
        await failedOperation('created-json'),
        '--yes',
        '--json'
      ],
      { cwd, respond: created }
    )
    const replayedText = await invoke(
      ['operation', 'replay', await failedOperation('created-text'), '--yes'],
      { cwd, respond: created }
    )

    expect(replayedJson.exitCodes).toEqual([])
    const replayed = JSON.parse(replayedJson.stdout)
    expect(replayed.result).toEqual({
      project: projectResource(CREATED_PROJECT)
    })
    expect(replayedJson.stderr).toContain(
      `Next: Save the project for this folder: ${step}\n`
    )
    expect(replayedText.stdout).toContain(
      `Next: Save the project for this folder: ${step}\n`
    )
    await expect(exists(join(cwd, '.photon'))).resolves.toBe(false)
  })

  test('a staging build ignores a file a production build saved', async ({
    skip
  }) => {
    skip(!stagingTarget)
    const production = await signedIn(PRODUCTION_URL)
    const staging = await signedIn(BUILD_CONFIG.apiOrigin)
    const cwd = await temporaryFolder()
    await production(['link', '--project', PROJECT_A], {
      baseUrl: PRODUCTION_URL,
      cwd
    })

    const fromProduction = await production(['project', 'view', '--json'], {
      baseUrl: PRODUCTION_URL,
      cwd
    })
    const fromStaging = await staging(['project', 'view', '--json'], {
      baseUrl: BUILD_CONFIG.apiOrigin,
      cwd
    })

    expect(fromProduction.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
    expect(fromStaging.exitCodes).toEqual([2])
    expect(fromStaging.requests).toEqual([])
    expect(JSON.parse(fromStaging.stdout)).toMatchObject({
      error: { code: 'PROJECT_NOT_SELECTED' }
    })
  })
})

describe('link with --org', () => {
  const renamed = `Warning: "${CLI_NAME} project use" is now "${CLI_NAME} link --project ${PROJECT_A}".\n`
  const commands = [
    ['link', ['link', '--project', PROJECT_A], ''],
    ['project use', ['project', 'use', PROJECT_A], renamed]
  ] as const
  const mismatch = `Project Project 1 (${PROJECT_A}) belongs to organization ${ORGANIZATION_ID}, not ${OTHER_ORGANIZATION_ID}.`

  test.each(commands)(
    "%s refuses an --org that isn't the project's organization, exits 2 with ORGANIZATION_MISMATCH, and writes nothing",
    async (_name, command, warning) => {
      const invoke = await signedIn()
      const linked = await temporaryFolder()
      const empty = await temporaryFolder()
      await invoke(['link', '--project', PROJECT_B], { cwd: linked })
      const saved = await readFile(folderFile(linked), 'utf8')
      const refused = [...command, '--org', OTHER_ORGANIZATION_ID]

      const json = await invoke([...refused, '--json'], { cwd: linked })
      const text = await invoke(refused, { cwd: empty })

      expect(json.exitCodes).toEqual([2])
      expect(json.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
      expect(json.stderr).toBe(warning)
      expect(JSON.parse(json.stdout)).toEqual({
        error: {
          code: 'ORGANIZATION_MISMATCH',
          docsUrl: CLI_ERROR_REFERENCE_URL,
          message: mismatch,
          next: [
            {
              description: 'Run it without --org',
              run: `${CLI_NAME} ${command.join(' ')} --json`
            },
            {
              description: "Run it with the project's organization",
              run: `${CLI_NAME} ${command.join(' ')} --json --org ${ORGANIZATION_ID}`
            }
          ],
          retryable: false
        }
      })
      await expect(readFile(folderFile(linked), 'utf8')).resolves.toBe(saved)

      expect(text.exitCodes).toEqual([2])
      expect(text.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
      expect(text.stdout).toBe('')
      expect(text.stderr).toBe(
        [
          `${warning}Error: ${mismatch} (ORGANIZATION_MISMATCH)`,
          'Next:',
          `  1. Run it without --org: ${CLI_NAME} ${command.join(' ')}`,
          `  2. Run it with the project's organization: ${CLI_NAME} ${command.join(' ')} --org ${ORGANIZATION_ID}`,
          `Docs: ${CLI_ERROR_REFERENCE_URL}`,
          ''
        ].join('\n')
      )
      await expect(exists(join(empty, '.photon'))).resolves.toBe(false)
      await expect(exists(join(empty, '.gitignore'))).resolves.toBe(false)
    }
  )

  test.each([
    [
      'before the command name',
      ['--org', OTHER_ORGANIZATION_ID, 'link', '--project', PROJECT_A]
    ],
    [
      'as --org=<id>',
      ['link', '--project', PROJECT_A, `--org=${OTHER_ORGANIZATION_ID}`]
    ],
    [
      'twice, the last naming another organization',
      [
        'link',
        '--org',
        ORGANIZATION_ID,
        '--project',
        PROJECT_A,
        '--org',
        OTHER_ORGANIZATION_ID
      ]
    ]
  ])(
    'link refuses --org given %s, and its steps leave every --org out',
    async (_case, args) => {
      const invoke = await signedIn()
      const cwd = await temporaryFolder()

      const result = await invoke([...args, '--json'], { cwd })

      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'ORGANIZATION_MISMATCH',
          next: [
            {
              description: 'Run it without --org',
              run: `${CLI_NAME} link --project ${PROJECT_A} --json`
            },
            {
              description: "Run it with the project's organization",
              run: `${CLI_NAME} link --project ${PROJECT_A} --json --org ${ORGANIZATION_ID}`
            }
          ]
        }
      })
      await expect(exists(join(cwd, '.photon'))).resolves.toBe(false)
    }
  )

  test.each(
    commands.flatMap(([name, command, warning]) => [
      [name, 'without --org', command, {}, warning],
      [
        name,
        "with --org naming the project's organization",
        [...command, '--org', ORGANIZATION_ID],
        {},
        warning
      ],
      [
        name,
        'with PHOTON_ORGANIZATION_ID naming another organization (only --org is checked)',
        command,
        { PHOTON_ORGANIZATION_ID: OTHER_ORGANIZATION_ID },
        warning
      ]
    ])
  )(
    '%s %s saves the project as it does today',
    async (_name, _case, args, env, warning) => {
      const invoke = await signedIn()
      const cwd = await temporaryFolder()

      const result = await invoke([...args], { cwd, env })

      expect(result.exitCodes).toEqual([])
      expect(result.requests).toEqual([`GET /v1/projects/${PROJECT_A}`])
      expect(result.stderr).toBe(warning)
      expect(result.stdout).toBe(
        [
          `Linked this folder to project Project 1 (${PROJECT_A}).`,
          `Saved to ${folderFile(cwd)}.`,
          'Added .photon/ to .gitignore.',
          ''
        ].join('\n')
      )
      expect(JSON.parse(await readFile(folderFile(cwd), 'utf8'))).toEqual({
        apiOrigin: BASE_URL,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_A,
        schemaVersion: 1
      })
    }
  )
})

describe('the old names', () => {
  const warning = (from: string, to: string): string =>
    `Warning: "${CLI_NAME} ${from}" is now "${CLI_NAME} ${to}".\n`

  test('project use and project clear still run as link and unlink, each warning with the new name first', async () => {
    const invoke = await signedIn()
    const cwd = await temporaryFolder()

    const used = await invoke(['project', 'use', PROJECT_A], { cwd })
    const linked = await invoke(['link', '--project', PROJECT_A], {
      cwd: await temporaryFolder()
    })

    expect(used.exitCodes).toEqual([])
    expect(used.stderr).toBe(
      warning('project use', `link --project ${PROJECT_A}`)
    )
    expect(used.requests).toEqual(linked.requests)
    expect(used.stdout).toBe(
      [
        `Linked this folder to project Project 1 (${PROJECT_A}).`,
        `Saved to ${folderFile(cwd)}.`,
        'Added .photon/ to .gitignore.',
        ''
      ].join('\n')
    )
    expect(JSON.parse(await readFile(folderFile(cwd), 'utf8'))).toMatchObject({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_A
    })

    const cleared = await invoke(['project', 'clear', '--json'], { cwd })

    expect(cleared.exitCodes).toEqual([])
    expect(cleared.stderr).toBe(warning('project clear', 'unlink'))
    expect(JSON.parse(cleared.stdout)).toEqual({
      cleared: true,
      path: folderFile(cwd)
    })
    await expect(exists(join(cwd, '.photon'))).resolves.toBe(false)
  })

  test('project create --use still saves the new project for the folder, warning with --link first', async () => {
    const invoke = await signedIn()
    const cwd = await temporaryFolder()
    const created = (requested: string) =>
      requested.startsWith('POST ')
        ? Response.json(projectResource(CREATED_PROJECT), { status: 201 })
        : undefined

    const result = await invoke(
      [
        'project',
        'create',
        '--name',
        'Created',
        '--slug',
        'created',
        '--use',
        '--json'
      ],
      { cwd, respond: created }
    )

    expect(result.exitCodes).toEqual([])
    expect(result.stderr).toBe(
      [
        warning('project create --use', 'project create --link'),
        `Organization: ${ORGANIZATION_ID}, from your only organization\n`
      ].join('')
    )
    expect(JSON.parse(result.stdout)).toMatchObject({
      path: folderFile(cwd),
      project: { projectId: CREATED_PROJECT },
      source: 'folder'
    })
    expect(JSON.parse(await readFile(folderFile(cwd), 'utf8'))).toMatchObject({
      projectId: CREATED_PROJECT
    })
  })

  test('the old names appear in neither help nor the command reference', async () => {
    const commandRows = (text: string): string[] => {
      const lines = text.split('\n')
      const start = lines.indexOf('COMMANDS:') + 1
      return lines
        .slice(start, lines.indexOf('', start))
        .map((row) => row.trim().split(' ')[0] ?? '')
    }
    const reference = await commandMetadata(photonCommands)
    const paths = reference.map(({ path }) => path.slice(1).join(' '))
    const createOptions =
      reference
        .find(({ path }) => path.slice(1).join(' ') === 'project create')
        ?.options.map(({ name }) => name) ?? []
    const projectRows = commandRows(await help(['project']))
    const createHelp = await help(['project', 'create'])

    expect(commandRows(await help([]))).toEqual(
      expect.arrayContaining(['link', 'unlink'])
    )
    expect(projectRows).toContain('current')
    expect(projectRows).not.toContain('use')
    expect(projectRows).not.toContain('clear')
    expect(createHelp).toContain('--link')
    expect(createHelp).not.toContain('--use')
    expect(paths).toEqual(expect.arrayContaining(['link', 'unlink']))
    expect(paths).not.toContain('project use')
    expect(paths).not.toContain('project clear')
    expect(createOptions).toContain('link')
    expect(createOptions).not.toContain('use')
  })
})
