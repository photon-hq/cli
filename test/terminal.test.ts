import { describe, expect, test } from 'vitest'
import {
  browserBlocker,
  canShowSpinner,
  canUseColor,
  isOn,
  promptBlocker
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
