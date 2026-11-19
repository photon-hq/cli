import { crc32, deflateSync } from 'node:zlib'
import type { Scenario, ScenarioContext } from './runner.ts'

// Every step names the test organization (the runner adds --org) and the
// run's own project, so nothing relies on a default or a remembered one. Every
// name starts with the run's prefix, so the last scenarios can show that
// nothing the run made is left.

const REDIRECT_URI = 'https://example.com/photon-cli-test/callback'
const WEBHOOK_URL = 'https://example.com/photon-cli-test/webhook'
const SIP_URI = 'sip:photon-cli-test@example.com'
const EDITED_SIP_URI = 'sip:photon-cli-test-edited@example.com'
const EMAIL_DOMAIN = 'photon-cli-test.example.com'
const BILLING_CATEGORY = 'messaging'
const PAID_PLAN = 'messaging_pro'
const BILLING_ATTEMPTS = 12
const BILLING_WAIT_MS = 10_000
const DAY_MS = 86_400_000
const MILLISECONDS_PATTERN = /\.\d{3}Z$/u

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fieldOf = (json: unknown, key: string): unknown =>
  isRecord(json) ? json[key] : undefined

const recordAt = (json: unknown, key: string): JsonRecord => {
  const value = fieldOf(json, key)
  return isRecord(value) ? value : {}
}

const listAt = (json: unknown, key: string): JsonRecord[] => {
  const list = fieldOf(json, key)
  return Array.isArray(list) ? list.filter(isRecord) : []
}

const lists =
  (key: string, field: string, value: string) =>
  (json: unknown): boolean =>
    listAt(json, key).some((entry) => entry[field] === value)

const namesNone =
  (key: string, prefix: string) =>
  (json: unknown): boolean =>
    !listAt(json, key).some(
      ({ name }) => typeof name === 'string' && name.startsWith(prefix)
    )

const inOneDay = (): string =>
  new Date(Date.now() + DAY_MS).toISOString().replace(MILLISECONDS_PATTERN, 'Z')

const pngChunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

// A 256-pixel square of one colour: an avatar upload needs a real image.
const avatarPng = (): Buffer => {
  const size = 256
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [47, 111, 235]).flat())
  ])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk(
      'IDAT',
      deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))
    ),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const hasActiveMessaging = (json: unknown): boolean =>
  listAt(recordAt(json, 'billing'), 'subscriptions').some(
    ({ category, status }) =>
      category === BILLING_CATEGORY && status === 'active'
  )

// A new project's billing is set up after the project is created. A purchase
// before then is refused for that reason, not the one the test expects.
const waitForBilling = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each attempt waits for the one before it.
    const overview = await context.photon(
      inProject('project', 'billing', 'overview')
    )
    if (context.dryRun || hasActiveMessaging(overview.json)) {
      return
    }
    if (attempt === BILLING_ATTEMPTS) {
      context.check(
        overview,
        `the project has an active ${BILLING_CATEGORY} subscription`,
        hasActiveMessaging
      )
    }
    await context.sleep(BILLING_WAIT_MS)
  }
}

const signIn: Scenario = {
  name: 'sign in',
  passes: ['first', 'second'],
  required: true,
  async run(context) {
    const login = await context.photon(
      ['login', '--service-key', '--insecure-storage'],
      { stdin: `${context.serviceKey}\n` }
    )
    context.check(
      login,
      'signed in with an account service key',
      (json) => fieldOf(json, 'credentialKind') === 'account_service_key'
    )
    const whoami = await context.photon(['whoami'])
    context.check(
      whoami,
      'whoami names the account',
      (json) => typeof fieldOf(json, 'accountId') === 'string'
    )
    const status = await context.photon(['auth', 'status'])
    context.check(
      status,
      'the session is authenticated',
      (json) => fieldOf(json, 'state') === 'authenticated'
    )
  }
}

