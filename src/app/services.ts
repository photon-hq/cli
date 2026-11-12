import { randomBytes } from 'node:crypto'
import { Photon, type PhotonOptions } from '@photon-ai/api'
import {
  createInternalServices,
  type InternalCommandServices,
  type InternalServiceOptions
} from '#internal'
import { type AccountScope, AccountService } from '../account/service.ts'
import { AccountServiceKeyInput } from '../auth/account-service-key.ts'
import { AuthenticatedRequest } from '../auth/authenticated-request.ts'
import { API_ORIGIN } from '../auth/constants.ts'
import {
  type BearerCredentialProvider,
  EnvironmentBearerCredentialProvider,
  StoredBearerCredentialProvider
} from '../auth/credential-provider.ts'
import { type PollClock, systemPollClock } from '../auth/device-flow.ts'
import { type EnvironmentKey, environmentKey } from '../auth/environment-key.ts'
import {
  type AccountServiceKeyVerifier,
  AuthLifecycleService
} from '../auth/lifecycle-service.ts'
import { type MfaQrRenderer, renderTerminalQr } from '../auth/mfa-qr.ts'
import {
  AuthRepository,
  type AuthRepositoryOptions
} from '../auth/storage/repository.ts'
import { TokenManager } from '../auth/token-manager.ts'
import type { DeviceAuthScope } from '../auth/types.ts'
import {
  type BrowserLauncher,
  browserCountdown,
  launchBrowser
} from '../core/browser.ts'
import { CliError } from '../core/errors.ts'
import {
  HttpDebugRecorder,
  type HttpTraceSource,
  registerSecret
} from '../core/http-debug.ts'
import {
  CliInput,
  type ConfirmationHandler,
  type ReadableInput,
  type SelectionHandler
} from '../core/input.ts'
import { withNetworkErrors } from '../core/network.ts'
import { CliOutput, type WritableOutput } from '../core/output.ts'
import { withEnvironmentProxy } from '../core/proxy.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../core/request.ts'
import { photonUserAgent, withUserAgent } from '../core/user-agent.ts'
import {
  type OauthCatalogScope,
  type OauthRawScope,
  type OauthScope,
  OauthService
} from '../oauth/service.ts'
import { MemoryOperationRepository } from '../operation/memory-repository.ts'
import {
  type OperationJournal,
  OperationRepository
} from '../operation/repository.ts'
import { OperationService } from '../operation/service.ts'
import { OrganizationContextRepository } from '../organization/context-repository.ts'
import { OrganizationContextService } from '../organization/context-service.ts'
import {
  type OrganizationScope,
  OrganizationService
} from '../organization/service.ts'
import { ProjectContextService } from '../project/context-service.ts'
import { ProjectFolderRepository } from '../project/folder-repository.ts'
import { installPhotonSdkHeaderCompatibility } from '../project/sdk-compatibility.ts'
import {
  type ProjectRawScope,
  type ProjectScope,
  ProjectService
} from '../project/service.ts'
import { type VoiceScope, VoiceService } from '../project/voice-service.ts'
import { type UpdateDependencies, UpdateService } from '../update/service.ts'
import { TargetNotice } from './target-notice.ts'

type PhotonTransportOptions = Pick<
  PhotonOptions,
  'baseUrl' | 'fetch' | 'timeoutMs'
>

