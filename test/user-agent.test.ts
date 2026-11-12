import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createPhotonCommandServices } from '../src/app/services.ts'
import {
  detectAgent,
  KNOWN_AGENTS,
  photonUserAgent,
  withUserAgent
} from '../src/core/user-agent.ts'
import { runCli } from '../src/main.ts'
import { CLI_VERSION, SDK_VERSION } from '../src/meta.ts'
import {
  collector,
  createAuthenticatedConfig,
  organizationFixture,
  TEST_NOW,
  unusedDeviceScope
} from './project-test-support.ts'

const AGENT_NAME_PATTERN = /^[a-z0-9-]{1,32}$/u
const CLAUDE_CODE_SUFFIX = / agent\/claude-code$/u
const apiOrigin = 'https://api.example.test'
const issuer = 'https://auth.example.test'
const host = {
  arch: 'arm64',
  platform: 'darwin',
  versions: { node: '24.11.0' }
}
const prefix = `photon-cli/${CLI_VERSION} (darwin; arm64) node/24.11.0 photon-api-ts/${SDK_VERSION}`

const requestUrl = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  input instanceof Request ? input.url : input.toString()

const recordingFetch = () => {
  const userAgents = new Map<string, string | null>()
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = requestUrl(input)
    userAgents.set(
      new URL(url).pathname,
      new Headers(init?.headers).get('user-agent')
    )
    if (url === `${apiOrigin}/.well-known/oauth-protected-resource`) {
      return Promise.resolve(
        Response.json({ authorization_servers: [issuer], resource: apiOrigin })
      )
    }
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Promise.resolve(
        Response.json({
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          issuer,
          token_endpoint: `${issuer}/oauth2/token`
        })
      )
    }
    if (url.startsWith(`${apiOrigin}/v1/organizations`)) {
      return Promise.resolve(
        Response.json({
          acquisitionQuestionnaireExempt: false,
          organizations: [organizationFixture()],
          ownedOrganizationIds: ['pho_org_00000000000000000000000001']
        })
      )
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })
  return { fetch, userAgents }
}

describe('agent detection', () => {
  test.each([
    [{}, undefined],
    [{ AI_AGENT: 'claude-code_2-1-284_agent' }, 'claude-code'],
    [{ AI_AGENT: 'claude-code/2.1.227' }, 'claude-code'],
    [{ AI_AGENT: 'github_copilot_vscode_agent' }, 'github-copilot'],
    [{ AI_AGENT: 'Cursor-CLI' }, 'cursor-cli'],
    [{ AI_AGENT: 'pi' }, 'pi'],
    [{ AI_AGENT: 'pipeline-bot' }, 'pipeline-bot'],
    [{ AI_AGENT: 'my-own-agent' }, 'my-own-agent'],
    [{ AI_AGENT: 'My_Agent v2.0!' }, 'my-agentv20'],
    [{ AI_AGENT: 'x\r\nX-Injected: 1' }, 'xx-injected1'],
    [{ AI_AGENT: '__acme_review_bot__' }, 'acme-review-bot'],
    [
      { AI_AGENT: 'acme-internal-review-agent-for-pull-requests' },
      'acme-internal-review-agent-for-p'
    ],
    [
      { AI_AGENT: 'acme-internal-review-agent-for--pull' },
      'acme-internal-review-agent-for'
    ],
    [{ AI_AGENT: '!!!' }, 'unknown'],
    [{ AI_AGENT: '_-_' }, 'unknown'],
    [{ AI_AGENT: 'my-own-agent', CLAUDECODE: '1' }, 'my-own-agent'],
    [{ AI_AGENT: 'false', CLAUDECODE: '1' }, 'claude-code'],
    [{ AI_AGENT: '0' }, undefined],
    [{ CLAUDECODE: '1' }, 'claude-code'],
    [{ AGENT: 'amp', CLAUDECODE: '1' }, 'amp'],
    [{ CLAUDE_CODE_IS_COWORK: '1', CLAUDECODE: '1' }, 'cowork'],
    [{ CODEX_THREAD_ID: 'thread_1' }, 'codex'],
    [{ GEMINI_CLI: '1' }, 'gemini-cli'],
    [{ CURSOR_EXTENSION_HOST_ROLE: 'agent-exec' }, 'cursor-cli'],
    [{ TERM_PROGRAM: 'kiro' }, 'kiro'],
    [{ PATH: `/usr/bin:${join(homedir(), '.pi', 'agent', 'bin')}` }, 'pi'],
    [{ CLAUDECODE: '' }, undefined]
  ])('%j names %s', (env, expected) => {
    expect(detectAgent(env)).toBe(expected)
  })

  test('every known agent name fits the header', () => {
    for (const { name } of KNOWN_AGENTS) {
      expect(name).toMatch(AGENT_NAME_PATTERN)
    }
  })
})

