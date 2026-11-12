import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { PHOTON_GLOBAL_OPTIONS } from '../src/app/global-options.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { runCli } from '../src/main.ts'
import {
  collector,
  createAuthenticatedConfig,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

interface Argument {
  readonly parse?: (value: string) => unknown
  readonly type: string
}

interface CommandNode {
  readonly args?: Readonly<Record<string, Argument>>
  readonly subCommands?:
    | ReadonlyMap<string, CommandNode>
    | Readonly<Record<string, CommandNode>>
}

const UNSAFE_VALUES = ['..', '.', 'a/b', 'x?y']
const ID_NAME_PATTERN = /(?:^|-)id$|Id$/u
const PROJECT_ID = 'pho_prj_00000000000000000000000001'

const idArguments = (): [string, Argument][] => {
  const found: [string, Argument][] = Object.entries(PHOTON_GLOBAL_OPTIONS)
    .filter(([name]) => name === 'org' || name === 'project')
    .map(([name, option]) => [`--${name}`, option as Argument])
  const visit = (path: string, command: CommandNode): void => {
    for (const [name, argument] of Object.entries(command.args ?? {})) {
      if (ID_NAME_PATTERN.test(name)) {
        found.push([`${path} ${name}`, argument])
      }
    }
    const children =
      command.subCommands instanceof Map
        ? [...command.subCommands]
        : Object.entries(command.subCommands ?? {})
    for (const [name, child] of children) {
      visit(`${path} ${name}`, child)
    }
  }
  for (const [name, command] of Object.entries(photonCommands)) {
    visit(name, command as CommandNode)
  }
  return found
}

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('ID arguments and options', () => {
  const found = idArguments()

  test('the registry has ID arguments to check', () => {
    expect(found.length).toBeGreaterThan(50)
  })

  test.each(found)('%s rejects unsafe values locally', (_name, argument) => {
    expect(argument.parse).toBeTypeOf('function')
    for (const value of UNSAFE_VALUES) {
      expect(() => argument.parse?.(value)).toThrow(
        expect.objectContaining({ code: 'ARGUMENT_VALIDATION', exitCode: 2 })
      )
    }
  })

  test.each([
    [['project', 'api-key', 'revoke', '..', '--project', PROJECT_ID]],
    [['project', 'view', '--project', '..']],
    [['org', 'show', '--org', '..']]
  ])('%j exits 2 and sends no request', async (args) => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(500).end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
    const authenticated = await createAuthenticatedConfig('user_ada', origin)
    const stderr = collector()
    const stdout = collector()
    const exitCodes: number[] = []

    await runCli([...args, '--json'], {
      baseUrl: origin,
      configDirectory: authenticated.configDirectory,
      deviceScope: unusedDeviceScope(),
      now: () => TEST_NOW,
      platform: 'linux',
      setExitCode: (exitCode) => exitCodes.push(exitCode),
      stderr,
      stdout
    })

    expect(exitCodes).toEqual([2])
    expect(JSON.parse(stdout.value())).toMatchObject({
      error: { code: 'ARGUMENT_VALIDATION' }
    })
    expect(stderr.value()).toBe('')
    expect(requests).toBe(0)
  })
})