export interface PhotonServiceOptions
  extends AuthRepositoryOptions,
    InternalServiceOptions,
    PhotonTransportOptions {
  accountScope?: AccountScope
  accountServiceKeyVerifier?: AccountServiceKeyVerifier
  browserLauncher?: BrowserLauncher
  clock?: PollClock
  color: boolean
  /** `--color` was given, which beats `NO_COLOR` and its kin. */
  colorExplicit?: boolean
  confirm?: ConfirmationHandler
  // The folder whose .photon/project.json (or its nearest parent's) selects
  // the project. Defaults to the process's working directory.
  cwd?: string
  debug?: boolean
  deviceScope?: DeviceAuthScope
  env?: NodeJS.ProcessEnv
  json: boolean
  mfaQr?: MfaQrRenderer
  noInput?: boolean
  now?: () => number
  oauthCatalogScope?: OauthCatalogScope
  oauthRawScope?: OauthRawScope
  oauthScope?: OauthScope
  organizationId?: string
  organizationScope?: OrganizationScope
  projectId?: string
  projectRawScope?: ProjectRawScope
  projectScope?: ProjectScope
  random?: () => number
  /** Cryptographically random bytes, for values such as OAuth state. */
  randomBytes?: (size: number) => Buffer
  select?: SelectionHandler
  setExitCode?: (exitCode: number) => void
  signal?: AbortSignal
  stderr?: WritableOutput
  stdin?: ReadableInput
  stdout?: WritableOutput
  updateDependencies?: UpdateDependencies
  voiceScope?: VoiceScope
}

export interface PhotonCommandServices {
  account: AccountService
  auth: AuthLifecycleService
  browser: {
    countdown: (tick: (secondsRemaining: number) => void) => Promise<void>
    open: BrowserLauncher
  }
  input: CliInput
  // Internal-only commands' services: empty in production builds.
  internal: InternalCommandServices
  mfaQr: MfaQrRenderer
  now: () => number
  oauth: OauthService
  operations: OperationService
  organizationContext: OrganizationContextService
  organizations: OrganizationService
  output: CliOutput
  projectContext: ProjectContextService
  projects: ProjectService
  randomBytes: (size: number) => Buffer
  setExitCode: (exitCode: number) => void
  update: UpdateService
  voice: VoiceService
}

// What src/internal/services.ts builds the internal-only services from.
export interface InternalServiceContext {
  account: AccountService
  auth: AuthLifecycleService
  input: CliInput
  options: PhotonServiceOptions
  organizationScope: OrganizationScope
  photon: Photon
  projectScope: ProjectScope
  repository: AuthRepository
  request: AuthenticatedRequest
}

export interface PhotonExtensions {
  photon: PhotonCommandServices
  [key: string]: unknown
}

const createOutput = (
  options: PhotonServiceOptions,
  httpTrace: HttpTraceSource | undefined
): CliOutput =>
  new CliOutput({
    color: options.color,
    ...(options.colorExplicit === undefined
      ? {}
      : { colorExplicit: options.colorExplicit }),
    debug: options.debug ?? false,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(httpTrace === undefined ? {} : { httpTrace }),
    json: options.json,
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout })
  })

const createRepository = (
  options: PhotonServiceOptions,
  apiOrigin: string
): AuthRepository =>
  new AuthRepository({
    apiOrigin,
    ...(options.configDirectory === undefined
      ? {}
      : { configDirectory: options.configDirectory }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.secureBackend === undefined
      ? {}
      : { secureBackend: options.secureBackend })
  })

const createTransportOptions = (
  options: PhotonServiceOptions,
  fetch: typeof globalThis.fetch
): PhotonTransportOptions => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return {
    baseUrl: options.baseUrl ?? API_ORIGIN,
    fetch: withNetworkErrors(fetch, { timeoutMs }),
    timeoutMs
  }
}

interface Transport {
  fetch: typeof globalThis.fetch
  httpTrace: HttpTraceSource | undefined
}

const effectivePollClock = (clock: PollClock | undefined): PollClock =>
  clock ?? systemPollClock

const createTransport = (
  options: PhotonServiceOptions,
  apiOrigin: string
): Transport => {
  const env = options.env ?? process.env
  const userAgent = photonUserAgent(env)
  const fetch: typeof globalThis.fetch =
    options.fetch ??
    withEnvironmentProxy(
      async (input, init) => await globalThis.fetch(input, init),
      env
    )
  if (options.debug !== true) {
    return { fetch: withUserAgent(fetch, userAgent), httpTrace: undefined }
  }
  const httpTrace = new HttpDebugRecorder({
    trustedOrigin: apiOrigin,
    ...(options.now === undefined ? {} : { now: options.now })
  })
  return {
    fetch: withUserAgent(httpTrace.wrap(fetch), userAgent),
    httpTrace
  }
}

