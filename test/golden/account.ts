import {
  type CommitAccountProfilePictureOutput,
  CommitAccountProfilePictureOutputSchema,
  type CreateAccountProfilePictureUploadOutput,
  type CreateAccountServiceKeyOutput,
  CreateAccountServiceKeyOutputSchema,
  type GetAccountOutput,
  GetAccountOutputSchema,
  type ListAccountServiceKeysOutput,
  ListAccountServiceKeysOutputSchema,
  type ListAuthorizedApplicationsOutput,
  ListAuthorizedApplicationsOutputSchema,
  type ResetAccountProfilePictureOutput,
  ResetAccountProfilePictureOutputSchema,
  type RevokeAccountServiceKeyOutput,
  RevokeAccountServiceKeyOutputSchema,
  type UpdateAccountOutput,
  UpdateAccountOutputSchema
} from '@photon-ai/api-public'
import { z } from 'zod'
import { ID_FORMATS } from '../../src/core/photon-id.ts'
import { photonKey } from '../key-support.ts'
import {
  CWD,
  type Declared,
  type GoldenCase,
  NEW_API_FIELD,
  printsResponse,
  STORAGE_ORIGIN,
  withNewField
} from './support.ts'

const timestamp = '2026-07-31T18:00:00.000Z'
const updatedAt = '2026-08-01T18:00:00.000Z'
const ACCOUNT_ID = 'pho_acc_00000000000000000000000001'
const PROFILE_PICTURE = '/v1/account/profile-picture'
const SERVICE_KEYS = '/v1/account/service-keys'
const SERVICE_KEY_ID = photonKey('ask', '01h455vb4pex5vsknk084sn02s')
const SECRET = `${SERVICE_KEY_ID}_golden-secret`
const UPLOAD_ID = 'pho_upl_01h455vb4pex5vsknk084sn02q'

const connection = {
  application: {
    applicationType: 'web',
    clientId: 'client_01k9yq3m7d2c8x4v6b5n0p1r2s',
    createdAt: timestamp,
    description: 'Connects Acme to Photon',
    id: 'connect_app_01k9yq3m7d2c8x4v6b5n0p1r2s',
    isFirstParty: false,
    name: 'Acme Integration',
    redirectUris: [
      { default: true, uri: 'https://acme.example.test/callback' }
    ],
    scopes: ['account:read', 'project:read'],
    updatedAt: timestamp,
    usesPkce: true
  },
  authorizationId: 'authorization_01k9yq3m7d2c8x4v6b5n0p1r2s',
  grantedScopes: ['account:read'],
  oauthResource: 'https://api.photon.codes'
} satisfies Declared<
  ListAuthorizedApplicationsOutput['authorizedApplications'][number]
>

const connections = {
  authorizedApplications: [
    { ...connection, ...NEW_API_FIELD },
    {
      ...connection,
      application: {
        ...connection.application,
        clientId: 'client_01k9yq3m7d2c8x4v6b5n0p1r2t',
        description: null,
        id: 'connect_app_01k9yq3m7d2c8x4v6b5n0p1r2t',
        name: 'Globex Sync'
      },
      authorizationId: 'authorization_01k9yq3m7d2c8x4v6b5n0p1r2t',
      oauthResource: null
    }
  ],
  listMetadata: { after: 'connect_cursor_2', before: null },
  ...NEW_API_FIELD
} satisfies Declared<ListAuthorizedApplicationsOutput>

const account = {
  accountId: ACCOUNT_ID,
  createdAt: timestamp,
  deletedAt: null,
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phoneNumber: null,
  phoneVerifiedAt: null,
  pictureUrl: 'https://images.example.test/accounts/ada.png',
  updatedAt
} satisfies Declared<GetAccountOutput>

const editedAccount = withNewField({
  ...account,
  firstName: 'Grace',
  lastName: 'Hopper'
}) satisfies Declared<UpdateAccountOutput>

const resetAccount = withNewField({
  ...account,
  pictureUrl: 'https://images.example.test/accounts/default.png'
}) satisfies Declared<ResetAccountProfilePictureOutput>

const uploadedAccount = withNewField({
  ...account,
  pictureUrl: 'https://images.example.test/accounts/ada-2.png'
}) satisfies Declared<CommitAccountProfilePictureOutput>

const avatarUpload = withNewField({
  expiresAt: updatedAt,
  formFields: { key: `avatars/${UPLOAD_ID}`, policy: 'golden-policy' },
  uploadId: UPLOAD_ID,
  uploadUrl: `${STORAGE_ORIGIN}/avatar-uploads`
}) satisfies Declared<CreateAccountProfilePictureUploadOutput>

const serviceKey = {
  accountId: ACCOUNT_ID,
  createdAt: timestamp,
  expiresAt: null,
  name: 'Deploy key',
  revokedAt: null,
  serviceKeyId: SERVICE_KEY_ID
} satisfies Declared<RevokeAccountServiceKeyOutput['serviceKey']>

const createdServiceKey = {
  secret: SECRET,
  serviceKey: withNewField(serviceKey)
} satisfies Declared<CreateAccountServiceKeyOutput>

