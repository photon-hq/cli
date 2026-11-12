import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ApiError, ResponseValidationError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { API_TOKEN_VARIABLE } from '../src/auth/constants.ts'
import type { PollClock } from '../src/auth/device-flow.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CliError, hasOwnNextSteps } from '../src/core/errors.ts'
import type { ReadableInput, SelectionHandler } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { resolveWhatsappAddMode } from '../src/project/whatsapp-onboarding.ts'
import { printed } from './help-support.ts'
import { photonKey } from './key-support.ts'
import {
  apiCalls,
  asProjectRawScope,
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-08-19T21:04:31.000Z'

const account = {
  accountName: null,
  alerts: [],
  businessId: '887766554433221',
  businessName: null,
  connectedAt: '2026-08-19T21:04:30.000Z',
  futureField: 'from-a-newer-api',
  outboundCapacity: 'UNKNOWN' as const,
  restriction: null,
  reviewStatus: 'UNKNOWN' as const,
  senderCount: 1,
  subscribedAt: '2026-08-19T21:05:00.000Z',
  wabaId: '112233445566778'
}

const whatsappNumber = (
  overrides: Record<string, unknown> = {}
): {
  abilities: string[]
  createdAt: string
  detail: Record<string, unknown>
  projectId: string
  resourceId: string
  retiredAt?: string
  state: string
  type: string
  updatedAt: string
} => ({
  abilities: ['whatsapp_business'],
  createdAt: timestamp,
  detail: {
    account: { wabaId: '112233445566778' },
    displayName: 'Acme Support',
    displayNameStatus: 'APPROVED',
    phoneNumber: '+14155550199',
    phoneNumberId: '123456789012345',
    qualityRating: 'GREEN',
    qualityRatingObservedAt: '2026-08-19T21:04:58.000Z',
    voipResourceId: 'pho_res_00000000000000000000000123'
  },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  state: 'active',
  type: 'whatsapp_sender',
  updatedAt: '2026-08-19T21:05:00.000Z',
  ...overrides
})

const voipNumber = (overrides: Record<string, unknown> = {}) => ({
  abilities: ['sms'],
  createdAt: timestamp,
  detail: { phoneNumber: '+14155550199' },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000123',
  state: 'active',
  type: 'voip_line',
  updatedAt: timestamp,
  ...overrides
})

const resourceOperation = (
  state: string,
  operationId = 'remote_whatsapp_release'
) => ({
  cancellable: false,
  createdAt: timestamp,
  detail: {
    accountDisconnected: true,
    futureField: 'from-a-newer-api'
  },
  operationId,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  resourceType: 'whatsapp_sender',
  state,
  type: 'resource.release',
  updatedAt: timestamp
})

const provisionOperation = (state: string) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId: 'remote_whatsapp_provision',
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000001',
  resourceType: 'whatsapp_sender',
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const rawResponse = <Result>(data: Result, status = 202, retryAfter = '5') => ({
  data,
  headers: new Headers({ 'retry-after': retryAfter }),
  status
})

const inputStream = (value: string, isTTY: boolean): ReadableInput => {
  const stream = Readable.from([value]) as ReadableInput
  stream.isTTY = isTTY
  return stream
}

const WHATSAPP_NUMBER_DELETE = [
  'project',
  'platform',
  'whatsapp-business',
  'number',
  'delete',
  'pho_res_00000000000000000000000001',
  '--project',
  'pho_prj_00000000000000000000000001',
  '--yes'
]

const interruptedPollClock = (): PollClock => ({
  now: () => 0,
  sleep: () => {
    throw new DOMException('cancelled', 'AbortError')
  },
  wallNow: () => TEST_NOW
})

const failedOperationId = (stdout: string): string =>
  (JSON.parse(stdout) as { error: { operationId: string } }).error.operationId

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('WhatsApp Business CLI', () => {
  test('registers the account and number lifecycle with exact flags', async () => {
    const lines: string[] = []
    lines.push(
      await printed(['project', 'platform', 'whatsapp-business', '--help'])
    )
    lines.push(
      await printed([
        'project',
        'platform',
        'whatsapp-business',
        'account',
        'list',
        '--help'
      ])
    )
    lines.push(
      await printed([
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'add',
        '--help'
      ])
    )
    lines.push(
      await printed([
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'list',
        '--help'
      ])
    )
    lines.push(
      await printed([
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'view',
        '--help'
      ])
    )
    lines.push(
      await printed([
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'delete',
        '--help'
      ])
    )

    const help = lines.join('\n')
    expect(help).toContain('account')
    expect(help).toContain('number')
    expect(help).toContain('--limit')
    expect(help).toContain('--page-token')
    expect(help).toContain('--no-browser')
    expect(help).toContain('--source')
    expect(help).toContain('--waba-id')
    expect(help).toContain('--new-waba')
    expect(help).toContain('--voip-resource-id')
    expect(help).toContain('--display-name')
    expect(help).toContain('--idempotency-key')
    expect(help).toContain('--yes')
    expect(help).toContain('resource-id')
    expect(help).not.toContain('--include-retired')
    expect(process.exitCode).toBeUndefined()
  })

  test('hands BYON off immediately with a structured browser guide', async () => {
    const authenticated = await createAuthenticatedConfig()
    const clock = instantPollClock()
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: {} }),
      { browserLauncher, clock }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'byon'
    ])

    expect(JSON.parse(result.stdout)).toEqual({
      handoff: {
        browserAttempted: true,
        kind: 'whatsapp-embedded-signup',
        opened: true,
        projectId: 'pho_prj_00000000000000000000000001',
        requiresHumanInteraction: true,
        source: 'byon',
        url: `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon`
      }
    })
    expect(clock.sleeps).toEqual([])
    expect(browserLauncher).toHaveBeenCalledOnce()
    expect(browserLauncher).toHaveBeenCalledWith(
      `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon`
    )
    expect(result.stderr).toBe(
      [
        'Opened WhatsApp onboarding in your browser.',
        `Dashboard URL: ${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon`,
        '',
        '1. Continue setup in the Photon dashboard.',
        '2. Sign in to Meta when prompted.',
        '3. Select your WhatsApp Business Account and phone number.',
        '4. Complete phone verification in the browser.',
        '5. Wait for the dashboard to confirm the connected sender.',
        ''
      ].join('\n')
    )
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    await authenticated.remove()
  })

  test('honors --no-browser for a BYON handoff', async () => {
    const authenticated = await createAuthenticatedConfig()
    const clock = instantPollClock()
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { browserLauncher, clock }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'byon',
      '--no-browser'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      handoff: {
        browserAttempted: false,
        opened: false,
        source: 'byon',
        url: `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon`
      }
    })
    expect(JSON.parse(result.stdout).handoff).not.toHaveProperty('nextSteps')
    expect(result.stderr).toContain(
      `Continue WhatsApp onboarding in a browser.\nDashboard URL: ${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon\n`
    )
    expect(clock.sleeps).toEqual([])
    expect(browserLauncher).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('keeps browser launch failures recoverable and leaves the URL visible', async () => {
    const authenticated = await createAuthenticatedConfig()
    const browserLauncher = vi.fn(() => Promise.reject(new Error('no browser')))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { browserLauncher, clock: instantPollClock() }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'byon'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      handoff: { browserAttempted: true, opened: false }
    })
    expect(result.exitCodes).toEqual([])
    expect(result.stderr).toContain('Warning:')
    expect(result.stderr).toContain(
      `Dashboard URL: ${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=byon\n`
    )
    await authenticated.remove()
  })

  test('number add does the same with or without --json', async () => {
    const add = async (args: string[]) => {
      const authenticated = await createAuthenticatedConfig()
      const spies = {
        platforms: {
          getOperation: vi.fn(() =>
            Promise.resolve({
              operation: provisionOperation('succeeded'),
              resource: whatsappNumber()
            })
          ),
          getResource: vi.fn(() => Promise.resolve(voipNumber())),
          getWhatsappBusinessAccount: vi.fn(() => Promise.resolve(account)),
          listResources: vi.fn(() => Promise.resolve({ resources: [] }))
        },
        raw: {
          createWhatsappVoipSender: vi.fn(() =>
            Promise.resolve(
              rawResponse(provisionOperation('pending'), 202, '3')
            )
          )
        }
      }
      const browserLauncher = vi.fn(() => Promise.resolve())
      const stdout = collector()
      const stderr = collector()
      const exitCodes: number[] = []
      await runCli(
        [
          'project',
          'platform',
          'whatsapp-business',
          'number',
          'add',
          '--project',
          'pho_prj_00000000000000000000000001',
          ...args
        ],
        {
          browserLauncher,
          clock: instantPollClock(),
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          projectRawScope: asProjectRawScope({ platforms: spies.raw }),
          projectScope: asProjectScope({ platforms: spies.platforms }),
          setExitCode: (exitCode) => exitCodes.push(exitCode),
          stderr,
          stdout
        }
      )
      await authenticated.remove()
      return {
        calls: apiCalls({ ...spies, browser: browserLauncher }),
        exitCodes,
        stderr: stderr.value(),
        stdout: stdout.value()
      }
    }
    const direct = [
      '--source',
      'photon',
      '--waba-id',
      account.wabaId,
      '--voip-resource-id',
      'pho_res_00000000000000000000000123',
      '--display-name',
      'Acme Support',
      '--idempotency-key',
      'customer-123-photon-wa-1'
    ]

    const text = await add(direct)
    const json = await add([...direct, '--json'])
    const askText = await add([])
    const askJson = await add(['--json'])

    expect(json.calls).toEqual(text.calls)
    expect(text.calls.map(([name]) => name)).toContain('platforms.getOperation')
    expect([text.exitCodes, json.exitCodes]).toEqual([[], []])
    expect(text.stderr).toBe('')
    expect(text.stdout).toContain(
      'Connected +14155550199 to WhatsApp Business.'
    )
    expect(JSON.parse(json.stdout)).toEqual({
      operation: provisionOperation('succeeded'),
      resource: whatsappNumber()
    })

    for (const asked of [askText, askJson]) {
      expect(asked.calls).toEqual([])
      expect(asked.exitCodes).toEqual([2])
    }
    expect(askText.stdout).toBe('')
    expect(askJson.stderr).toBe('')
    expect(askText.stderr).toContain(
      "Without --source this command asks its questions, and Photon can't ask: standard input is not a terminal."
    )
    expect(JSON.parse(askJson.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail:
          "Without --source this command asks its questions, and Photon can't ask: --json is set."
      }
    })
  })

  test('rejects --json without an explicit source instead of launching the TUI', async () => {
    const authenticated = await createAuthenticatedConfig()
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { browserLauncher }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(result.exitCodes).toEqual([2])
    expect(result.stderr).toBe('')
    expect(browserLauncher).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('hands a validated Photon number to dashboard-owned new-WABA onboarding', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() => Promise.resolve(voipNumber()))
    const listResources = vi.fn(() => Promise.resolve({ resources: [] }))
    const browserLauncher = vi.fn(() => Promise.resolve())
    const createWhatsappVoipSender = vi.fn()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource, listResources } }),
      {
        browserLauncher,
        projectRawScope: asProjectRawScope({
          platforms: { createWhatsappVoipSender }
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'photon',
      '--new-waba',
      '--voip-resource-id',
      'pho_res_00000000000000000000000123'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      handoff: {
        browserAttempted: true,
        opened: true,
        resource: voipNumber(),
        source: 'photon',
        url: `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=photon&voipResourceId=pho_res_00000000000000000000000123&verification=dashboard`,
        verificationOwner: 'dashboard'
      }
    })
    expect(JSON.parse(result.stdout).handoff).not.toHaveProperty('nextSteps')
    expect(result.stderr).toContain(
      `Opened WhatsApp onboarding in your browser.\nDashboard URL: ${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=photon&voipResourceId=pho_res_00000000000000000000000123&verification=dashboard\n`
    )
    expect(browserLauncher).toHaveBeenCalledWith(
      `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=photon&voipResourceId=pho_res_00000000000000000000000123&verification=dashboard`
    )
    expect(createWhatsappVoipSender).not.toHaveBeenCalled()
    await expect(
      readdir(join(authenticated.configDirectory, 'operations'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await authenticated.remove()
  })

  test('honors --no-browser for Photon new-WABA handoff', async () => {
    const authenticated = await createAuthenticatedConfig()
    const browserLauncher = vi.fn(() => Promise.resolve())
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: {
          getResource: () => Promise.resolve(voipNumber()),
          listResources: () => Promise.resolve({ resources: [] })
        }
      }),
      { browserLauncher }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'photon',
      '--new-waba',
      '--voip-resource-id',
      'pho_res_00000000000000000000000123',
      '--no-browser'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      handoff: {
        browserAttempted: false,
        opened: false,
        source: 'photon',
        url: `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=photon&voipResourceId=pho_res_00000000000000000000000123&verification=dashboard`,
        verificationOwner: 'dashboard'
      }
    })
    expect(JSON.parse(result.stdout).handoff).not.toHaveProperty('nextSteps')
    expect(browserLauncher).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('provisions a Photon number directly through a connected WABA', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() => Promise.resolve(voipNumber()))
    const listResources = vi.fn(() => Promise.resolve({ resources: [] }))
    const getWhatsappBusinessAccount = vi.fn(() => Promise.resolve(account))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: provisionOperation('succeeded'),
        resource: whatsappNumber()
      })
    )
    const createWhatsappVoipSender = vi.fn(() =>
      Promise.resolve(rawResponse(provisionOperation('pending'), 202, '3'))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: {
          getOperation,
          getResource,
          getWhatsappBusinessAccount,
          listResources
        }
      }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { createWhatsappVoipSender }
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'photon',
      '--waba-id',
      account.wabaId,
      '--voip-resource-id',
      'pho_res_00000000000000000000000123',
      '--display-name',
      'Acme Support',
      '--idempotency-key',
      'customer-123-photon-wa-1'
    ])

    expect(JSON.parse(result.stdout)).toEqual({
      operation: provisionOperation('succeeded'),
      resource: whatsappNumber()
    })
    expect(createWhatsappVoipSender).toHaveBeenCalledWith(
      {
        body: {
          displayName: 'Acme Support',
          voipResourceId: 'pho_res_00000000000000000000000123'
        },
        headers: { idempotencyKey: 'customer-123-photon-wa-1' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('replays accepted direct Photon provisioning from its remote operation', async () => {
    const authenticated = await createAuthenticatedConfig()
    let sleepCalls = 0
    const clock: PollClock = {
      now: () => 0,
      sleep: () => {
        sleepCalls += 1
        if (sleepCalls === 1) {
          throw new DOMException('cancelled', 'AbortError')
        }
        return Promise.resolve()
      },
      wallNow: () => TEST_NOW
    }
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: provisionOperation('succeeded'),
        resource: whatsappNumber()
      })
    )
    const createWhatsappVoipSender = vi.fn(() =>
      Promise.resolve(rawResponse(provisionOperation('pending'), 202, '3'))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: {
          getOperation,
          getResource: () => Promise.resolve(voipNumber()),
          getWhatsappBusinessAccount: () => Promise.resolve(account),
          listResources: () => Promise.resolve({ resources: [] })
        }
      }),
      {
        clock,
        projectRawScope: asProjectRawScope({
          platforms: { createWhatsappVoipSender }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'photon',
      '--waba-id',
      account.wabaId,
      '--voip-resource-id',
      'pho_res_00000000000000000000000123',
      '--idempotency-key',
      'stable-whatsapp-provision'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'COMMAND_INTERRUPTED',
        remoteOperationId: 'remote_whatsapp_provision',
        replayable: true
      }
    })

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    const replayedProvision = JSON.parse(replayed.stdout) as { result: unknown }
    expect(replayedProvision).toMatchObject({
      operation: {
        kind: 'whatsapp-business-number.provision',
        status: 'resolved'
      }
    })
    expect(replayedProvision.result).toEqual({
      operation: provisionOperation('succeeded'),
      resource: whatsappNumber()
    })
    expect(createWhatsappVoipSender).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test.each([
    [
      [
        '--source',
        'photon',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123'
      ],
      'exactly one of --waba-id or --new-waba'
    ],
    [
      [
        '--source',
        'photon',
        '--new-waba',
        '--waba-id',
        account.wabaId,
        '--voip-resource-id',
        'pho_res_00000000000000000000000123'
      ],
      'exactly one of --waba-id or --new-waba'
    ],
    [
      [
        '--source',
        'byon',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123'
      ],
      '--source byon cannot be combined'
    ],
    [['--source', 'photon', '--new-waba'], '--voip-resource-id'],
    [
      [
        '--source',
        'photon',
        '--new-waba',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123',
        '--display-name',
        'Acme'
      ],
      'does not accept --display-name'
    ],
    [
      [
        '--source',
        'photon',
        '--waba-id',
        account.wabaId,
        '--voip-resource-id',
        'pho_res_00000000000000000000000123',
        '--no-browser'
      ],
      '--no-browser is not valid'
    ]
  ])('rejects invalid number-add mode %#', async (modeArgs, detail) => {
    const authenticated = await createAuthenticatedConfig()
    const invoke = cliInvoker(authenticated.configDirectory, asProjectScope({}))
    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      ...modeArgs
    ])

    const failure = JSON.parse(result.stdout) as {
      error: { code: string; detail: string }
    }
    expect(failure.error.code).toBe('ARGUMENT_VALIDATION')
    expect(failure.error.detail).toContain(detail)
    expect(result.stderr).toBe('')
    await authenticated.remove()
  })

  test.each([
    [
      [
        '--source',
        'photon',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123'
      ],
      [
        { description: 'Use --source byon for a browser handoff.' },
        {
          description:
            'Or use --source photon with exactly one of --waba-id or --new-waba.'
        }
      ]
    ],
    [
      ['--source', 'photon', '--new-waba'],
      [
        {
          description: "List the project's SMS numbers",
          run: `${CLI_NAME} project platform sms list --project pho_prj_00000000000000000000000001`
        },
        {
          description: 'Run it with one of them',
          run: `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --new-waba --json --voip-resource-id <resource-id>`
        }
      ]
    ],
    [
      [
        '--source',
        'photon',
        '--waba-id',
        'not-digits',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123'
      ],
      [
        {
          description: "See the connected WABA's ID",
          run: `${CLI_NAME} project platform whatsapp-business account list --project <project-id>`
        }
      ]
    ],
    [
      [
        '--source',
        'photon',
        '--new-waba',
        '--voip-resource-id',
        'pho_res_00000000000000000000000123',
        '--display-name',
        'Acme'
      ],
      [
        {
          description: 'Run it without them',
          run: `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --new-waba --voip-resource-id pho_res_00000000000000000000000123 --json`
        },
        {
          description: 'See the valid options',
          run: `${CLI_NAME} project platform whatsapp-business number add --help`
        }
      ]
    ],
    [
      [
        '--source',
        'photon',
        '--new-waba',
        '--idempotency-key=retry-1',
        '--voip-resource-id=pho_res_00000000000000000000000123'
      ],
      [
        {
          description: 'Run it without them',
          run: `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --new-waba --voip-resource-id=pho_res_00000000000000000000000123 --json`
        },
        {
          description: 'See the valid options',
          run: `${CLI_NAME} project platform whatsapp-business number add --help`
        }
      ]
    ],
    [
      [
        '--source',
        'photon',
        '--waba-id',
        account.wabaId,
        '--voip-resource-id',
        'pho_res_00000000000000000000000123',
        '--no-browser'
      ],
      [
        {
          description: 'Run it without --no-browser',
          run: `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --waba-id ${account.wabaId} --voip-resource-id pho_res_00000000000000000000000123 --json`
        },
        {
          description: 'See the valid options',
          run: `${CLI_NAME} project platform whatsapp-business number add --help`
        }
      ]
    ],
    [
      [
        '--source',
        'photon',
        '--no-browser',
        '--waba-id',
        account.wabaId,
        '--voip-resource-id',
        'pho_res_00000000000000000000000123',
        '--display-name',
        'Acme Support'
      ],
      [
        {
          description: 'Run it without --no-browser',
          run: `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --waba-id ${account.wabaId} --voip-resource-id pho_res_00000000000000000000000123 --display-name 'Acme Support' --json`
        },
        {
          description: 'See the valid options',
          run: `${CLI_NAME} project platform whatsapp-business number add --help`
        }
      ]
    ]
  ])(
    'gives number-add mode steps only to mode errors %#',
    async (modeArgs, next) => {
      const authenticated = await createAuthenticatedConfig()
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({})
      )
      const result = await invoke([
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'add',
        '--project',
        'pho_prj_00000000000000000000000001',
        ...modeArgs
      ])

      const failure = JSON.parse(result.stdout) as {
        error: { code: string; next: unknown }
      }
      expect(failure.error.code).toBe('ARGUMENT_VALIDATION')
      expect(failure.error.next).toEqual(next)
      await authenticated.remove()
    }
  )

  test('names --waba-id and lists the connected WABA when the WABA ID is not digits', async () => {
    const authenticated = await createAuthenticatedConfig()
    const invoke = cliInvoker(authenticated.configDirectory, asProjectScope({}))
    const command = [
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--source',
      'photon',
      '--waba-id',
      'not-digits',
      '--voip-resource-id'
    ]

    const alone = await invoke([
      ...command,
      'pho_res_00000000000000000000000123'
    ])
    const withAnother = await invoke([...command, 'not-a-resource'])

    expect(JSON.parse(alone.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail: '--waba-id must be digits only.',
        next: [
          {
            description: "See the connected WABA's ID",
            run: `${CLI_NAME} project platform whatsapp-business account list --project <project-id>`
          }
        ]
      }
    })
    expect(alone.exitCodes).toEqual([2])
    expect(JSON.parse(withAnother.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        next: [
          { description: 'Run the command with --help for valid options.' }
        ]
      }
    })
    expect(withAnother.exitCodes).toEqual([2])
    await authenticated.remove()
  })

  test('adds --voip-resource-id before a trailing --', async () => {
    const authenticated = await createAuthenticatedConfig()
    const stdout = collector(false)
    await runCli(
      [
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'add',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--source',
        'photon',
        '--new-waba',
        '--json',
        '--'
      ],
      {
        configDirectory: authenticated.configDirectory,
        cwd: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: asProjectScope({}),
        setExitCode: () => undefined,
        stderr: collector(false),
        stdout
      }
    )

    const failure = JSON.parse(stdout.value()) as {
      error: { next: { run?: string }[] }
    }
    expect(failure.error.next[1]?.run).toBe(
      `${CLI_NAME} project platform whatsapp-business number add --project pho_prj_00000000000000000000000001 --source photon --new-waba --json --voip-resource-id <resource-id> --`
    )
    await authenticated.remove()
  })

  test('gives a WABA ID that passed parsing but is not digits no mode steps', () => {
    let failure: unknown
    try {
      resolveWhatsappAddMode(
        {
          source: 'photon',
          voipResourceId: 'pho_res_00000000000000000000000123',
          wabaId: 'not-digits'
        },
        undefined,
        {
          projectId: 'pho_prj_00000000000000000000000001',
          typed: { _: [], args: {}, commandPath: [], tokens: [] }
        }
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(CliError)
    expect(hasOwnNextSteps(failure as CliError)).toBe(false)
  })

  test('the human wizard always offers the sole WABA and Connect another WABA', async () => {
    const authenticated = await createAuthenticatedConfig()
    const selections = [
      'photon',
      'pho_res_00000000000000000000000123',
      `waba:${account.wabaId}`
    ]
    const selectionCalls: Array<{
      message: string
      options: readonly { label: string; value: string }[]
    }> = []
    const select: SelectionHandler = <Value extends string>(
      message: string,
      options: readonly { label: string; value: Value }[]
    ): Promise<Value> => {
      selectionCalls.push({ message, options })
      return Promise.resolve(selections.shift() as Value)
    }
    const listResources = vi.fn(
      (input: { query?: { ability?: string | undefined } | undefined }) =>
        Promise.resolve({
          resources: input.query?.ability === 'sms' ? [voipNumber()] : []
        })
    )
    const listOperations = vi.fn(() => Promise.resolve({ operations: [] }))
    const getWhatsappBusinessAccount = vi.fn(() => Promise.resolve(account))
    const getOperation = vi.fn(() =>
      Promise.resolve({
        operation: provisionOperation('succeeded'),
        resource: whatsappNumber()
      })
    )
    const createWhatsappVoipSender = vi.fn(() =>
      Promise.resolve(rawResponse(provisionOperation('pending'), 202, '1'))
    )
    const stdout = collector(true)
    await runCli(
      [
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'add',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--no-color'
      ],
      {
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectRawScope: asProjectRawScope({
          platforms: { createWhatsappVoipSender }
        }),
        projectScope: asProjectScope({
          platforms: {
            getOperation,
            getWhatsappBusinessAccount,
            listOperations,
            listResources
          }
        }),
        select,
        stderr: collector(true),
        stdin: inputStream('', true),
        stdout
      }
    )

    expect(stdout.value()).toContain('Connected +14155550199')
    const wabaPrompt = selectionCalls.find(({ message }) =>
      message.startsWith('Which WhatsApp Business Account')
    )
    expect(wabaPrompt?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: `WABA ${account.wabaId}`,
          value: `waba:${account.wabaId}`
        }),
        expect.objectContaining({
          label: 'Connect another WABA with Meta',
          value: '__new_waba__'
        })
      ])
    )
    await authenticated.remove()
  })

  test('the human new-WABA path keeps the terminal open and displays the OTP', async () => {
    const authenticated = await createAuthenticatedConfig()
    const selections = [
      'photon',
      'pho_res_00000000000000000000000123',
      '__new_waba__'
    ]
    const select: SelectionHandler = <Value extends string>(): Promise<Value> =>
      Promise.resolve(selections.shift() as Value)
    let whatsappListCalls = 0
    const listResources = vi.fn(
      (input: { query?: { ability?: string | undefined } | undefined }) => {
        if (input.query?.ability === 'sms') {
          return Promise.resolve({ resources: [voipNumber()] })
        }
        whatsappListCalls += 1
        return Promise.resolve({
          resources: whatsappListCalls >= 3 ? [whatsappNumber()] : []
        })
      }
    )
    const getWhatsappBusinessVerificationCode = vi.fn(() =>
      Promise.resolve({
        code: '864209',
        receivedAt: '2026-08-19T21:04:35.000Z'
      })
    )
    const browserLauncher = vi.fn(() => Promise.resolve())
    const stderr = collector(true)
    const stdout = collector(true)
    await runCli(
      [
        'project',
        'platform',
        'whatsapp-business',
        'number',
        'add',
        '--project',
        'pho_prj_00000000000000000000000001',
        '--no-color'
      ],
      {
        browserLauncher,
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        confirm: () => Promise.resolve(true),
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: asProjectScope({
          platforms: {
            getWhatsappBusinessAccount: () => Promise.resolve(account),
            getWhatsappBusinessVerificationCode,
            listOperations: () => Promise.resolve({ operations: [] }),
            listResources
          }
        }),
        random: () => 0.5,
        select,
        stderr,
        stdin: inputStream('', true),
        stdout
      }
    )

    expect(stderr.value()).toContain('WhatsApp verification code: 864209')
    expect(stdout.value()).toContain('Connected +14155550199')
    expect(browserLauncher).toHaveBeenCalledWith(
      `${BUILD_CONFIG.appOrigin}/pho_prj_00000000000000000000000001/platforms/whatsapp-business?onboarding=cli&source=photon&voipResourceId=pho_res_00000000000000000000000123&verification=terminal`
    )
    expect(getWhatsappBusinessVerificationCode).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000123'
        },
        query: { receivedAfter: new Date(TEST_NOW).toISOString() }
      },
      undefined
    )
    await expect(
      readdir(join(authenticated.configDirectory, 'operations'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await authenticated.remove()
  })

  describe('with a key in the environment, a write in the wizard that fails', () => {
    const project = 'pho_prj_00000000000000000000000001'
    const unavailable = (operationId: string) =>
      new ApiError('unavailable', {
        body: { code: 'SERVICE_UNAVAILABLE' },
        headers: new Headers(),
        operationId,
        status: 503
      })
    const run = async (
      args: string[],
      selections: string[],
      scopes: {
        projectRawScope: ReturnType<typeof asProjectRawScope>
        projectScope: ReturnType<typeof asProjectScope>
      }
    ): Promise<string> => {
      const authenticated = await createAuthenticatedConfig()
      const select: SelectionHandler = <
        Value extends string
      >(): Promise<Value> => Promise.resolve(selections.shift() as Value)
      const stderr = collector(true)
      await runCli([...args, '--no-color'], {
        ...scopes,
        clock: instantPollClock(),
        configDirectory: authenticated.configDirectory,
        confirm: () => Promise.resolve(true),
        deviceScope: unusedDeviceScope(),
        env: {
          [API_TOKEN_VARIABLE]: photonKey(
            'sk',
            '01h455vb4pex5vsknk084sn02q_wizard-secret-never-print'
          )
        },
        now: () => TEST_NOW,
        platform: 'linux',
        select,
        setExitCode: () => undefined,
        stderr,
        stdin: inputStream('', true),
        stdout: collector(true)
      })
      await authenticated.remove()
      return stderr.value()
    }
    const retryCommand = (stderr: string, description: string): string => {
      const prefix = `${description}: ${CLI_NAME} `
      const line =
        stderr.split('\n').find((candidate) => candidate.includes(prefix)) ?? ''
      return line.slice(line.indexOf(prefix) + prefix.length)
    }
    const wizard = [
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'add',
      '--project',
      project
    ]

    test('names sms purchase with the purchase key, which sends the same request', async () => {
      const purchaseSmsNumber = vi.fn((_request: unknown) =>
        Promise.reject(unavailable('purchaseSmsNumber'))
      )
      const scopes = {
        projectRawScope: asProjectRawScope({
          platforms: { purchaseSmsNumber }
        }),
        projectScope: asProjectScope({
          platforms: {
            getWhatsappBusinessAccount: () => Promise.resolve(account),
            listOperations: () => Promise.resolve({ operations: [] }),
            listResources: () => Promise.resolve({ resources: [] })
          }
        })
      }

      const failed = await run(wizard, ['photon', '__buy_number__'], scopes)
      const retry = retryCommand(
        failed,
        'Retry the purchase with its idempotency key'
      )
      const wizardCalls = purchaseSmsNumber.mock.calls.length
      await run(retry.split(' '), [], scopes)

      expect(failed).not.toContain('Retry the same command')
      expect(retry).toMatch(
        new RegExp(
          `^project platform sms purchase --project ${project} --country US --idempotency-key [\\w-]+$`
        )
      )
      expect(wizardCalls).toBeGreaterThan(0)
      expect(purchaseSmsNumber.mock.calls.length).toBeGreaterThan(wizardCalls)
      for (const [request] of purchaseSmsNumber.mock.calls) {
        expect(request).toEqual(purchaseSmsNumber.mock.calls[0]?.[0])
      }
    })

    test('names number add with the connection key, which sends the same request', async () => {
      const createWhatsappVoipSender = vi.fn((_request: unknown) =>
        Promise.reject(unavailable('createWhatsappVoipSender'))
      )
      const scopes = {
        projectRawScope: asProjectRawScope({
          platforms: { createWhatsappVoipSender }
        }),
        projectScope: asProjectScope({
          platforms: {
            getResource: () => Promise.resolve(voipNumber()),
            getWhatsappBusinessAccount: () => Promise.resolve(account),
            listOperations: () => Promise.resolve({ operations: [] }),
            listResources: (input: {
              query?: { ability?: string | undefined } | undefined
            }) =>
              Promise.resolve({
                resources: input.query?.ability === 'sms' ? [voipNumber()] : []
              })
          }
        })
      }

      const failed = await run(
        wizard,
        [
          'photon',
          'pho_res_00000000000000000000000123',
          `waba:${account.wabaId}`
        ],
        scopes
      )
      const retry = retryCommand(
        failed,
        'Retry the connection with its idempotency key'
      )
      const wizardCalls = createWhatsappVoipSender.mock.calls.length
      await run(retry.split(' '), [], scopes)

      expect(failed).not.toContain('Retry the same command')
      expect(retry).toMatch(
        new RegExp(
          `^project platform whatsapp-business number add --project ${project} --source photon --voip-resource-id pho_res_00000000000000000000000123 --waba-id ${account.wabaId} --idempotency-key [\\w-]+$`
        )
      )
      expect(wizardCalls).toBeGreaterThan(0)
      expect(createWhatsappVoipSender.mock.calls.length).toBeGreaterThan(
        wizardCalls
      )
      for (const [request] of createWhatsappVoipSender.mock.calls) {
        expect(request).toEqual(createWhatsappVoipSender.mock.calls[0]?.[0])
      }
    })
  })

  test('lists accounts and active numbers through stable projections', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getWhatsappBusinessAccount = vi.fn(() => Promise.resolve(account))
    const listResources = vi.fn(() =>
      Promise.resolve({
        nextPageToken: 'number_next',
        resources: [whatsappNumber({ futureField: 'from-a-newer-api' })]
      })
    )
    const listOperations = vi.fn()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: {
          getWhatsappBusinessAccount,
          listOperations,
          listResources
        }
      })
    )

    const accounts = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'account',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--limit',
      '1'
    ])
    expect(JSON.parse(accounts.stdout)).toEqual({ accounts: [account] })

    const numbers = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--limit',
      '1'
    ])
    expect(JSON.parse(numbers.stdout)).toEqual({
      nextPageToken: 'number_next',
      resources: [whatsappNumber({ futureField: 'from-a-newer-api' })]
    })
    expect(listOperations).not.toHaveBeenCalled()
    expect(numbers.stdout).toContain('from-a-newer-api')
    await authenticated.remove()
  })

  test('views an addressed retired sender but rejects another resource type', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(
        whatsappNumber({
          abilities: [],
          retiredAt: timestamp,
          state: 'retired'
        })
      )
      .mockResolvedValueOnce(whatsappNumber({ type: 'voip_line' }))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } })
    )

    const viewed = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'view',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(viewed.stdout)).toEqual(
      whatsappNumber({
        abilities: [],
        retiredAt: timestamp,
        state: 'retired'
      })
    )

    const wrongType = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'view',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(wrongType.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(wrongType.stderr).toBe('')
    await authenticated.remove()
  })

  test('requires exact phone confirmation and cancels without mutation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const releaseResource = vi.fn()
    const invoke = terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } }),
      {
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        }),
        stdin: inputStream('+14155550198\n', true)
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(result.stdout).toBe('')
    expect(result.exitCodes).toEqual([1])
    expect(result.stderr).toContain('Cancelled.')
    expect(result.stderr).toContain('stops it from sending')
    expect(result.stderr).toContain('Type +14155550199 to confirm:')
    expect(getResource).toHaveBeenCalledOnce()
    expect(releaseResource).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('rejects non-interactive deletion without --yes', async () => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi.fn()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: { getResource: () => Promise.resolve(whatsappNumber()) }
      }),
      {
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        }),
        stdin: inputStream('', false)
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'CONFIRMATION_REQUIRED' }
    })
    expect(result.exitCodes).toEqual([2])
    expect(releaseResource).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('accepts the exact phone and observes the final-sender account cascade', async () => {
    const authenticated = await createAuthenticatedConfig()
    let connected = true
    const getWhatsappBusinessAccount = vi.fn(() =>
      connected ? Promise.resolve(account) : Promise.reject(notConnected())
    )
    const releaseResource = vi.fn(() => {
      connected = false
      return Promise.resolve(rawResponse(resourceOperation('succeeded'), 200))
    })
    const projectScope = asProjectScope({
      platforms: {
        getResource: () => Promise.resolve(whatsappNumber()),
        getWhatsappBusinessAccount
      }
    })
    const projectRawScope = asProjectRawScope({
      platforms: { releaseResource }
    })
    const atTerminal = terminalInvoker(
      authenticated.configDirectory,
      projectScope,
      { projectRawScope, stdin: inputStream('+14155550199\n', true) }
    )
    const invoke = cliInvoker(authenticated.configDirectory, projectScope, {
      projectRawScope
    })

    const deleted = await atTerminal([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(deleted.exitCodes).toEqual([])
    expect(deleted.stdout).toContain(
      'Deleted WhatsApp Business number +14155550199 (pho_res_00000000000000000000000001).'
    )

    const accounts = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'account',
      'list',
      '--project',
      'pho_prj_00000000000000000000000001'
    ])
    expect(JSON.parse(accounts.stdout)).toEqual({ accounts: [] })
    expect(releaseResource).toHaveBeenCalledOnce()
    expect(getWhatsappBusinessAccount).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('deletes with --yes and emits only the stable success result', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('succeeded'), 200))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])

    expect(JSON.parse(result.stdout)).toEqual({
      operation: resourceOperation('succeeded')
    })
    expect(result.stderr).toBe('')
    expect(getResource).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000001'
        }
      },
      undefined
    )
    expect(result.stdout).toContain('from-a-newer-api')
    expect(result.stdout).toContain('accountDisconnected')
    await authenticated.remove()
  })

  test('replays a release from its recorded remote operation ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    let sleepCalls = 0
    const clock: PollClock = {
      now: () => sleepCalls * 1000,
      sleep: () => {
        sleepCalls += 1
        throw new DOMException('cancelled', 'AbortError')
      },
      wallNow: () => TEST_NOW + sleepCalls * 1000
    }
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const getOperation = vi.fn(() =>
      Promise.resolve({ operation: resourceOperation('succeeded') })
    )
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('pending'), 202, '3'))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock,
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    expect(failure).toMatchObject({
      error: {
        code: 'COMMAND_INTERRUPTED',
        remoteOperationId: 'remote_whatsapp_release',
        replayable: true
      }
    })
    const operationsRoot = join(authenticated.configDirectory, 'operations')
    const [scopeDirectory] = await readdir(operationsRoot)
    if (scopeDirectory === undefined) {
      throw new Error('Expected a scoped operation directory.')
    }
    const persisted = await readFile(
      join(operationsRoot, scopeDirectory, `${failure.error.operationId}.json`),
      'utf8'
    )
    expect(persisted).not.toContain('+14155550199')
    expect(persisted).not.toContain('from-a-newer-api')
    expect(persisted).not.toContain('accountDisconnected')

    const viewed = await invoke([
      'operation',
      'view',
      failure.error.operationId
    ])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      operation: {
        command: 'project platform whatsapp-business number delete',
        input: {
          projectId: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000001'
        },
        kind: 'whatsapp-business-number.delete',
        remoteOperationId: 'remote_whatsapp_release'
      }
    })
    expect(viewed.stdout).not.toContain('+14155550199')
    expect(viewed.stdout).not.toContain('from-a-newer-api')
    expect(viewed.stdout).not.toContain('accountDisconnected')

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    const replayedRelease = JSON.parse(replayed.stdout) as { result: unknown }
    expect(replayedRelease).toMatchObject({
      operation: {
        kind: 'whatsapp-business-number.delete',
        status: 'resolved'
      }
    })
    expect(replayedRelease.result).toEqual({
      operation: resourceOperation('succeeded')
    })
    expect(releaseResource).toHaveBeenCalledOnce()
    expect(getOperation).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('replay converges without a remote ID when the sender is retired', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(whatsappNumber())
      .mockResolvedValueOnce(
        whatsappNumber({
          abilities: [],
          retiredAt: timestamp,
          state: 'retired'
        })
      )
    const releaseResource = vi.fn(() =>
      Promise.reject(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } }),
      {
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const failed = await invoke([
      'project',
      'platform',
      'whatsapp-business',
      'number',
      'delete',
      'pho_res_00000000000000000000000001',
      '--project',
      'pho_prj_00000000000000000000000001',
      '--yes'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])

    expect(JSON.parse(replayed.stdout)).toMatchObject({
      result: {
        resource: whatsappNumber({
          abilities: [],
          retiredAt: timestamp,
          state: 'retired'
        })
      }
    })
    expect(releaseResource).toHaveBeenCalledOnce()
    expect(JSON.stringify(replayed)).toContain('+14155550199')
    await authenticated.remove()
  })

  test('replay converges without a remote ID when the sender is gone', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getResource = vi
      .fn()
      .mockResolvedValueOnce(whatsappNumber())
      .mockRejectedValueOnce(resourceNotFound())
    const releaseResource = vi.fn(() =>
      Promise.reject(
        new ResponseValidationError('releaseResource', [], { status: 200 })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getResource } }),
      {
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const operationId = failedOperationId(
      (await invoke(WHATSAPP_NUMBER_DELETE)).stdout
    )
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.stderr).toBe('')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'whatsapp-business-number.delete',
        status: 'resolved'
      },
      result: {
        deleted: true,
        resourceId: 'pho_res_00000000000000000000000001'
      }
    })
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test('keeps a release unresolved when its operation is not found and the sender is active', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
    const getResource = vi.fn(() => Promise.resolve(whatsappNumber()))
    const releaseResource = vi.fn(() =>
      Promise.resolve(rawResponse(resourceOperation('pending'), 202, '3'))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({ platforms: { getOperation, getResource } }),
      {
        clock: interruptedPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        })
      }
    )

    const operationId = failedOperationId(
      (await invoke(WHATSAPP_NUMBER_DELETE)).stdout
    )
    const replayed = await invoke(['operation', 'replay', operationId, '--yes'])

    expect(replayed.exitCodes).toEqual([1])
    expect(replayed.stderr).not.toContain('resolved')
    expect(replayed.stdout).not.toContain('resolved')
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_OPERATION_OUTCOME_UNKNOWN',
        message: 'The outcome of the operation is unknown.',
        next: [
          {
            description: 'Replay the operation',
            run: `${CLI_NAME} operation replay ${operationId}`
          }
        ],
        operationId,
        replayable: true
      }
    })
    const viewed = JSON.parse(
      (await invoke(['operation', 'view', operationId])).stdout
    ) as { operation: Record<string, unknown> }
    expect(viewed.operation).toMatchObject({
      kind: 'whatsapp-business-number.delete',
      status: 'outcome-unknown'
    })
    expect(viewed.operation).not.toHaveProperty('remoteOperationId')
    expect(getOperation).toHaveBeenCalledOnce()
    expect(releaseResource).toHaveBeenCalledOnce()
    await authenticated.remove()
  })

  test.each([
    [
      'retired',
      () =>
        Promise.resolve(
          whatsappNumber({
            abilities: [],
            retiredAt: timestamp,
            state: 'retired'
          })
        )
    ],
    ['gone', () => Promise.reject(resourceNotFound())]
  ])(
    'resolves a release when its operation is not found and the sender is %s',
    async (_target, readTarget) => {
      const authenticated = await createAuthenticatedConfig()
      const getOperation = vi.fn(() => Promise.reject(operationNotFound()))
      const getResource = vi
        .fn()
        .mockResolvedValueOnce(whatsappNumber())
        .mockImplementationOnce(readTarget)
      const releaseResource = vi.fn(() =>
        Promise.resolve(rawResponse(resourceOperation('pending'), 202, '3'))
      )
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({ platforms: { getOperation, getResource } }),
        {
          clock: interruptedPollClock(),
          projectRawScope: asProjectRawScope({
            platforms: { releaseResource }
          })
        }
      )

      const operationId = failedOperationId(
        (await invoke(WHATSAPP_NUMBER_DELETE)).stdout
      )
      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])

      expect(replayed.stderr).toBe('')
      expect(JSON.parse(replayed.stdout)).toMatchObject({
        operation: {
          kind: 'whatsapp-business-number.delete',
          status: 'resolved'
        },
        result: {
          deleted: true,
          resourceId: 'pho_res_00000000000000000000000001'
        }
      })
      expect(getOperation).toHaveBeenCalledOnce()
      expect(getResource).toHaveBeenCalledTimes(2)
      expect(releaseResource).toHaveBeenCalledOnce()
      await authenticated.remove()
    }
  )

  test('renders documented human tables and number details', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = asProjectScope({
      platforms: {
        getResource: () => Promise.resolve(whatsappNumber()),
        getWhatsappBusinessAccount: () => Promise.resolve(account),
        listResources: () => Promise.resolve({ resources: [whatsappNumber()] })
      }
    })
    const commands = [
      ['account', 'list'],
      ['number', 'list'],
      ['number', 'view', 'pho_res_00000000000000000000000001']
    ]
    const outputs: string[] = []
    for (const command of commands) {
      const stdout = collector()
      // biome-ignore lint/performance/noAwaitInLoops: each command needs a fresh output collector.
      await runCli(
        [
          'project',
          'platform',
          'whatsapp-business',
          ...command,
          '--project',
          'pho_prj_00000000000000000000000001'
        ],
        {
          configDirectory: authenticated.configDirectory,
          deviceScope: unusedDeviceScope(),
          now: () => TEST_NOW,
          platform: 'linux',
          projectScope: scope,
          stderr: collector(),
          stdout
        }
      )
      outputs.push(stdout.value())
    }

    expect(outputs[0]).toContain('WABA ID')
    expect(outputs[0]).toContain('BUSINESS ID')
    expect(outputs[1]).toContain('DISPLAY NAME')
    expect(outputs[1]).toContain('NAME STATUS')
    expect(outputs[1]).toContain('QUALITY')
    expect(outputs[2]).toContain('Phone number ID')
    expect(outputs[2]).toContain('Retired')
    await authenticated.remove()
  })

  test('renders the documented account and number empty states', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = asProjectScope({
      platforms: {
        getWhatsappBusinessAccount: () => Promise.reject(notConnected()),
        listResources: () => Promise.resolve({ resources: [] })
      }
    })
    const stdout = collector()
    const stderr = collector()
    await runCli(
      [
        'project',
        'platform',
        'whatsapp-business',
        'account',
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
    await runCli(
      [
        'project',
        'platform',
        'whatsapp-business',
        'number',
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

    expect(stdout.value()).toBe('')
    expect(stderr.value()).toBe(
      'No WhatsApp Business accounts found.\nNo active WhatsApp Business numbers found.\n'
    )
    await authenticated.remove()
  })
})

const operationNotFound = (): ApiError =>
  new ApiError('not found', {
    body: { code: 'OPERATION_NOT_FOUND', detail: 'Operation not found.' },
    headers: new Headers(),
    operationId: 'getOperation',
    status: 404
  })

const resourceNotFound = (): ApiError =>
  new ApiError('not found', {
    body: { code: 'RESOURCE_NOT_FOUND', detail: 'Resource not found.' },
    headers: new Headers(),
    operationId: 'getResource',
    status: 404
  })

const notConnected = (): ApiError =>
  new ApiError('No connected account', {
    body: {
      code: 'WHATSAPP_WABA_NOT_CONNECTED',
      detail: 'No connected account'
    },
    headers: new Headers(),
    status: 404
  })
