import open from 'open'
import type { PollClock } from '../auth/device-flow.ts'

export type BrowserLauncher = (url: string) => Promise<void>

interface BrowserCountdownOptions {
  clock: PollClock
  seconds: number
  signal?: AbortSignal
}

export const browserCountdown = async (
  tick: (secondsRemaining: number) => void,
  options: BrowserCountdownOptions
): Promise<void> => {
  for (
    let secondsRemaining = options.seconds;
    secondsRemaining > 0;
    secondsRemaining -= 1
  ) {
    options.signal?.throwIfAborted()
    tick(secondsRemaining)
    // biome-ignore lint/performance/noAwaitInLoops: countdown ticks must remain one second apart.
    await options.clock.sleep(1000, options.signal)
    options.signal?.throwIfAborted()
  }
}

export const launchBrowser: BrowserLauncher = async (url) => {
  await open(url, { wait: false })
}
