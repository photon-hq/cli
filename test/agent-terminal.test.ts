import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { resolveTarget } from '../scripts/build-config.mjs'
import { BUILD_CONFIG } from '../src/build-config.ts'
import { CLI_NAME } from '../src/meta.ts'
import { photonKey } from './key-support.ts'

const TERMINAL = join(import.meta.dirname, 'support', 'terminal.py')
const PROJECT_ID = 'pho_prj_00000000000000000000000001'
const PROJECT_NAME = 'Alpha Project'
const QUESTION = `Delete project "${PROJECT_NAME}" (${PROJECT_ID})?`
const TYPE_TO_CONFIRM = `Type ${PROJECT_NAME} to confirm: `
const TIMEOUT_SECONDS = 10
const ASK_THE_USER = 'Ask the user before you run the command again with --yes.'
const supported =
  process.platform !== 'win32' &&
  spawnSync('python3', ['--version']).status === 0

interface Run {
  exitCode: number
  stderr: string
  stdout: string
  timedOut: boolean
}

interface RunOptions {
  answer?: string
  args?: string[]
  env?: Record<string, string>
  stdout?: 'pipe' | 'terminal'
}

let directory: string
let bundle: string
let server: Server
const requests: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'photon-agent-terminal-'))
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (
      request.method === 'GET' &&
      request.url === `/v1/projects/${PROJECT_ID}`
    ) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          agentProfile: {
            avatarUrl: 'https://images.example.test/avatar.png',
            firstName: 'Photon',
            lastName: null
          },
          createdAt: '2026-07-31T18:00:00.000Z',
          createdByAccountId: 'user_ada',
          createdByActorId: 'user_ada',
          createdByActorKind: 'account',
          deletedAt: null,
          flags: [],
          name: PROJECT_NAME,
          organizationId: 'pho_org_00000000000000000000000001',
          projectId: PROJECT_ID,
          slug: 'alpha-project',
          updatedAt: '2026-07-31T18:00:00.000Z'
        })
      )
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((listening) => {
    server.listen(0, '127.0.0.1', listening)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
  bundle = join(directory, 'bundle.mjs')
  const { aliases, conditions } = resolveTarget(BUILD_CONFIG)
  await build({
    alias: aliases,
    bundle: true,
    conditions,
    external: ['@napi-rs/keyring'],
    format: 'esm',
    logLevel: 'silent',
    outfile: bundle,
    platform: 'node',
    stdin: {
      contents: [
        "import { runCli } from './main.ts'",
        `await runCli(process.argv.slice(2), { baseUrl: ${JSON.stringify(origin)} })`
      ].join('\n'),
      loader: 'ts',
      resolveDir: join(import.meta.dirname, '..', 'src')
    },
    target: 'node22'
  })
}, 60_000)

afterAll(async () => {
  server?.close()
  await rm(directory, { force: true, recursive: true })
})

/**
 * `project delete` in a pseudo-terminal: standard input, output and error are
 * terminals unless `stdout` says otherwise. The environment holds an API key,
 * a temporary home and `options.env`, and nothing from this shell.
 */
const deleteInTerminal = async (options: RunOptions = {}): Promise<Run> => {
  requests.length = 0
  const result = await promisify(execFile)('python3', [
    TERMINAL,
    JSON.stringify({
      ...(options.answer === undefined
        ? {}
        : { answer: { after: TYPE_TO_CONFIRM, send: options.answer } }),
      command: [
        process.execPath,
        bundle,
        'project',
        'delete',
        PROJECT_ID,
        ...(options.args ?? [])
      ],
      env: {
        [BUILD_CONFIG.apiTokenVariable]: photonKey(
          'sk',
          '01h455vb4pex5vsknk084sn02q_agent-terminal-secret'
        ),
        HOME: directory,
        PATH: process.env.PATH ?? '',
        PHOTON_NO_UPDATE_NOTIFIER: '1',
        TERM: 'xterm-256color',
        XDG_CONFIG_HOME: join(directory, '.config'),
        ...options.env
      },
      stdout: options.stdout ?? 'terminal',
      timeoutSeconds: TIMEOUT_SECONDS
    })
  ])
  const run = JSON.parse(result.stdout) as Run
  return {
    ...run,
    stderr: stripVTControlCharacters(run.stderr),
    stdout: stripVTControlCharacters(run.stdout)
  }
}

