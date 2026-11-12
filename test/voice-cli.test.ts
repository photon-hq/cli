import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ApiError, TransportError } from '@photon-ai/api'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReadableInput } from '../src/core/input.ts'
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { OperationService } from '../src/operation/service.ts'
import type {
  VoiceLineProfileAssignment,
  VoiceScope
} from '../src/project/voice-service.ts'
import { printed } from './help-support.ts'
import {
  asProjectScope,
  cliInvoker,
  collector,
  createAuthenticatedConfig,
  lateFailingInvoker,
  stderrError,
  TEST_NOW,
  terminalInvoker,
  unusedDeviceScope
} from './project-test-support.ts'

const projectId = 'pho_prj_01h455vb4pex5vsknk084sn02q'
const profileId = 'pho_vpf_01h455vb4pex5vsknk084sn02q'
const otherProfileId = 'pho_vpf_01h455vb4pex5vsknk084sn02r'
const resourceId = 'pho_res_01h455vb4pex5vsknk084sn02q'
const secondResourceId = 'pho_res_01h455vb4pex5vsknk084sn02r'
const timestamp = '2026-08-21T18:00:00.000Z'
const outboundEditCommand = [
  'project',
  'platform',
  'voice',
  'profile',
  'outbound',
  'edit'
]
type SdkVoiceProfile = Awaited<ReturnType<VoiceScope['getVoiceProfile']>>
type SdkVoiceProfileOutbound = NonNullable<
  SdkVoiceProfile['configuration']['outbound']
>

const outbound = (
  overrides: Partial<SdkVoiceProfileOutbound> = {}
): SdkVoiceProfileOutbound => ({
  authentication: {
    algorithm: 'sha-256',
    previousPasswordValidUntil: null,
    username: 'profile-outbound-user',
    validFrom: timestamp
  },
  connection: {
    endpoints: [
      {
        host: 'sip.example.test',
        port: 5071,
        transport: 'tls'
      }
    ],
    realm: 'sip.example.test'
  },
  ...overrides
})

const profile = (
  overrides: Partial<SdkVoiceProfile> = {}
): SdkVoiceProfile => ({
  configuration: {
    inbound: {
      credentials: null,
      destinationUri: 'sips:agent@example.test:5061'
    },
    outbound: null
  },
  createdAt: timestamp,
  isDefault: false,
  lineCount: 0,
  mediaEncryption: 'auto',
  name: 'Production agent',
  profileId,
  projectId,
  protocol: 'sip',
  updatedAt: timestamp,
  version: 1,
  ...overrides
})

const assignment = (
  id: string,
  overrides: Partial<VoiceLineProfileAssignment> = {}
): VoiceLineProfileAssignment => ({
  projectId,
  resourceId: id,
  resourceVersion: 3,
  updatedAt: timestamp,
  ...overrides
})

