import { Photon, type PhotonOptions } from '@photon-ai/api'
import { API_ORIGIN } from '../auth/constants.ts'
import {
  DEFAULT_PHOTON_API_VERSION,
  photonApiVersionOverride
} from '../core/api-version.ts'
import { CliError } from '../core/errors.ts'
import { HttpDebugRecorder } from '../core/http-debug.ts'
import { withNetworkErrors } from '../core/network.ts'
import { withEnvironmentProxy } from '../core/proxy.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../core/request.ts'
import { photonUserAgent, withUserAgent } from '../core/user-agent.ts'
import { installPhotonSdkHeaderCompatibility } from '../project/sdk-compatibility.ts'

export interface PhotonTransportOptions
  extends Pick<PhotonOptions, 'baseUrl' | 'fetch' | 'timeoutMs'> {
  debug?: boolean
  env?: NodeJS.ProcessEnv
  now?: () => number
}

interface ApiClientOptions {
  getBearer?: () => string | Promise<string>
  retry?: false
}

const apiOriginOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).origin
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CliError forwards this cause through its options object.
    throw new CliError(
      'ARGUMENT_VALIDATION',
      'Photon API base URL must be a valid URL.',
      { cause: error, exitCode: 2 }
    )
  }
}

export const createPhotonTransport = (options: PhotonTransportOptions) => {
  installPhotonSdkHeaderCompatibility()
  const baseUrl = options.baseUrl ?? API_ORIGIN
  const apiOrigin = apiOriginOf(baseUrl)
  const env = options.env ?? process.env
  const baseFetch =
    options.fetch ??
    withEnvironmentProxy(
      async (input, init) => await globalThis.fetch(input, init),
      env
    )
  const httpTrace =
    options.debug === true
      ? new HttpDebugRecorder({
          trustedOrigin: apiOrigin,
          ...(options.now === undefined ? {} : { now: options.now })
        })
      : undefined
  const fetch = withUserAgent(
    httpTrace?.wrap(baseFetch) ?? baseFetch,
    photonUserAgent(env)
  )
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const sdkTransport = {
    baseUrl,
    fetch: withNetworkErrors(fetch, { timeoutMs }),
    timeoutMs
  }
  const versionHeader = {
    'Photon-Version':
      photonApiVersionOverride(env) ?? DEFAULT_PHOTON_API_VERSION
  }
  // Auth device-code and token routes preserve OAuth wire semantics and are
  // exempt from Photon-Version.
  return {
    apiOrigin,
    createApiClient: ({ getBearer, retry }: ApiClientOptions = {}) =>
      new Photon({
        ...sdkTransport,
        headers:
          getBearer === undefined
            ? versionHeader
            : async () => ({
                ...versionHeader,
                authorization: `Bearer ${await getBearer()}`
              }),
        ...(retry === undefined ? {} : { retry })
      }),
    fetch,
    httpTrace,
    unversionedDevice: new Photon({ ...sdkTransport, retry: false }).auth.device
  }
}
