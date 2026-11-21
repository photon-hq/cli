import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { launchBrowser } from '../src/core/browser.ts'

// Windows opens a URL with the handler its scheme is registered to, the way it
// opens https with the default browser. This scheme's handler records the URL.
const scheme = 'photon-cli-launcher-test'
const schemeKey = `HKCU\\Software\\Classes\\${scheme}`
const timeoutMs = 30_000
const pollMs = 250

const reg = (args: string[]): void => {
  const result = spawnSync('reg', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`reg ${args[0]} failed: ${result.stderr || result.stdout}`)
  }
}

const waitForFile = async (path: string): Promise<string | undefined> => {
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    // biome-ignore lint/performance/noAwaitInLoops: polls until the handler writes the file.
    const content = await readFile(path, 'utf8').catch(() => undefined)
    if (content !== undefined) {
      return content
    }
    await sleep(pollMs)
  }
}

const main = async (): Promise<void> => {
  if (process.platform !== 'win32') {
    throw new Error('The browser launcher test runs on Windows only.')
  }

  const directory = await mkdtemp(join(tmpdir(), 'photon-launcher-'))
  const opened = join(directory, 'opened.txt')
  const handler = join(directory, 'handler.mjs')
  const partial = `${opened}.partial`
  const url = `${scheme}://photon.test/device?user_code=${randomUUID()}`

  try {
    await writeFile(
      handler,
      `import { renameSync, writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(partial)}, process.argv[2] ?? '')\nrenameSync(${JSON.stringify(partial)}, ${JSON.stringify(opened)})\n`
    )
    reg(['add', schemeKey, '/ve', '/d', `URL:${scheme}`, '/f'])
    reg(['add', schemeKey, '/v', 'URL Protocol', '/d', '', '/f'])
    reg([
      'add',
      `${schemeKey}\\shell\\open\\command`,
      '/ve',
      '/d',
      `"${process.execPath}" "${handler}" "%1"`,
      '/f'
    ])

    await launchBrowser(url)

    const received = await waitForFile(opened)
    if (received === undefined) {
      throw new Error(
        `The browser launcher did not open ${url} within ${timeoutMs / 1000} seconds.`
      )
    }
    if (received !== url) {
      throw new Error(`The browser launcher opened ${received}, not ${url}.`)
    }
  } finally {
    spawnSync('reg', ['delete', schemeKey, '/f'])
    await rm(directory, { force: true, recursive: true })
  }

  process.stdout.write(`The browser launcher opened ${url}.\n`)
}

await main()
