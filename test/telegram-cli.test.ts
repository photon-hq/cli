import { Readable } from 'node:stream'
import { ApiError, ResponseValidationError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import type { WritableOutput } from '../src/core/output.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  apiCalls,
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  lateFailingStdout,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const SETUP_URL = 'https://t.me/PhotonManagerBot?start=setup_token-1'
const QR = '<qr code>'

const operation = (state: string, overrides: Record<string, unknown> = {}) => ({
  cancellable: state === 'pending',
  createdAt: timestamp,
  ...(state === 'pending' || state === 'running'
    ? { detail: { setupUrl: SETUP_URL } }
    : {}),
  operationId: OPERATION_ID,
  projectId: 'pho_prj_00000000000000000000000001',
  resourceType: 'telegram_bot',
  state,
  type: 'resource.provision',
  updatedAt: timestamp,
  ...overrides
})

const bot = (detail: Record<string, unknown> = {}) => ({
  abilities: ['telegram'],
  createdAt: timestamp,
  detail: {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot',
    ...detail
  },
  projectId: 'pho_prj_00000000000000000000000001',
  resourceId: 'pho_res_00000000000000000000000031',
  state: 'active',
  type: 'telegram_bot',
  updatedAt: timestamp
})

const rawResponse = <Result>(data: Result) => ({
  data,
  headers: new Headers({ 'retry-after': '5' }),
  status: 202
})

const terminal = (): ReadableInput => {
  const input = Readable.from([]) as ReadableInput
  input.isTTY = true
  return input
}

const createScope = () => {
  const platforms = {
    getOperation: vi.fn(() =>
      Promise.resolve<{
        operation: ReturnType<typeof operation>
        resource?: ReturnType<typeof bot>
      }>({
        operation: operation('succeeded'),
        resource: bot()
      })
    ),
    getResource: vi.fn(() => Promise.resolve(bot())),
    listOperations: vi.fn(() =>
      Promise.resolve<{ operations: ReturnType<typeof operation>[] }>({
        operations: []
      })
    ),
    listResources: vi.fn(() => Promise.resolve({ resources: [bot()] }))
  }
  const raw = {
    connectTelegramBot: vi.fn(() =>
      Promise.resolve(rawResponse(operation('pending')))
    ),
    releaseResource: vi.fn(() =>
      Promise.resolve(
        rawResponse(
          operation('succeeded', {
            resourceId: 'pho_res_00000000000000000000000031',
            type: 'resource.release'
          })
        )
      )
    )
  }
  return { platforms, raw }
}

interface InvokeOptions {
  browserLauncher?: (url: string) => Promise<void>
  /** A signed-in configuration to share between runs; a fresh one without. */
  configDirectory?: string
  confirm?: (message: string) => Promise<boolean>
  interactive?: boolean
  stdout?: WritableOutput
}

const invoke = async (
  args: string[],
  scope: ReturnType<typeof createScope>,
  options: InvokeOptions = {}
) => {
  const authenticated =
    options.configDirectory === undefined
      ? await createAuthenticatedConfig()
      : {
          configDirectory: options.configDirectory,
          remove: () => Promise.resolve()
        }
  const stderr = collector(options.interactive === true)
  const stdout = collector(options.interactive === true)
  const exitCodes: number[] = []
  const clock = instantPollClock()
  const browserLauncher =
    options.browserLauncher ?? vi.fn(() => Promise.resolve())
  const mfaQr = vi.fn(() => QR)
  await runCli(
    [
      'project',
      'platform',
      'telegram',
      ...args,
      '--project',
      'pho_prj_00000000000000000000000001',
      '--no-color'
    ],
    {
      browserLauncher,
      clock,
      configDirectory: authenticated.configDirectory,
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
      deviceScope: unusedDeviceScope(),
      mfaQr,
      now: () => TEST_NOW,
      organizationScope: asOrganizationScope(),
      platform: 'linux',
      projectRawScope: asProjectRawScope({ platforms: scope.raw }),
      projectScope: asProjectScope({ platforms: scope.platforms }),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      ...(options.interactive === true ? { stdin: terminal() } : {}),
      stdout: options.stdout ?? stdout
    }
  )
  await authenticated.remove()
  return {
    browserLauncher,
    clock,
    exitCodes,
    mfaQr,
    stderr: stderr.value(),
    stdout: stdout.value()
  }
}

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe(`${CLI_NAME} project platform telegram connect`, () => {
  test('waits with or without --json, unless --no-wait, and sends the same requests', async () => {
    const connect = async (flags: string[]) => {
      const scope = createScope()
      scope.platforms.getOperation.mockResolvedValueOnce({
        operation: operation('running')
      })
      const result = await invoke(
        ['connect', '--idempotency-key', 'telegram-parity', '--yes', ...flags],
        scope
      )
      return {
        ...result,
        calls: apiCalls({ ...scope, browser: result.browserLauncher })
      }
    }

    const text = await connect([])
    const json = await connect(['--json'])
    const noWait = await connect(['--json', '--no-wait'])

    const byName = (calls: unknown[][]) =>
      [...calls].sort(([left], [right]) =>
        String(left).localeCompare(String(right))
      )
    const names = text.calls.map(([name]) => name)
    expect(byName(json.calls)).toEqual(byName(text.calls))
    expect(names.slice(0, 2).sort()).toEqual([
      'platforms.listOperations',
      'platforms.listResources'
    ])
    expect(names.slice(2)).toEqual([
      'raw.connectTelegramBot',
      'browser',
      'platforms.getOperation',
      'platforms.getOperation'
    ])
    expect(byName(noWait.calls)).toEqual(byName(text.calls.slice(0, 4)))
    expect([text.exitCodes, json.exitCodes, noWait.exitCodes]).toEqual([
      [],
      [],
      []
    ])
    expect(text.stderr).toBe('')
    expect(json.stderr).toContain('Waiting for the bot to be connected')
    expect(text.stdout.startsWith(json.stderr)).toBe(true)
    expect(text.stdout).toContain('Connected @AlexSupportBot.')
    expect(JSON.parse(json.stdout)).toMatchObject({
      operation: { state: 'succeeded' },
      resource: {
        resourceId: 'pho_res_00000000000000000000000031',
        state: 'active'
      }
    })
    expect(noWait.stderr).toBe('')
    expect(JSON.parse(noWait.stdout)).toMatchObject({
      operation: { detail: { setupUrl: SETUP_URL }, state: 'pending' }
    })
  })

  test('returns the setup at once for JSON automation that passes --no-wait', async () => {
    const scope = createScope()

    const result = await invoke(
      [
        'connect',
        '--idempotency-key',
        'telegram-key',
        '--no-wait',
        '--json',
        '--yes'
      ],
      scope
    )

    expect(JSON.parse(result.stdout)).toEqual({
      operation: operation('pending')
    })
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledWith(
      {
        body: {},
        headers: { idempotencyKey: 'telegram-key' },
        path: { id: 'pho_prj_00000000000000000000000001' }
      },
      undefined
    )
    expect(result.browserLauncher).toHaveBeenCalledExactlyOnceWith(SETUP_URL)
    expect(result.mfaQr).not.toHaveBeenCalled()
    expect(scope.platforms.getOperation).not.toHaveBeenCalled()
    expect(result.exitCodes).toEqual([])
  })

  test('opens nothing for JSON automation that passes --no-browser', async () => {
    const scope = createScope()
    scope.platforms.listResources.mockResolvedValueOnce({ resources: [] })

    const result = await invoke(
      ['connect', '--no-browser', '--no-wait', '--json'],
      scope,
      { interactive: true }
    )

    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: { detail: { setupUrl: SETUP_URL } }
    })
    expect(result.browserLauncher).not.toHaveBeenCalled()
    expect(result.mfaQr).not.toHaveBeenCalled()
  })

  test('opens the link, shows a code to scan and waits for the bot', async () => {
    const scope = createScope()
    scope.platforms.listResources.mockResolvedValueOnce({ resources: [] })
    scope.platforms.getOperation
      .mockResolvedValueOnce({ operation: operation('pending') })
      .mockResolvedValueOnce({ operation: operation('running') })

    const result = await invoke(['connect'], scope, { interactive: true })

    expect(result.browserLauncher).toHaveBeenCalledExactlyOnceWith(SETUP_URL)
    expect(result.mfaQr).toHaveBeenCalledExactlyOnceWith(SETUP_URL)
    expect(result.stdout).toContain('Started a Telegram bot setup.')
    expect(result.stdout).not.toContain('already has')
    expect(result.stdout).toContain(SETUP_URL)
    expect(result.stdout).toContain(QR)
    expect(result.stdout).toContain('Opened the setup link in your browser.')
    expect(result.stdout).toContain('Press Ctrl-C to stop waiting')
    expect(result.stdout).toContain('Connected @AlexSupportBot.')
    expect(result.stdout).toContain('Alex Support')
    expect(result.clock.sleeps).toEqual([5000, 5000])
    expect(result.exitCodes).toEqual([])
  })

  test('prints the link only, without a terminal, a browser or a wait', async () => {
    const scope = createScope()

    const result = await invoke(
      ['connect', '--no-browser', '--no-wait', '--yes'],
      scope
    )

    expect(result.stdout).toContain(SETUP_URL)
    expect(result.stdout).not.toContain(QR)
    expect(result.stdout).not.toContain('Waiting for the bot')
    expect(result.browserLauncher).not.toHaveBeenCalled()
    expect(result.mfaQr).not.toHaveBeenCalled()
    expect(scope.platforms.getOperation).not.toHaveBeenCalled()
  })

  test('asks a person before adding a bot to a project that has one', async () => {
    const scope = createScope()
    const confirm = vi.fn(() => Promise.resolve(true))

    const result = await invoke(['connect', '--no-wait'], scope, {
      confirm,
      interactive: true
    })

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Connect another Telegram bot to project pho_prj_00000000000000000000000001? Project pho_prj_00000000000000000000000001 already has @AlexSupportBot connected.'
    )
    expect(scope.platforms.listResources).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'telegram', pageSize: 30 }
      },
      undefined
    )
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledOnce()
    expect(result.stdout).toContain('This setup adds another bot.')
  })

  test('does not ask when the connect continues a setup in progress', async () => {
    // Declining would leave the person without the link of their own setup.
    const scope = createScope()
    scope.platforms.listOperations.mockResolvedValue({
      operations: [operation('pending')]
    })
    const confirm = vi.fn(() => Promise.resolve(false))

    const result = await invoke(['connect', '--no-wait'], scope, {
      confirm,
      interactive: true
    })

    expect(confirm).not.toHaveBeenCalled()
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledOnce()
    expect(result.stdout).toContain(SETUP_URL)
  })

  test('starts nothing when the person declines to add a bot', async () => {
    const scope = createScope()

    const result = await invoke(['connect'], scope, {
      confirm: () => Promise.resolve(false),
      interactive: true
    })

    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Cancelled.')
    expect(result.exitCodes).toEqual([1])
    expect(scope.raw.connectTelegramBot).not.toHaveBeenCalled()
    expect(result.browserLauncher).not.toHaveBeenCalled()
  })

  test('needs --yes to add a bot to a project that has one when nobody can answer', async () => {
    const scope = createScope()

    const refused = await invoke(['connect', '--no-wait'], scope)

    expect(refused.exitCodes).toEqual([2])
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain(
      'Error: This would connect another Telegram bot to project pho_prj_00000000000000000000000001. Confirm it with --yes. (CONFIRMATION_REQUIRED)'
    )
    expect(refused.stderr).toContain(
      `Next: Run it again with --yes: ${CLI_NAME} project platform telegram connect --no-color --no-wait --project pho_prj_00000000000000000000000001 --yes`
    )
    expect(scope.raw.connectTelegramBot).not.toHaveBeenCalled()

    const result = await invoke(['connect', '--no-wait', '-y'], scope)

    expect(result.exitCodes).toEqual([])
    expect(result.stdout).toContain(
      'Project pho_prj_00000000000000000000000001 already has @AlexSupportBot connected. This setup adds another bot.'
    )
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledOnce()
  })

  test('does not ask again when an idempotency key continues a request', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = createScope()
    scope.raw.connectTelegramBot.mockRejectedValueOnce(
      new ResponseValidationError('connectTelegramBot', [], { status: 202 })
    )
    const confirm = vi.fn(() => Promise.resolve(false))
    const args = ['connect', '--idempotency-key', 'telegram-key', '--no-wait']

    const lost = await invoke([...args, '--yes'], scope, {
      configDirectory: authenticated.configDirectory
    })
    await invoke(args, scope, {
      configDirectory: authenticated.configDirectory,
      confirm,
      interactive: true
    })

    expect(lost.exitCodes).toEqual([1])
    expect(confirm).not.toHaveBeenCalled()
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledTimes(2)
    await authenticated.remove()
  })

  test('asks before a new idempotency key adds another bot', async () => {
    const scope = createScope()
    const confirm = vi.fn(() => Promise.resolve(false))
    const args = [
      'connect',
      '--idempotency-key',
      'telegram-new-key',
      '--no-wait'
    ]

    const declined = await invoke(args, scope, { confirm, interactive: true })
    const refused = await invoke([...args, '--json'], scope)

    expect(confirm).toHaveBeenCalledOnce()
    expect(declined.exitCodes).toEqual([1])
    expect(refused.exitCodes).toEqual([2])
    expect(JSON.parse(refused.stdout)).toMatchObject({
      error: { code: 'CONFIRMATION_REQUIRED' }
    })
    expect(scope.raw.connectTelegramBot).not.toHaveBeenCalled()
  })

  test('connects all the same when the bots cannot be read', async () => {
    const scope = createScope()
    scope.platforms.listResources.mockRejectedValueOnce(
      new Error('unavailable')
    )

    const result = await invoke(['connect', '--no-wait'], scope, {
      interactive: true
    })

    expect(result.stdout).toContain('Started a Telegram bot setup.')
    expect(result.stdout).not.toContain('already has')
    expect(result.exitCodes).toEqual([])
  })

  test('keeps the link on screen when the browser cannot be opened', async () => {
    const scope = createScope()

    const result = await invoke(['connect', '--no-wait', '--yes'], scope, {
      browserLauncher: vi.fn(() => Promise.reject(new Error('no browser')))
    })

    expect(result.stdout).toContain(SETUP_URL)
    expect(result.stdout).not.toContain('Opened the setup link')
    expect(result.stderr).toContain('browser could not be opened')
    expect(result.exitCodes).toEqual([])
  })

  test('continues the setup already in progress and says how to start over', async () => {
    const scope = createScope()
    scope.raw.connectTelegramBot.mockRejectedValueOnce(
      new ApiError('conflict', {
        body: {
          code: 'TELEGRAM_PROVISION_IN_PROGRESS',
          operationId: OPERATION_ID,
          operationUrl: `/v1/projects/pho_prj_00000000000000000000000001/platforms/operations/${OPERATION_ID}`
        },
        headers: new Headers(),
        operationId: 'connectTelegramBot',
        status: 409
      })
    )
    scope.platforms.getOperation.mockResolvedValueOnce({
      operation: operation('pending', {
        detail: { displayName: 'Alex Support', setupUrl: SETUP_URL }
      })
    })

    const result = await invoke(['connect', '--no-wait', '--yes'], scope)

    expect(result.stdout).toContain(
      'Continuing the Telegram bot setup already in progress.'
    )
    expect(result.stdout).toContain('Alex Support')
    expect(result.stdout).toContain(
      `${CLI_NAME} project platform operation cancel ${OPERATION_ID}`
    )
    expect(result.browserLauncher).toHaveBeenCalledExactlyOnceWith(SETUP_URL)
    expect(scope.raw.connectTelegramBot).toHaveBeenCalledOnce()
  })

  test('says so when Photon returns no usable setup link', async () => {
    const scope = createScope()
    scope.raw.connectTelegramBot.mockResolvedValueOnce(
      rawResponse(operation('pending', { detail: {} }))
    )

    const result = await invoke(['connect', '--no-wait', '--yes'], scope)

    expect(result.stderr).toContain('did not return the setup link')
    expect(result.browserLauncher).not.toHaveBeenCalled()
    expect(result.exitCodes).toEqual([])
  })

  test('shows the bot when a replayed key names a finished setup', async () => {
    const scope = createScope()
    scope.raw.connectTelegramBot.mockResolvedValueOnce(
      rawResponse(operation('succeeded'))
    )

    const result = await invoke(
      ['connect', '--idempotency-key', 'telegram-key', '--json', '--yes'],
      scope
    )

    expect(JSON.parse(result.stdout)).toEqual({
      operation: operation('succeeded'),
      resource: bot()
    })
    expect(result.browserLauncher).not.toHaveBeenCalled()
    expect(result.clock.sleeps).toEqual([])
  })

  test.each([
    [
      'ENOSPC',
      'Error: Photon could not write the result to standard output. (OUTPUT_WRITE_FAILED)\n'
    ],
    ['EPIPE', '']
  ] as const)(
    'stops before the wait when stdout fails with %s, and reports it as every command without a record does',
    async (code, stderr) => {
      const scope = createScope()

      const result = await invoke(['connect', '--no-browser', '--yes'], scope, {
        stdout: lateFailingStdout(code)
      })

      expect(result.stderr).toBe(stderr)
      expect(result.exitCodes).toEqual([1])
      expect(scope.platforms.getOperation).not.toHaveBeenCalled()
    }
  )

  test('fails when the setup is cancelled while waiting', async () => {
    const scope = createScope()
    scope.platforms.getOperation
      .mockResolvedValueOnce({ operation: operation('pending') })
      .mockResolvedValueOnce({ operation: operation('cancelled') })

    const result = await invoke(['connect', '--no-browser', '--yes'], scope)

    expect(result.stderr).toContain('The resource operation was cancelled.')
    expect(result.stdout).not.toContain('Connected')
    expect(result.exitCodes).toEqual([1])
  })

  test('prints only the error document when the setup is cancelled while waiting with --json', async () => {
    const scope = createScope()
    scope.platforms.getOperation
      .mockResolvedValueOnce({ operation: operation('pending') })
      .mockResolvedValueOnce({ operation: operation('cancelled') })

    const result = await invoke(
      ['connect', '--no-browser', '--json', '--yes'],
      scope
    )

    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { remoteOperationId: OPERATION_ID }
    })
    expect(result.stderr).toContain(
      'Waiting for the bot to be connected in Telegram.'
    )
    expect(result.stderr).not.toContain('{')
    expect(result.exitCodes).toEqual([1])
  })
})