describe('User-Agent', () => {
  test('names the CLI, platform, runtime and SDK, and the agent only when detected', () => {
    expect(photonUserAgent({}, host)).toBe(prefix)
    expect(photonUserAgent({ CLAUDECODE: '1' }, host)).toBe(
      `${prefix} agent/claude-code`
    )
    expect(photonUserAgent({ AI_AGENT: 'Acme Review Bot/1.2' }, host)).toBe(
      `${prefix} agent/acmereviewbot12`
    )
    expect(photonUserAgent({ AI_AGENT: '???' }, host)).toBe(
      `${prefix} agent/unknown`
    )
    expect(
      photonUserAgent(
        {},
        { ...host, versions: { bun: '1.4.4', node: '24.3.0' } }
      )
    ).toBe(
      `photon-cli/${CLI_VERSION} (darwin; arm64) bun/1.4.4 photon-api-ts/${SDK_VERSION}`
    )
  })

  test('keeps a request whose headers cannot be read unchanged', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 }))
    )
    const init = { headers: [['bad header', 'value']] } as RequestInit

    await withUserAgent(fetch, 'photon-cli/1.0.0')(`${apiOrigin}/v1/x`, init)

    expect(fetch).toHaveBeenCalledWith(`${apiOrigin}/v1/x`, init)
  })

  test('labels SDK requests and the OAuth discovery calls that bypass the SDK', async () => {
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      apiOrigin
    )
    const { fetch, userAgents } = recordingFetch()
    const services = createPhotonCommandServices({
      baseUrl: apiOrigin,
      color: false,
      configDirectory,
      deviceScope: unusedDeviceScope(),
      env: { AI_AGENT: 'claude-code_2-1-284_agent' },
      fetch,
      json: true,
      now: () => TEST_NOW,
      platform: 'linux'
    })

    await services.organizations.list()
    await services.oauth.discoverAuthorizationServer()

    const expected = photonUserAgent({ CLAUDECODE: '1' })
    expect(expected).toMatch(CLAUDE_CODE_SUFFIX)
    expect(Object.fromEntries(userAgents)).toEqual({
      '/.well-known/oauth-authorization-server': expected,
      '/.well-known/oauth-protected-resource': expected,
      '/v1/organizations': expected
    })
  })

  test('shows the header in --debug output', async () => {
    const { configDirectory } = await createAuthenticatedConfig(
      'user_ada',
      apiOrigin
    )
    const { fetch } = recordingFetch()
    const stderr = collector()
    const stdout = collector()

    await runCli(['org', 'list', '--debug', '--json'], {
      baseUrl: apiOrigin,
      configDirectory,
      deviceScope: unusedDeviceScope(),
      env: {},
      fetch,
      now: () => TEST_NOW,
      platform: 'linux',
      stderr,
      stdout
    })

    const trace = JSON.parse(stderr.value()) as {
      debug: {
        http: { exchanges: { request: { headers: Record<string, string> } }[] }
      }
    }
    const userAgents = trace.debug.http.exchanges.map(
      ({ request }) => request.headers['user-agent']
    )
    expect(userAgents.length).toBeGreaterThan(0)
    expect(new Set(userAgents)).toEqual(new Set([photonUserAgent({})]))
  })
})
