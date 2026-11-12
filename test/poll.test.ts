import { describe, expect, test, vi } from 'vitest'
import { type PollingClock, pollUntilSettled } from '../src/core/poll.ts'

type PollResult =
  | { retryAfterSeconds?: number; status: 'pending' }
  | { status: 'succeeded'; value: string }

const isPending = (
  result: PollResult
): result is Extract<PollResult, { status: 'pending' }> =>
  result.status === 'pending'

describe('pollUntilSettled', () => {
  test('uses server hints exactly and falls back to two seconds', async () => {
    const sleeps: number[] = []
    const clock: PollingClock = {
      sleep: (durationMs) => {
        sleeps.push(durationMs)
        return Promise.resolve()
      }
    }
    const poll = vi
      .fn<() => Promise<PollResult>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'succeeded', value: 'complete' })

    await expect(
      pollUntilSettled({
        clock,
        initial: { retryAfterSeconds: 7, status: 'pending' } as PollResult,
        isPending,
        poll,
        retryAfterSeconds: (result) =>
          isPending(result) ? result.retryAfterSeconds : undefined
      })
    ).resolves.toEqual({ status: 'succeeded', value: 'complete' })
    expect(sleeps).toEqual([7000, 2000])
    expect(poll).toHaveBeenCalledTimes(2)
  })

  test('has no round limit and stops only when its signal is aborted', async () => {
    const controller = new AbortController()
    const sleeps: number[] = []
    const clock: PollingClock = {
      sleep: (durationMs, signal) => {
        sleeps.push(durationMs)
        if (sleeps.length === 5) {
          controller.abort(new DOMException('interrupted', 'AbortError'))
        }
        return signal?.aborted
          ? Promise.reject(signal.reason)
          : Promise.resolve()
      }
    }
    const poll = vi.fn<() => Promise<PollResult>>(() =>
      Promise.resolve({ status: 'pending' })
    )

    await expect(
      pollUntilSettled({
        clock,
        initial: { status: 'pending' } as PollResult,
        isPending,
        poll,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000])
    expect(poll).toHaveBeenCalledTimes(4)
  })
})
