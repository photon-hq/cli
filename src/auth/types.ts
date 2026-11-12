import type { PhotonNamespaces } from '@photon-ai/api'
import { z } from 'zod'
import type { NextStep } from '../core/errors.ts'
import {
  isAccountServiceKeyId,
  parseAccountServiceKey
} from './account-service-key.ts'
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION,
  ACCOUNT_SERVICE_KEY_CREDENTIAL_SCHEMA_VERSION,
  AUTH_SCHEMA_VERSION,
  CREDENTIAL_SCHEMA_VERSION
} from './constants.ts'
import type { EnvironmentKeyKind } from './environment-key.ts'

export type DeviceAuthScope = PhotonNamespaces['auth']['device']
export type CredentialKind = 'account_service_key' | 'device'

const credentialBackendKindSchema = z.enum([
  'keychain',
  'secret-service',
  'file'
])
export type CredentialBackendKind = z.infer<typeof credentialBackendKindSchema>

export const accountEmailSchema = z.email({ pattern: z.regexes.html5Email })

const cachedUserSchema = z.strictObject({
  email: accountEmailSchema,
  id: z.string().min(1),
  name: z.string().min(1).nullable()
})
export type CachedUser = z.infer<typeof cachedUserSchema>

export const deviceAuthMetadataSchema = z
  .strictObject({
    apiOrigin: z.url(),
    backend: credentialBackendKindSchema,
    cachedUser: cachedUserSchema,
    createdAt: z.iso.datetime(),
    credentialLocator: z.string().min(1).optional(),
    lastVerifiedAccountId: z.string().min(1).optional(),
    lastVerifiedAt: z.iso.datetime().optional(),
    schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
    updatedAt: z.iso.datetime()
  })
  .superRefine((metadata, context) => {
    if (
      metadata.backend !== 'file' &&
      metadata.credentialLocator === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Secure credential metadata requires a locator.',
        path: ['credentialLocator']
      })
    }
  })
export type DeviceAuthMetadata = z.infer<typeof deviceAuthMetadataSchema>

export const accountServiceKeyAuthMetadataSchema = z.strictObject({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  apiOrigin: z.url(),
  backend: credentialBackendKindSchema,
  createdAt: z.iso.datetime(),
  credentialKind: z.literal('account_service_key'),
  credentialLocator: z.string().min(1).max(512),
  email: accountEmailSchema,
  lastVerifiedAt: z.iso.datetime(),
  name: z.string().min(1).nullable(),
  schemaVersion: z.literal(ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION),
  serviceKeyId: z.string().refine(isAccountServiceKeyId),
  updatedAt: z.iso.datetime()
})
export type AccountServiceKeyAuthMetadata = z.infer<
  typeof accountServiceKeyAuthMetadataSchema
>

export const authMetadataSchema = z.union([
  deviceAuthMetadataSchema,
  accountServiceKeyAuthMetadataSchema
])
export type AuthMetadata = z.infer<typeof authMetadataSchema>

export const credentialSecretSchema = z.strictObject({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(1),
  version: z.literal(CREDENTIAL_SCHEMA_VERSION)
})
export type CredentialSecret = z.infer<typeof credentialSecretSchema>

export const accountServiceKeyCredentialSecretSchema = z.strictObject({
  credential: z.string().refine((value) => parseAccountServiceKey(value)),
  kind: z.literal('account_service_key'),
  version: z.literal(ACCOUNT_SERVICE_KEY_CREDENTIAL_SCHEMA_VERSION)
})
export type AccountServiceKeyCredentialSecret = z.infer<
  typeof accountServiceKeyCredentialSecretSchema
>

export const storedCredentialSecretSchema = z.union([
  credentialSecretSchema,
  accountServiceKeyCredentialSecretSchema
])
export type StoredCredentialSecret = z.infer<
  typeof storedCredentialSecretSchema
>

export interface DeviceStoredSession {
  credentials: CredentialSecret
  kind: 'device'
  metadata: DeviceAuthMetadata
}

export interface AccountServiceKeyStoredSession {
  credentials: AccountServiceKeyCredentialSecret
  kind: 'account_service_key'
  metadata: AccountServiceKeyAuthMetadata
}

export type StoredSession = AccountServiceKeyStoredSession | DeviceStoredSession

export interface AuthIdentityDescriptor {
  accountId?: string
  kind: CredentialKind
  publicId: string
}

export const isAccountServiceKeyMetadata = (
  metadata: AuthMetadata
): metadata is AccountServiceKeyAuthMetadata =>
  metadata.schemaVersion === ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION

export const authIdentityDescriptor = (
  metadata: AuthMetadata
): AuthIdentityDescriptor =>
  isAccountServiceKeyMetadata(metadata)
    ? {
        accountId: metadata.accountId,
        kind: 'account_service_key',
        publicId: metadata.serviceKeyId
      }
    : {
        ...(metadata.lastVerifiedAccountId === undefined
          ? {}
          : { accountId: metadata.lastVerifiedAccountId }),
        kind: 'device',
        publicId: metadata.cachedUser.id
      }

export interface LoginOptions {
  force: boolean
  insecureStorage: boolean
  noBrowser: boolean
  serviceKey: boolean
}

export interface LoginResult {
  accountId?: string
  alreadyAuthenticated: boolean
  apiOrigin: string
  credentialKind?: CredentialKind
  email: string
  name: string | null
  serviceKeyId?: string
  storage: CredentialBackendKind
}

export interface LogoutResult {
  credentialKind?: CredentialKind
  /** The variable whose key this CLI still uses after the logout. */
  environmentVariable?: string
  orphanedCredential: boolean
  removed: boolean
}

export interface AuthStatusResult {
  accountId?: string
  apiOrigin: string
  credentialKind?: CredentialKind | EnvironmentKeyKind
  email?: string
  expiresAt?: string
  /** The public ID of a key from the environment. */
  keyId?: string
  name?: string | null
  next?: readonly NextStep[]
  reason?: string
  serviceKeyId?: string
  /** Where the credential came from: the environment or the stored sign-in. */
  source?: 'environment' | 'stored'
  /**
   * `unverified` is a key the API has no request to check without a
   * project, such as a project API key.
   */
  state: 'authenticated' | 'not_authenticated' | 'unavailable' | 'unverified'
  storage?: CredentialBackendKind
  variable?: string
}
