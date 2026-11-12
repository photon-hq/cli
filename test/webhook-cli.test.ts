import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ApiError,
  type GetWebhookDestinationOutput,
  ResponseValidationError
} from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import type { ProjectScope } from '../src/project/service.ts'
import { printed } from './help-support.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  lateFailingInvoker,
  lateFailingStdout,
  stderrError,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const destinationId = 'pho_whd_01h455vb4pex5vsknk084sn02q'
const signingSecret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const rotatedSigningSecret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`

const webhookDestination = (
  overrides: Partial<GetWebhookDestinationOutput> = {}
): GetWebhookDestinationOutput => ({
  apiVersion: '2026-07-01',
  createdAt: timestamp,
  deletedAt: null,
  description: 'Production messages',
  destinationId,
  enabledEvents: ['message.created'],
  futureField: 'from-a-newer-api',
  name: 'Production hook',
  projectId: 'pho_prj_00000000000000000000000001',
  status: 'enabled',
  updatedAt: timestamp,
  url: 'https://hooks.example.test/deliver',
  ...overrides
})

const webhookScope = () => {
  const listWebhookDestinations = vi.fn<
    ProjectScope['listWebhookDestinations']
  >(() => Promise.resolve({ destinations: [webhookDestination()] }))
  const getWebhookDestination = vi.fn<ProjectScope['getWebhookDestination']>(
    () => Promise.resolve(webhookDestination())
  )
  const createWebhookDestination = vi.fn<
    ProjectScope['createWebhookDestination']
  >((input) =>
    Promise.resolve({
      destination: webhookDestination({
        apiVersion: input.body.apiVersion,
        description: input.body.description ?? null,
        enabledEvents: input.body.enabledEvents,
        name: input.body.name,
        status: input.body.status ?? 'enabled',
        url: input.body.url
      }),
      signingSecret
    })
  )
  const updateWebhookDestination = vi.fn<
    ProjectScope['updateWebhookDestination']
  >((input) =>
    Promise.resolve(
      webhookDestination({
        description:
          input.body.description === undefined
            ? 'Production messages'
            : input.body.description,
        enabledEvents: input.body.enabledEvents ?? ['message.created'],
        name: input.body.name ?? 'Production hook',
        status: input.body.status ?? 'enabled',
        url: input.body.url ?? 'https://hooks.example.test/deliver'
      })
    )
  )
  const deleteWebhookDestination = vi.fn<
    ProjectScope['deleteWebhookDestination']
  >(() => Promise.resolve(webhookDestination({ deletedAt: timestamp })))
  const rotateWebhookSigningSecret = vi.fn<
    ProjectScope['rotateWebhookSigningSecret']
  >(() =>
    Promise.resolve({
      previousSecretExpiresAt: '2026-08-01T18:00:00.000Z',
      signingSecret: rotatedSigningSecret
    })
  )
  const listWebhookApiVersions = vi.fn<ProjectScope['listWebhookApiVersions']>(
    () =>
      Promise.resolve({
        apiVersions: [
          {
            futureField: 'from-a-newer-api',
            retirement: null,
            selectable: true,
            status: 'latest',
            successor: null,
            version: '2026-07-01'
          }
        ],
        contractNamespace: '@photon-hq/contracts',
        packageVersion: '1.0.0'
      })
  )
  const listWebhookEventTypes = vi.fn<ProjectScope['listWebhookEventTypes']>(
    () =>
      Promise.resolve({
        apiVersion: '2026-07-01',
        contractNamespace: '@photon-hq/contracts',
        events: [
          {
            audience: 'agent',
            description: 'A message was created.',
            futureField: 'from-a-newer-api',
            schemaProfile: 'reader',
            schemaUrl: 'https://schemas.example.test/message-created.json',
            type: 'message.created'
          }
        ],
        packageVersion: '1.0.0',
        retirement: null,
        selectable: true,
        status: 'latest',
        successor: null
      })
  )
  return {
    scope: asProjectScope({
      createWebhookDestination,
      deleteWebhookDestination,
      getWebhookDestination,
      listWebhookApiVersions,
      listWebhookDestinations,
      listWebhookEventTypes,
      rotateWebhookSigningSecret,
      updateWebhookDestination
    }),
    spies: {
      createWebhookDestination,
      deleteWebhookDestination,
      getWebhookDestination,
      listWebhookApiVersions,
      listWebhookDestinations,
      listWebhookEventTypes,
      rotateWebhookSigningSecret,
      updateWebhookDestination
    }
  }
}

const webhookNotFound = (): ApiError =>
  new ApiError('webhook destination not found', {
    body: {
      code: 'WEBHOOK_DESTINATION_NOT_FOUND',
      detail: 'Webhook destination not found.'
    },
    headers: new Headers(),
    operationId: 'deleteWebhookDestination',
    status: 404
  })

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('project webhook CLI', () => {
  test('registers the command tree and renders documented human list columns', async () => {
    const helpLines: string[] = []
    helpLines.push(await printed(['project', 'webhook', '--help']))
    const help = helpLines.join('\n')
    expect(help).toContain('api-version')
    expect(help).toContain('event-type')
    expect(help).toContain('rotate-secret')

    const authenticated = await createAuthenticatedConfig()
    const { scope } = webhookScope()
    const stdout = collector()
    const stderr = collector()
    await runCli(
      [
        'project',
        'webhook',
        'list',
        '--project',
        'pho_prj_00000000000000000000000001'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        stderr,
        stdout
      }
    )
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toContain('NAME')
    expect(stdout.value()).toContain('DESTINATION ID')
    expect(stdout.value()).toContain('STATUS')
    expect(stdout.value()).toContain('API VERSION')
    expect(stdout.value()).toContain('URL')
    expect(stdout.value()).toContain('UPDATED')
    expect(stdout.value()).not.toContain(signingSecret)
  })

  test("lists, views, and inspects catalogs as the API's responses", async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const listed = await invoke([
      'project',
      'webhook',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(listed.stdout)).toEqual({
      destinations: [webhookDestination()]
    })
    expect(listed.stdout).not.toContain(signingSecret)
    expect(spies.listWebhookDestinations).toHaveBeenCalledWith(
      {
        path: { projectId: 'pho_prj_00000000000000000000000001' },
        query: { pageSize: 30 }
      },
      undefined
    )

    const viewed = await invoke([
      'project',
      'webhook',
      'view',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(viewed.stdout)).toEqual(webhookDestination())
    expect(spies.getWebhookDestination).toHaveBeenCalledWith(
      {
        path: { destinationId, projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )

    const versions = await invoke([
      'project',
      'webhook',
      'api-version',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(versions.stdout)).toEqual({
      apiVersions: [
        {
          futureField: 'from-a-newer-api',
          retirement: null,
          selectable: true,
          status: 'latest',
          successor: null,
          version: '2026-07-01'
        }
      ],
      contractNamespace: '@photon-hq/contracts',
      packageVersion: '1.0.0'
    })

    const events = await invoke([
      'project',
      'webhook',
      'event-type',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--api-version',
      '2026-07-01'
    ])
    expect(JSON.parse(events.stdout)).toEqual({
      apiVersion: '2026-07-01',
      contractNamespace: '@photon-hq/contracts',
      events: [
        {
          audience: 'agent',
          description: 'A message was created.',
          futureField: 'from-a-newer-api',
          schemaProfile: 'reader',
          schemaUrl: 'https://schemas.example.test/message-created.json',
          type: 'message.created'
        }
      ],
      packageVersion: '1.0.0',
      retirement: null,
      selectable: true,
      status: 'latest',
      successor: null
    })
    expect(spies.listWebhookEventTypes).toHaveBeenCalledWith(
      {
        path: { projectId: 'pho_prj_00000000000000000000000001' },
        query: { apiVersion: '2026-07-01' }
      },
      undefined
    )
  })

  test('creates a destination with normalized events and one-time output acknowledgement', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const result = await invoke([
      'project',
      'webhook',
      'create',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      ' Production hook ',
      '--url',
      'https://hooks.example.test/deliver',
      '--api-version',
      '2026-07-01',
      '--description',
      ' Production messages ',
      '--event',
      'message.updated',
      '--event',
      'message.created',
      '--idempotency-key',
      'webhook-create'
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      destination: {
        apiVersion: '2026-07-01',
        createdAt: timestamp,
        deletedAt: null,
        description: 'Production messages',
        destinationId,
        enabledEvents: ['message.created', 'message.updated'],
        futureField: 'from-a-newer-api',
        name: 'Production hook',
        projectId: 'pho_prj_00000000000000000000000001',
        status: 'enabled',
        updatedAt: timestamp,
        url: 'https://hooks.example.test/deliver'
      },
      signingSecret
    })
    expect(result.stderr).toContain('cannot be retrieved again')
    expect(result.stderr).not.toContain(signingSecret)
    expect(spies.createWebhookDestination).toHaveBeenCalledWith(
      {
        body: {
          apiVersion: '2026-07-01',
          description: 'Production messages',
          enabledEvents: ['message.created', 'message.updated'],
          name: 'Production hook',
          status: 'enabled',
          url: 'https://hooks.example.test/deliver'
        },
        headers: { idempotencyKey: 'webhook-create' },
        path: { projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('rejects an unsafe signing secret without exposing it in diagnostics or storage', async () => {
    const authenticated = await createAuthenticatedConfig()
    const unsafeSecret = 'whsec_private-marker!not-base64'
    const createWebhookDestination = vi.fn<
      ProjectScope['createWebhookDestination']
    >(() =>
      Promise.resolve({
        destination: webhookDestination(),
        signingSecret: unsafeSecret
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ createWebhookDestination })
    )

    const result = await invoke([
      'project',
      'webhook',
      'create',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Unsafe response',
      '--url',
      'https://hooks.example.test/unsafe',
      '--api-version',
      '2026-07-01',
      '--all-events',
      '--debug'
    ])
    expect(result.stderr).toBe('')
    expect(result.stderr).not.toContain(unsafeSecret)
    expect(result.stdout).not.toContain(unsafeSecret)
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_PROTOCOL_ERROR',
        replayable: true
      }
    })
    const pending = JSON.parse(
      (await invoke(['operation', 'list'])).stdout
    ) as { operations: Array<{ operationId: string }> }
    const operationId = pending.operations.at(0)?.operationId
    expect(operationId).toBeDefined()
    if (operationId === undefined) {
      throw new Error('unsafe-secret operation fixture is missing')
    }
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    const stored = await readFile(
      join(operationsRoot, scopeName ?? '', `${operationId}.json`),
      'utf8'
    )
    expect(stored).not.toContain(unsafeSecret)
  })

  test('validates webhook URLs, event selections, edits, and overlap bounds before mutation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)
    const createPrefix = [
      'project',
      'webhook',
      'create',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Invalid hook',
      '--api-version',
      '2026-07-01',
      '--event',
      'message.created'
    ]

    const invalidUrls = await Promise.all(
      [
        'http://hooks.example.test/deliver',
        'https://user:password@hooks.example.test/deliver',
        'https://hooks.example.test/deliver#private'
      ].map(async (url) => await invoke([...createPrefix, '--url', url]))
    )
    for (const invalid of invalidUrls) {
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        error: { code: 'ARGUMENT_VALIDATION' }
      })
      expect(invalid.exitCodes).toEqual([2])
    }

    const invalidDate = await invoke([
      ...createPrefix,
      '--api-version',
      '2026-02-30',
      '--url',
      'https://hooks.example.test/deliver'
    ])
    expect(JSON.parse(invalidDate.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const duplicateEvents = await invoke([
      ...createPrefix,
      '--event',
      'message.created',
      '--url',
      'https://hooks.example.test/deliver'
    ])
    expect(JSON.parse(duplicateEvents.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const missingEvents = await invoke([
      'project',
      'webhook',
      'create',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--name',
      'Missing events',
      '--api-version',
      '2026-07-01',
      '--url',
      'https://hooks.example.test/deliver'
    ])
    expect(JSON.parse(missingEvents.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const conflictingEvents = await invoke([
      ...createPrefix,
      '--all-events',
      '--url',
      'https://hooks.example.test/deliver'
    ])
    expect(JSON.parse(conflictingEvents.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const invalidDestination = await invoke([
      'project',
      'webhook',
      'view',
      'pho_whd_invalid',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(invalidDestination.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const emptyEdit = await invoke([
      'project',
      'webhook',
      'edit',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(emptyEdit.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })

    const invalidOverlap = await invoke([
      'project',
      'webhook',
      'rotate-secret',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--overlap-seconds',
      '604801',
      '--yes'
    ])
    expect(JSON.parse(invalidOverlap.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(spies.createWebhookDestination).not.toHaveBeenCalled()
    expect(spies.getWebhookDestination).not.toHaveBeenCalled()
    expect(spies.updateWebhookDestination).not.toHaveBeenCalled()
    expect(spies.rotateWebhookSigningSecret).not.toHaveBeenCalled()

    const edited = await invoke([
      'project',
      'webhook',
      'edit',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--clear-description',
      '--event',
      'message.updated',
      '--status',
      'disabled',
      '--idempotency-key',
      'webhook-edit'
    ])
    expect(JSON.parse(edited.stdout)).toMatchObject({
      description: null,
      destinationId,
      enabledEvents: ['message.updated'],
      status: 'disabled'
    })
    expect(spies.updateWebhookDestination).toHaveBeenCalledWith(
      {
        body: {
          description: null,
          enabledEvents: ['message.updated'],
          status: 'disabled'
        },
        headers: { idempotencyKey: 'webhook-edit' },
        path: { destinationId, projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('gives an event type that exists in the hint for an invalid --event', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope)

    const invalid = await Promise.all([
      invoke([
        'project',
        'webhook',
        'create',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--name',
        'Invalid event',
        '--url',
        'https://hooks.example.test/deliver',
        '--api-version',
        '2026-07-01',
        '--event',
        'MessageReceived'
      ]),
      invoke([
        'project',
        'webhook',
        'edit',
        destinationId,
        '--project',
        'pho_prj_00000000000000000000000001',
        '--event',
        'MessageReceived'
      ])
    ])
    for (const result of invalid) {
      expect(result.exitCodes).toEqual([2])
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: 'ARGUMENT_VALIDATION',
          detail:
            'Webhook event "MessageReceived" must use a dotted event type such as message.received.'
        }
      })
    }
    expect(spies.createWebhookDestination).not.toHaveBeenCalled()
    expect(spies.updateWebhookDestination).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('confirms deletion and secret rotation and emits no secret on stderr', async () => {
    const authenticated = await createAuthenticatedConfig()
    const prompts: string[] = []
    const { scope, spies } = webhookScope()
    const invoke = cliInvoker(authenticated.configDirectory, scope, {
      confirm: (message) => {
        prompts.push(message)
        return Promise.resolve(false)
      }
    })

    const cancelledDelete = await invoke([
      'project',
      'webhook',
      'delete',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    const cancelledRotation = await invoke([
      'project',
      'webhook',
      'rotate-secret',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(cancelledDelete.stdout).toBe('')
    expect(cancelledRotation.stdout).toBe('')
    expect(prompts).toEqual([
      `Delete webhook destination ${destinationId} from project pho_prj_00000000000000000000000001?`,
      `Rotate the signing secret for webhook destination ${destinationId}? The previous secret will remain valid for 86400 seconds.`
    ])

    const rotated = await invoke([
      'project',
      'webhook',
      'rotate-secret',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--overlap-seconds',
      '0',
      '--idempotency-key',
      'webhook-rotate',
      '--yes'
    ])
    expect(JSON.parse(rotated.stdout)).toEqual({
      previousSecretExpiresAt: '2026-08-01T18:00:00.000Z',
      signingSecret: rotatedSigningSecret
    })
    expect(rotated.stderr).toContain('cannot be retrieved again')
    expect(rotated.stderr).not.toContain(rotatedSigningSecret)
    expect(spies.rotateWebhookSigningSecret).toHaveBeenCalledWith(
      {
        body: { overlapSeconds: 0 },
        headers: { idempotencyKey: 'webhook-rotate' },
        path: { destinationId, projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )

    const deleted = await invoke([
      'project',
      'webhook',
      'delete',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    expect(JSON.parse(deleted.stdout)).toEqual(
      webhookDestination({ deletedAt: timestamp })
    )
    expect(deleted.stdout).not.toContain(signingSecret)
    expect(deleted.stderr).not.toContain(signingSecret)
    expect(spies.deleteWebhookDestination).toHaveBeenCalledWith(
      {
        path: { destinationId, projectId: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
  })

  test('keeps secret output awaiting acknowledgement and safely replays it', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const stderr = collector()
    const exitCodes: number[] = []
    const rejectingStdout: WritableOutput = {
      write: () => Promise.reject(new Error('stdout unavailable'))
    }

    await runCli(
      [
        'project',
        'webhook',
        'create',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--name',
        'Output recovery',
        '--url',
        'https://hooks.example.test/recovery',
        '--api-version',
        '2026-07-01',
        '--all-events',
        '--idempotency-key',
        'webhook-output-recovery',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: rejectingStdout
      }
    )
    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain(signingSecret)

    const invoke = cliInvoker(authenticated.configDirectory, scope)
    const pending = JSON.parse(
      (await invoke(['operation', 'list'])).stdout
    ) as {
      operations: Array<{
        kind: string
        operationId: string
        status: string
      }>
    }
    expect(pending.operations).toHaveLength(1)
    expect(pending.operations[0]).toMatchObject({
      kind: 'webhook-destination.create',
      status: 'awaiting-output-ack'
    })
    const operation = pending.operations.at(0)
    if (operation === undefined) {
      throw new Error('pending webhook operation fixture is missing')
    }

    const viewed = await invoke(['operation', 'view', operation.operationId])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        input: {
          apiVersion: '2026-07-01',
          enabledEvents: ['*'],
          name: 'Output recovery',
          projectId: 'pho_prj_00000000000000000000000001',
          status: 'enabled',
          url: 'https://hooks.example.test/recovery'
        }
      }
    })
    expect(viewed.stdout).not.toContain(signingSecret)

    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeName] = await readdir(operationsRoot)
    const stored = await readFile(
      join(operationsRoot, scopeName ?? '', `${operation.operationId}.json`),
      'utf8'
    )
    expect(stored).not.toContain(signingSecret)

    const replayed = await invoke([
      'operation',
      'replay',
      operation.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'webhook-destination.create',
        operationId: operation.operationId,
        status: 'resolved'
      },
      result: { signingSecret }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual(
      await spies.createWebhookDestination.mock.results.at(1)?.value
    )
    expect(replayed.stderr).toContain('cannot be retrieved again')
    expect(replayed.stderr).not.toContain(signingSecret)
    expect(spies.createWebhookDestination).toHaveBeenCalledTimes(2)
    expect(spies.createWebhookDestination.mock.calls.at(1)?.[0]).toEqual(
      spies.createWebhookDestination.mock.calls.at(0)?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('recovers a rotated secret after output failure without journaling it', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const stderr = collector()
    const exitCodes: number[] = []
    const rejectingStdout: WritableOutput = {
      write: () => Promise.reject(new Error('stdout unavailable'))
    }

    await runCli(
      [
        'project',
        'webhook',
        'rotate-secret',
        destinationId,
        '--project',
        'pho_prj_00000000000000000000000001',
        '--overlap-seconds',
        '3600',
        '--idempotency-key',
        'webhook-rotation-output-recovery',
        '--yes',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: rejectingStdout
      }
    )
    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain(rotatedSigningSecret)

    const invoke = cliInvoker(authenticated.configDirectory, scope)
    const pending = JSON.parse(
      (await invoke(['operation', 'list'])).stdout
    ) as { operations: Array<{ operationId: string }> }
    const operation = pending.operations.at(0)
    if (operation === undefined) {
      throw new Error('pending rotation operation fixture is missing')
    }
    const viewed = await invoke(['operation', 'view', operation.operationId])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        input: {
          destinationId,
          overlapSeconds: 3600,
          projectId: 'pho_prj_00000000000000000000000001'
        },
        kind: 'webhook-signing-secret.rotate',
        status: 'awaiting-output-ack'
      }
    })
    expect(viewed.stdout).not.toContain(rotatedSigningSecret)

    const replayed = await invoke([
      'operation',
      'replay',
      operation.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'webhook-signing-secret.rotate',
        status: 'resolved'
      },
      result: {
        previousSecretExpiresAt: '2026-08-01T18:00:00.000Z',
        signingSecret: rotatedSigningSecret
      }
    })
    expect(JSON.parse(replayed.stdout).result).toEqual(
      await spies.rotateWebhookSigningSecret.mock.results.at(1)?.value
    )
    expect(replayed.stderr).not.toContain(rotatedSigningSecret)
    expect(spies.rotateWebhookSigningSecret).toHaveBeenCalledTimes(2)
    expect(spies.rotateWebhookSigningSecret.mock.calls.at(1)?.[0]).toEqual(
      spies.rotateWebhookSigningSecret.mock.calls.at(0)?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('names the replay and keeps the record when stdout fails after taking a new signing secret, and again when the replay output fails', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'webhook',
        'create',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--name',
        'Late output failure',
        '--url',
        'https://hooks.example.test/late',
        '--api-version',
        '2026-07-01',
        '--all-events',
        '--idempotency-key',
        'webhook-late-output-failure',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: lateFailingStdout()
      }
    )

    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain(signingSecret)
    const failure = JSON.parse(stderr.value().trim().split('\n').at(-1) ?? '')
    expect(failure.error).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      idempotencyKey: 'webhook-late-output-failure',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      replayable: true
    })

    const invoke = cliInvoker(authenticated.configDirectory, scope)
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [
        {
          kind: 'webhook-destination.create',
          operationId: failure.error.operationId,
          status: 'awaiting-output-ack'
        }
      ]
    })
    const failedReplay = await lateFailingInvoker(
      authenticated.configDirectory,
      scope
    )(['operation', 'replay', failure.error.operationId, '--yes'])
    expect(failedReplay.exitCodes).toEqual([1])
    expect(failedReplay.stderr).not.toContain(signingSecret)
    expect(stderrError(failedReplay.stderr)).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      operationId: failure.error.operationId,
      replayable: true
    })
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stdout.split(signingSecret)).toHaveLength(2)
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'webhook-destination.create', status: 'resolved' },
      result: { signingSecret }
    })
    expect(spies.createWebhookDestination).toHaveBeenCalledTimes(3)
    expect(spies.createWebhookDestination.mock.calls.at(1)?.[0]).toEqual(
      spies.createWebhookDestination.mock.calls.at(0)?.[0]
    )
    expect(spies.createWebhookDestination.mock.calls.at(2)?.[0]).toEqual(
      spies.createWebhookDestination.mock.calls.at(0)?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('names the replay and keeps the record when stdout fails after taking a rotated signing secret, and again when the replay output fails', async () => {
    const authenticated = await createAuthenticatedConfig()
    const { scope, spies } = webhookScope()
    const stderr = collector()
    const exitCodes: number[] = []

    await runCli(
      [
        'project',
        'webhook',
        'rotate-secret',
        destinationId,
        '--project',
        'pho_prj_00000000000000000000000001',
        '--idempotency-key',
        'webhook-rotation-late-output-failure',
        '--yes',
        '--json'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: scope,
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout: lateFailingStdout()
      }
    )

    expect(exitCodes).toEqual([1])
    expect(stderr.value()).not.toContain(rotatedSigningSecret)
    const failure = JSON.parse(stderr.value().trim().split('\n').at(-1) ?? '')
    expect(failure.error).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      idempotencyKey: 'webhook-rotation-late-output-failure',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      replayable: true
    })

    const invoke = cliInvoker(authenticated.configDirectory, scope)
    expect(
      JSON.parse((await invoke(['operation', 'list'])).stdout)
    ).toMatchObject({
      operations: [
        {
          kind: 'webhook-signing-secret.rotate',
          operationId: failure.error.operationId,
          status: 'awaiting-output-ack'
        }
      ]
    })
    const failedReplay = await lateFailingInvoker(
      authenticated.configDirectory,
      scope
    )(['operation', 'replay', failure.error.operationId, '--yes'])
    expect(failedReplay.exitCodes).toEqual([1])
    expect(failedReplay.stderr).not.toContain(rotatedSigningSecret)
    expect(stderrError(failedReplay.stderr)).toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
      next: [
        {
          description: 'Replay the operation',
          run: `${CLI_NAME} operation replay ${failure.error.operationId}`
        }
      ],
      operationId: failure.error.operationId,
      replayable: true
    })
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.stdout.split(rotatedSigningSecret)).toHaveLength(2)
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: { kind: 'webhook-signing-secret.rotate', status: 'resolved' },
      result: { signingSecret: rotatedSigningSecret }
    })
    expect(spies.rotateWebhookSigningSecret).toHaveBeenCalledTimes(3)
    expect(spies.rotateWebhookSigningSecret.mock.calls.at(1)?.[0]).toEqual(
      spies.rotateWebhookSigningSecret.mock.calls.at(0)?.[0]
    )
    expect(spies.rotateWebhookSigningSecret.mock.calls.at(2)?.[0]).toEqual(
      spies.rotateWebhookSigningSecret.mock.calls.at(0)?.[0]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test('converges a delete replay when the destination is already absent', async () => {
    const authenticated = await createAuthenticatedConfig()
    const deleteWebhookDestination = vi
      .fn<ProjectScope['deleteWebhookDestination']>()
      .mockRejectedValueOnce(
        new ResponseValidationError('deleteWebhookDestination', [], {
          status: 200
        })
      )
      .mockRejectedValueOnce(webhookNotFound())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ deleteWebhookDestination })
    )

    const failed = await invoke([
      'project',
      'webhook',
      'delete',
      destinationId,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: { code: 'API_PROTOCOL_ERROR', replayable: true }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(JSON.parse(replayed.stdout)).toEqual({
      operation: {
        kind: 'webhook-destination.delete',
        operationId: failure.error.operationId,
        status: 'resolved'
      },
      result: { deleted: true, destinationId }
    })
    expect(deleteWebhookDestination).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })
})
