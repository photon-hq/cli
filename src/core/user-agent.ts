import { CLI_VERSION, SDK_VERSION } from '../meta.ts'

type Environment = Readonly<Record<string, string | undefined>>

interface KnownAgent {
  detect?: (env: Environment) => boolean
  name: string
}

export interface UserAgentHost {
  arch: string
  platform: string
  versions: Readonly<Record<string, string | undefined>>
}

const isSet =
  (...names: string[]) =>
  (env: Environment): boolean =>
    names.some((name) => (env[name] ?? '') !== '')

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { detect: (env) => env.AGENT === 'amp', name: 'amp' },
  {
    detect: isSet('CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID'),
    name: 'codex'
  },
  { detect: isSet('GEMINI_CLI'), name: 'gemini-cli' },
  { detect: isSet('COPILOT_CLI'), name: 'copilot-cli' },
  { detect: isSet('OPENCODE'), name: 'opencode' },
  { detect: isSet('ANTIGRAVITY_AGENT'), name: 'antigravity' },
  { detect: isSet('AUGMENT_AGENT'), name: 'augment-cli' },
  { detect: isSet('REPL_ID'), name: 'replit' },
  { detect: isSet('CLAUDE_CODE_IS_COWORK'), name: 'cowork' },
  { detect: isSet('CLAUDECODE', 'CLAUDE_CODE'), name: 'claude-code' },
  { detect: isSet('CURSOR_TRACE_ID'), name: 'cursor' },
  {
    detect: (env) =>
      isSet('CURSOR_AGENT')(env) ||
      env.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec',
    name: 'cursor-cli'
  },
  { detect: (env) => env.TERM_PROGRAM === 'kiro', name: 'kiro' },
  {
    detect: (env) =>
      (env.PATH ?? '').includes('/.pi/agent') ||
      (env.PATH ?? '').includes('\\.pi\\agent'),
    name: 'pi'
  },
  { detect: isSet('GOOSE_PROVIDER'), name: 'goose' },
  { name: 'crush' },
  { name: 'github-copilot' },
  { name: 'hermes-agent' },
  { name: 'openhands' }
]

export const UNKNOWN_AGENT = 'unknown'

const AGENT_NAME_PATTERN = /^[a-z0-9-]{1,32}$/u
const ALPHANUMERIC_PATTERN = /[a-z0-9]/u
const OUTSIDE_AGENT_NAME_PATTERN = /[^a-z0-9-]/gu
const EDGE_HYPHENS_PATTERN = /^-+|-+$/gu
const MAX_AGENT_NAME_LENGTH = 32
const NOT_AN_AGENT = new Set(['0', 'false', 'no', 'off'])

const agentsByLongestName = [...KNOWN_AGENTS].sort(
  (left, right) => right.name.length - left.name.length
)

const agentFromAiAgent = (value: string): string => {
  const normalized = value.toLowerCase().replaceAll('_', '-')
  const agent = agentsByLongestName.find(
    ({ name }) =>
      normalized.startsWith(name) &&
      !ALPHANUMERIC_PATTERN.test(normalized.charAt(name.length))
  )
  if (agent !== undefined) {
    return agent.name
  }
  const trimHyphens = (name: string): string =>
    name.replace(EDGE_HYPHENS_PATTERN, '')
  const cleaned = trimHyphens(
    trimHyphens(normalized.replace(OUTSIDE_AGENT_NAME_PATTERN, '')).slice(
      0,
      MAX_AGENT_NAME_LENGTH
    )
  )
  return cleaned === '' ? UNKNOWN_AGENT : cleaned
}

export const detectAgent = (env: Environment): string | undefined => {
  const aiAgent = (env.AI_AGENT ?? '').trim()
  const name =
    aiAgent === '' || NOT_AN_AGENT.has(aiAgent.toLowerCase())
      ? KNOWN_AGENTS.find(({ detect }) => detect?.(env) === true)?.name
      : agentFromAiAgent(aiAgent)
  return name !== undefined && AGENT_NAME_PATTERN.test(name) ? name : undefined
}

const runtime = (versions: UserAgentHost['versions']): string =>
  versions.bun === undefined ? `node/${versions.node}` : `bun/${versions.bun}`

export const photonUserAgent = (
  env: Environment,
  host: UserAgentHost = process
): string => {
  let agent: string | undefined
  try {
    agent = detectAgent(env)
  } catch {
    agent = undefined
  }
  return [
    `photon-cli/${CLI_VERSION}`,
    `(${host.platform}; ${host.arch})`,
    runtime(host.versions),
    `photon-api-ts/${SDK_VERSION}`,
    ...(agent === undefined ? [] : [`agent/${agent}`])
  ].join(' ')
}

export const withUserAgent =
  (
    fetchImplementation: typeof globalThis.fetch,
    userAgent: string
  ): typeof globalThis.fetch =>
  async (input, init) => {
    let headers: Headers
    try {
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      headers.set('user-agent', userAgent)
    } catch {
      return await fetchImplementation(input, init)
    }
    return await fetchImplementation(input, { ...init, headers })
  }