const localState: Scenario = {
  name: 'local state',
  passes: ['first'],
  async run(context) {
    const organizations = await context.photon(['org', 'list'])
    context.check(
      organizations,
      'the test organization is listed',
      lists('organizations', 'organizationId', context.organizationId)
    )
    await context.photon(['org', 'use', context.organizationId], {
      org: false
    })
    const shown = await context.photon(['org', 'show'], { org: false })
    context.check(
      shown,
      'org show reads the organization org use stored',
      (json) =>
        recordAt(json, 'organization').organizationId ===
          context.organizationId && fieldOf(json, 'source') === 'stored'
    )
    const cleared = await context.photon(['org', 'clear'], { org: false })
    context.check(
      cleared,
      'org clear removed the stored organization',
      (json) => fieldOf(json, 'cleared') === true
    )
    const completion = await context.photon(['completion', 'zsh'], {
      json: false,
      org: false
    })
    context.check(
      completion,
      'the zsh script calls back into complete',
      (text) => typeof text === 'string' && text.includes(' complete -- ')
    )
    const update = await context.photon(['update', '--check'], { org: false })
    context.check(
      update,
      'update --check names the newest published version',
      (json) => typeof fieldOf(json, 'latestVersion') === 'string'
    )
  }
}

const account: Scenario = {
  name: 'account',
  passes: ['first', 'second'],
  async run(context) {
    const view = await context.photon(['account', 'view'])
    // The test signs in as a person's own account, so the edit writes the
    // name the account already has.
    const firstName = context.value(view, 'firstName')
    const edited = await context.photon([
      'account',
      'edit',
      '--first-name',
      firstName
    ])
    context.check(
      edited,
      'the first name is unchanged',
      (json) => fieldOf(json, 'firstName') === firstName
    )
    await context.part(
      'reads',
      async () => {
        await context.photon(['account', 'oauth', 'connection', 'list'])
        await context.photon(['account', 'oauth', 'scope', 'list'])
      },
      { passes: ['first'] }
    )
  }
}

const serviceKeys: Scenario = {
  name: 'Account service keys',
  passes: ['first', 'second'],
  async run(context) {
    const created = await context.photon([
      'account',
      'service-key',
      'create',
      '--name',
      context.name('service-key'),
      '--expires-at',
      inOneDay()
    ])
    const serviceKeyId = context.value(created, 'serviceKey.serviceKeyId')
    context.defer(['account', 'service-key', 'revoke', serviceKeyId, '--yes'])
    const listed = await context.photon(['account', 'service-key', 'list'])
    context.check(
      listed,
      'the new key is listed',
      lists('serviceKeys', 'serviceKeyId', serviceKeyId)
    )
  }
}

const organization: Scenario = {
  name: 'organization',
  passes: ['first'],
  async run(context) {
    const shown = await context.photon(['org', 'show'])
    context.check(
      shown,
      'org show reads the organization --org names',
      (json) =>
        recordAt(json, 'organization').organizationId === context.organizationId
    )
    await context.photon(['org', 'member', 'list'])
    await context.photon(['org', 'invitation', 'list'])
    await context.photon(['org', 'billing', 'payment-method', 'status'])
  }
}

const oauthClients: Scenario = {
  name: 'OAuth clients',
  passes: ['first', 'second'],
  async run(context) {
    const created = await context.photon([
      'org',
      'oauth-client',
      'create',
      '--name',
      context.name('oauth-client'),
      '--redirect-uri',
      REDIRECT_URI,
      '--default-redirect-uri',
      REDIRECT_URI
    ])
    const clientId = context.value(created, 'clientId')
    context.defer(['org', 'oauth-client', 'delete', clientId, '--yes'])
    const listed = await context.photon(['org', 'oauth-client', 'list'])
    context.check(
      listed,
      'the new client is listed',
      lists('oauthClients', 'clientId', clientId)
    )
    await context.photon(['org', 'oauth-client', 'view', clientId])
    const renamed = context.name('oauth-client-renamed')
    const updated = await context.photon([
      'org',
      'oauth-client',
      'update',
      clientId,
      '--name',
      renamed
    ])
    context.check(
      updated,
      'the client has its new name',
      (json) => fieldOf(json, 'name') === renamed
    )
    await context.part('secret', async () => {
      await context.photon([
        'org',
        'oauth-client',
        'secret',
        'create',
        clientId
      ])
      context.defer([
        'org',
        'oauth-client',
        'secret',
        'revoke',
        clientId,
        '--yes'
      ])
      await context.photon(['org', 'oauth-client', 'secret', 'view', clientId])
      await context.photon([
        'org',
        'oauth-client',
        'secret',
        'rotate',
        clientId,
        '--yes'
      ])
    })
  }
}

