import { describe, expect, test } from 'vitest'
import {
  browserBlocker,
  canShowSpinner,
  canUseColor,
  isOn,
  promptBlocker,
  terminalBlocker
} from '../src/core/terminal.ts'

const terminal = {
  clearLine: () => true,
  cursorTo: () => true,
  isTTY: true,
  moveCursor: () => true
}
const pipe = { isTTY: false }
const terminals = { stderr: terminal, stdin: terminal, stdout: terminal }
const asked = { env: {}, json: false, noInput: false }

describe('isOn', () => {
  test.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['False', false],
    ['1', true],
    ['true', true],
    ['yes', true]
  ])('%j is %s', (value, on) => {
    expect(isOn(value)).toBe(on)
  })
})

describe('promptBlocker', () => {
  test('lets the CLI ask when all three streams are terminals and nothing says not to', () => {
    expect(promptBlocker(terminals, asked)).toBeUndefined()
    expect(
      promptBlocker(terminals, {
        ...asked,
        env: { CI: 'false', PHOTON_NO_INPUT: '0' }
      })
    ).toBeUndefined()
  })

  test.each([
    ['--json is set', terminals, { ...asked, json: true }],
    ['--no-input is set', terminals, { ...asked, noInput: true }],
    [
      'PHOTON_NO_INPUT is set',
      terminals,
      { ...asked, env: { PHOTON_NO_INPUT: '1' } }
    ],
    ['CI is set', terminals, { ...asked, env: { CI: 'true' } }],
    ['standard input is not a terminal', { ...terminals, stdin: pipe }, asked],
    [
      'standard output is not a terminal',
      { ...terminals, stdout: pipe },
      asked
    ],
    ['standard error is not a terminal', { ...terminals, stderr: pipe }, asked]
  ])('says "%s"', (reason, streams, options) => {
    expect(promptBlocker(streams, options)).toBe(reason)
  })

  test('names the first reason when there are several', () => {
    expect(
      promptBlocker(
        { stderr: pipe, stdin: pipe, stdout: pipe },
        { env: { CI: '1', PHOTON_NO_INPUT: '1' }, json: true, noInput: true }
      )
    ).toBe('--json is set')
  })
})

