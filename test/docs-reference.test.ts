import { cli, lazy } from 'gunshi'
import { describe, expect, it, vi } from 'vitest'
import { commandMetadata, referenceSource } from '../scripts/export-docs.ts'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { photonCommands } from '../src/commands/registry.ts'
import { CLI_NAME } from '../src/meta.ts'
import { stagingTarget } from './target-support.ts'

describe('documentation metadata', () => {
  it('names the docs family and package of the repository that releases the reference', ({
    skip
  }) => {
    skip(stagingTarget)
    expect(referenceSource(BUILD_CONFIG.releaseRepository)).toEqual({
      family: 'cli-stable',
      package: '@photon-ai/cli'
    })
    expect(referenceSource('photon-hq/example')).toEqual({
      family: 'example',
      package: 'photon-cli'
    })
  })

  it('never names a staging build reference cli-stable', ({ skip }) => {
    skip(!stagingTarget)
    expect(referenceSource(BUILD_CONFIG.releaseRepository)).toEqual({
      family: BUILD_CONFIG.releaseRepository.split('/')[1],
      package: 'photon-cli'
    })
  })

  it('loads the original definitions without running command handlers', async () => {
    const execute = vi.fn(() => {
      throw new Error('handler executed')
    })
    const load = vi.fn(() => execute)
    const command = lazy(load, {
      args: { sampleValue: { required: true, toKebab: true, type: 'string' } },
      name: 'test'
    })
    const text = JSON.stringify(
      await commandMetadata({
        eager: { run: execute },
        test: command
      })
    )
    expect(load).toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(text).toContain('sample-value')
    expect(text).toContain('"required":true')
    expect(text).toContain('"negatable":true')
  })

  it('uses Gunshi built-ins and respects hidden metadata, nesting and aliases', async () => {
    const nested = {
      args: {
        environment: {
          choices: ['test', 'production'],
          default: 'test',
          type: 'enum'
        },
        secretOption: { hidden: true, type: 'string' },
        targetName: { required: true, type: 'positional' }
      },
      name: 'display-name',
      toKebab: true
    } as const
    const commands = await commandMetadata({
      hidden: { internal: true },
      parent: {
        subCommands: new Map([
          ['nested', nested],
          ['alias', nested]
        ])
      }
    })
    expect(commands.map(({ path }) => path.join(' '))).toEqual([
      CLI_NAME,
      `${CLI_NAME} complete`,
      `${CLI_NAME} parent`,
      `${CLI_NAME} parent alias`,
      `${CLI_NAME} parent nested`
    ])
    const options = commands.find(
      ({ path }) => path.at(-1) === 'nested'
    )?.options
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ global: true, name: 'version', short: 'v' }),
        expect.objectContaining({ global: true, name: 'help', short: 'h' }),
        expect.objectContaining({
          global: true,
          name: 'color',
          negatable: true
        }),
        expect.objectContaining({
          name: 'target-name',
          required: true,
          type: 'positional'
        }),
        expect.objectContaining({
          choices: ['test', 'production'],
          default: 'test',
          name: 'environment'
        })
      ])
    )
    expect(options?.some(({ name }) => name === 'secret-option')).toBe(false)
  })

  it('documents the shell argument of complete', async () => {
    const commands = await commandMetadata({})
    const complete = commands.find(
      ({ path }) => path.join(' ') === `${CLI_NAME} complete`
    )
    expect(complete?.options).toContainEqual(
      expect.objectContaining({
        name: 'shell',
        required: false,
        type: 'positional'
      })
    )
  })

  it('keeps the built-in version option available on subcommands like runtime help', async () => {
    const commands = await commandMetadata({
      sample: { description: 'Sample command' }
    })
    const sample = commands.find(({ path }) => path.at(-1) === 'sample')
    const help = await cli(
      ['sample', '--help'],
      {},
      {
        name: 'photon',
        subCommands: { sample: {} },
        usageSilent: true,
        version: '1.0.0'
      }
    )
    expect(help).toContain('--version')
    expect(sample?.options).toContainEqual(
      expect.objectContaining({ global: true, name: 'version' })
    )
  })

  it('preserves Gunshi positional requiredness and repeatability in the artifact', async () => {
    const commands = await commandMetadata({
      defaulted: { args: { id: { default: 'current', type: 'positional' } } },
      optional: { args: { id: { required: false, type: 'positional' } } },
      repeated: { args: { id: { multiple: true, type: 'positional' } } },
      required: { args: { id: { type: 'positional' } } }
    })
    const argument = (name: string) =>
      commands
        .find(({ path }) => path.at(-1) === name)
        ?.options.find(({ type }) => type === 'positional')
    expect(argument('required')?.required).toBe(true)
    expect(argument('optional')?.required).toBe(false)
    expect(argument('defaulted')?.required).toBe(false)
    expect(argument('repeated')).toEqual(
      expect.objectContaining({ required: false, variadic: true })
    )
  })

  it('covers the runtime command tree deterministically without API requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Documentation must not request product services')
    })
    try {
      const first = await commandMetadata(photonCommands)
      expect(first).toEqual(await commandMetadata(photonCommands))
      expect(first.length).toBeGreaterThan(40)
      expect(JSON.stringify(first)).toContain('agent-profile')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })
})
