import { Readable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReadableInput, SelectionHandler } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import {
  asOrganizationScope,
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

const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const SENDER_ID = 'pho_res_00000000000000000000000001'
const OTHER_SENDER_ID = 'pho_res_00000000000000000000000002'
const SMS_NUMBER_ID = 'pho_res_00000000000000000000000123'
const PROVISION_ID = 'pho_opr_01h455vb4pex5vsknk084sn02q'
const RELEASE_ID = 'pho_opr_01h455vb4pex5vsknk084sn02r'
const WABA_ID = '112233445566778'
const PHONE_NUMBER = '+14155550199'
const createdAt = '2026-08-19T21:04:31.000Z'
const updatedAt = '2026-08-19T21:05:00.000Z'

// A sender's detail in the shape Platforms sends it: the WABA under
// `account`, the number in `phoneNumber` and the Photon SMS number the sender
// came from in `voipResourceId`. The number has formatting here, so the tests
// also show that text prints it in E.164 form.
const senderDetail = {
  account: { wabaId: WABA_ID },
  displayName: 'Acme Support',
  displayNameStatus: 'APPROVED',
  phoneNumber: '+1 415-555-0199',
  phoneNumberId: '123456789012345',
  qualityRating: 'GREEN',
  qualityRatingObservedAt: '2026-08-19T21:04:58.000Z',
  voipResourceId: SMS_NUMBER_ID
}

const sender = (
  detail: Record<string, unknown> = senderDetail,
  resourceId = SENDER_ID
) => ({
  abilities: ['whatsapp_business'],
  createdAt,
  detail,
  projectId: PROJECT_ID,
  resourceId,
  state: 'active',
  type: 'whatsapp_sender',
  updatedAt
})

const smsNumber = {
  abilities: ['sms', 'pstn_voice'],
  createdAt,
  detail: { phoneNumber: PHONE_NUMBER },
  projectId: PROJECT_ID,
  resourceId: SMS_NUMBER_ID,
  state: 'active',
  type: 'voip_line',
  updatedAt
}

const account = {
  accountName: 'Acme Support',
  alerts: [],
  businessId: '887766554433221',
  businessName: 'Acme',
  connectedAt: createdAt,
  outboundCapacity: 'UNKNOWN',
  restriction: null,
  reviewStatus: 'APPROVED',
  senderCount: 1,
  subscribedAt: updatedAt,
  wabaId: WABA_ID
}

const operation = (operationId: string, type: string, state: string) => ({
  cancellable: false,
  createdAt,
  operationId,
  projectId: PROJECT_ID,
  resourceId: SENDER_ID,
  resourceType: 'whatsapp_sender',
  startedAt: createdAt,
  state,
  type,
  updatedAt,
  ...(state === 'succeeded' ? { endedAt: updatedAt } : {})
})

const rawResponse = <Result>(data: Result, status: number) => ({
  data,
  headers: new Headers({ 'retry-after': '1' }),
  status
})

const terminalInput = (value: string): ReadableInput => {
  const stream = Readable.from([value]) as ReadableInput
  stream.isTTY = true
  return stream
}

const NUMBER = ['project', 'platform', 'whatsapp-business', 'number']
const PROJECT = ['--project', PROJECT_ID]
const ADD_DIRECT = [
  ...NUMBER,
  'add',
  ...PROJECT,
  '--source',
  'photon',
  '--waba-id',
  WABA_ID,
  '--voip-resource-id',
  SMS_NUMBER_ID,
  '--display-name',
  'Acme Support',
  '--idempotency-key',
  'customer-123-photon-wa-1'
]

// Runs a command off a terminal and without --json, so its text is on stdout.
const runText = async (
  args: string[],
  platforms: Record<string, unknown>,
  raw: Record<string, unknown> = {}
) => {
  const authenticated = await createAuthenticatedConfig()
  const stderr = collector()
  const stdout = collector()
  const exitCodes: number[] = []
  await runCli([...args, '--no-color'], {
    clock: instantPollClock(),
    configDirectory: authenticated.configDirectory,
    cwd: authenticated.configDirectory,
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    organizationScope: asOrganizationScope(),
    platform: 'linux',
    projectRawScope: asProjectRawScope({ platforms: raw }),
    projectScope: asProjectScope({ platforms }),
    setExitCode: (exitCode) => exitCodes.push(exitCode),
    stderr,
    stdout
  })
  await authenticated.remove()
  return { exitCodes, stderr: stderr.value(), stdout: stdout.value() }
}

const runJson = async (
  args: string[],
  platforms: Record<string, unknown>,
  raw: Record<string, unknown> = {}
) => {
  const authenticated = await createAuthenticatedConfig()
  const result = await cliInvoker(
    authenticated.configDirectory,
    asProjectScope({ platforms }),
    {
      clock: instantPollClock(),
      projectRawScope: asProjectRawScope({ platforms: raw })
    }
  )(args)
  await authenticated.remove()
  return result
}

const addScope = (listed: unknown[] = []) => ({
  platforms: {
    getOperation: vi.fn(() =>
      Promise.resolve({
        operation: operation(PROVISION_ID, 'resource.provision', 'succeeded'),
        resource: sender()
      })
    ),
    getResource: vi.fn(() => Promise.resolve(smsNumber)),
    getWhatsappBusinessAccount: vi.fn(() => Promise.resolve(account)),
    listResources: vi.fn(() => Promise.resolve({ resources: listed }))
  },
  raw: {
    createWhatsappVoipSender: vi.fn(() =>
      Promise.resolve(
        rawResponse(
          operation(PROVISION_ID, 'resource.provision', 'pending'),
          202
        )
      )
    )
  }
})

// The human wizard with a Photon SMS number and a new WABA. It reads the
// senders for the eligible numbers, then for the senders that already exist,
// then until a new sender appears.
const runWizard = async (connected: ReturnType<typeof sender>) => {
  const authenticated = await createAuthenticatedConfig()
  const selections = ['photon', SMS_NUMBER_ID, '__new_waba__']
  const select: SelectionHandler = <Value extends string>(): Promise<Value> =>
    Promise.resolve(selections.shift() as Value)
  let senderReads = 0
  const listResources = vi.fn(
    (input: { query?: { ability?: string | undefined } | undefined }) => {
      if (input.query?.ability === 'sms') {
        return Promise.resolve({ resources: [smsNumber] })
      }
      senderReads += 1
      return Promise.resolve({
        resources: senderReads >= 3 ? [connected] : []
      })
    }
  )
  const stderr = collector(true)
  const stdout = collector(true)
  await runCli([...NUMBER, 'add', ...PROJECT, '--no-color'], {
    browserLauncher: vi.fn(() => Promise.resolve()),
    clock: instantPollClock(),
    configDirectory: authenticated.configDirectory,
    confirm: () => Promise.resolve(true),
    deviceScope: unusedDeviceScope(),
    now: () => TEST_NOW,
    platform: 'linux',
    projectScope: asProjectScope({
      platforms: {
        getWhatsappBusinessAccount: () => Promise.resolve(account),
        getWhatsappBusinessVerificationCode: () =>
          Promise.resolve({
            code: '864209',
            receivedAt: '2026-08-19T21:04:35.000Z'
          }),
        listOperations: () => Promise.resolve({ operations: [] }),
        listResources
      }
    }),
    random: () => 0.5,
    select,
    stderr,
    stdin: terminalInput(''),
    stdout
  })
  await authenticated.remove()
  return stdout.value()
}

const {
  displayName: _displayName,
  displayNameStatus: _displayNameStatus,
  voipResourceId: _voipResourceId,
  ...requiredDetail
} = senderDetail
const { account: _account, ...withoutAccount } = senderDetail
const { phoneNumber: _phoneNumber, ...withoutPhoneNumber } = senderDetail
const { phoneNumberId: _phoneNumberId, ...withoutPhoneNumberId } = senderDetail
const { qualityRating: _qualityRating, ...withoutQualityRating } = senderDetail

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('a WhatsApp Business sender in the shape Platforms sends', () => {
  test('number list shows its phone number and Photon source', async () => {
    const listResources = vi.fn(() =>
      Promise.resolve({ resources: [sender()] })
    )

    const text = await runText([...NUMBER, 'list', ...PROJECT], {
      listResources
    })
    const json = await runJson([...NUMBER, 'list', ...PROJECT], {
      listResources
    })

    expect(text).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: [
        'WhatsApp Business numbers',
        'PHONE NUMBER  DISPLAY NAME  NAME STATUS  QUALITY  PHOTON SOURCE                       RESOURCE ID',
        `${PHONE_NUMBER}  Acme Support  APPROVED     GREEN    ${SMS_NUMBER_ID}  ${SENDER_ID}`,
        ''
      ].join('\n')
    })
    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual({ resources: [sender()] })
  })

  test('number view shows its phone number, WABA ID and Photon source', async () => {
    const getResource = vi.fn(() => Promise.resolve(sender()))

    const text = await runText([...NUMBER, 'view', SENDER_ID, ...PROJECT], {
      getResource
    })
    const json = await runJson([...NUMBER, 'view', SENDER_ID, ...PROJECT], {
      getResource
    })

    expect(text).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: [
        'WhatsApp Business number',
        `Phone number     ${PHONE_NUMBER}`,
        'Phone number ID  123456789012345',
        `WABA ID          ${WABA_ID}`,
        'Display name     Acme Support',
        'Name status      APPROVED',
        'Quality          GREEN',
        `Photon source    ${SMS_NUMBER_ID}`,
        `Resource ID      ${SENDER_ID}`,
        'State            active',
        'Abilities        whatsapp_business',
        `Project          ${PROJECT_ID}`,
        `Created          ${createdAt}`,
        `Updated          ${updatedAt}`,
        'Retired          —',
        ''
      ].join('\n')
    })
    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual(sender())
  })

  test('number view shows — for the optional fields Photon leaves out', async () => {
    const text = await runText([...NUMBER, 'view', SENDER_ID, ...PROJECT], {
      getResource: () => Promise.resolve(sender(requiredDetail))
    })

    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toContain(`Phone number     ${PHONE_NUMBER}\n`)
    expect(text.stdout).toContain(`WABA ID          ${WABA_ID}\n`)
    expect(text.stdout).toContain('Display name     —\n')
    expect(text.stdout).toContain('Name status      —\n')
    expect(text.stdout).toContain('Photon source    —\n')
  })

  test('number delete asks for its phone number and names it when deleted', async () => {
    const authenticated = await createAuthenticatedConfig()
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(operation(RELEASE_ID, 'resource.release', 'succeeded'), 200)
      )
    )
    const invoke = terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({
        platforms: { getResource: () => Promise.resolve(sender()) }
      }),
      {
        clock: instantPollClock(),
        projectRawScope: asProjectRawScope({
          platforms: { releaseResource }
        }),
        stdin: terminalInput(`${PHONE_NUMBER}\n`)
      }
    )

    const deleted = await invoke([...NUMBER, 'delete', SENDER_ID, ...PROJECT])
    await authenticated.remove()

    expect(deleted.exitCodes).toEqual([])
    expect(deleted.stderr).toContain(`Type ${PHONE_NUMBER} to confirm:`)
    expect(deleted.stdout).toContain(
      `Deleted WhatsApp Business number ${PHONE_NUMBER} (${SENDER_ID}).\n`
    )
    expect(releaseResource).toHaveBeenCalledWith(
      { path: { id: PROJECT_ID, resourceId: SENDER_ID } },
      undefined
    )
  })

  test('number delete --yes names its phone number', async () => {
    const releaseResource = vi.fn(() =>
      Promise.resolve(
        rawResponse(operation(RELEASE_ID, 'resource.release', 'succeeded'), 200)
      )
    )

    const text = await runText(
      [...NUMBER, 'delete', SENDER_ID, ...PROJECT, '--yes'],
      { getResource: () => Promise.resolve(sender()) },
      { releaseResource }
    )

    expect(text).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: `Deleted WhatsApp Business number ${PHONE_NUMBER} (${SENDER_ID}).\n`
    })
    expect(releaseResource).toHaveBeenCalledOnce()
  })

  test('number add names the connected number and its WABA', async () => {
    const textScope = addScope()
    const jsonScope = addScope()

    const text = await runText(ADD_DIRECT, textScope.platforms, textScope.raw)
    const json = await runJson(ADD_DIRECT, jsonScope.platforms, jsonScope.raw)

    expect(text).toEqual({
      exitCodes: [],
      stderr: '',
      stdout: [
        `Connected ${PHONE_NUMBER} to WhatsApp Business.`,
        `WABA: ${WABA_ID}`,
        `Resource ID: ${SENDER_ID}`,
        ''
      ].join('\n')
    })
    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual({
      operation: operation(PROVISION_ID, 'resource.provision', 'succeeded'),
      resource: sender()
    })
    for (const scope of [textScope, jsonScope]) {
      expect(scope.raw.createWhatsappVoipSender).toHaveBeenCalledWith(
        {
          body: { displayName: 'Acme Support', voipResourceId: SMS_NUMBER_ID },
          headers: { idempotencyKey: 'customer-123-photon-wa-1' },
          path: { id: PROJECT_ID }
        },
        undefined
      )
    }
  })

  test('number add refuses a Photon number that a sender came from', async () => {
    const scope = addScope([
      sender({ ...senderDetail, phoneNumber: '+14155550100' }, OTHER_SENDER_ID)
    ])

    const result = await runJson(ADD_DIRECT, scope.platforms, scope.raw)

    expect(result.exitCodes).toEqual([1])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: 'WHATSAPP_NUMBER_ALREADY_CONNECTED',
        detail: `${PHONE_NUMBER} is linked to sender ${OTHER_SENDER_ID}.`
      }
    })
    expect(scope.raw.createWhatsappVoipSender).not.toHaveBeenCalled()
  })

  test('the number add wizard names the number Meta connected', async () => {
    const { voipResourceId: _source, ...unlinked } = senderDetail

    const connected = await runWizard(sender())
    const other = await runWizard(
      sender({ ...unlinked, phoneNumber: '+1 415-555-0100' }, OTHER_SENDER_ID)
    )

    expect(connected).toContain(
      `Connected ${PHONE_NUMBER} to WhatsApp Business.\nResource ID: ${SENDER_ID}\n`
    )
    expect(other).toContain(
      `Meta connected +14155550100, not ${PHONE_NUMBER}.\n`
    )
  })

  test.each([
    ['no phoneNumber', withoutPhoneNumber],
    [
      'a phoneNumber that is not a phone number',
      { ...senderDetail, phoneNumber: 'Acme' }
    ],
    ['no account', withoutAccount],
    ['an account without wabaId', { ...senderDetail, account: {} }],
    ['an account that is a string', { ...senderDetail, account: WABA_ID }],
    ['an account that is null', { ...senderDetail, account: null }],
    [
      'a wabaId that is not digits',
      { ...senderDetail, account: { wabaId: 'waba_1' } }
    ],
    ['no phoneNumberId', withoutPhoneNumberId],
    ['no qualityRating', withoutQualityRating],
    ['an empty voipResourceId', { ...senderDetail, voipResourceId: '' }],
    [
      'its fields at the top level, with no account or phoneNumber',
      {
        displayPhoneNumber: PHONE_NUMBER,
        phoneNumberId: '123456789012345',
        qualityRating: 'GREEN',
        sourceVoipResourceId: SMS_NUMBER_ID,
        wabaId: WABA_ID
      }
    ]
  ])('a sender with %s gets the protocol error', async (_case, detail) => {
    const platforms = {
      getResource: () => Promise.resolve(sender(detail)),
      listResources: () => Promise.resolve({ resources: [sender(detail)] })
    }

    const viewed = await runJson(
      [...NUMBER, 'view', SENDER_ID, ...PROJECT],
      platforms
    )
    const listed = await runText([...NUMBER, 'list', ...PROJECT], platforms)

    expect(viewed.exitCodes).toEqual([1])
    expect(JSON.parse(viewed.stdout)).toMatchObject({
      error: {
        code: 'PROJECT_PROTOCOL_ERROR',
        detail: `Resource ${SENDER_ID} has malformed WhatsApp Business detail.`,
        message: 'Photon returned an invalid project response.'
      }
    })
    expect(listed.exitCodes).toEqual([1])
    expect(listed.stdout).toBe('')
    expect(listed.stderr).toContain(
      `Resource ${SENDER_ID} has malformed WhatsApp Business detail.`
    )
  })
})