const projectReads = async (
  context: ScenarioContext,
  name: string,
  projectId: string,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  await context.photon(inProject('project', 'view'))
  const listed = await context.photon(['project', 'list', '--search', name])
  context.check(
    listed,
    'the new project is listed',
    lists('projects', 'projectId', projectId)
  )
  const counted = await context.photon(['project', 'count', '--search', name])
  context.check(
    counted,
    'the count includes the new project',
    (json) => Number(fieldOf(json, 'count')) >= 1
  )
  await context.photon(['link', '--project', projectId])
  const current = await context.photon(['project', 'current'])
  context.check(
    current,
    'project current reads the project link saved for the folder',
    (json) =>
      recordAt(json, 'project').projectId === projectId &&
      fieldOf(json, 'source') === 'folder'
  )
  const cleared = await context.photon(['unlink'])
  context.check(
    cleared,
    'unlink removed the saved project',
    (json) => fieldOf(json, 'cleared') === true
  )
}

const agentProfile = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  await context.photon(inProject('project', 'agent-profile', 'view'))
  const edited = await context.photon(
    inProject(
      'project',
      'agent-profile',
      'edit',
      '--first-name',
      'Photon',
      '--last-name',
      'Test'
    )
  )
  context.check(
    edited,
    'the agent has its new name',
    (json) => fieldOf(json, 'firstName') === 'Photon'
  )
  const avatar = await context.file('avatar.png', avatarPng())
  const uploaded = await context.photon(
    inProject('project', 'agent-profile', 'avatar', 'upload', avatar)
  )
  context.defer(
    inProject('project', 'agent-profile', 'avatar', 'reset', '--yes')
  )
  context.check(
    uploaded,
    'the agent has an avatar',
    (json) => typeof fieldOf(json, 'avatarUrl') === 'string'
  )
}

const apiKeys = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const created = await context.photon(
    inProject(
      'project',
      'api-key',
      'create',
      '--name',
      context.name('api-key'),
      '--permission',
      'project:read',
      '--expires-at',
      inOneDay()
    )
  )
  const apiKeyId = context.value(created, 'apiKey.apiKeyId')
  context.defer(inProject('project', 'api-key', 'revoke', apiKeyId, '--yes'))
  const listed = await context.photon(inProject('project', 'api-key', 'list'))
  context.check(
    listed,
    'the new API key is listed',
    lists('apiKeys', 'apiKeyId', apiKeyId)
  )
}

const webhooks = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const webhook = (...argv: string[]) =>
    inProject('project', 'webhook', ...argv)
  const versions = await context.photon(webhook('api-version', 'list'))
  const apiVersion = context.select(
    versions,
    'a selectable API version',
    (json) =>
      listAt(json, 'apiVersions').find(({ selectable }) => selectable === true)
        ?.version
  )
  await context.photon(
    webhook('event-type', 'list', '--api-version', apiVersion)
  )
  const created = await context.photon(
    webhook(
      'create',
      '--name',
      context.name('webhook'),
      '--url',
      WEBHOOK_URL,
      '--api-version',
      apiVersion,
      '--all-events',
      '--status',
      'disabled'
    )
  )
  const destinationId = context.value(created, 'destination.destinationId')
  context.defer(webhook('delete', destinationId, '--yes'))
  await context.photon(webhook('view', destinationId))
  const listed = await context.photon(webhook('list'))
  context.check(
    listed,
    'the new destination is listed',
    lists('destinations', 'destinationId', destinationId)
  )
  const renamed = context.name('webhook-renamed')
  const edited = await context.photon(
    webhook('edit', destinationId, '--name', renamed)
  )
  context.check(
    edited,
    'the destination has its new name',
    (json) => fieldOf(json, 'name') === renamed
  )
  await context.photon(webhook('rotate-secret', destinationId, '--yes'))
}