const agentBlocked = (agent: string): string =>
  [
    `Error: This would delete project "${PROJECT_NAME}" (${PROJECT_ID}). Confirm it with --yes. (CONFIRMATION_REQUIRED)`,
    `Detail: Photon can't ask because an AI agent is running this command (${agent}). ${ASK_THE_USER}`,
    `Next: Run it again with --yes: ${CLI_NAME} project delete ${PROJECT_ID} --yes`,
    'Docs: https://photon.codes/docs/cli/output#errors',
    ''
  ].join('\n')

describe.runIf(supported)('project delete in a terminal', () => {
  test.each([
    [{ AI_AGENT: 'codex' }, 'codex'],
    [{ CLAUDE_CODE_CHILD_SESSION: '1' }, 'claude-code'],
    [{ CODEX_CI: '1' }, 'codex'],
    [{ CODEX_THREAD_ID: '019a6f2e-thread' }, 'codex'],
    [{ GEMINI_CLI: '1' }, 'gemini-cli'],
    [{ OPENCODE: '1' }, 'opencode'],
    [{ CURSOR_AGENT: '1' }, 'cursor'],
    [{ COPILOT_AGENT: '1' }, 'github-copilot'],
    [{ CLINE_ACTIVE: 'true' }, 'cline'],
    [{ ROO_ACTIVE: 'true' }, 'roo-code'],
    [{ AGENT: 'goose' }, 'goose']
  ])(
    'with %j asks nothing and fails at once, naming %s and --yes',
    async (env, agent) => {
      const run = await deleteInTerminal({ env })

      expect(run.timedOut).toBe(false)
      expect(run.exitCode).toBe(2)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe(agentBlocked(agent))
      expect(requests).toEqual([`GET /v1/projects/${PROJECT_ID}`])
    }
  )

  test.each([
    {},
    { CLAUDECODE: '1' },
    { CURSOR_TRACE_ID: 'trace-1' },
    { REPL_ID: 'repl-1' },
    { GOOSE_PROVIDER: 'openai' },
    { TERM_PROGRAM: 'kiro' }
  ])('with %j asks, and a wrong answer cancels', async (env) => {
    const run = await deleteInTerminal({ answer: 'no\n', env })

    expect(run.timedOut).toBe(false)
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe(`${QUESTION}\n${TYPE_TO_CONFIRM}Cancelled.\n`)
    expect(requests).toEqual([`GET /v1/projects/${PROJECT_ID}`])
  })

  test.each(['no', '0', 'false', 'off'])(
    'with agent markers and PHOTON_AGENT=%j asks, and a wrong answer cancels',
    async (value) => {
      const run = await deleteInTerminal({
        answer: 'no\n',
        env: { AI_AGENT: 'codex', CODEX_CI: '1', PHOTON_AGENT: value }
      })

      expect(run.timedOut).toBe(false)
      expect(run.exitCode).toBe(1)
      expect(run.stderr).toBe(`${QUESTION}\n${TYPE_TO_CONFIRM}Cancelled.\n`)
      expect(requests).toEqual([`GET /v1/projects/${PROJECT_ID}`])
    }
  )

  test.each(['yes', 'nope'])(
    'with AI_AGENT=codex and PHOTON_AGENT=%j asks nothing and fails at once',
    async (value) => {
      const run = await deleteInTerminal({
        env: { AI_AGENT: 'codex', PHOTON_AGENT: value }
      })

      expect(run.timedOut).toBe(false)
      expect(run.exitCode).toBe(2)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe(agentBlocked('codex'))
      expect(requests).toEqual([`GET /v1/projects/${PROJECT_ID}`])
    }
  )

  test.each<[string, RunOptions, string]>([
    ['--json', { args: ['--json'] }, '--json is set'],
    ['--no-input', { args: ['--no-input'] }, '--no-input is set'],
    ['CI', { env: { CI: 'true' } }, 'CI is set'],
    [
      'a standard output that is not a terminal',
      { stdout: 'pipe' },
      'standard output is not a terminal'
    ]
  ])(
    'with PHOTON_AGENT=no is still blocked by %s',
    async (_case, options, reason) => {
      const run = await deleteInTerminal({
        ...options,
        env: { AI_AGENT: 'codex', PHOTON_AGENT: 'no', ...options.env }
      })

      expect(run.timedOut).toBe(false)
      expect(run.exitCode).toBe(2)
      expect(`${run.stdout}${run.stderr}`).toContain(
        `Photon can't ask because ${reason}.`
      )
      expect(`${run.stdout}${run.stderr}`).not.toContain(ASK_THE_USER)
      expect(requests).toEqual([`GET /v1/projects/${PROJECT_ID}`])
    }
  )
})