describe(`${CLI_NAME} project platform telegram list, view and disconnect`, () => {
  test('lists bots and setups in progress', async () => {
    const scope = createScope()
    scope.platforms.listOperations.mockResolvedValue({
      operations: [operation('pending')]
    })

    const json = await invoke(['list', '--json'], scope)
    const human = await invoke(['list'], scope)

    expect(JSON.parse(json.stdout)).toEqual({
      provisioning: [operation('pending')],
      resources: [bot()]
    })
    expect(scope.platforms.listResources).toHaveBeenCalledWith(
      {
        path: { id: 'pho_prj_00000000000000000000000001' },
        query: { ability: 'telegram', pageSize: 30 }
      },
      undefined
    )
    expect(human.stdout).toContain('Telegram bots')
    expect(human.stdout).toContain('@AlexSupportBot')
    expect(human.stdout).toContain('healthy')
    expect(human.stdout).toContain(OPERATION_ID)
    expect(human.stdout).toContain(
      `Continue a setup in progress with "${CLI_NAME} project platform telegram connect".`
    )
  })

  test('views a bot and explains a connection issue', async () => {
    const scope = createScope()
    scope.platforms.getResource
      .mockResolvedValueOnce(bot())
      .mockResolvedValueOnce(bot({ connectionIssue: 'owner_changed' }))

    const json = await invoke(
      ['view', 'pho_res_00000000000000000000000031', '--json'],
      scope
    )
    const human = await invoke(
      ['view', 'pho_res_00000000000000000000000031'],
      scope
    )

    expect(JSON.parse(json.stdout)).toEqual(bot())
    expect(human.stdout).toContain('@AlexSupportBot')
    expect(human.stdout).toContain('https://t.me/AlexSupportBot')
    expect(human.stdout).toContain('needs attention')
    expect(human.stdout).toContain('The owner of this bot changed in Telegram.')
  })

  test('prints a name inert in text and unchanged in JSON', async () => {
    const scope = createScope()
    const resource = bot({ displayName: 'Alex\u001b[31m Support' })
    scope.platforms.getResource.mockResolvedValue(resource)

    const human = await invoke(
      ['view', 'pho_res_00000000000000000000000031'],
      scope
    )
    const json = await invoke(
      ['view', 'pho_res_00000000000000000000000031', '--json'],
      scope
    )

    expect(human.stdout).not.toContain('\u001b')
    expect(human.stdout).toContain('Alex^[[31m Support')
    expect(JSON.parse(json.stdout)).toEqual(resource)
  })

  test('disconnects a bot after confirmation', async () => {
    const scope = createScope()
    const confirm = vi.fn(() => Promise.resolve(true))

    const result = await invoke(
      ['disconnect', 'pho_res_00000000000000000000000031'],
      scope,
      {
        confirm
      }
    )

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Disconnect Telegram bot resource pho_res_00000000000000000000000031 from project pho_prj_00000000000000000000000001? The bot stops sending and receiving through Photon. It is not deleted from Telegram.'
    )
    expect(scope.raw.releaseResource).toHaveBeenCalledWith(
      {
        path: {
          id: 'pho_prj_00000000000000000000000001',
          resourceId: 'pho_res_00000000000000000000000031'
        }
      },
      undefined
    )
    expect(result.stdout).toContain(
      'Disconnected Telegram bot resource pho_res_00000000000000000000000031.'
    )
    expect(result.stdout).toContain('The bot still exists in Telegram')
  })

  test('returns a stable JSON result with --yes', async () => {
    const scope = createScope()

    const result = await invoke(
      ['disconnect', 'pho_res_00000000000000000000000031', '--yes', '--json'],
      scope
    )

    expect(JSON.parse(result.stdout)).toEqual({
      operation: operation('succeeded', {
        resourceId: 'pho_res_00000000000000000000000031',
        type: 'resource.release'
      })
    })
  })

  test('leaves the bot connected when the confirmation is declined', async () => {
    const scope = createScope()

    const result = await invoke(
      ['disconnect', 'pho_res_00000000000000000000000031'],
      scope,
      {
        confirm: () => Promise.resolve(false)
      }
    )

    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Cancelled.')
    expect(scope.raw.releaseResource).not.toHaveBeenCalled()
  })
})