const voiceProfiles = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const profile = (...argv: string[]) =>
    inProject('project', 'platform', 'voice', 'profile', ...argv)
  // An additional profile needs the default one, which can't be deleted and
  // goes with the project.
  await context.photon(profile('create', '--default'))
  const created = await context.photon(
    profile('create', '--name', context.name('voice-profile'))
  )
  const profileId = context.value(created, 'profileId')
  context.defer(profile('delete', profileId, '--yes'))
  const listed = await context.photon(profile('list'))
  context.check(
    listed,
    'the new profile is listed',
    lists('profiles', 'profileId', profileId)
  )
  await context.photon(profile('view', profileId))
  const renamed = context.name('voice-profile-renamed')
  const edited = await context.photon(
    profile('edit', profileId, '--name', renamed)
  )
  context.check(
    edited,
    'the profile has its new name',
    (json) => fieldOf(json, 'name') === renamed
  )
  await context.photon(
    profile('inbound', 'set', profileId, '--sip-uri', SIP_URI, '--yes')
  )
  context.defer(profile('inbound', 'clear', profileId, '--yes'))
  await context.photon(
    profile('inbound', 'edit', profileId, '--sip-uri', EDITED_SIP_URI, '--yes')
  )
}

const billing = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const subscription = (...argv: string[]) =>
    inProject('project', 'billing', 'subscription', ...argv)
  await waitForBilling(context, inProject)
  await context.photon(inProject('project', 'billing', 'invoice', 'list'))
  // On the default plan, cancel and resume find nothing to change.
  await context.photon(
    subscription('cancel', '--category', BILLING_CATEGORY, '--yes')
  )
  await context.photon(subscription('resume', '--category', BILLING_CATEGORY))
}

const platformReads = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const platform = (...argv: string[]) =>
    inProject('project', 'platform', ...argv)
  for (const argv of [
    ['list'],
    ['email', 'list'],
    ['imessage', 'list'],
    ['imessage', 'view'],
    ['imessage', 'assignment', 'list'],
    ['sms', 'list'],
    ['telegram', 'list'],
    ['voice', 'list'],
    ['whatsapp-business', 'account', 'list'],
    ['whatsapp-business', 'number', 'list']
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: the test runs one command at a time.
    await context.photon(platform(...argv))
  }
}