const serviceKeys = {
  serviceKeys: [
    withNewField(serviceKey),
    {
      ...serviceKey,
      expiresAt: '2027-08-01T18:00:00.000Z',
      name: 'CI key',
      serviceKeyId: photonKey('ask', '01h455vb4pex5vsknk084sn02t')
    }
  ]
} satisfies Declared<ListAccountServiceKeysOutput>

const revokedServiceKey = {
  serviceKey: withNewField({ ...serviceKey, revokedAt: updatedAt })
} satisfies Declared<RevokeAccountServiceKeyOutput>

// The API's service key. Before it prints one, the CLI checks its IDs and
// timestamps, as this schema does.
const TIMESTAMP = z.iso.datetime({ offset: true })
const CheckedServiceKeySchema =
  RevokeAccountServiceKeyOutputSchema.shape.serviceKey.extend({
    accountId: z.string().regex(ID_FORMATS.account.pattern),
    createdAt: TIMESTAMP,
    expiresAt: TIMESTAMP.nullable(),
    revokedAt: TIMESTAMP.nullable(),
    serviceKeyId: z.string().regex(ID_FORMATS.accountServiceKey.pattern)
  })

const ServiceKeyCreationSchema = CreateAccountServiceKeyOutputSchema.extend({
  serviceKey: CheckedServiceKeySchema
})

const ServiceKeyListSchema = ListAccountServiceKeysOutputSchema.extend({
  serviceKeys: CheckedServiceKeySchema.array()
})

const ServiceKeyRevocationSchema = RevokeAccountServiceKeyOutputSchema.extend({
  serviceKey: CheckedServiceKeySchema
})

// The first bytes of a PNG file, which are what the CLI checks before it
// uploads one.
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
])

/** Golden tests for the account commands that print the API's response. */
export const ACCOUNT_GOLDENS: readonly GoldenCase[] = [
  printsResponse({
    args: [],
    command: 'account view',
    route: { body: withNewField(account), method: 'GET', path: '/v1/account' },
    schema: GetAccountOutputSchema,
    shows: account.email
  }),
  printsResponse({
    args: [
      '--first-name',
      editedAccount.firstName,
      '--last-name',
      editedAccount.lastName,
      '--idempotency-key',
      'golden-account-edit'
    ],
    command: 'account edit',
    route: {
      body: editedAccount,
      method: 'PATCH',
      path: '/v1/account',
      requestBody: {
        firstName: editedAccount.firstName,
        lastName: editedAccount.lastName
      }
    },
    schema: UpdateAccountOutputSchema,
    shows: editedAccount.lastName
  }),
  printsResponse({
    args: ['--yes', '--idempotency-key', 'golden-account-avatar-reset'],
    command: 'account avatar reset',
    route: { body: resetAccount, method: 'DELETE', path: PROFILE_PICTURE },
    schema: ResetAccountProfilePictureOutputSchema,
    shows: 'Reset the account avatar.',
    showsNoApiText: true
  }),
  {
    args: [
      `${CWD}/avatar.png`,
      '--idempotency-key',
      'golden-account-avatar-upload'
    ],
    command: 'account avatar upload',
    document: uploadedAccount,
    files: { 'avatar.png': PNG },
    routes: [
      {
        body: avatarUpload,
        method: 'POST',
        path: `${PROFILE_PICTURE}/uploads`,
        requestBody: { contentType: 'image/png' },
        status: 201
      },
      {
        method: 'POST',
        path: '/avatar-uploads',
        requestBody: { ...avatarUpload.formFields, file: 'avatar.png' },
        status: 204
      },
      {
        body: uploadedAccount,
        method: 'PUT',
        path: PROFILE_PICTURE,
        requestBody: { uploadId: UPLOAD_ID }
      }
    ],
    schema: CommitAccountProfilePictureOutputSchema,
    shows: uploadedAccount.pictureUrl
  },
  printsResponse({
    args: [],
    command: 'account oauth connection list',
    route: {
      body: connections,
      method: 'GET',
      path: '/v1/account/oauth/authorized-applications?limit=30'
    },
    schema: ListAuthorizedApplicationsOutputSchema,
    shows: 'Globex Sync'
  }),
  printsResponse({
    args: [
      '--name',
      serviceKey.name,
      '--no-expiry',
      '--idempotency-key',
      'golden-service-key-create'
    ],
    checkedSecret: 'secret',
    command: 'account service-key create',
    route: {
      body: withNewField(createdServiceKey),
      method: 'POST',
      path: SERVICE_KEYS,
      requestBody: { name: serviceKey.name },
      status: 201
    },
    schema: ServiceKeyCreationSchema,
    shows: SECRET
  }),
  printsResponse({
    args: [],
    command: 'account service-key list',
    route: {
      body: withNewField(serviceKeys),
      method: 'GET',
      path: SERVICE_KEYS
    },
    schema: ServiceKeyListSchema,
    shows: 'CI key'
  }),
  printsResponse({
    args: [
      SERVICE_KEY_ID,
      '--yes',
      '--idempotency-key',
      'golden-service-key-revoke'
    ],
    command: 'account service-key revoke',
    route: {
      body: withNewField(revokedServiceKey),
      method: 'DELETE',
      path: `${SERVICE_KEYS}/${SERVICE_KEY_ID}`
    },
    schema: ServiceKeyRevocationSchema,
    shows: `Revoked account service key ${SERVICE_KEY_ID}.`
  })
]
