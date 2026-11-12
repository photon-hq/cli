import { BUILD_CONFIG } from '../build-config.ts'
import { ID_FORMATS } from '../core/photon-id.ts'

export const API_ORIGIN = BUILD_CONFIG.apiOrigin
export const APP_ORIGIN = BUILD_CONFIG.appOrigin
export const AUTH_SCHEMA_VERSION = 1
export const CREDENTIAL_SCHEMA_VERSION = 1
export const ACCOUNT_SERVICE_KEY_AUTH_SCHEMA_VERSION = 2
export const ACCOUNT_SERVICE_KEY_CREDENTIAL_SCHEMA_VERSION = 2
export const ACCOUNT_ID_PATTERN = ID_FORMATS.account.pattern
export const KEYCHAIN_SERVICE = BUILD_CONFIG.keychainService
export const API_TOKEN_VARIABLE = BUILD_CONFIG.apiTokenVariable
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
export const REFRESH_GRANT_TYPE = 'refresh_token'

export const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000
export const LOCK_ACQUISITION_TIMEOUT_MS = 10_000
export const LOCK_HEARTBEAT_MS = 10_000
export const LOCK_STALE_MS = 120_000
export const MAX_DEVICE_AUTHORIZATION_LIFETIME_SECONDS = 3600
export const MAX_DEVICE_POLL_INTERVAL_SECONDS = 300
export const MAX_POLL_BACKOFF_MS = 30_000
export const MIN_POLL_INTERVAL_MS = 1000
export const OAUTH_SLOW_DOWN_MS = 5000