// Each purchase must be refused. The card check comes first: with a card on
// file, a refused purchase could be a real one.
const purchases = async (
  context: ScenarioContext,
  inProject: (...argv: string[]) => string[]
): Promise<void> => {
  const payment = await context.photon([
    'org',
    'billing',
    'payment-method',
    'status'
  ])
  context.check(
    payment,
    'the organization has no card on file, so no purchase can spend money',
    (json) => fieldOf(json, 'cardOnFile') === false
  )
  await waitForBilling(context, inProject)
  await context.photon(
    inProject('project', 'platform', 'voice', 'profile', 'create', '--default')
  )
  const refusals: [string, string[]][] = [
    [
      'SMS number',
      inProject('project', 'platform', 'sms', 'purchase', '--yes')
    ],
    [
      'iMessage line',
      inProject('project', 'platform', 'imessage', 'purchase', '--yes')
    ],
    [
      'email domain',
      inProject(
        'project',
        'platform',
        'email',
        'connect',
        EMAIL_DOMAIN,
        '--no-browser',
        '--no-wait'
      )
    ],
    [
      'outbound calling',
      inProject(
        'project',
        'platform',
        'voice',
        'profile',
        'outbound',
        'enable',
        'default'
      )
    ]
  ]
  for (const [label, argv] of refusals) {
    // biome-ignore lint/performance/noAwaitInLoops: the test runs one command at a time.
    await context.part(label, async () => {
      await context.refused(argv)
    })
  }
  // A refused plan purchase names the billing operation billing rejected.
  await context.part('plan', async () => {
    const refusal = await context.refused(
      inProject(
        'project',
        'billing',
        'plan',
        'purchase',
        '--category',
        BILLING_CATEGORY,
        '--plan-code',
        PAID_PLAN,
        '--yes'
      )
    )
    await context.photon(
      inProject(
        'project',
        'billing',
        'operation',
        'view',
        context.value(refusal, 'remoteOperationId')
      )
    )
  })
}

const project: Scenario = {
  name: 'project',
  passes: ['first', 'second'],
  async run(context) {
    const name = context.name('project')
    const created = await context.photon([
      'project',
      'create',
      '--name',
      name,
      '--slug',
      name
    ])
    const projectId = context.value(created, 'projectId')
    context.defer(['project', 'delete', projectId, '--yes'])
    const inProject = (...argv: string[]) => [...argv, '--project', projectId]
    const firstPass = { passes: ['first'] } as const

    await context.part(
      'reads and local state',
      async () => await projectReads(context, name, projectId, inProject),
      firstPass
    )
    await context.part('edit', async () => {
      const renamed = context.name('project-renamed')
      const edited = await context.photon(
        inProject('project', 'edit', '--name', renamed)
      )
      context.check(
        edited,
        'the project has its new name',
        (json) => fieldOf(json, 'name') === renamed
      )
    })
    await context.part(
      'agent profile',
      async () => await agentProfile(context, inProject)
    )
    await context.part(
      'API keys',
      async () => await apiKeys(context, inProject)
    )
    await context.part(
      'webhooks',
      async () => await webhooks(context, inProject)
    )
    await context.part(
      'Voice profiles',
      async () => await voiceProfiles(context, inProject)
    )
    await context.part(
      'billing',
      async () => await billing(context, inProject),
      firstPass
    )
    await context.part(
      'platforms',
      async () => await platformReads(context, inProject),
      firstPass
    )
    await context.part(
      'purchases',
      async () => await purchases(context, inProject),
      firstPass
    )
  }
}

const leftovers: Scenario = {
  name: 'nothing left behind',
  passes: ['first', 'second'],
  async run(context) {
    const prefix = context.namePrefix
    const projects = await context.photon([
      'project',
      'list',
      '--search',
      prefix
    ])
    context.check(
      projects,
      `no project named ${prefix}-* is left`,
      namesNone('projects', prefix)
    )
    const clients = await context.photon(['org', 'oauth-client', 'list'])
    context.check(
      clients,
      `no OAuth client named ${prefix}-* is left`,
      namesNone('oauthClients', prefix)
    )
    const keys = await context.photon(['account', 'service-key', 'list'])
    context.check(
      keys,
      `no account service key named ${prefix}-* is left`,
      namesNone('serviceKeys', prefix)
    )
  }
}

const signOut: Scenario = {
  name: 'sign out',
  passes: ['first', 'second'],
  async run(context) {
    const operations = await context.photon(['operation', 'list'])
    context.check(
      operations,
      'the operation journal holds no unresolved operation',
      (json) => listAt(json, 'operations').length === 0
    )
    await context.photon(['logout'])
  }
}

export const scenarios: readonly Scenario[] = [
  signIn,
  localState,
  account,
  serviceKeys,
  organization,
  oauthClients,
  project,
  leftovers,
  signOut
]
