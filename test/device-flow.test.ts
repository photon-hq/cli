import {
  ApiError,
  type DeviceAuthorizeOutput,
  type DeviceTokenOutput,
  TransportError
} from '@photon-ai/api'
import { describe, expect, test, vi } from 'vitest'
import {
  MAX_DEVICE_AUTHORIZATION_LIFETIME_SECONDS,
  MAX_DEVICE_POLL_INTERVAL_SECONDS
} from '../src/auth/constants.ts'
import {
  type PollClock,
  pollDeviceToken,
  validateDeviceAuthorization
} from '../src/auth/device-flow.ts'
import type { DeviceAuthScope } from '../src/auth/types.ts'
import { CliError } from '../src/core/errors.ts'
import { CLI_NAME } from '../src/meta.ts'

const authorization: DeviceAuthorizeOutput = {
  device_code: 'private-device-code',
  expires_in: 120,
  interval: 1,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example.test/device',
  verification_uri_complete:
    'https://auth.example.test/device?user_code=ABCD-EFGH'
}

const grant: DeviceTokenOutput = {
  access_token: 'access-token',
  expires_in: 300,
  refresh_token: 'refresh-token',
  user: {
    email: 'ada@example.test',
    first_name: 'Ada',
    id: 'user_123',
    last_name: 'Lovelace'
  }
}

const oauthError = (
  error: string,
  status = 400,
  headers: Headers = new Headers()
): ApiError =>
  new ApiError('OAuth request failed', {
    body: { error },
    headers,
    operationId: 'deviceToken',
    requestId: 'req_test',
    status
  })

const fakeClock = (): PollClock & {
  sleeps: number[]
} => {
  let now = 0
  const wallStart = Date.parse('2026-07-30T20:00:00.000Z')
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: (durationMs) => {
      sleeps.push(durationMs)
      now += durationMs
      return Promise.resolve()
    },
    sleeps,
    wallNow: () => wallStart + now
  }
}

const deviceWithPollResults = (results: unknown[]): DeviceAuthScope => ({
  authorize: () => Promise.resolve(authorization),
  token: vi.fn(() => {
    const result = results.shift()
    if (result instanceof Error) {
      return Promise.reject(result)
    }
    return Promise.resolve(result as DeviceTokenOutput)
  })
})

describe('device authorization polling', () => {
  test('waits before the first poll and retains the interval while pending', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([
      oauthError('authorization_pending'),
      oauthError('authorization_pending'),
      grant
    ])

    await expect(
      pollDeviceToken({ authorization, clock, device })
    ).resolves.toEqual(grant)
    expect(clock.sleeps).toEqual([1000, 1000, 1000])
    expect(device.token).toHaveBeenCalledTimes(3)
  })

  test('permanently increases the interval for slow_down and bare 429', async () => {
    const clock = fakeClock()
    const retryAfter = new Headers({ 'retry-after': '20' })
    const device = deviceWithPollResults([
      oauthError('slow_down'),
      oauthError('rate_limited', 429, retryAfter),
      oauthError('authorization_pending'),
      grant
    ])

    await pollDeviceToken({ authorization, clock, device })

    expect(clock.sleeps).toEqual([1000, 6000, 20_000, 11_000])
  })

  test('evaluates HTTP-date Retry-After against the injected wall clock', async () => {
    const clock = fakeClock()
    const retryAt = new Date(clock.wallNow() + 21_000).toUTCString()
    const device = deviceWithPollResults([
      oauthError('rate_limited', 429, new Headers({ 'retry-after': retryAt })),
      grant
    ])

    await pollDeviceToken({ authorization, clock, device })

    expect(clock.sleeps).toEqual([1000, 20_000])
  })

  test('uses truncated exponential backoff for transient failures', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([
      new TransportError('offline'),
      new ApiError('bad gateway', {
        body: { error: 'upstream_overloaded' },
        headers: new Headers(),
        operationId: 'deviceToken',
        status: 502
      }),
      grant
    ])

    await pollDeviceToken({ authorization, clock, device })

    expect(clock.sleeps).toEqual([1000, 2000, 4000])
  })

  test('treats OAuth server_error as terminal even when the status is 5xx', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([oauthError('server_error', 503)])

    await expect(
      pollDeviceToken({ authorization, clock, device })
    ).rejects.toMatchObject({
      code: 'AUTH_SERVER_ERROR'
    })
    expect(device.token).toHaveBeenCalledTimes(1)
  })

  test('stops immediately when the user denies access', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([oauthError('access_denied')])

    await expect(
      pollDeviceToken({ authorization, clock, device })
    ).rejects.toMatchObject({
      code: 'AUTH_ACCESS_DENIED'
    })
    expect(clock.sleeps).toEqual([1000])
  })

  test('expires without making a late poll', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([grant])

    await expect(
      pollDeviceToken({
        authorization: { ...authorization, expires_in: 1 },
        clock,
        device
      })
    ).rejects.toMatchObject({
      code: 'AUTH_DEVICE_CODE_EXPIRED',
      exitCode: 4,
      next: [
        { description: 'Sign in again', person: true, run: `${CLI_NAME} login` }
      ]
    })
    expect(device.token).not.toHaveBeenCalled()
  })

  test('enforces a positive polling delay for fractional intervals', async () => {
    const clock = fakeClock()
    const device = deviceWithPollResults([grant])

    await pollDeviceToken({
      authorization: { ...authorization, interval: 0.0001 },
      clock,
      device
    })

    expect(clock.sleeps).toEqual([1000])
  })

  test('stops polling when the wait is aborted', async () => {
    const controller = new AbortController()
    const reason = new DOMException('interrupted', 'AbortError')
    const clock = fakeClock()
    const { sleep } = clock
    clock.sleep = async (durationMs, signal) => {
      if (clock.sleeps.length === 1) {
        controller.abort(reason)
        throw reason
      }
      await sleep(durationMs, signal)
    }
    const device = deviceWithPollResults([
      oauthError('authorization_pending'),
      grant
    ])

    await expect(
      pollDeviceToken({
        authorization,
        clock,
        device,
        signal: controller.signal
      })
    ).rejects.toBe(reason)
    expect(device.token).toHaveBeenCalledTimes(1)
  })

  test('rejects unsafe verification URLs and malformed timing', () => {
    expect(() =>
      validateDeviceAuthorization({
        ...authorization,
        verification_uri: 'http://auth.example.test/device'
      })
    ).toThrow(CliError)
    expect(() =>
      validateDeviceAuthorization({ ...authorization, interval: 0 })
    ).toThrow(CliError)
    expect(() =>
      validateDeviceAuthorization({
        ...authorization,
        expires_in: MAX_DEVICE_AUTHORIZATION_LIFETIME_SECONDS + 1
      })
    ).toThrow(CliError)
    expect(() =>
      validateDeviceAuthorization({
        ...authorization,
        interval: MAX_DEVICE_POLL_INTERVAL_SECONDS + 1
      })
    ).toThrow(CliError)
  })

  test('rejects an incomplete token response without persisting it', async () => {
    const device = deviceWithPollResults([
      {
        ...grant,
        refresh_token: ''
      }
    ])

    await expect(
      pollDeviceToken({ authorization, clock: fakeClock(), device })
    ).rejects.toMatchObject({
      code: 'AUTH_PROTOCOL_ERROR'
    })
  })
})