const voiceScope = (overrides: Partial<VoiceScope> = {}): VoiceScope => ({
  assignVoiceLineProfile: vi.fn(() =>
    Promise.resolve(assignment(resourceId, { profileId, profileVersion: 1 }))
  ),
  batchUpdateVoiceLineProfileAssignments: vi.fn<
    VoiceScope['batchUpdateVoiceLineProfileAssignments']
  >((input) =>
    Promise.resolve({
      assignments: input.body.updates.map((update) =>
        assignment(update.resourceId, {
          ...(update.profileId === null
            ? {}
            : { profileId: update.profileId, profileVersion: 1 }),
          resourceVersion: update.expectedVersion + 1
        })
      )
    })
  ),
  configureVoiceProfileOutbound: vi.fn(() =>
    Promise.resolve({
      outbound: outbound(),
      password: 'outbound-password',
      profileVersion: 2
    })
  ),
  createDefaultVoiceProfile: vi.fn(() =>
    Promise.resolve(profile({ isDefault: true }))
  ),
  createVoiceProfile: vi.fn(() => Promise.resolve(profile())),
  deleteVoiceProfile: vi.fn(() => Promise.resolve(undefined)),
  deleteVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({ inbound: null, profileVersion: 2 })
  ),
  deleteVoiceProfileOutbound: vi.fn(() =>
    Promise.resolve({ outbound: null, profileVersion: 2 })
  ),
  getDefaultVoiceProfile: vi.fn(() =>
    Promise.resolve(profile({ isDefault: true }))
  ),
  getVoiceLineProfileAssignment: vi.fn((input) =>
    Promise.resolve(assignment(input.path.resourceId))
  ),
  getVoiceProfile: vi.fn(() => Promise.resolve(profile())),
  listVoiceProfiles: vi.fn(() => Promise.resolve({ profiles: [profile()] })),
  replaceVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({
      inbound: {
        credentials: null,
        destinationUri: 'sips:agent@example.test:5061'
      },
      profileVersion: 2
    })
  ),
  rotateVoiceProfileOutboundCredential: vi.fn(() =>
    Promise.resolve({
      password: 'rotated-password',
      previousPasswordValidUntil: null,
      profileVersion: 3
    })
  ),
  unassignVoiceLineProfile: vi.fn(() => Promise.resolve(undefined)),
  updateDefaultVoiceProfile: () =>
    Promise.resolve(profile({ isDefault: true })),
  updateVoiceProfile: vi.fn(() => Promise.resolve(profile({ version: 2 }))),
  updateVoiceProfileInbound: vi.fn(() =>
    Promise.resolve({
      inbound: {
        credentials: null,
        destinationUri: 'sips:agent@example.test:5061'
      },
      profileVersion: 2
    })
  ),
  updateVoiceProfileOutboundAuthentication: vi.fn(() =>
    Promise.resolve({ outbound: outbound(), profileVersion: 2 })
  ),
  ...overrides
})

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('project platform Voice CLI', () => {
  test.each([
    { algorithm: 'md5', before: 'sha-256', force: false, reference: 'default' },
    { algorithm: 'sha-256', before: 'md5', force: false, reference: profileId },
    {
      algorithm: 'sha-256',
      before: 'sha-256',
      force: false,
      reference: 'default'
    },
    { algorithm: 'md5', before: 'md5', force: true, reference: profileId }
  ] as const)(
    'edits $reference from $before to $algorithm and preserves credentials',
    async ({ before, algorithm, reference, force }) => {
      const authenticated = await createAuthenticatedConfig()
      const previous = outbound({
        authentication: {
          ...outbound().authentication,
          algorithm: before,
          previousPasswordValidUntil: timestamp
        }
      })
      const current = profile({
        configuration: { inbound: null, outbound: previous },
        version: 12
      })
      const updatedOutbound = outbound({
        authentication: { ...previous.authentication, algorithm }
      })
      const profileVersion = before === algorithm ? 12 : 13
      const updateVoiceProfileOutboundAuthentication = vi
        .fn<VoiceScope['updateVoiceProfileOutboundAuthentication']>()
        .mockResolvedValue({ outbound: updatedOutbound, profileVersion })
      const scope = voiceScope({
        getDefaultVoiceProfile: vi
          .fn()
          .mockResolvedValue({ ...current, isDefault: true }),
        getVoiceProfile: vi.fn().mockResolvedValue(current),
        updateVoiceProfileOutboundAuthentication
      })
      const confirm = vi.fn().mockResolvedValue(true)
      const execute = vi.spyOn(OperationService.prototype, 'execute')
      const executeAwaitingOutput = vi.spyOn(
        OperationService.prototype,
        'executeAwaitingOutput'
      )
      const acknowledgeOutput = vi.spyOn(
        OperationService.prototype,
        'acknowledgeOutput'
      )
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { confirm, voiceScope: scope }
      )

      const result = await invoke([
        ...outboundEditCommand,
        reference,
        '--digest-algorithm',
        algorithm,
        '--project',
        projectId,
        ...(force ? ['--yes'] : [])
      ])

      expect(result.exitCodes).toEqual([])
      expect(JSON.parse(result.stdout)).toEqual({
        outbound: updatedOutbound,
        profileVersion
      })
      expect(result.stderr).toBe(
        force ? '' : `Project: ${projectId}, from --project\n`
      )
      expect(
        updateVoiceProfileOutboundAuthentication
      ).toHaveBeenCalledExactlyOnceWith(
        {
          body: { authentication: { algorithm }, expectedVersion: 12 },
          path: { id: projectId, profileId }
        },
        undefined
      )
      expect(scope.getDefaultVoiceProfile).toHaveBeenCalledTimes(
        reference === 'default' ? 1 : 0
      )
      expect(scope.getVoiceProfile).toHaveBeenCalledTimes(
        reference === 'default' ? 0 : 1
      )
      expect(confirm).toHaveBeenCalledTimes(force ? 0 : 1)
      if (!force) {
        expect(confirm).toHaveBeenCalledWith(
          expect.stringContaining('username and password are preserved')
        )
        expect(confirm).toHaveBeenCalledWith(
          expect.stringContaining(
            algorithm === 'md5'
              ? 'MD5 is the weaker legacy option'
              : 'can stop an incompatible PBX from authenticating'
          )
        )
      }
      expect(execute).not.toHaveBeenCalled()
      expect(executeAwaitingOutput).not.toHaveBeenCalled()
      expect(acknowledgeOutput).not.toHaveBeenCalled()
      expect(scope.configureVoiceProfileOutbound).not.toHaveBeenCalled()
      expect(scope.rotateVoiceProfileOutboundCredential).not.toHaveBeenCalled()
      expect(scope.deleteVoiceProfileOutbound).not.toHaveBeenCalled()
    }
  )

  test('cancels an outbound algorithm edit before any mutation or journal activity', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = voiceScope()
    const execute = vi.spyOn(OperationService.prototype, 'execute')
    const executeAwaitingOutput = vi.spyOn(
      OperationService.prototype,
      'executeAwaitingOutput'
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        confirm: vi.fn().mockResolvedValue(false),
        voiceScope: scope
      }
    )

    const result = await invoke([
      ...outboundEditCommand,
      'default',
      '--digest-algorithm',
      'md5',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([1])
    expect(result.stdout).toBe('')
    expect(
      scope.updateVoiceProfileOutboundAuthentication
    ).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(executeAwaitingOutput).not.toHaveBeenCalled()
  })

  test('requires --yes for an outbound edit without an interactive terminal', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = voiceScope()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: scope }
    )

    const result = await invoke([
      ...outboundEditCommand,
      profileId,
      '--digest-algorithm',
      'md5',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'CONFIRMATION_REQUIRED' }
    })
    expect(
      scope.updateVoiceProfileOutboundAuthentication
    ).not.toHaveBeenCalled()
  })

  test.each([
    { flags: [] },
    { flags: ['--digest-algorithm', 'unspecified'] },
    { flags: ['--digest-algorithm', 'SHA-256'] },
    { flags: ['--digest-algorithm', 'md5', '--idempotency-key', 'unsupported'] }
  ])(
    'rejects invalid outbound edit arguments %j before reading a profile',
    async ({ flags }) => {
      const authenticated = await createAuthenticatedConfig()
      const scope = voiceScope()
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )

      const result = await invoke([
        ...outboundEditCommand,
        'default',
        ...flags,
        '--yes',
        '--project',
        projectId
      ])

      expect(result.exitCodes).toEqual([2])
      expect(scope.getDefaultVoiceProfile).not.toHaveBeenCalled()
      expect(
        scope.updateVoiceProfileOutboundAuthentication
      ).not.toHaveBeenCalled()
    }
  )

  test.each([
    'VOICE_PROFILE_VERSION_CONFLICT',
    'VOICE_OUTBOUND_OPERATION_PENDING'
  ])('surfaces %s even for a same-value edit', async (code) => {
    const authenticated = await createAuthenticatedConfig()
    const updateVoiceProfileOutboundAuthentication = vi
      .fn<VoiceScope['updateVoiceProfileOutboundAuthentication']>()
      .mockRejectedValue(
        new ApiError('conflict', {
          body: { code },
          headers: new Headers(),
          operationId: 'updateVoiceProfileOutboundAuthentication',
          status: 409
        })
      )
    const scope = voiceScope({
      getDefaultVoiceProfile: vi.fn().mockResolvedValue(
        profile({
          configuration: { inbound: null, outbound: outbound() },
          version: 12
        })
      ),
      updateVoiceProfileOutboundAuthentication
    })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: scope }
    )

    const result = await invoke([
      ...outboundEditCommand,
      'default',
      '--digest-algorithm',
      'sha-256',
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([1])
    const { error } = JSON.parse(result.stdout)
    expect(error).toMatchObject({ code })
    expect(error).not.toHaveProperty('next')
    expect(result.stderr).toBe('')
    expect(updateVoiceProfileOutboundAuthentication).toHaveBeenCalledTimes(1)
    expect(
      updateVoiceProfileOutboundAuthentication.mock.calls[0]?.[0].body
    ).toEqual({ authentication: { algorithm: 'sha-256' }, expectedVersion: 12 })
    const operations = await invoke(['operation', 'list'])
    expect(JSON.parse(operations.stdout)).toEqual({ operations: [] })
  })

  test('prints authoritative outbound edit metadata without a display-once password or warning', async () => {
    const authenticated = await createAuthenticatedConfig()
    const stdout = collector()
    const stderr = collector()
    const updatedOutbound = outbound({
      authentication: {
        ...outbound().authentication,
        algorithm: 'md5',
        previousPasswordValidUntil: timestamp
      },
      connection: {
        endpoints: [
          { host: 'sip.example.test', port: 5060, transport: 'udp' },
          { host: 'sip.example.test', port: 5060, transport: 'tcp' },
          { host: 'sip.example.test', port: 5071, transport: 'tls' }
        ],
        realm: 'voice.example.test'
      }
    })
    const exitCodes: number[] = []

    await runCli(
      [
        ...outboundEditCommand,
        profileId,
        '--digest-algorithm',
        'md5',
        '--yes',
        '--project',
        projectId,
        '--no-color'
      ],
      {
        configDirectory: authenticated.configDirectory,
        deviceScope: unusedDeviceScope(),
        now: () => TEST_NOW,
        platform: 'linux',
        projectScope: asProjectScope({}),
        setExitCode: (code) => exitCodes.push(code),
        stderr,
        stdout,
        voiceScope: voiceScope({
          updateVoiceProfileOutboundAuthentication: vi.fn().mockResolvedValue({
            outbound: updatedOutbound,
            password: 'must-not-appear',
            profileVersion: 42
          })
        })
      }
    )

    expect(exitCodes).toEqual([])
    expect(stdout.value()).toContain('Username and password are preserved')
    expect(stdout.value()).toContain('md5')
    expect(stdout.value()).toContain('profile-outbound-user')
    expect(stdout.value()).toContain('voice.example.test')
    expect(stdout.value()).toContain('udp://sip.example.test:5060')
    expect(stdout.value()).toContain('tcp://sip.example.test:5060')
    expect(stdout.value()).toContain('tls://sip.example.test:5071')
    expect(stdout.value()).toContain(timestamp)
    expect(stdout.value()).toContain('42')
    expect(stdout.value()).not.toContain('Display-once')
    expect(stdout.value()).not.toContain('must-not-appear')
    expect(stderr.value()).toBe('')
  })

  test('registers profile directions and assignments beneath Voice', async () => {
    const helpLines: string[] = []
    helpLines.push(await printed(['project', 'platform', 'voice', '--help']))

    const help = helpLines.join('\n')
    expect(help).toContain('assignment')
    expect(help).toContain('list')
    expect(help).toContain('profile')

    helpLines.length = 0
    helpLines.push(
      await printed(['project', 'platform', 'voice', 'profile', '--help'])
    )
    const profileHelp = helpLines.join('\n')
    expect(profileHelp).toContain('inbound')
    expect(profileHelp).toContain('outbound')

    helpLines.length = 0
    helpLines.push(
      await printed([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'enable',
        '--help'
      ])
    )
    const enableHelp = helpLines.join('\n')
    expect(enableHelp).toContain('--digest-algorithm')
    expect(enableHelp).toContain('weaker legacy compatibility')

    helpLines.length = 0
    helpLines.push(await printed([...outboundEditCommand, '--help']))
    const editHelp = helpLines.join('\n')
    expect(editHelp).toContain('--digest-algorithm')
    expect(editHelp).toContain('--yes')
    expect(editHelp).toContain('preserving username and password')
    expect(editHelp).not.toContain('--idempotency-key')

    helpLines.length = 0
    helpLines.push(
      await printed([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'rotate',
        '--help'
      ])
    )
    expect(helpLines.join('\n')).not.toContain('--digest-algorithm')
  })

  test('creates a direction-neutral default profile through its dedicated route', async () => {
    const authenticated = await createAuthenticatedConfig()
    const createDefaultVoiceProfile = vi.fn<
      VoiceScope['createDefaultVoiceProfile']
    >(() =>
      Promise.resolve(
        profile({
          configuration: { inbound: null, outbound: null },
          isDefault: true,
          name: 'Default Profile'
        })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: voiceScope({ createDefaultVoiceProfile }) }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'create',
      '--default',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(
      profile({
        configuration: { inbound: null, outbound: null },
        isDefault: true,
        name: 'Default Profile'
      })
    )
    expect(createDefaultVoiceProfile).toHaveBeenCalledWith(
      {
        body: {
          protocol: 'sip'
        },
        path: { id: projectId }
      },
      undefined
    )
  })

  test('views the default profile through its dedicated endpoint', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getDefaultVoiceProfile = vi.fn<VoiceScope['getDefaultVoiceProfile']>(
      () =>
        Promise.resolve(profile({ isDefault: true, lineCount: 2, version: 4 }))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: voiceScope({ getDefaultVoiceProfile }) }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'view',
      'default',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(
      profile({ isDefault: true, lineCount: 2, version: 4 })
    )
    expect(getDefaultVoiceProfile).toHaveBeenCalledWith(
      { path: { id: projectId } },
      undefined
    )
  })

  test('updates default inbound delivery with its fetched profile version', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getDefaultVoiceProfile = vi.fn<VoiceScope['getDefaultVoiceProfile']>(
      () =>
        Promise.resolve(profile({ isDefault: true, lineCount: 3, version: 7 }))
    )
    const updateVoiceProfileInbound = vi.fn<
      VoiceScope['updateVoiceProfileInbound']
    >((input) =>
      Promise.resolve({
        inbound: {
          credentials: null,
          destinationUri:
            input.body.destinationUri ?? 'sips:agent@example.test:5061'
        },
        profileVersion: 8
      })
    )
    const confirm = vi.fn(() => Promise.resolve(true))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        confirm,
        voiceScope: voiceScope({
          getDefaultVoiceProfile,
          updateVoiceProfileInbound
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'inbound',
      'edit',
      'default',
      '--sip-uri',
      'sip:agent@example.test;transport=tcp',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('3 lines'))
    expect(JSON.parse(result.stdout)).toMatchObject({
      inbound: {
        destinationUri: 'sip:agent@example.test;transport=tcp'
      },
      profileVersion: 8
    })
    expect(updateVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          destinationUri: 'sip:agent@example.test;transport=tcp',
          expectedVersion: 7
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
  })

  test('keeps profile metadata updates on profile PATCH', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getVoiceProfile = vi.fn<VoiceScope['getVoiceProfile']>(() =>
      Promise.resolve(profile({ version: 9 }))
    )
    const updateVoiceProfile = vi.fn<VoiceScope['updateVoiceProfile']>(
      (input) =>
        Promise.resolve(
          profile({ name: input.body.name ?? 'Production agent', version: 10 })
        )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: voiceScope({ getVoiceProfile, updateVoiceProfile }) }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'edit',
      profileId,
      '--name',
      'Renamed agent',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(
      profile({ name: 'Renamed agent', version: 10 })
    )
    expect(updateVoiceProfile).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 9, name: 'Renamed agent' },
        path: { id: projectId, profileId }
      },
      undefined
    )
  })

  test('rejects renaming the default profile by its stable ID', async () => {
    const authenticated = await createAuthenticatedConfig()
    const updateVoiceProfile = vi.fn<VoiceScope['updateVoiceProfile']>()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          getVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true }))
          ),
          updateVoiceProfile
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'edit',
      profileId,
      '--name',
      'Renamed default',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([2])
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'VOICE_DEFAULT_PROFILE_NAME_IMMUTABLE' }
    })
    expect(updateVoiceProfile).not.toHaveBeenCalled()
  })

  test('reads a SIP password from piped stdin only for --sip-password-file -', async () => {
    const authenticated = await createAuthenticatedConfig()
    const password = ' piped replacement password \n'
    const getVoiceProfile = vi.fn<VoiceScope['getVoiceProfile']>(() =>
      Promise.resolve(
        profile({
          configuration: {
            inbound: {
              credentials: { username: 'existing-user' },
              destinationUri: 'sips:old@example.test:5061'
            },
            outbound: null
          },
          version: 4
        })
      )
    )
    const replaceVoiceProfileInbound = vi.fn<
      VoiceScope['replaceVoiceProfileInbound']
    >((input) =>
      Promise.resolve({
        inbound: {
          credentials: { username: input.body.credentials?.username ?? '' },
          destinationUri: input.body.destinationUri
        },
        profileVersion: 5
      })
    )
    const set = async (
      passwordFile: string[],
      action = 'set',
      invoker = cliInvoker
    ) => {
      const stdin = Readable.from([password]) as Readable & ReadableInput
      stdin.isTTY = false
      const invoke = invoker(
        authenticated.configDirectory,
        asProjectScope({}),
        {
          stdin,
          voiceScope: voiceScope({
            getVoiceProfile,
            replaceVoiceProfileInbound
          })
        }
      )
      const result = await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'inbound',
        action,
        profileId,
        '--sip-uri',
        'sips:new@example.test:5061',
        '--sip-username',
        'new-user',
        ...passwordFile,
        '--project',
        projectId
      ])
      return { ...result, stdin }
    }

    const unasked = await set([])
    expect(unasked.exitCodes).toEqual([2])
    expect(JSON.parse(unasked.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail:
          "Pass --sip-password-file with a file, or --sip-password-file - to read it from standard input. Photon can't ask for it: --json is set."
      }
    })
    expect(unasked.stdin.readableFlowing).toBeNull()
    expect(replaceVoiceProfileInbound).not.toHaveBeenCalled()

    const unaskedEdit = await set([], 'edit')
    expect(unaskedEdit.exitCodes).toEqual([2])
    expect(JSON.parse(unaskedEdit.stdout)).toMatchObject({
      error: {
        code: 'ARGUMENT_VALIDATION',
        detail:
          "Pass --sip-password-file with a file, or --sip-password-file - to read it from standard input. Photon can't ask for it: --json is set."
      }
    })
    expect(unaskedEdit.stdin.readableFlowing).toBeNull()

    const atTerminal = await Promise.all(
      ['set', 'edit'].map((action) => set([], action, terminalInvoker))
    )
    for (const result of atTerminal) {
      expect(result.exitCodes).toEqual([2])
      expect(result.stderr).toContain(
        "Pass --sip-password-file with a file, or --sip-password-file - to read it from standard input. Photon can't ask for it: standard input is not a terminal."
      )
      expect(result.stdin.readableFlowing).toBeNull()
    }

    const asked = await set(['--sip-password-file', '-'])
    expect(asked.exitCodes).toEqual([])
    expect(asked.stdout).not.toContain(password)
    expect(replaceVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          credentials: { password, username: 'new-user' },
          destinationUri: 'sips:new@example.test:5061',
          expectedVersion: 4
        },
        path: { id: projectId, profileId }
      },
      undefined
    )
  })

  test('names the SIP password file before it asks to change delivery for assigned lines', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getVoiceProfile = vi.fn<VoiceScope['getVoiceProfile']>(() =>
      Promise.resolve(profile({ lineCount: 2, version: 4 }))
    )
    const replaceVoiceProfileInbound =
      vi.fn<VoiceScope['replaceVoiceProfileInbound']>()
    const set = async (passwordFile: string[]) => {
      const stdin = Readable.from([' piped password \n']) as Readable &
        ReadableInput
      stdin.isTTY = false
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        {
          stdin,
          voiceScope: voiceScope({
            getVoiceProfile,
            replaceVoiceProfileInbound
          })
        }
      )
      const result = await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'inbound',
        'set',
        profileId,
        '--sip-uri',
        'sips:new@example.test:5061',
        '--sip-username',
        'new-user',
        ...passwordFile,
        '--project',
        projectId
      ])
      return { ...result, stdin }
    }

    const withoutPassword = await set([])
    const withPassword = await set(['--sip-password-file', '-'])

    expect(withoutPassword.exitCodes).toEqual([2])
    expect(JSON.parse(withoutPassword.stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(withoutPassword.stdout).toContain('--sip-password-file')
    expect(withPassword.exitCodes).toEqual([2])
    const { error } = JSON.parse(withPassword.stdout)
    expect(error.code).toBe('CONFIRMATION_REQUIRED')
    expect(error.next[0].run).toContain('--sip-password-file=-')
    expect(error.next[0].run.endsWith(' --yes')).toBe(true)
    expect(withoutPassword.stdin.readableFlowing).toBeNull()
    expect(withPassword.stdin.readableFlowing).toBeNull()
    expect(replaceVoiceProfileInbound).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('sets and clears inbound credentials without replaying masked values', async () => {
    const authenticated = await createAuthenticatedConfig()
    const password = ' exact replacement password \n'
    const passwordPath = join(authenticated.configDirectory, 'replacement-sip')
    await writeFile(passwordPath, password, { mode: 0o600 })
    const getVoiceProfile = vi.fn<VoiceScope['getVoiceProfile']>(() =>
      Promise.resolve(
        profile({
          configuration: {
            inbound: {
              credentials: { username: 'existing-user' },
              destinationUri: 'sips:old@example.test:5061'
            },
            outbound: null
          },
          version: 4
        })
      )
    )
    const replaceVoiceProfileInbound = vi.fn<
      VoiceScope['replaceVoiceProfileInbound']
    >((input) =>
      Promise.resolve({
        inbound: {
          credentials:
            input.body.credentials === null
              ? null
              : {
                  username: input.body.credentials?.username ?? 'existing-user'
                },
          destinationUri: input.body.destinationUri
        },
        profileVersion: 5
      })
    )
    const updateVoiceProfileInbound = vi.fn<
      VoiceScope['updateVoiceProfileInbound']
    >(() =>
      Promise.resolve({
        inbound: {
          credentials: null,
          destinationUri: 'sips:new@example.test:5061'
        },
        profileVersion: 5
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          getVoiceProfile,
          replaceVoiceProfileInbound,
          updateVoiceProfileInbound
        })
      }
    )

    const set = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'inbound',
      'set',
      profileId,
      '--sip-uri',
      'sips:new@example.test:5061',
      '--sip-username',
      'new-user',
      '--sip-password-file',
      passwordPath,
      '--project',
      projectId
    ])
    expect(set.exitCodes).toEqual([])
    expect(set.stdout).not.toContain(password)
    expect(replaceVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: {
          credentials: { password, username: 'new-user' },
          destinationUri: 'sips:new@example.test:5061',
          expectedVersion: 4
        },
        path: { id: projectId, profileId }
      },
      undefined
    )

    const cleared = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'inbound',
      'edit',
      profileId,
      '--clear-sip-credentials',
      '--project',
      projectId
    ])
    expect(cleared.exitCodes).toEqual([])
    expect(updateVoiceProfileInbound).toHaveBeenCalledWith(
      {
        body: { credentials: null, expectedVersion: 4 },
        path: { id: projectId, profileId }
      },
      undefined
    )
  })

  test('enables, rotates, and revokes outbound with default shorthand', async () => {
    const authenticated = await createAuthenticatedConfig()
    const firstPassword = 'first-outbound-password'
    const rotatedPassword = 'rotated-outbound-password'
    const getDefaultVoiceProfile = vi
      .fn<VoiceScope['getDefaultVoiceProfile']>()
      .mockResolvedValueOnce(
        profile({
          configuration: { inbound: null, outbound: null },
          isDefault: true,
          version: 5
        })
      )
      .mockResolvedValueOnce(
        profile({
          configuration: { inbound: null, outbound: outbound() },
          isDefault: true,
          version: 6
        })
      )
      .mockResolvedValueOnce(
        profile({
          configuration: { inbound: null, outbound: outbound() },
          isDefault: true,
          version: 7
        })
      )
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() =>
      Promise.resolve({
        outbound: outbound(),
        password: firstPassword,
        profileVersion: 6
      })
    )
    const rotateVoiceProfileOutboundCredential = vi.fn<
      VoiceScope['rotateVoiceProfileOutboundCredential']
    >(() =>
      Promise.resolve({
        password: rotatedPassword,
        previousPasswordValidUntil: null,
        profileVersion: 7
      })
    )
    const deleteVoiceProfileOutbound = vi.fn<
      VoiceScope['deleteVoiceProfileOutbound']
    >(() => Promise.resolve({ outbound: null, profileVersion: 8 }))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          deleteVoiceProfileOutbound,
          getDefaultVoiceProfile,
          rotateVoiceProfileOutboundCredential
        })
      }
    )

    const enabled = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--idempotency-key',
      'enable-default-1',
      '--project',
      projectId
    ])
    expect(enabled.exitCodes).toEqual([])
    expect(JSON.parse(enabled.stdout)).toMatchObject({
      outbound: {
        authentication: {
          algorithm: 'sha-256',
          username: 'profile-outbound-user'
        },
        connection: {
          endpoints: [
            {
              host: 'sip.example.test',
              port: 5071,
              transport: 'tls'
            }
          ],
          realm: 'sip.example.test'
        }
      },
      password: firstPassword,
      profileVersion: 6
    })
    expect(enabled.stderr).not.toContain(firstPassword)
    const operationsAfterEnable = await invoke(['operation', 'list'])
    expect(JSON.parse(operationsAfterEnable.stdout)).toEqual({ operations: [] })
    expect(configureVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        body: {
          authentication: { algorithm: 'sha-256' },
          expectedVersion: 5
        },
        headers: { idempotencyKey: 'enable-default-1' },
        path: { id: projectId, profileId }
      },
      undefined
    )

    const rotated = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'rotate',
      'default',
      '--mode',
      'emergency',
      '--idempotency-key',
      'rotate-default-1',
      '--yes',
      '--project',
      projectId
    ])
    expect(rotated.exitCodes).toEqual([])
    expect(JSON.parse(rotated.stdout)).toMatchObject({
      password: rotatedPassword,
      previousPasswordValidUntil: null,
      profileVersion: 7
    })
    expect(rotated.stderr).not.toContain(rotatedPassword)
    expect(rotateVoiceProfileOutboundCredential).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 6, mode: 'emergency' },
        headers: { idempotencyKey: 'rotate-default-1' },
        path: { id: projectId, profileId }
      },
      undefined
    )

    const revoked = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'revoke',
      'default',
      '--yes',
      '--project',
      projectId
    ])
    expect(revoked.exitCodes).toEqual([])
    expect(JSON.parse(revoked.stdout)).toEqual({
      outbound: null,
      profileVersion: 8
    })
    expect(deleteVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 7 }
      },
      undefined
    )
  })

  test('prints inbound clear and outbound revoke responses as Photon sends them', async () => {
    const authenticated = await createAuthenticatedConfig()
    const newField = { addedByNewerApi: 'not in this SDK yet' }
    const cleared = { inbound: null, profileVersion: 2, ...newField }
    const revoked = { outbound: null, profileVersion: 3, ...newField }
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          deleteVoiceProfileInbound: vi.fn(() => Promise.resolve(cleared)),
          deleteVoiceProfileOutbound: vi.fn(() => Promise.resolve(revoked))
        })
      }
    )
    const command = (...argv: string[]) => [
      'project',
      'platform',
      'voice',
      'profile',
      ...argv,
      profileId,
      '--yes',
      '--project',
      projectId
    ]

    const clearedResult = await invoke(command('inbound', 'clear'))
    const revokedResult = await invoke(command('outbound', 'revoke'))

    expect(clearedResult.exitCodes).toEqual([])
    expect(JSON.parse(clearedResult.stdout)).toEqual(cleared)
    expect(revokedResult.exitCodes).toEqual([])
    expect(JSON.parse(revokedResult.stdout)).toEqual(revoked)
  })

  test('sends and reports MD5 only when explicitly selected for enablement', async () => {
    const authenticated = await createAuthenticatedConfig()
    const md5Outbound = outbound({
      authentication: {
        algorithm: 'md5',
        previousPasswordValidUntil: null,
        username: 'legacy-outbound-user',
        validFrom: timestamp
      },
      connection: {
        endpoints: [
          {
            host: 'sip.example.test',
            port: 5060,
            transport: 'udp'
          }
        ],
        realm: 'sip.example.test'
      }
    })
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() =>
      Promise.resolve({
        outbound: md5Outbound,
        password: 'legacy-outbound-password',
        profileVersion: 6
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          getDefaultVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true, version: 5 }))
          )
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--digest-algorithm',
      'md5',
      '--idempotency-key',
      'enable-legacy-1',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      outbound: {
        authentication: { algorithm: 'md5' },
        connection: {
          endpoints: [
            {
              host: 'sip.example.test',
              port: 5060,
              transport: 'udp'
            }
          ]
        }
      }
    })
    expect(configureVoiceProfileOutbound).toHaveBeenCalledWith(
      {
        body: {
          authentication: { algorithm: 'md5' },
          expectedVersion: 5
        },
        headers: { idempotencyKey: 'enable-legacy-1' },
        path: { id: projectId, profileId }
      },
      undefined
    )
  })

  test('treats an unavailable outbound password as success without retrying enable', async () => {
    const authenticated = await createAuthenticatedConfig()
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() =>
      Promise.resolve({
        outbound: outbound(),
        password: null,
        profileVersion: 6
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          getDefaultVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true, version: 5 }))
          )
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--idempotency-key',
      'enable-replay-1',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      outbound: { authentication: { username: 'profile-outbound-user' } },
      password: null,
      profileVersion: 6
    })
    expect(result.stderr).toContain('Rotate')
    expect(result.stderr).toContain('reusing the original key')
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(1)
  })

  test('continues an ambiguous outbound enable with its original version across invocations', async () => {
    const authenticated = await createAuthenticatedConfig()
    let requestCount = 0
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() => {
      requestCount += 1
      if (requestCount <= 2) {
        return Promise.reject(new TransportError('response interrupted'))
      }
      return Promise.resolve({
        outbound: outbound(),
        password: null,
        profileVersion: 6
      })
    })
    const getDefaultVoiceProfile = vi.fn(() =>
      Promise.resolve(
        profile({
          isDefault: true,
          version: requestCount === 0 ? 5 : 6
        })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          getDefaultVoiceProfile
        })
      }
    )
    const args = [
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--idempotency-key',
      'enable-cross-invocation-1',
      '--project',
      projectId
    ]

    const interrupted = await invoke(args)
    expect(interrupted.exitCodes).toEqual([1])
    expect(JSON.parse(interrupted.stdout)).toMatchObject({
      error: {
        code: 'API_CONNECTION_ERROR',
        idempotencyKey: 'enable-cross-invocation-1',
        replayable: true
      }
    })

    const continued = await invoke(args)
    expect(continued.exitCodes).toEqual([])
    expect(JSON.parse(continued.stdout)).toMatchObject({
      password: null,
      profileVersion: 6
    })
    expect(getDefaultVoiceProfile).toHaveBeenCalledTimes(1)
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(3)
    expect(configureVoiceProfileOutbound.mock.calls[0]).toEqual(
      configureVoiceProfileOutbound.mock.calls[2]
    )

    const operations = await invoke(['operation', 'list'])
    expect(JSON.parse(operations.stdout)).toEqual({ operations: [] })
  })

  test('rejects changing the digest algorithm for an unresolved enablement', async () => {
    const authenticated = await createAuthenticatedConfig()
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() => Promise.reject(new TransportError('response interrupted')))
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          getDefaultVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true, version: 5 }))
          )
        })
      }
    )
    const commonArgs = [
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--idempotency-key',
      'enable-algorithm-conflict-1',
      '--project',
      projectId
    ]

    const interrupted = await invoke([
      ...commonArgs,
      '--digest-algorithm',
      'md5'
    ])
    expect(interrupted.exitCodes).toEqual([1])
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(2)

    const rejected = await invoke(commonArgs)
    expect(rejected.exitCodes).toEqual([2])
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        detail: expect.stringContaining('different payload fingerprint')
      }
    })
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(2)
  })

  test('replays an ambiguous outbound enable from the operation journal', async () => {
    const authenticated = await createAuthenticatedConfig()
    let requestCount = 0
    const configureVoiceProfileOutbound = vi.fn<
      VoiceScope['configureVoiceProfileOutbound']
    >(() => {
      requestCount += 1
      if (requestCount <= 2) {
        return Promise.reject(new TransportError('response interrupted'))
      }
      return Promise.resolve({
        outbound: outbound(),
        password: null,
        profileVersion: 6
      })
    })
    const getDefaultVoiceProfile = vi.fn(() =>
      Promise.resolve(profile({ isDefault: true, version: 5 }))
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound,
          getDefaultVoiceProfile
        })
      }
    )

    const interrupted = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--idempotency-key',
      'enable-operation-replay-1',
      '--project',
      projectId
    ])
    const failure = JSON.parse(interrupted.stdout) as {
      error: { operationId: string }
    }

    const replayed = await invoke([
      'operation',
      'replay',
      failure.error.operationId,
      '--yes'
    ])
    expect(replayed.exitCodes).toEqual([])
    expect(JSON.parse(replayed.stdout)).toMatchObject({
      operation: {
        kind: 'voice-profile-outbound.enable',
        status: 'resolved'
      },
      result: { password: null, profileVersion: 6 }
    })
    expect(replayed.stderr).toContain('no longer available')
    expect(getDefaultVoiceProfile).toHaveBeenCalledTimes(1)
    expect(configureVoiceProfileOutbound).toHaveBeenCalledTimes(3)
    expect(configureVoiceProfileOutbound.mock.calls[0]).toEqual(
      configureVoiceProfileOutbound.mock.calls[2]
    )
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  })

  test.each([
    {
      args: ['enable', 'default'],
      kind: 'voice-profile-outbound.enable',
      response: {
        addedByNewerApi: 'not in this SDK yet',
        outbound: outbound(),
        password: 'replayed-enable-password',
        profileVersion: 6
      },
      scopeMethod: 'configureVoiceProfileOutbound'
    },
    {
      args: ['rotate', 'default', '--mode', 'normal', '--yes'],
      kind: 'voice-profile-outbound.rotate',
      response: {
        addedByNewerApi: 'not in this SDK yet',
        password: 'replayed-rotate-password',
        previousPasswordValidUntil: timestamp,
        profileVersion: 7
      },
      scopeMethod: 'rotateVoiceProfileOutboundCredential'
    }
  ] as const)(
    'replays $kind with the response the direct command prints',
    async ({ args, kind, response, scopeMethod }) => {
      const authenticated = await createAuthenticatedConfig()
      const send = vi
        .fn()
        .mockRejectedValueOnce(new TransportError('response interrupted'))
        .mockRejectedValueOnce(new TransportError('response interrupted'))
        .mockResolvedValue(response)
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        {
          voiceScope: voiceScope({
            getDefaultVoiceProfile: vi.fn(() =>
              Promise.resolve(
                profile({
                  configuration: { inbound: null, outbound: outbound() },
                  isDefault: true,
                  version: 5
                })
              )
            ),
            [scopeMethod]: send
          })
        }
      )

      const interrupted = await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        ...args,
        '--project',
        projectId
      ])
      const failure = JSON.parse(interrupted.stdout) as {
        error: { operationId: string }
      }
      const replayed = await invoke([
        'operation',
        'replay',
        failure.error.operationId,
        '--yes'
      ])
      const direct = await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        ...args,
        '--project',
        projectId
      ])

      expect(interrupted.exitCodes).toEqual([1])
      expect(replayed.exitCodes).toEqual([])
      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: {
          kind,
          operationId: failure.error.operationId,
          status: 'resolved'
        },
        result: response
      })
      expect(direct.exitCodes).toEqual([])
      expect(JSON.parse(direct.stdout)).toEqual(response)
    }
  )

  test.each([
    {
      args: ['enable', 'default'],
      kind: 'voice-profile-outbound.enable',
      response: {
        outbound: outbound(),
        password: 'late-output-enable-password',
        profileVersion: 6
      },
      scopeMethod: 'configureVoiceProfileOutbound'
    },
    {
      args: ['rotate', 'default', '--mode', 'normal', '--yes'],
      kind: 'voice-profile-outbound.rotate',
      response: {
        password: 'late-output-rotate-password',
        previousPasswordValidUntil: timestamp,
        profileVersion: 7
      },
      scopeMethod: 'rotateVoiceProfileOutboundCredential'
    }
  ] as const)(
    'names the replay when stdout fails after $kind, and again when the replay output fails',
    async ({ args, kind, response, scopeMethod }) => {
      const authenticated = await createAuthenticatedConfig()
      const send = vi.fn().mockResolvedValue(response)
      const overrides = {
        voiceScope: voiceScope({
          getDefaultVoiceProfile: vi.fn(() =>
            Promise.resolve(
              profile({
                configuration: { inbound: null, outbound: outbound() },
                isDefault: true,
                version: 5
              })
            )
          ),
          [scopeMethod]: send
        })
      }
      const failing = lateFailingInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        overrides
      )
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        overrides
      )

      const failed = await failing([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        ...args,
        '--project',
        projectId
      ])
      expect(failed.exitCodes, failed.stderr).toEqual([1])
      expect(failed.stderr).not.toContain(response.password)
      const operationId = String(stderrError(failed.stderr).operationId)
      const replayStep = {
        code: 'OUTPUT_WRITE_FAILED',
        next: [
          {
            description: 'Replay the operation',
            run: `${CLI_NAME} operation replay ${operationId}`
          }
        ],
        operationId,
        replayable: true
      }
      expect(stderrError(failed.stderr)).toMatchObject(replayStep)

      const failedReplay = await failing([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])
      expect(failedReplay.exitCodes).toEqual([1])
      expect(failedReplay.stderr).not.toContain(response.password)
      expect(stderrError(failedReplay.stderr)).toMatchObject(replayStep)

      const replayed = await invoke([
        'operation',
        'replay',
        operationId,
        '--yes'
      ])
      expect(replayed.exitCodes).toEqual([])
      expect(JSON.parse(replayed.stdout)).toEqual({
        operation: { kind, operationId, status: 'resolved' },
        result: response
      })
      expect(send).toHaveBeenCalledTimes(3)
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
    }
  )

  test('continues an ambiguous outbound rotation with its original version across invocations', async () => {
    const authenticated = await createAuthenticatedConfig()
    let requestCount = 0
    const rotateVoiceProfileOutboundCredential = vi.fn<
      VoiceScope['rotateVoiceProfileOutboundCredential']
    >(() => {
      requestCount += 1
      if (requestCount <= 2) {
        return Promise.reject(new TransportError('response interrupted'))
      }
      return Promise.resolve({
        password: null,
        previousPasswordValidUntil: timestamp,
        profileVersion: 7
      })
    })
    const getDefaultVoiceProfile = vi.fn(() =>
      Promise.resolve(
        profile({
          configuration: {
            inbound: null,
            outbound: outbound()
          },
          isDefault: true,
          version: requestCount === 0 ? 6 : 7
        })
      )
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          getDefaultVoiceProfile,
          rotateVoiceProfileOutboundCredential
        })
      }
    )
    const args = [
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'rotate',
      'default',
      '--mode',
      'normal',
      '--idempotency-key',
      'rotate-cross-invocation-1',
      '--yes',
      '--project',
      projectId
    ]

    const interrupted = await invoke(args)
    expect(interrupted.exitCodes).toEqual([1])
    expect(JSON.parse(interrupted.stdout)).toMatchObject({
      error: {
        code: 'API_CONNECTION_ERROR',
        idempotencyKey: 'rotate-cross-invocation-1',
        replayable: true
      }
    })

    const continued = await invoke(args)
    expect(continued.exitCodes).toEqual([])
    expect(JSON.parse(continued.stdout)).toMatchObject({
      password: null,
      previousPasswordValidUntil: timestamp,
      profileVersion: 7
    })
    expect(getDefaultVoiceProfile).toHaveBeenCalledTimes(1)
    expect(rotateVoiceProfileOutboundCredential).toHaveBeenCalledTimes(3)
    expect(rotateVoiceProfileOutboundCredential.mock.calls[0]).toEqual(
      rotateVoiceProfileOutboundCredential.mock.calls[2]
    )
  })

  test('fails closed when an outbound password is unsafe to display', async () => {
    const authenticated = await createAuthenticatedConfig()
    const unsafePassword = 'unsafe-password\nsecond-line'
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          configureVoiceProfileOutbound: vi.fn(() =>
            Promise.resolve({
              outbound: outbound(),
              password: unsafePassword,
              profileVersion: 6
            })
          ),
          getDefaultVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true, version: 5 }))
          )
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([1])
    expect(result.stderr).toBe('')
    expect(result.stderr).not.toContain('unsafe-password')
    expect(result.stdout).not.toContain('unsafe-password')
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: 'VOICE_PROTOCOL_ERROR' }
    })
  })

  test.each([
    {
      args: [] as string[],
      command: 'enable',
      configured: null
    },
    {
      args: ['--yes'],
      command: 'rotate',
      configured: outbound()
    }
  ])(
    'only reads the profile for outbound $command when Photon returns a malformed profile ID',
    async ({ args, command, configured }) => {
      const authenticated = await createAuthenticatedConfig()
      const scope = voiceScope({
        getDefaultVoiceProfile: vi.fn(() =>
          Promise.resolve(
            profile({
              configuration: { inbound: null, outbound: configured },
              isDefault: true,
              profileId: `a\u001b[31m\u202e${profileId}`,
              version: 5
            })
          )
        )
      })
      const invoke = terminalInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )

      const result = await invoke([
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        command,
        'default',
        ...args,
        '--project',
        projectId
      ])

      expect(result.exitCodes).toHaveLength(1)
      expect(result.exitCodes[0]).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(
        Object.entries(scope).flatMap(([name, method]) =>
          vi.isMockFunction(method) ? method.mock.calls.map(() => name) : []
        )
      ).toEqual(['getDefaultVoiceProfile'])
    }
  )

  test.each([
    {
      args: [] as string[],
      command: 'enable',
      configured: null,
      reference: 'default'
    },
    {
      args: [] as string[],
      command: 'enable',
      configured: null,
      reference: profileId
    },
    {
      args: ['--yes'],
      command: 'rotate',
      configured: outbound(),
      reference: 'default'
    },
    {
      args: ['--yes'],
      command: 'rotate',
      configured: outbound(),
      reference: profileId
    }
  ])(
    'answers a malformed profile ID from Photon as a Voice protocol error for outbound $command $reference',
    async ({ args, command, configured, reference }) => {
      const authenticated = await createAuthenticatedConfig()
      const malformed = profile({
        configuration: { inbound: null, outbound: configured },
        isDefault: reference === 'default',
        profileId: `a\u001b[31m\u202e${profileId}`,
        version: 5
      })
      const scope = voiceScope({
        getDefaultVoiceProfile: vi.fn(() => Promise.resolve(malformed)),
        getVoiceProfile: vi.fn(() => Promise.resolve(malformed))
      })
      const commandLine = [
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        command,
        reference,
        ...args,
        '--project',
        projectId
      ]
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )

      const json = await invoke(commandLine)
      const text = await terminalInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )(commandLine)

      expect(json.exitCodes).toEqual([1])
      expect(JSON.parse(json.stdout)).toMatchObject({
        error: {
          code: 'VOICE_PROTOCOL_ERROR',
          detail: 'The Voice profile did not contain a canonical profile ID.',
          message: 'Photon returned an invalid Voice response.'
        }
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain(
        'Photon returned an invalid Voice response.'
      )
      expect(text.stderr).toContain(
        'The Voice profile did not contain a canonical profile ID.'
      )
      for (const output of [json.stdout, json.stderr, text.stderr]) {
        expect(output).not.toContain('local operation record')
        expect(output).not.toContain(profileId)
        expect(output).not.toContain('\u001b[31m')
        expect(output).not.toContain('\u202e')
      }
      expect(scope.configureVoiceProfileOutbound).not.toHaveBeenCalled()
      expect(scope.rotateVoiceProfileOutboundCredential).not.toHaveBeenCalled()
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      await authenticated.remove()
    }
  )

  test('fails outbound rotate on a malformed profile ID before it asks for confirmation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = voiceScope({
      getDefaultVoiceProfile: vi.fn(() =>
        Promise.resolve(
          profile({
            configuration: { inbound: null, outbound: outbound() },
            isDefault: true,
            profileId: 'vpf_not_canonical',
            version: 5
          })
        )
      )
    })
    const stdin = Readable.from(['y\n']) as Readable & ReadableInput
    stdin.isTTY = true

    const result = await terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { stdin, voiceScope: scope }
    )([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'rotate',
      'default',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([1])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      'Photon returned an invalid Voice response.'
    )
    expect(result.stderr).not.toContain('[y/N]')
    expect(stdin.readableFlowing).toBeNull()
    expect(scope.rotateVoiceProfileOutboundCredential).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test.each([
    {
      args: [] as string[],
      command: 'enable',
      configured: null
    },
    {
      args: ['--yes'],
      command: 'rotate',
      configured: outbound()
    }
  ])(
    'refuses outbound $command when Photon reads another Voice profile for the ID given',
    async ({ args, command, configured }) => {
      const authenticated = await createAuthenticatedConfig()
      const scope = voiceScope({
        getVoiceProfile: vi.fn(() =>
          Promise.resolve(
            profile({
              configuration: { inbound: null, outbound: configured },
              profileId: otherProfileId,
              version: 5
            })
          )
        )
      })
      const commandLine = [
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        command,
        profileId,
        ...args,
        '--project',
        projectId
      ]
      const message = `Photon returned another Voice profile for ${profileId}. No change was made.`
      const invoke = cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )

      const json = await invoke(commandLine)
      const text = await terminalInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        { voiceScope: scope }
      )(commandLine)

      expect(json.exitCodes).toEqual([1])
      expect(JSON.parse(json.stdout)).toMatchObject({
        error: { code: 'VOICE_PROTOCOL_ERROR', message }
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain(message)
      expect(
        Object.entries(scope).flatMap(([name, method]) =>
          vi.isMockFunction(method) ? method.mock.calls.map(() => name) : []
        )
      ).toEqual(['getVoiceProfile', 'getVoiceProfile'])
      expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
        operations: []
      })
      await authenticated.remove()
    }
  )

  test('fails outbound rotate on another Voice profile before it asks for confirmation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const scope = voiceScope({
      getVoiceProfile: vi.fn(() =>
        Promise.resolve(
          profile({
            configuration: { inbound: null, outbound: outbound() },
            profileId: otherProfileId,
            version: 5
          })
        )
      )
    })
    const stdin = Readable.from(['y\n']) as Readable & ReadableInput
    stdin.isTTY = true

    const result = await terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { stdin, voiceScope: scope }
    )([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'rotate',
      profileId,
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([1])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      `Photon returned another Voice profile for ${profileId}. No change was made.`
    )
    expect(result.stderr).not.toContain('[y/N]')
    expect(stdin.readableFlowing).toBeNull()
    expect(scope.rotateVoiceProfileOutboundCredential).not.toHaveBeenCalled()
    await authenticated.remove()
  })

  test('requires explicit atomic unassignment before deleting an assigned profile', async () => {
    const authenticated = await createAuthenticatedConfig()
    const deleteVoiceProfile = vi.fn<VoiceScope['deleteVoiceProfile']>(() =>
      Promise.resolve(undefined)
    )
    const scope = voiceScope({
      deleteVoiceProfile,
      getVoiceProfile: vi.fn(() =>
        Promise.resolve(profile({ lineCount: 2, version: 4 }))
      )
    })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: scope }
    )

    const rejected = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'delete',
      profileId,
      '--yes',
      '--project',
      projectId
    ])
    expect(rejected.exitCodes).toEqual([2])
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      error: { code: 'VOICE_PROFILE_ASSIGNED' }
    })
    expect(deleteVoiceProfile).not.toHaveBeenCalled()

    const deleted = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'delete',
      profileId,
      '--unassign-lines',
      '--yes',
      '--project',
      projectId
    ])
    expect(JSON.parse(deleted.stdout)).toEqual({
      deleted: true,
      profileId,
      returnedToDefaultLineCount: 2
    })
    expect(deleteVoiceProfile).toHaveBeenCalledWith(
      {
        path: { id: projectId, profileId },
        query: { expectedVersion: 4, force: 'true' }
      },
      undefined
    )
  })

  test('rejects deleting the default profile with actionable remediation', async () => {
    const authenticated = await createAuthenticatedConfig()
    const deleteVoiceProfile = vi.fn<VoiceScope['deleteVoiceProfile']>()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          deleteVoiceProfile,
          getVoiceProfile: vi.fn(() =>
            Promise.resolve(profile({ isDefault: true }))
          )
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'delete',
      profileId,
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([2])
    const { error } = JSON.parse(result.stdout)
    expect(error).toMatchObject({
      code: 'VOICE_DEFAULT_PROFILE_DELETION_FORBIDDEN',
      next: [
        {
          description: 'Inspect the default profile',
          run: `${CLI_NAME} project platform voice profile view default`
        },
        {
          description: `Change its delivery with "${CLI_NAME} project platform voice profile inbound" or "${CLI_NAME} project platform voice profile outbound".`
        }
      ]
    })
    expect(deleteVoiceProfile).not.toHaveBeenCalled()
  })

  test('batch assigns distinct lines using their fetched resource versions', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getVoiceLineProfileAssignment = vi.fn<
      VoiceScope['getVoiceLineProfileAssignment']
    >((input) =>
      Promise.resolve(
        assignment(input.path.resourceId, {
          resourceVersion: input.path.resourceId === resourceId ? 11 : 12
        })
      )
    )
    const batchUpdateVoiceLineProfileAssignments = vi.fn<
      VoiceScope['batchUpdateVoiceLineProfileAssignments']
    >((input) =>
      Promise.resolve({
        assignments: input.body.updates.map((update) =>
          assignment(update.resourceId, {
            ...(update.profileId === null
              ? {}
              : { profileId: update.profileId }),
            profileVersion: 2,
            resourceVersion: update.expectedVersion + 1
          })
        )
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          batchUpdateVoiceLineProfileAssignments,
          getVoiceLineProfileAssignment
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'assignment',
      'set',
      '--profile-id',
      profileId,
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject({
      assignments: [
        { profileId, resourceId, resourceVersion: 12 },
        { profileId, resourceId: secondResourceId, resourceVersion: 13 }
      ]
    })
    expect(batchUpdateVoiceLineProfileAssignments).toHaveBeenCalledWith(
      {
        body: {
          updates: [
            { expectedVersion: 11, profileId, resourceId },
            {
              expectedVersion: 12,
              profileId,
              resourceId: secondResourceId
            }
          ]
        },
        path: { id: projectId }
      },
      undefined
    )
  })

  test('lists the read of a line that already uses the profile beside the assignment Photon returns for the changed line', async () => {
    const authenticated = await createAuthenticatedConfig()
    const unchanged = {
      ...assignment(resourceId, {
        profileId,
        profileVersion: 1,
        resourceVersion: 7
      }),
      addedByNewerApi: 'read before the change'
    }
    const assigned = {
      ...assignment(secondResourceId, {
        profileId,
        profileVersion: 1,
        resourceVersion: 5,
        updatedAt: '2026-08-21T19:00:00.000Z'
      }),
      addedByNewerApi: 'returned for the change'
    }
    const assignVoiceLineProfile = vi.fn<VoiceScope['assignVoiceLineProfile']>(
      () => Promise.resolve(assigned)
    )
    const batchUpdateVoiceLineProfileAssignments =
      vi.fn<VoiceScope['batchUpdateVoiceLineProfileAssignments']>()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          assignVoiceLineProfile,
          batchUpdateVoiceLineProfileAssignments,
          getVoiceLineProfileAssignment: vi.fn((input) =>
            Promise.resolve(
              input.path.resourceId === resourceId
                ? unchanged
                : assignment(secondResourceId, { resourceVersion: 4 })
            )
          )
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'assignment',
      'set',
      '--profile-id',
      profileId,
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      assignments: [unchanged, assigned]
    })
    expect(assignVoiceLineProfile).toHaveBeenCalledOnce()
    expect(assignVoiceLineProfile).toHaveBeenCalledWith(
      {
        body: { expectedVersion: 4, profileId },
        path: { id: projectId, resourceId: secondResourceId }
      },
      undefined
    )
    expect(batchUpdateVoiceLineProfileAssignments).not.toHaveBeenCalled()
  })

  test('lists each line as read when every line already uses the profile', async () => {
    const authenticated = await createAuthenticatedConfig()
    const first = {
      ...assignment(resourceId, { profileId, profileVersion: 1 }),
      addedByNewerApi: 'first read'
    }
    const second = {
      ...assignment(secondResourceId, {
        profileId,
        profileVersion: 1,
        resourceVersion: 8
      }),
      addedByNewerApi: 'second read'
    }
    const assignVoiceLineProfile = vi.fn<VoiceScope['assignVoiceLineProfile']>()
    const batchUpdateVoiceLineProfileAssignments =
      vi.fn<VoiceScope['batchUpdateVoiceLineProfileAssignments']>()
    const scope = {
      voiceScope: voiceScope({
        assignVoiceLineProfile,
        batchUpdateVoiceLineProfileAssignments,
        getVoiceLineProfileAssignment: vi.fn((input) =>
          Promise.resolve(input.path.resourceId === resourceId ? first : second)
        )
      })
    }
    const command = [
      'project',
      'platform',
      'voice',
      'assignment',
      'set',
      '--profile-id',
      profileId,
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ]

    const json = await cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      scope
    )(command)
    const text = await terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      scope
    )(command)

    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual({ assignments: [first, second] })
    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toContain('Every line already uses that profile.')
    expect(assignVoiceLineProfile).not.toHaveBeenCalled()
    expect(batchUpdateVoiceLineProfileAssignments).not.toHaveBeenCalled()
  })

  test('lists the read of a line that is already unassigned beside the read after the change for the line it clears', async () => {
    const authenticated = await createAuthenticatedConfig()
    const unassigned = {
      ...assignment(resourceId, { resourceVersion: 7 }),
      addedByNewerApi: 'read before the change'
    }
    const cleared = {
      ...assignment(secondResourceId, {
        resourceVersion: 5,
        updatedAt: '2026-08-21T19:00:00.000Z'
      }),
      addedByNewerApi: 'read after the change'
    }
    let secondReads = 0
    const getVoiceLineProfileAssignment = vi.fn<
      VoiceScope['getVoiceLineProfileAssignment']
    >((input) => {
      if (input.path.resourceId === resourceId) {
        return Promise.resolve(unassigned)
      }
      secondReads += 1
      return Promise.resolve(
        secondReads === 1
          ? assignment(secondResourceId, {
              profileId,
              profileVersion: 1,
              resourceVersion: 4
            })
          : cleared
      )
    })
    const unassignVoiceLineProfile = vi.fn<
      VoiceScope['unassignVoiceLineProfile']
    >(() => Promise.resolve(undefined))
    const assignVoiceLineProfile = vi.fn<VoiceScope['assignVoiceLineProfile']>()
    const batchUpdateVoiceLineProfileAssignments =
      vi.fn<VoiceScope['batchUpdateVoiceLineProfileAssignments']>()
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          assignVoiceLineProfile,
          batchUpdateVoiceLineProfileAssignments,
          getVoiceLineProfileAssignment,
          unassignVoiceLineProfile
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'assignment',
      'clear',
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      assignments: [unassigned, cleared]
    })
    expect(unassignVoiceLineProfile).toHaveBeenCalledOnce()
    expect(unassignVoiceLineProfile).toHaveBeenCalledWith(
      {
        path: { id: projectId, resourceId: secondResourceId },
        query: { expectedVersion: 4 }
      },
      undefined
    )
    const reads = getVoiceLineProfileAssignment.mock.calls.map(
      ([input]) => input.path.resourceId
    )
    expect(reads).toHaveLength(3)
    expect(new Set(reads.slice(0, 2))).toEqual(
      new Set([resourceId, secondResourceId])
    )
    expect(reads[2]).toBe(secondResourceId)
    expect(assignVoiceLineProfile).not.toHaveBeenCalled()
    expect(batchUpdateVoiceLineProfileAssignments).not.toHaveBeenCalled()
  })

  test('lists each line as read when every line is already unassigned', async () => {
    const authenticated = await createAuthenticatedConfig()
    const first = {
      ...assignment(resourceId),
      addedByNewerApi: 'first read'
    }
    const second = {
      ...assignment(secondResourceId, { resourceVersion: 8 }),
      addedByNewerApi: 'second read'
    }
    const unassignVoiceLineProfile =
      vi.fn<VoiceScope['unassignVoiceLineProfile']>()
    const assignVoiceLineProfile = vi.fn<VoiceScope['assignVoiceLineProfile']>()
    const batchUpdateVoiceLineProfileAssignments =
      vi.fn<VoiceScope['batchUpdateVoiceLineProfileAssignments']>()
    const scope = {
      voiceScope: voiceScope({
        assignVoiceLineProfile,
        batchUpdateVoiceLineProfileAssignments,
        getVoiceLineProfileAssignment: vi.fn((input) =>
          Promise.resolve(input.path.resourceId === resourceId ? first : second)
        ),
        unassignVoiceLineProfile
      })
    }
    const command = [
      'project',
      'platform',
      'voice',
      'assignment',
      'clear',
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ]

    const json = await cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      scope
    )(command)
    const text = await terminalInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      scope
    )(command)

    expect(json.exitCodes).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual({ assignments: [first, second] })
    expect(text.exitCodes).toEqual([])
    expect(text.stdout).toContain('Every line is already unassigned.')
    expect(unassignVoiceLineProfile).not.toHaveBeenCalled()
    expect(assignVoiceLineProfile).not.toHaveBeenCalled()
    expect(batchUpdateVoiceLineProfileAssignments).not.toHaveBeenCalled()
  })

  test.each([
    { command: 'set', count: 'one line', lines: [resourceId] },
    {
      command: 'set',
      count: 'two lines',
      lines: [resourceId, secondResourceId]
    },
    { command: 'clear', count: 'one line', lines: [resourceId] },
    {
      command: 'clear',
      count: 'two lines',
      lines: [resourceId, secondResourceId]
    }
  ] as const)(
    'sends no $command change for $count when a read answers for another line',
    async ({ command, lines }) => {
      const authenticated = await createAuthenticatedConfig()
      const strayResourceId = 'pho_res_01h455vb4pex5vsknk084sn02z'
      const named = lines.at(-1)
      const overrides =
        command === 'clear' ? { profileId, profileVersion: 1 } : {}
      const assignVoiceLineProfile =
        vi.fn<VoiceScope['assignVoiceLineProfile']>()
      const unassignVoiceLineProfile =
        vi.fn<VoiceScope['unassignVoiceLineProfile']>()
      const batchUpdateVoiceLineProfileAssignments =
        vi.fn<VoiceScope['batchUpdateVoiceLineProfileAssignments']>()
      const scope = {
        voiceScope: voiceScope({
          assignVoiceLineProfile,
          batchUpdateVoiceLineProfileAssignments,
          getVoiceLineProfileAssignment: vi.fn<
            VoiceScope['getVoiceLineProfileAssignment']
          >((input) =>
            Promise.resolve(
              assignment(
                input.path.resourceId === named
                  ? strayResourceId
                  : input.path.resourceId,
                overrides
              )
            )
          ),
          unassignVoiceLineProfile
        })
      }
      const args = [
        'project',
        'platform',
        'voice',
        'assignment',
        command,
        ...(command === 'set' ? ['--profile-id', profileId] : []),
        ...lines.flatMap((line) => ['--resource-id', line]),
        '--yes',
        '--project',
        projectId
      ]
      const message = `Photon returned another line's Voice assignment for ${named}. No change was made.`

      const json = await cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        scope
      )([...args, '--json'])
      const text = await terminalInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        scope
      )(args)

      expect(json.exitCodes).toEqual([1])
      expect(JSON.parse(json.stdout)).toMatchObject({
        error: { code: 'VOICE_PROTOCOL_ERROR', message }
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain(`Error: ${message} (VOICE_PROTOCOL_ERROR)`)
      expect(json.stdout + text.stderr).not.toContain(strayResourceId)
      expect(assignVoiceLineProfile).not.toHaveBeenCalled()
      expect(unassignVoiceLineProfile).not.toHaveBeenCalled()
      expect(batchUpdateVoiceLineProfileAssignments).not.toHaveBeenCalled()
    }
  )

  test.each([
    { answer: 'batch', command: 'set', lines: [resourceId, secondResourceId] },
    {
      answer: 'batch',
      command: 'clear',
      lines: [resourceId, secondResourceId]
    },
    { answer: 'assign', command: 'set', lines: [resourceId] },
    { answer: 'read after clear', command: 'clear', lines: [resourceId] }
  ] as const)(
    'fails $command when the $answer answer leaves out a line it changed',
    async ({ command, lines }) => {
      const authenticated = await createAuthenticatedConfig()
      const strayResourceId = 'pho_res_01h455vb4pex5vsknk084sn02z'
      const leftOut = lines.at(-1)
      const sentTo: string[] = []
      const scope = () => {
        let reads = 0
        return {
          voiceScope: voiceScope({
            assignVoiceLineProfile: vi.fn<VoiceScope['assignVoiceLineProfile']>(
              (input) => {
                sentTo.push(input.path.resourceId)
                return Promise.resolve(
                  assignment(strayResourceId, { profileId, profileVersion: 1 })
                )
              }
            ),
            batchUpdateVoiceLineProfileAssignments: vi.fn<
              VoiceScope['batchUpdateVoiceLineProfileAssignments']
            >((input) => {
              sentTo.push(
                ...input.body.updates.map((update) => update.resourceId)
              )
              return Promise.resolve({
                assignments: input.body.updates
                  .filter((update) => update.resourceId !== leftOut)
                  .map((update) =>
                    assignment(update.resourceId, {
                      ...(update.profileId === null
                        ? {}
                        : { profileId: update.profileId, profileVersion: 1 }),
                      resourceVersion: update.expectedVersion + 1
                    })
                  )
              })
            }),
            getVoiceLineProfileAssignment: vi.fn<
              VoiceScope['getVoiceLineProfileAssignment']
            >((input) => {
              reads += 1
              return Promise.resolve(
                reads > lines.length
                  ? assignment(strayResourceId, { resourceVersion: 4 })
                  : assignment(
                      input.path.resourceId,
                      command === 'clear'
                        ? { profileId, profileVersion: 1 }
                        : {}
                    )
              )
            }),
            unassignVoiceLineProfile: vi.fn<
              VoiceScope['unassignVoiceLineProfile']
            >((input) => {
              sentTo.push(input.path.resourceId)
              return Promise.resolve(undefined)
            })
          })
        }
      }
      const args = [
        'project',
        'platform',
        'voice',
        'assignment',
        command,
        ...(command === 'set' ? ['--profile-id', profileId] : []),
        ...lines.flatMap((line) => ['--resource-id', line]),
        '--yes',
        '--project',
        projectId
      ]
      const message = `Photon did not return the Voice assignment for ${leftOut}. The change may have been made.`
      const view = `${CLI_NAME} project platform voice assignment view ${leftOut} --project ${projectId}`

      const json = await cliInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        scope()
      )([...args, '--json'])
      const text = await terminalInvoker(
        authenticated.configDirectory,
        asProjectScope({}),
        scope()
      )(args)

      expect(json.exitCodes).toEqual([1])
      const document = JSON.parse(json.stdout)
      expect(document).not.toHaveProperty('assignments')
      expect(document).toMatchObject({
        error: {
          code: 'VOICE_PROTOCOL_ERROR',
          message,
          next: [{ description: 'Check the line', run: view }]
        }
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stdout).toBe('')
      expect(text.stderr).toContain(`Error: ${message} (VOICE_PROTOCOL_ERROR)`)
      expect(text.stderr).toContain(`Next: Check the line: ${view}`)
      expect(json.stdout + text.stderr).not.toContain(strayResourceId)
      expect(sentTo).toEqual([...lines, ...lines])
    }
  )

  test('batch clears distinct lines at the IDs given, using their fetched resource versions', async () => {
    const authenticated = await createAuthenticatedConfig()
    const getVoiceLineProfileAssignment = vi.fn<
      VoiceScope['getVoiceLineProfileAssignment']
    >((input) =>
      Promise.resolve(
        assignment(input.path.resourceId, {
          profileId,
          profileVersion: 1,
          resourceVersion: input.path.resourceId === resourceId ? 11 : 12
        })
      )
    )
    const batchUpdateVoiceLineProfileAssignments = vi.fn<
      VoiceScope['batchUpdateVoiceLineProfileAssignments']
    >((input) =>
      Promise.resolve({
        assignments: input.body.updates.map((update) =>
          assignment(update.resourceId, {
            resourceVersion: update.expectedVersion + 1
          })
        )
      })
    )
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      {
        voiceScope: voiceScope({
          batchUpdateVoiceLineProfileAssignments,
          getVoiceLineProfileAssignment
        })
      }
    )

    const result = await invoke([
      'project',
      'platform',
      'voice',
      'assignment',
      'clear',
      '--resource-id',
      resourceId,
      '--resource-id',
      secondResourceId,
      '--yes',
      '--project',
      projectId
    ])

    expect(result.exitCodes).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual({
      assignments: [
        assignment(resourceId, { resourceVersion: 12 }),
        assignment(secondResourceId, { resourceVersion: 13 })
      ]
    })
    expect(
      batchUpdateVoiceLineProfileAssignments
    ).toHaveBeenCalledExactlyOnceWith(
      {
        body: {
          updates: [
            { expectedVersion: 11, profileId: null, resourceId },
            {
              expectedVersion: 12,
              profileId: null,
              resourceId: secondResourceId
            }
          ]
        },
        path: { id: projectId }
      },
      undefined
    )
  })
})

