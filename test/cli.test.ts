import { afterEach, describe, expect, test, vi } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { runCli } from '../src/main.ts'
import { CLI_NAME } from '../src/meta.ts'
import { printed } from './help-support.ts'
import { stagingTarget } from './target-support.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CLI contract', () => {
  test('uses photon as the command name', async () => {
    const lines: string[] = []
    lines.push(await printed(['--help']))

    expect(lines.join('\n')).toContain('photon')
  })

  test('exposes the lazy account command tree', async () => {
    const lines: string[] = []
    lines.push(await printed(['account', '--help']))

    const help = lines.join('\n')
    expect(help).toContain('avatar')
    expect(help).not.toContain('billing')
    expect(help).toContain('edit')
    expect(help).toContain('view')
  })

  test('exposes the lazy MFA command tree', async ({ skip }) => {
    skip(!stagingTarget)
    const lines: string[] = []
    lines.push(await printed(['auth', 'mfa', '--help']))

    const help = lines.join('\n')
    expect(help).toContain('disable')
    expect(help).toContain('enable')
    expect(help).toContain('status')
  })

  test('emits machine-readable JSON', async () => {
    let output = ''

    await runCli(['--json'], {
      stdout: {
        write: (chunk) => {
          output += chunk
        }
      }
    })

    expect(JSON.parse(output)).toEqual({
      name: CLI_NAME,
      version: packageJson.version
    })
  })

  test('exposes version metadata', async () => {
    const lines: string[] = []
    lines.push(await printed(['--version']))

    expect(lines).toEqual([packageJson.version])
  })
})