const createInput = (
  options: PhotonServiceOptions,
  targetNotice: TargetNotice
): CliInput =>
  new CliInput({
    beforeQuestion: () => targetNotice.beforeQuestion(),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.env === undefined ? {} : { env: options.env }),
    json: options.json,
    noInput: options.noInput ?? false,
    ...(options.select === undefined ? {} : { select: options.select }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout })
  })

const effectiveMfaQr = (renderer: MfaQrRenderer | undefined): MfaQrRenderer =>
  renderer ?? renderTerminalQr

const createAccountServiceKeyInput = (
  options: PhotonServiceOptions
): AccountServiceKeyInput =>
  new AccountServiceKeyInput({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin })
  })

const createAccountServiceKeyVerifier = (
  options: PhotonServiceOptions,
  transportOptions: PhotonTransportOptions
): AccountServiceKeyVerifier => {
  if (options.accountServiceKeyVerifier !== undefined) {
    return options.accountServiceKeyVerifier
  }
  return async (credential) =>
    await new Photon({
      ...transportOptions,
      headers: { authorization: `Bearer ${credential}` },
      retry: false
    }).account.get(
      {},
      options.signal === undefined ? undefined : { signal: options.signal }
    )
}

interface AccountServiceDependencies {
  account: AccountScope
  apiOrigin: string
  environmentKey: EnvironmentKey | undefined
  fetch: typeof globalThis.fetch | undefined
  repository: AuthRepository
  request: AuthenticatedRequest
  warning: (message: string) => void
}

