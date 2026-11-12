const DEFAULT_POLL_INTERVAL_MS = 2000

export interface PollingClock {
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>
}

interface PollUntilSettledOptions<Result, Pending extends Result> {
  clock: PollingClock
  initial: Result
  isPending: (result: Result) => result is Pending
  poll: (previous: Result) => Promise<Result>
  retryAfterSeconds?: (result: Result) => number | undefined
  signal?: AbortSignal
}

const pollDelay = <Result>(
  result: Result,
  retryAfterSeconds: ((result: Result) => number | undefined) | undefined
): number => {
  const hint = retryAfterSeconds?.(result)
  return hint === undefined ? DEFAULT_POLL_INTERVAL_MS : hint * 1000
}

export const pollUntilSettled = async <Result, Pending extends Result>(
  options: PollUntilSettledOptions<Result, Pending>
): Promise<Exclude<Result, Pending>> => {
  let result = options.initial
  while (options.isPending(result)) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is intentionally serial.
    await options.clock.sleep(
      pollDelay(result, options.retryAfterSeconds),
      options.signal
    )
    result = await options.poll(result)
  }
  return result as Exclude<Result, Pending>
}