test('edits default Voice media encryption with the fetched version and rejects renaming it', async () => {
  const authenticated = await createAuthenticatedConfig()
  const updateDefaultVoiceProfile = vi.fn<
    VoiceScope['updateDefaultVoiceProfile']
  >(() =>
    Promise.resolve(
      profile({ isDefault: true, mediaEncryption: 'srtp', version: 2 })
    )
  )
  const scope = voiceScope({ updateDefaultVoiceProfile })
  const invoke = cliInvoker(authenticated.configDirectory, asProjectScope({}), {
    voiceScope: scope
  })
  const edited = await invoke([
    'project',
    'platform',
    'voice',
    'profile',
    'edit',
    'default',
    '--media-encryption',
    'srtp',
    '--project',
    projectId
  ])
  expect(edited.exitCodes).toEqual([])
  expect(JSON.parse(edited.stdout)).toEqual(
    profile({ isDefault: true, mediaEncryption: 'srtp', version: 2 })
  )
  expect(updateDefaultVoiceProfile).toHaveBeenCalledWith(
    {
      body: { expectedVersion: 1, mediaEncryption: 'srtp' },
      path: { id: projectId }
    },
    undefined
  )
  expect(scope.updateVoiceProfile).not.toHaveBeenCalled()
  const renamed = await invoke([
    'project',
    'platform',
    'voice',
    'profile',
    'edit',
    'default',
    '--name',
    'Renamed',
    '--project',
    projectId
  ])
  expect(renamed.exitCodes).toEqual([2])
  expect(updateDefaultVoiceProfile).toHaveBeenCalledTimes(1)
  await authenticated.remove()
})

