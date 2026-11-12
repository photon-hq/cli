import { afterEach, describe, expect, test, vi } from 'vitest'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import {
  asOrganizationScope,
  asProjectRawScope,
  asProjectScope,
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const RESOURCE_ID = 'pho_res_00000000000000000000000011'
const OPERATION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const PHONE_NUMBER = '+14155550125'

const feature = (status: string, cause: string | null = null) => ({
  cause,
  status
})

// A line's detail as Platforms sends it: one health object per product, with
// a status and its cause for each iMessage feature.
const lineDetail = (overallStatus: string) => ({
  imessageHealth: {
    account: feature('limited'),
    imessageOnPhoneNumber: feature('available'),
    mms: feature('available'),
    newConversations: feature('unavailable', 'account'),
    outboundPhoneCalling: feature('available'),
    overallStatus,
    photonSystemComponents: feature('available'),
    sms: feature('available')
  },
  phoneNumber: PHONE_NUMBER,
  whatsappHealth: { overallStatus: 'available' }
})

const line = (detail: Record<string, unknown>) => ({
  abilities: ['imessage', 'pstn_voice'],
  createdAt: timestamp,
  detail,
  projectId: PROJECT_ID,
  resourceId: RESOURCE_ID,
  state: 'active',
  type: 'cosmos_line',
  updatedAt: timestamp
})

const operation = (state: string) => ({
  cancellable: false,
  createdAt: timestamp,
  operationId: OPERATION_ID,
  projectId: PROJECT_ID,
  resourceType: 'cosmos_line',
  startedAt: timestamp,
  state,
  type: 'resource.provision',
  updatedAt: timestamp
})

const createScope = (resource: ReturnType<typeof line>) => ({
  platforms: {
    getOperation: vi.fn(() =>
      Promise.resolve({ operation: operation('succeeded'), resource })
    ),
    listOperations: vi.fn(() => Promise.resolve({ operations: [] })),
    listResources: vi.fn(() => Promise.resolve({ resources: [resource] }))
  },
  raw: {
    provisionImessageDedicatedLine: vi.fn(() =>
      Promise.resolve({
        data: operation('running'),
        headers: new Headers({ 'retry-after': '1' }),
        status: 202
      })
    )
  }
})

const invoke = async (
  args: string[],
  scope: ReturnType<typeof createScope>,
  platform = 'imessage'
) => {
  const authenticated = await createAuthenticatedConfig()
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli(
    [
      'project',
      'platform',
      platform,
      ...args,
      '--project',
      PROJECT_ID,
      '--no-color'
    ],
    {
      clock: instantPollClock(),
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      organizationScope: asOrganizationScope(),
      platform: 'linux',
      projectRawScope: asProjectRawScope({ platforms: scope.raw }),
      projectScope: asProjectScope({ platforms: scope.platforms }),
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    }
  )
  await authenticated.remove()
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const listed = (health: string): string => {
  const width = Math.max('HEALTH'.length, health.length)
  return [
    'iMessage resources',
    `PHONE NUMBER  RESOURCE ID                         ${'HEALTH'.padEnd(width)}  STATE   ABILITIES             CREATED`,
    `${PHONE_NUMBER}  ${RESOURCE_ID}  ${health.padEnd(width)}  active  imessage, pstn_voice  ${timestamp}`,
    ''
  ].join('\n')
}

const purchased = (health: string): string =>
  [
    `Provisioned iMessage line ${PHONE_NUMBER}.`,
    'iMessage resource',
    `Phone number  ${PHONE_NUMBER}`,
    `Resource ID   ${RESOURCE_ID}`,
    'State         active',
    `Health        ${health}`,
    'Abilities     imessage, pstn_voice',
    `Project       ${PROJECT_ID}`,
    `Created       ${timestamp}`,
    `Updated       ${timestamp}`,
    ''
  ].join('\n')

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe(`${CLI_NAME} project platform resource health`, () => {
  test.each(['available', 'degraded', 'unavailable', 'unknown'])(
    'list shows a line whose overallStatus is %s under HEALTH',
    async (status) => {
      const result = await invoke(
        ['list'],
        createScope(line(lineDetail(status)))
      )

      expect(result.stdout).toBe(listed(status))
      expect(result.exitCodes).toEqual([])
    }
  )

  test('purchase shows the line overallStatus in the Health row', async () => {
    const scope = createScope(line(lineDetail('degraded')))
    const result = await invoke(['purchase', '--yes'], scope)

    expect(result.stdout).toBe(purchased('degraded'))
    expect(result.exitCodes).toEqual([])
  })

  test('--json prints the line detail as Photon sends it', async () => {
    const resource = line(lineDetail('degraded'))
    const listResult = await invoke(['list', '--json'], createScope(resource))
    const purchaseResult = await invoke(
      ['purchase', '--yes', '--json'],
      createScope(resource)
    )

    expect(JSON.parse(listResult.stdout)).toEqual({
      provisioning: [],
      resources: [resource]
    })
    expect(JSON.parse(purchaseResult.stdout)).toEqual({
      operation: operation('succeeded'),
      resource
    })
  })

  test.each([
    { detail: { phoneNumber: PHONE_NUMBER }, name: 'no imessageHealth' },
    {
      detail: { imessageHealth: {}, phoneNumber: PHONE_NUMBER },
      name: 'an imessageHealth without overallStatus'
    },
    {
      detail: { imessageHealth: null, phoneNumber: PHONE_NUMBER },
      name: 'a null imessageHealth'
    },
    {
      detail: { imessageHealth: ['degraded'], phoneNumber: PHONE_NUMBER },
      name: 'an array imessageHealth'
    },
    {
      detail: {
        imessageHealth: { overallStatus: 7 },
        phoneNumber: PHONE_NUMBER
      },
      name: 'a number overallStatus'
    },
    {
      detail: {
        imessageHealth: { overallStatus: ' ' },
        phoneNumber: PHONE_NUMBER
      },
      name: 'a blank overallStatus'
    }
  ])(
    'a line with $name shows — and the command exits 0',
    async ({ detail }) => {
      const list = await invoke(['list'], createScope(line(detail)))
      const purchase = await invoke(
        ['purchase', '--yes'],
        createScope(line(detail))
      )

      expect(list.stdout).toBe(listed('—'))
      expect(list.exitCodes).toEqual([])
      expect(purchase.stdout).toBe(purchased('—'))
      expect(purchase.exitCodes).toEqual([])
    }
  )

  test.each([
    { health: 'healthy', healthy: true },
    { health: 'unhealthy', healthy: false }
  ])(
    'email list still shows $health for an email domain whose healthy is $healthy',
    async ({ health, healthy }) => {
      const domain = {
        ...line({ domain: 'example.com', healthy }),
        abilities: ['email'],
        type: 'email_domain'
      }
      const result = await invoke(['list'], createScope(domain), 'email')

      expect(result.stdout).toContain(
        `example.com  ${RESOURCE_ID}  ${health}  active`
      )
      expect(result.exitCodes).toEqual([])
    }
  )
})
