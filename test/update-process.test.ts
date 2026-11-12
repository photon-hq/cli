import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runProcess } from '../src/update/process.ts'

const WAIT = 'setTimeout(() => {}, 60_000)'

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runProcess', () => {
  test('returns the exit code and output of the command', async () => {
    await expect(
      runProcess(process.execPath, [
        '-e',
        'console.log("out"); console.error("err"); process.exitCode = 3'
      ])
    ).resolves.toEqual({ exitCode: 3, stderr: 'err\n', stdout: 'out\n' })
  })

  test('stops the command and rejects with the interrupt when the signal aborts', async () => {
    const controller = new AbortController()
    const running = runProcess(process.execPath, ['-e', WAIT], {
      signal: controller.signal
    })
    controller.abort(new DOMException('Command interrupted.', 'AbortError'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('stops a command that runs past its time and says so', async () => {
    await expect(
      runProcess(process.execPath, ['-e', WAIT], { timeoutMs: 200 })
    ).resolves.toMatchObject({ timedOut: true })
  })

  test('runs the command in the folder it is given', async () => {
    const folder = realpathSync.native(
      await mkdtemp(join(tmpdir(), 'photon-process-'))
    )
    try {
      await expect(
        runProcess(
          process.execPath,
          ['-e', 'process.stdout.write(process.cwd())'],
          { cwd: folder }
        )
      ).resolves.toMatchObject({ exitCode: 0, stdout: folder })
    } finally {
      await rm(folder, { force: true, recursive: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('runProcess on POSIX', () => {
  test('treats a command stopped by Ctrl-C as interrupted', async () => {
    await expect(
      runProcess(process.execPath, [
        '-e',
        `process.kill(process.pid, 'SIGINT'); ${WAIT}`
      ])
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('settles at its time when what the command started holds its output', async () => {
    const started = Date.now()
    await expect(
      runProcess('/bin/sh', ['-c', 'sleep 3 & sleep 3'], { timeoutMs: 200 })
    ).resolves.toMatchObject({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('kills a command that goes on after SIGTERM', async () => {
    const started = Date.now()
    await expect(
      runProcess(
        process.execPath,
        ['-e', `process.on('SIGTERM', () => undefined); ${WAIT}`],
        { timeoutMs: 500 }
      )
    ).resolves.toMatchObject({ timedOut: true })
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  test('settles soon after the command ends, with its output, while what it started holds the output', async () => {
    const started = Date.now()
    await expect(
      runProcess('/bin/sh', ['-c', 'echo out; sleep 6 & exit 0'])
    ).resolves.toEqual({ exitCode: 0, stderr: '', stdout: 'out\n' })
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test('reports a command that ended in time as ended, though what it started runs on', async () => {
    await expect(
      runProcess('/bin/sh', ['-c', 'sleep 3 & exit 0'], { timeoutMs: 200 })
    ).resolves.toEqual({ exitCode: 0, stderr: '', stdout: '' })
  })
})

describe.runIf(process.platform === 'win32')('runProcess on Windows', () => {
  test('runs a .cmd command found on PATH', async () => {
    await expect(runProcess('npm', ['--version'])).resolves.toMatchObject({
      exitCode: 0
    })
  })

  test('refuses a word cmd.exe would read as syntax', async () => {
    await expect(runProcess('npm', ['view', 'x&calc'])).rejects.toThrow(
      'cannot be passed to cmd.exe'
    )
  })

  test('stops what cmd.exe started when the command runs past its time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'photon-process-'))
    try {
      const started = join(directory, 'started')
      await writeFile(
        join(directory, 'slow.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, String(process.pid)); ${WAIT}`
      )
      await writeFile(
        join(directory, 'slow.cmd'),
        `@"${process.execPath}" "${join(directory, 'slow.js')}"\r\n`
      )
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ??
        'PATH'
      const result = await runProcess('slow', [], {
        env: {
          ...process.env,
          [pathKey]: `${directory};${process.env[pathKey] ?? ''}`
        },
        timeoutMs: 5000
      })
      expect(result).toMatchObject({ timedOut: true })
      const pid = Number(await readFile(started, 'utf8'))
      await expect
        .poll(() => isRunning(pid), { interval: 100, timeout: 5000 })
        .toBe(false)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }, 20_000)
})