test('prints a recovered outbound password in human output before acknowledgement', async () => {
  const authenticated = await createAuthenticatedConfig()
  try {
    const configureVoiceProfileOutbound = vi
      .fn<VoiceScope['configureVoiceProfileOutbound']>()
      .mockRejectedValueOnce(new TransportError('Interrupted'))
      .mockRejectedValueOnce(new TransportError('Interrupted'))
      .mockResolvedValue({
        outbound: outbound(),
        password: 'recovered-outbound-password',
        profileVersion: 2
      })
    const scope = voiceScope({ configureVoiceProfileOutbound })
    const invoke = cliInvoker(
      authenticated.configDirectory,
      asProjectScope({}),
      { voiceScope: scope }
    )
    const failed = await invoke([
      'project',
      'platform',
      'voice',
      'profile',
      'outbound',
      'enable',
      'default',
      '--project',
      projectId,
      '--idempotency-key',
      'recover-display-password'
    ])
    const failure = JSON.parse(failed.stdout) as {
      error: { operationId: string }
    }
    const stdout = collector()
    const stderr = collector()
    await runCli(['operation', 'replay', failure.error.operationId, '--yes'], {
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      projectScope: asProjectScope({}),
      stderr,
      stdout,
      voiceScope: scope
    })
    expect(stdout.value()).toContain('recovered-outbound-password')
    expect(stderr.value()).not.toContain('recovered-outbound-password')
    expect(JSON.parse((await invoke(['operation', 'list'])).stdout)).toEqual({
      operations: []
    })
  } finally {
    await authenticated.remove()
  }
})