const createAccountService = (
  options: PhotonServiceOptions,
  dependencies: AccountServiceDependencies
): AccountService =>
  new AccountService({
    account: dependencies.account,
    apiOrigin: dependencies.apiOrigin,
    ...(dependencies.environmentKey === undefined
      ? {}
      : { environmentKey: dependencies.environmentKey }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    repository: dependencies.repository,
    request: dependencies.request,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    warning: dependencies.warning
  })

const createAuthenticatedPhoton = (
  transportOptions: PhotonTransportOptions,
  credentialProvider: BearerCredentialProvider
): Photon =>
  new Photon({
    ...transportOptions,
    headers: async () => ({
      authorization: `Bearer ${await credentialProvider.getBearer()}`
    })
  })

const createAuthenticatedRequest = (
  credentialProvider: BearerCredentialProvider,
  signal: AbortSignal | undefined
): AuthenticatedRequest =>
  new AuthenticatedRequest({
    credentialProvider,
    ...(signal === undefined ? {} : { signal })
  })

const createOauthService = (
  options: PhotonServiceOptions,
  request: AuthenticatedRequest,
  defaultCatalog: OauthCatalogScope,
  defaultRawScope: OauthRawScope,
  defaultScope: OauthScope,
  apiOrigin: string,
  fetch: typeof globalThis.fetch | undefined
): OauthService =>
  new OauthService({
    apiOrigin,
    catalog: options.oauthCatalogScope ?? defaultCatalog,
    ...(fetch === undefined ? {} : { fetch }),
    rawScope: options.oauthRawScope ?? defaultRawScope,
    request,
    scope: options.oauthScope ?? defaultScope,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })

const projectApiOrigin = (baseUrl: string | undefined): string => {
  try {
    return new URL(baseUrl ?? API_ORIGIN).origin
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
    throw new CliError(
      'ARGUMENT_VALIDATION',
      'Photon API base URL must be a valid URL.',
      { cause: error, exitCode: 2 }
    )
  }
}

const createProjectContext = (
  options: PhotonServiceOptions,
  repository: AuthRepository,
  folder: ProjectFolderRepository,
  apiKey: EnvironmentKey | undefined
): ProjectContextService =>
  new ProjectContextService({
    authRepository: repository,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(apiKey === undefined ? {} : { environmentKey: apiKey }),
    ...(options.projectId === undefined
      ? {}
      : { explicitProjectId: options.projectId }),
    folder
  })

const createOrganizationService = (
  options: PhotonServiceOptions,
  request: AuthenticatedRequest,
  scope: OrganizationScope
): OrganizationService =>
  new OrganizationService({
    request,
    scope,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })

const createOrganizationContext = (
  options: PhotonServiceOptions,
  repository: AuthRepository,
  apiOrigin: string,
  organizations: OrganizationService,
  folder: ProjectFolderRepository,
  apiKey: EnvironmentKey | undefined
): OrganizationContextService =>
  new OrganizationContextService({
    authRepository: repository,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(apiKey === undefined ? {} : { environmentKey: apiKey }),
    ...(options.organizationId === undefined
      ? {}
      : { explicitOrganizationId: options.organizationId }),
    folder,
    listOrganizationIds: async () =>
      (await organizations.list()).organizations.map(
        ({ organizationId }) => organizationId
      ),
    ...(options.now === undefined ? {} : { now: options.now }),
    repository: new OrganizationContextRepository({
      apiOrigin,
      configDirectory: repository.paths.configDirectory
    })
  })

const createProjectService = (
  options: PhotonServiceOptions,
  request: AuthenticatedRequest,
  defaultRawScope: ProjectRawScope,
  scope: ProjectScope,
  organizationScope: OrganizationScope,
  fetch: typeof globalThis.fetch | undefined
): ProjectService =>
  new ProjectService({
    clock: effectivePollClock(options.clock),
    ...(fetch === undefined ? {} : { fetch }),
    organizationScope,
    ...(options.random === undefined ? {} : { random: options.random }),
    rawScope: options.projectRawScope ?? defaultRawScope,
    request,
    scope,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })

const createUpdateService = (
  options: PhotonServiceOptions,
  fetch: typeof globalThis.fetch,
  output: CliOutput
): UpdateService =>
  new UpdateService({
    ...options.updateDependencies,
    env: options.env ?? process.env,
    fetch,
    progress: (message) => output.progress(message),
    showOutput: !options.json,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })

interface CredentialDependencies {
  apiKey: EnvironmentKey | undefined
  apiOrigin: string
  device: DeviceAuthScope
  repository: AuthRepository
}

// A key from the environment wins over the stored sign-in, which it leaves
// untouched.
const createCredentialProvider = (
  options: PhotonServiceOptions,
  { apiKey, apiOrigin, device, repository }: CredentialDependencies
): BearerCredentialProvider => {
  if (apiKey !== undefined) {
    registerSecret(apiKey.secret)
    return new EnvironmentBearerCredentialProvider(apiKey)
  }
  return new StoredBearerCredentialProvider({
    apiOrigin,
    repository,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    tokenManager: new TokenManager({
      device,
      repository,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
  })
}

interface JournalDependencies {
  apiKey: EnvironmentKey | undefined
  apiOrigin: string
  repository: AuthRepository
  warning: (message: string) => void
}

// A run with a key from the environment writes nothing to disk, so its
// journal lives in memory.
const createOperationJournal = (
  options: PhotonServiceOptions,
  { apiKey, apiOrigin, repository, warning }: JournalDependencies
): OperationJournal =>
  apiKey === undefined
    ? new OperationRepository({
        apiOrigin,
        authRepository: repository,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        warning
      })
    : new MemoryOperationRepository({ apiOrigin, key: apiKey })

export const createPhotonCommandServices = (
  options: PhotonServiceOptions
): PhotonCommandServices => {
  installPhotonSdkHeaderCompatibility()
  const apiOrigin = projectApiOrigin(options.baseUrl)
  const { fetch, httpTrace } = createTransport(options, apiOrigin)
  const output = createOutput(options, httpTrace)
  const warning = (message: string): void => output.warning(message)
  const repository = createRepository(options, apiOrigin)
  const transportOptions = createTransportOptions(options, fetch)
  const publicPhoton = new Photon({ ...transportOptions, retry: false })
  const device: DeviceAuthScope =
    options.deviceScope ?? publicPhoton.auth.device
  const apiKey = environmentKey(options.env ?? process.env)
  const credentialProvider = createCredentialProvider(options, {
    apiKey,
    apiOrigin,
    device,
    repository
  })
  const authenticatedRequest = createAuthenticatedRequest(
    credentialProvider,
    options.signal
  )
  const authenticatedPhoton = createAuthenticatedPhoton(
    transportOptions,
    credentialProvider
  )
  const browserLauncher = options.browserLauncher ?? launchBrowser
  const organizationScope =
    options.organizationScope ?? authenticatedPhoton.organizations
  const accountService = createAccountService(options, {
    account: options.accountScope ?? authenticatedPhoton.account,
    apiOrigin,
    environmentKey: apiKey,
    fetch,
    repository,
    request: authenticatedRequest,
    warning
  })
  const auth = new AuthLifecycleService({
    accountService,
    accountServiceKeyInput: createAccountServiceKeyInput(options),
    accountServiceKeyVerifier: createAccountServiceKeyVerifier(
      options,
      transportOptions
    ),
    apiOrigin,
    browserLauncher,
    device,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(apiKey === undefined ? {} : { environmentKey: apiKey }),
    output,
    repository,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })
  const oauth = createOauthService(
    options,
    authenticatedRequest,
    publicPhoton.auth,
    authenticatedPhoton.raw.organizations,
    { ...authenticatedPhoton.account, ...organizationScope },
    apiOrigin,
    fetch
  )
  const organizations = createOrganizationService(
    options,
    authenticatedRequest,
    organizationScope
  )
  const folder = new ProjectFolderRepository({
    apiOrigin,
    cwd: options.cwd ?? process.cwd()
  })
  const organizationContext = createOrganizationContext(
    options,
    repository,
    apiOrigin,
    organizations,
    folder,
    apiKey
  )
  const projectContext = createProjectContext(
    options,
    repository,
    folder,
    apiKey
  )
  const projectScope = options.projectScope ?? authenticatedPhoton.projects
  const projects = createProjectService(
    options,
    authenticatedRequest,
    authenticatedPhoton.raw.projects,
    projectScope,
    organizationScope,
    fetch
  )
  const targetNotice = new TargetNotice({
    organizationContext,
    output,
    projectContext,
    projects
  })
  const input = createInput(options, targetNotice)
  const internal = createInternalServices({
    account: accountService,
    auth,
    input,
    options,
    organizationScope,
    photon: authenticatedPhoton,
    projectScope,
    repository,
    request: authenticatedRequest
  })
  const voice = new VoiceService({
    request: authenticatedRequest,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scope: options.voiceScope ?? authenticatedPhoton.projects.platforms
  })
  const operations = new OperationService({
    account: accountService,
    beforeWrite: (intent) => targetNotice.beforeWrite(intent),
    internal,
    ...(options.now === undefined ? {} : { now: options.now }),
    organizationContext,
    organizations,
    projectContext,
    projects,
    repository: createOperationJournal(options, {
      apiKey,
      apiOrigin,
      repository,
      warning
    }),
    voice,
    warning
  })

  return {
    account: accountService,
    auth,
    browser: {
      countdown: async (tick) =>
        await browserCountdown(tick, {
          clock: effectivePollClock(options.clock),
          seconds: 5,
          ...(options.signal === undefined ? {} : { signal: options.signal })
        }),
      open: browserLauncher
    },
    input,
    internal,
    mfaQr: effectiveMfaQr(options.mfaQr),
    now: options.now ?? Date.now,
    oauth,
    operations,
    organizationContext,
    organizations,
    output,
    projectContext,
    projects,
    randomBytes: options.randomBytes ?? randomBytes,
    setExitCode:
      options.setExitCode ??
      ((exitCode) => {
        process.exitCode = exitCode
      }),
    update: createUpdateService(options, fetch, output),
    voice
  }
}
