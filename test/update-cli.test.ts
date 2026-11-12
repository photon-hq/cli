import { describe, expect, test } from 'vitest'
import { runCli } from '../src/main.ts'
import { PHOTON_PACKAGE } from '../src/update/release.ts'

const REGISTRY = 'https://registry.example.test'
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u

const run = async (args: string[], latest = '3.1.0') => {
  let stdout = ''
  let stderr = ''
  const exitCodes: number[] = []
  await runCli(args, {
    env: { npm_config_registry: REGISTRY },
    fetch: async () =>
      Response.json({ 'dist-tags': { [PHOTON_PACKAGE.tag]: latest } }),
    setExitCode: (code) => exitCodes.push(code),
    stderr: {
      write: (chunk: string) => {
        stderr += chunk
      }
    },
    stdout: {
      write: (chunk: string) => {
        stdout += chunk
      }
    },
    updateDependencies: { binary: undefined, currentVersion: '0.3.0' }
  })
  return { exitCodes, stderr, stdout }
}

describe('photon update --check --json', () => {
  test('returns the 1.0 fields', async () => {
    const { exitCodes, stdout } = await run(['update', '--check', '--json'])
    expect(exitCodes).toEqual([])
    expect(stdout).toBe(
      '{"currentVersion":"0.3.0","installer":null,"latestVersion":"3.1.0","status":"update-available"}\n'
    )
  })

  test('accepts --installer', async () => {
    const { exitCodes, stdout } = await run([
      'update',
      '--check',
      '--installer',
      'pnpm',
      '--json'
    ])
    expect(exitCodes).toEqual([])
    expect(JSON.parse(stdout)).toEqual({
      currentVersion: '0.3.0',
      installer: null,
      latestVersion: '3.1.0',
      status: 'update-available'
    })
  })

  test('rejects an installer it does not know', async () => {
    const { exitCodes, stdout } = await run([
      'update',
      '--check',
      '--installer',
      'brew',
      '--json'
    ])
    expect(exitCodes).toEqual([2])
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
  })
})

describe('photon update --check', () => {
  test.each([
    { latest: '99.0.0\u001b[31m', name: 'an escape sequence' },
    { latest: '99.0.0\u202e', name: 'a right-to-left override' }
  ])(
    'rejects a registry version with $name, in both output modes',
    async ({ latest }) => {
      const json = await run(['update', '--check', '--json'], latest)
      const text = await run(['update', '--check', '--no-color'], latest)

      expect(json.exitCodes).toEqual([1])
      expect(JSON.parse(json.stdout)).toMatchObject({
        error: { code: 'UPDATE_CHECK_FAILED' }
      })
      expect(text.exitCodes).toEqual([1])
      expect(text.stderr).toContain('(UPDATE_CHECK_FAILED)')
      for (const output of [
        json.stdout,
        json.stderr,
        text.stdout,
        text.stderr
      ]) {
        expect(output.replaceAll('\n', '')).not.toMatch(CONTROL_OR_FORMAT)
      }
    }
  )
})
