import {
  type DeviceAuthorizeOutput,
  type DeviceTokenOutput,
  type GetAccountOutput,
  GetAccountOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { accountEmailSchema } from '../../src/auth/types.ts'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import { CLI_VERSION } from '../../src/meta.ts'
import {
  OPERATION_DEFINITIONS,
  operationStatusSchema,
  requestFingerprint
} from '../../src/operation/types.ts'
import { PACKAGE_MANAGERS } from '../../src/update/package-managers.ts'
import { PHOTON_PACKAGE } from '../../src/update/release.ts'
import { photonKey } from '../key-support.ts'
import { TEST_NOW } from '../project-test-support.ts'
import {
  API,
  buildsDocument,
  type Declared,
  type GoldenCase,
  type JournalRecord,
  PLANTED
} from './support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const ORGANIZATION_ID = 'pho_org_00000000000000000000000001'
const SERVICE_KEY_ID = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const OPERATION_ID = 'op_00000000-0000-4000-8000-000000000001'
const LATEST_VERSION = '99.0.0'
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const TRAILING_SLASHES = /\/+$/u
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u

const account = {
  accountId: 'pho_acc_00000000000000000000000001',
  createdAt: timestamp,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/accounts/ada.png',
  updatedAt: '2026-08-01T18:00:00.000Z'
} satisfies Declared<GetAccountOutput>

const accountRoute = {
  body: account,
  method: 'GET',
  path: '/v1/account'
} as const

const deviceAuthorization = {
  device_code: 'golden-device-code',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.test/device',
  verification_uri_complete:
    'https://auth.example.test/device?user_code=ABCD-EFGH'
} satisfies Declared<DeviceAuthorizeOutput>

const deviceToken = {
  access_token: 'golden-access-token',
  expires_in: 300,
  refresh_token: 'golden-refresh-token',
  user: {
    email: account.email,
    first_name: account.firstName,
    id: 'user_ada',
    last_name: account.lastName
  }
} satisfies Declared<DeviceTokenOutput>

const tokenRequest = {
  device_code: deviceAuthorization.device_code,
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
}

const tokenRoute = {
  body: deviceToken,
  method: 'POST',
  path: '/v1/auth/device/token',
  requestBody: tokenRequest
} as const

// The package document the registry sends, with the newest version under
// the tag this build follows.
const packument = { 'dist-tags': { [PHOTON_PACKAGE.tag]: LATEST_VERSION } }

const registryRoute = {
  body: packument,
  method: 'GET',
  path: `${new URL(PHOTON_PACKAGE.registry).pathname.replace(TRAILING_SLASHES, '')}/${PHOTON_PACKAGE.name.replace('/', '%2f')}`
} as const

const createIntent = {
  activate: false,
  kind: 'project.create',
  name: 'Acme Support',
  organizationId: ORGANIZATION_ID,
  slug: 'acme-support'
} as const

// A project create the API answered with a 503, as the journal keeps it.
const failedCreate: JournalRecord = {
  attemptCount: 1,
  createdAt: timestamp,
  expiresAt: new Date(TEST_NOW + 30 * DAY_MS).toISOString(),
  failure: {
    code: 'PROJECTS_UNAVAILABLE',
    detail: 'The project service is unavailable.',
    httpStatus: 503,
    message: 'Photon could not reach the project service.',
    remediation: ['Retry the operation.'],
    requestId: 'req_golden',
    retryable: true
  },
  idempotencyKey: 'golden-project-create',
  intent: createIntent,
  operationId: OPERATION_ID,
  replayable: true,
  replayPolicy: 'keyed',
  requestFingerprint: requestFingerprint(createIntent),
  status: 'failed',
  updatedAt: timestamp
}

const fullName = (first: string | null, last: string | null): string =>
  [first, last].join(' ')

const TIMESTAMP = z.iso.datetime({ offset: true })
const VERSION = z.string().regex(VERSION_PATTERN)
const ACCOUNT_ID = GetAccountOutputSchema.shape.accountId
const CREDENTIAL_KIND = z.enum(['account_service_key', 'device'])
const STORAGE = z.enum(['file', 'keychain', 'secret-service'])
const SERVICE_KEY = z.string().regex(ID_FORMATS.accountServiceKey.pattern)

// What whoami prints: the account's ID, its name and email.
const WhoamiSchema = z.strictObject({
  accountId: ACCOUNT_ID,
  email: GetAccountOutputSchema.shape.email,
  name: z.string().nullable()
})

// What auth status prints: the sign-in's state and where it comes from, and
// the account it signs in as when the API confirms it.
const AuthStatusSchema = z.strictObject({
  accountId: ACCOUNT_ID.optional(),
  apiOrigin: z.string(),
  credentialKind: z
    .enum([
      'account_service_key',
      'device',
      'project_api_key',
      'service_identity_key'
    ])
    .optional(),
  email: GetAccountOutputSchema.shape.email.optional(),
  expiresAt: TIMESTAMP.optional(),
  keyId: z.string().optional(),
  name: z.string().nullable().optional(),
  reason: z.string().optional(),
  serviceKeyId: SERVICE_KEY.optional(),
  source: z.enum(['environment', 'stored']).optional(),
  state: z.enum([
    'authenticated',
    'not_authenticated',
    'unavailable',
    'unverified'
  ]),
  storage: STORAGE.optional(),
  variable: z.string().optional()
})

// What login prints: the account it signed in as, and where it keeps the
// sign-in. The CLI checks the account's email, and the account ID a service
// key signs in as.
const LoginSchema = z.strictObject({
  accountId: z.string().regex(ID_FORMATS.account.pattern).optional(),
  alreadyAuthenticated: z.boolean(),
  apiOrigin: z.string(),
  credentialKind: CREDENTIAL_KIND.optional(),
  email: accountEmailSchema,
  name: z.string().nullable(),
  serviceKeyId: SERVICE_KEY.optional(),
  storage: STORAGE
})

// What login --service-key prints. The CLI saves the account's email with the
// sign-in, checked as an email.
const ServiceKeyLoginSchema = LoginSchema.extend({ email: z.email() })

// What logout prints: whether it removed a sign-in. It never revokes the
// session on the server.
const LogoutSchema = z.strictObject({
  orphanedCredential: z.boolean(),
  remoteSessionRevoked: z.literal(false),
  removed: z.boolean()
})

// What update prints: the installed and newest versions, which the CLI checks
// as versions, and what it did.
const UpdateSchema = z.strictObject({
  currentVersion: VERSION,
  installer: z.enum([...PACKAGE_MANAGERS, 'standalone']).nullable(),
  latestVersion: VERSION,
  status: z.enum(['up-to-date', 'update-available', 'updated'])
})

const OperationSummarySchema = z.strictObject({
  kind: z.string().refine((kind) => Object.hasOwn(OPERATION_DEFINITIONS, kind)),
  operationId: z.string().regex(ID_FORMATS.localOperation.pattern),
  replayable: z.boolean(),
  status: operationStatusSchema,
  updatedAt: TIMESTAMP
})

// What operation list prints: a page of unresolved local operations.
const OperationListSchema = z.strictObject({
  nextPageToken: z.string().optional(),
  operations: z.array(OperationSummarySchema)
})

// What operation view prints: one local operation, with the input the command
// sent and the failure it recorded.
const OperationViewSchema = z.strictObject({
  operation: OperationSummarySchema.extend({
    attemptCount: z.number().int().positive(),
    command: z.string(),
    createdAt: TIMESTAMP,
    expiresAt: TIMESTAMP,
    failure: z
      .strictObject({
        code: z.string(),
        detail: z.string().optional(),
        httpStatus: z.number().int().optional(),
        message: z.string(),
        problemType: z.string().optional(),
        reason: z.string().optional(),
        remediation: z.array(z.string()).max(10),
        remoteOperationId: z.string().optional(),
        requestId: z.string().optional(),
        retryAfterSeconds: z.number().optional(),
        retryable: z.boolean(),
        transportCode: z.string().optional()
      })
      .optional(),
    idempotencyKey: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    remoteOperationId: z.string().optional(),
    replayExpiresAt: TIMESTAMP.optional()
  })
})

// What operation remove prints: the operation and whether it was removed.
const OperationRemovalSchema = z.strictObject({
  operationId: z.string().regex(ID_FORMATS.localOperation.pattern),
  removed: z.boolean()
})

// The commands that read the local journal show only its records' strings,
// and the journal rejects a record with control characters in any of them.
export const SESSION_GOLDENS: readonly GoldenCase[] = [
  buildsDocument({
    args: [],
    build: (response: typeof account) => ({
      accountId: response.accountId,
      apiOrigin: API,
      credentialKind: 'device',
      email: response.email,
      expiresAt: new Date(TEST_NOW + HOUR_MS).toISOString(),
      name: fullName(response.firstName, response.lastName),
      source: 'stored',
      state: 'authenticated',
      storage: 'file'
    }),
    command: 'auth status',
    from: [accountRoute],
    routes: [accountRoute],
    schema: AuthStatusSchema,
    shows: `Email: ${account.email}`
  }),
  buildsDocument({
    args: ['--force', '--insecure-storage', '--no-browser'],
    build: (response: typeof deviceToken) => ({
      alreadyAuthenticated: false,
      apiOrigin: API,
      email: response.user.email,
      name: fullName(response.user.first_name, response.user.last_name),
      storage: 'file'
    }),
    command: 'login',
    from: [tokenRoute],
    routes: [
      {
        body: deviceAuthorization,
        method: 'POST',
        path: '/v1/auth/device/code',
        planted: {
          ...deviceAuthorization,
          user_code: `ABCD${PLANTED}EFGH`,
          verification_uri: `https://auth.example.test/de${PLANTED}vice`,
          verification_uri_complete: `https://auth.example.test/de${PLANTED}vice?user_code=ABCD-EFGH`
        }
      },
      {
        body: { error: 'authorization_pending' },
        method: 'POST',
        path: '/v1/auth/device/token',
        requestBody: tokenRequest,
        status: 400,
        unshown: true
      },
      tokenRoute
    ],
    schema: LoginSchema,
    shows: `Logged in as ${account.email}.`,
    showsNoApiText: true
  }),
  buildsDocument({
    args: ['--service-key', '--force', '--insecure-storage'],
    build: (response: typeof account) => ({
      accountId: response.accountId,
      alreadyAuthenticated: false,
      apiOrigin: API,
      credentialKind: 'account_service_key',
      email: response.email,
      name: fullName(response.firstName, response.lastName),
      serviceKeyId: SERVICE_KEY_ID,
      storage: 'file'
    }),
    command: 'login',
    from: [accountRoute],
    routes: [accountRoute],
    schema: ServiceKeyLoginSchema,
    shows: `Logged in with account service key ${SERVICE_KEY_ID}.`,
    showsNoApiText: true,
    stdin: `${SERVICE_KEY_ID}_golden-secret\n`
  }),
  {
    args: [],
    command: 'logout',
    document: {
      orphanedCredential: false,
      remoteSessionRevoked: false,
      removed: true
    },
    routes: [],
    schema: LogoutSchema,
    shows: 'Logged out of Photon.',
    showsNoApiText: true
  },
  buildsDocument({
    args: ['--check'],
    build: (response: typeof packument) => ({
      currentVersion: CLI_VERSION,
      installer: null,
      latestVersion: response['dist-tags'][PHOTON_PACKAGE.tag],
      status: 'update-available'
    }),
    command: 'update',
    from: [registryRoute],
    routes: [registryRoute],
    schema: UpdateSchema,
    shows: `${LATEST_VERSION} is available`,
    showsNoApiText: true
  }),
  buildsDocument({
    args: [],
    build: (response: typeof account) => ({
      accountId: response.accountId,
      email: response.email,
      name: fullName(response.firstName, response.lastName)
    }),
    command: 'whoami',
    from: [accountRoute],
    routes: [accountRoute],
    schema: WhoamiSchema,
    shows: `Name: ${fullName(account.firstName, account.lastName)}`
  }),
  {
    args: [],
    command: 'operation list',
    document: {
      operations: [
        {
          kind: 'project.create',
          operationId: OPERATION_ID,
          replayable: true,
          status: 'failed',
          updatedAt: timestamp
        }
      ]
    },
    journal: [failedCreate],
    routes: [],
    schema: OperationListSchema,
    shows: OPERATION_ID,
    showsNoApiText: true
  },
  {
    args: [OPERATION_ID],
    command: 'operation view',
    document: {
      operation: {
        attemptCount: 1,
        command: 'project create',
        createdAt: timestamp,
        expiresAt: failedCreate.expiresAt,
        failure: failedCreate.failure,
        idempotencyKey: 'golden-project-create',
        input: {
          activate: false,
          name: createIntent.name,
          organizationId: ORGANIZATION_ID,
          slug: createIntent.slug
        },
        kind: 'project.create',
        operationId: OPERATION_ID,
        replayable: true,
        status: 'failed',
        updatedAt: timestamp
      }
    },
    journal: [failedCreate],
    routes: [],
    schema: OperationViewSchema,
    shows: 'PROJECTS_UNAVAILABLE',
    showsNoApiText: true
  },
  {
    args: [OPERATION_ID, '--yes'],
    command: 'operation remove',
    document: { operationId: OPERATION_ID, removed: true },
    journal: [failedCreate],
    routes: [],
    schema: OperationRemovalSchema,
    shows: `Removed local operation ${OPERATION_ID}.`,
    showsNoApiText: true
  }
]