describe('promptBlocker when an AI agent runs the command', () => {
  const agentReason = (agent: string): string =>
    `an AI agent is running this command (${agent})`

  test.each([
    [{ AI_AGENT: 'codex' }, 'codex'],
    [{ AI_AGENT: 'claude-code_2-1-284_agent' }, 'claude-code'],
    [{ AI_AGENT: 'github_copilot_vscode_agent' }, 'github-copilot'],
    [{ AI_AGENT: 'opencode', OPENCODE: '1' }, 'opencode'],
    [{ AI_AGENT: '!!!' }, 'unknown'],
    [{ CLAUDE_CODE_CHILD_SESSION: '1' }, 'claude-code'],
    [{ CODEX_CI: '1' }, 'codex'],
    [{ CODEX_THREAD_ID: 'thread_1' }, 'codex'],
    [{ GEMINI_CLI: '1' }, 'gemini-cli'],
    [{ OPENCODE: '1' }, 'opencode'],
    [{ CURSOR_AGENT: '1' }, 'cursor'],
    [{ COPILOT_AGENT: '1' }, 'github-copilot'],
    [{ CLINE_ACTIVE: 'true' }, 'cline'],
    [{ ROO_ACTIVE: 'true' }, 'roo-code'],
    [{ AGENT: 'goose' }, 'goose'],
    [{ AI_AGENT: 'off', GEMINI_CLI: '1' }, 'gemini-cli'],
    [{ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' }, 'claude-code']
  ])('blocks at a terminal with %j, naming %s', (env, agent) => {
    expect(promptBlocker(terminals, { ...asked, env })).toBe(agentReason(agent))
  })

  test.each([
    { CLAUDECODE: '1' },
    { CURSOR_TRACE_ID: 'trace_1' },
    { REPL_ID: 'repl_1' },
    { GOOSE_PROVIDER: 'openai' },
    { TERM_PROGRAM: 'kiro' },
    { AGENT: '1' },
    { AI_AGENT: '' },
    { AI_AGENT: ' ' },
    { AI_AGENT: '0' },
    { AI_AGENT: 'false' },
    { AI_AGENT: 'No' },
    { AI_AGENT: 'OFF' },
    { CODEX_CI: '', GEMINI_CLI: '' },
    { PHOTON_AGENT: 'yes' }
  ])('lets the CLI ask at a terminal with only %j', (env) => {
    expect(promptBlocker(terminals, { ...asked, env })).toBeUndefined()
  })

  test.each(['no', 'NO', ' no ', '0', 'false', 'False', 'off', ' OFF '])(
    'PHOTON_AGENT=%j lifts the agent reason',
    (value) => {
      expect(
        promptBlocker(terminals, {
          ...asked,
          env: { AI_AGENT: 'codex', CODEX_CI: '1', PHOTON_AGENT: value }
        })
      ).toBeUndefined()
    }
  )

  test.each(['', ' ', 'yes', 'YES', '1', 'true', 'on', 'nope'])(
    'PHOTON_AGENT=%j leaves the agent reason',
    (value) => {
      expect(
        promptBlocker(terminals, {
          ...asked,
          env: { CODEX_CI: '1', PHOTON_AGENT: value }
        })
      ).toBe(agentReason('codex'))
    }
  )

  test.each([
    ['--json is set', terminals, { ...asked, json: true }],
    ['--no-input is set', terminals, { ...asked, noInput: true }],
    [
      'PHOTON_NO_INPUT is set',
      terminals,
      { ...asked, env: { PHOTON_NO_INPUT: '1' } }
    ],
    ['CI is set', terminals, { ...asked, env: { CI: 'true' } }],
    ['standard input is not a terminal', { ...terminals, stdin: pipe }, asked],
    [
      'standard output is not a terminal',
      { ...terminals, stdout: pipe },
      asked
    ],
    ['standard error is not a terminal', { ...terminals, stderr: pipe }, asked]
  ])('PHOTON_AGENT=no still blocks: "%s"', (reason, streams, options) => {
    expect(
      promptBlocker(streams, {
        ...options,
        env: { ...options.env, AI_AGENT: 'codex', PHOTON_AGENT: 'no' }
      })
    ).toBe(reason)
  })

  test('leaves terminalBlocker, which output for a person follows, to the other reasons', () => {
    expect(
      terminalBlocker(terminals, {
        ...asked,
        env: { AI_AGENT: 'codex', CODEX_CI: '1' }
      })
    ).toBeUndefined()
    expect(
      terminalBlocker(
        { ...terminals, stdout: pipe },
        { ...asked, env: { CODEX_CI: '1' } }
      )
    ).toBe('standard output is not a terminal')
    expect(
      terminalBlocker(terminals, { ...asked, env: { CI: '1', CODEX_CI: '1' } })
    ).toBe('CI is set')
  })

  test('names the reason a run already had before the agent', () => {
    expect(
      promptBlocker(
        { ...terminals, stdin: pipe },
        { ...asked, env: { CODEX_CI: '1' } }
      )
    ).toBe('standard input is not a terminal')
    expect(
      promptBlocker(terminals, {
        ...asked,
        env: { AI_AGENT: 'codex', CI: '1' }
      })
    ).toBe('CI is set')
    expect(
      promptBlocker(terminals, {
        ...asked,
        env: { AI_AGENT: 'codex', CODEX_CI: '1' },
        json: true
      })
    ).toBe('--json is set')
  })
})

describe('browserBlocker', () => {
  test.each([
    [{}, false, undefined],
    [{ CI: 'false' }, false, undefined],
    [{ CI: '0' }, false, undefined],
    [{ CI: 'true' }, false, 'CI is set'],
    [{}, true, '--no-browser is set'],
    [{ CI: 'true' }, true, '--no-browser is set']
  ])('env %j with --no-browser %s gives %j', (env, noBrowser, reason) => {
    expect(browserBlocker({ env, noBrowser })).toBe(reason)
  })
})

describe('canShowSpinner', () => {
  const streams = { stderr: terminal, stdout: terminal }

  test('animates when standard output and error are terminals, whatever standard input is', () => {
    expect(canShowSpinner(streams, { env: {}, json: false })).toBe(true)
  })

  test.each([
    ['--json', streams, { env: {}, json: true }],
    ['CI', streams, { env: { CI: '1' }, json: false }],
    ['TERM=dumb', streams, { env: { TERM: 'dumb' }, json: false }],
    [
      'a redirected stdout',
      { ...streams, stdout: pipe },
      { env: {}, json: false }
    ],
    [
      'a redirected stderr',
      { ...streams, stderr: pipe },
      { env: {}, json: false }
    ],
    [
      'a stderr that cannot move its cursor',
      { ...streams, stderr: { isTTY: true } },
      { env: {}, json: false }
    ]
  ])('does not animate with %s', (_case, spinnerStreams, options) => {
    expect(canShowSpinner(spinnerStreams, options)).toBe(false)
  })
})

describe('canUseColor', () => {
  test.each([
    ['a terminal', terminal, { env: {}, json: false }, true],
    ['a pipe', pipe, { env: {}, json: false }, false],
    ['--json', terminal, { env: {}, json: true }, false],
    ['--no-color', terminal, { color: false, env: {}, json: false }, false],
    ['NO_COLOR=1', terminal, { env: { NO_COLOR: '1' }, json: false }, false],
    [
      'an empty NO_COLOR',
      terminal,
      { env: { NO_COLOR: '' }, json: false },
      true
    ],
    [
      '--color and NO_COLOR=1',
      terminal,
      { colorExplicit: true, env: { NO_COLOR: '1' }, json: false },
      true
    ],
    [
      '--color and TERM=dumb',
      terminal,
      { colorExplicit: true, env: { TERM: 'dumb' }, json: false },
      false
    ],
    [
      'FORCE_COLOR=1 on a pipe',
      pipe,
      { env: { FORCE_COLOR: '1' }, json: false },
      true
    ],
    [
      'FORCE_COLOR=0 on a terminal',
      terminal,
      { env: { FORCE_COLOR: '0' }, json: false },
      false
    ]
  ])('with %s is %s', (_case, stream, options, color) => {
    expect(canUseColor(stream, options)).toBe(color)
  })
})
