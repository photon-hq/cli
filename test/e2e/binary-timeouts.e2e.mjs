import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { readBuildConfig } from '../../scripts/build-config.mjs'

// Runs the standalone binary that pnpm build:binary made against a local
// server. When the server stops answering, the way a lost response or a
// stalled network looks to the CLI, each attempt must end at the per-attempt
// limit, and the transport must retry with the same Idempotency-Key. When the
// server answers and the binary is stopped past that limit, the binary must
// still read the answer instead of retrying into a replay. A runner can't
// sleep, so test/network-errors.test.ts covers a limit that fires after a
// system sleep. The API's host has to resolve to this machine first: CI adds
// it to /etc/hosts.
const root = fileURLToPath(new URL('../../', import.meta.url))
// DEFAULT_REQUEST_TIMEOUT_MS in src/core/request.ts.
const PER_ATTEMPT_LIMIT_MS = 60_000
// The SDK's retry limit (maxAttempts in its transport).
const ATTEMPTS = 3
// How late an attempt may end on a busy runner. A stalled attempt ends much
// later, if ever.
const LATE_MS = 3000
// How long the paused case keeps the binary stopped: past the per-attempt
// limit.
const PAUSE_MS = 70_000
const ORGANIZATION = 'pho_org_01m82r1bszvw93zabcdefghjkm'
const SECRET = 'e2e-rotated-secret'
const UUID_PATTERN = /^[0-9a-f-]{36}$/u
// An account service key: the server below never checks it. Built at run time
// so no file holds a key-shaped literal.
const KEY = ['pho', 'ask', '01m82r1bszvw93zabcdefghjkm', 'e2e'].join('_')

const CASES = [
  {
    client: 'client_01M82R1BSZVW93ZABCDEFGHJKM',
    name: 'the server never answers',
    respond: () => undefined
  },
  {
    client: 'client_01M82R1BSZVW93ZABCDEFGHJKN',
    name: 'the server sends the headers, then stops',
    respond: (response) => {
      response.writeHead(200, {
        'content-length': '1000',
        'content-type': 'application/json'
      })
      response.write('{"previousSecretValidUntil":null,"value":"')
    }
  }
]

// Photon returns the plaintext only to the request that minted the secret, so
// a retry gets a replay with no value.
const PAUSED = {
  client: 'client_01M82R1BSZVW93ZABCDEFGHJKP',
  name: 'the binary is stopped after the server answers',
  respond: (response, { attempt, child }) => {
    if (attempt === 1) {
      child.kill('SIGSTOP')
      setTimeout(() => child.kill('SIGCONT'), PAUSE_MS).unref()
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        previousSecretValidUntil: null,
        value: attempt === 1 ? SECRET : null
      })
    )
  }
}

const config = await readBuildConfig('production')
const binary = join(root, 'dist', config.executableName)
const apiHost = new URL(config.apiOrigin).hostname
const attempts = new Map([...CASES, PAUSED].map(({ client }) => [client, []]))
const children = new Map()
let directory
let server

const run = (command, args, options, onSpawn) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    onSpawn(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr, stdout }))
  })

before(async () => {
  if (!existsSync(binary)) {
    throw new Error(`Build ${binary} first: pnpm build:binary`)
  }
  const { address } = await lookup(apiHost)
  if (!['127.0.0.1', '::1'].includes(address)) {
    throw new Error(
      `${apiHost} resolves to ${address}. Point it at this machine in /etc/hosts first.`
    )
  }
  directory = await mkdtemp(join(tmpdir(), 'photon-binary-timeouts-'))
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'key.pem'),
    '-out',
    join(directory, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    `/CN=${apiHost}`,
    '-addext',
    `subjectAltName=DNS:${apiHost}`
  ])
  server = createServer(
    {
      cert: await readFile(join(directory, 'cert.pem')),
      key: await readFile(join(directory, 'key.pem'))
    },
    (request, response) => {
      const testCase = [...CASES, PAUSED].find(({ client }) =>
        request.url?.includes(client)
      )
      if (testCase === undefined) {
        response.writeHead(404).end()
        return
      }
      const attempt = {
        endedAt: undefined,
        key: request.headers['idempotency-key'],
        startedAt: Date.now()
      }
      const caseAttempts = attempts.get(testCase.client) ?? []
      caseAttempts.push(attempt)
      const context = {
        attempt: caseAttempts.length,
        child: children.get(testCase.client)
      }
      request.socket.once('close', () => {
        attempt.endedAt = Date.now()
      })
      request.resume()
      request.once('end', () => testCase.respond(response, context))
    }
  )
  // Keeps an answered connection open until the binary closes it, so an
  // attempt's end in the log is the binary's, not this server's.
  server.keepAliveTimeout = 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '::', port: 443 }, resolve)
  })
})

// A binary still running when the tests end, stopped or not, would keep this
// process alive.
after(() => {
  for (const child of children.values()) {
    child.kill('SIGKILL')
  }
  server?.closeAllConnections()
  server?.close()
})

const runCase = async ({ client }) =>
  await run(
    binary,
    [
      'org',
      'oauth-client',
      'secret',
      'rotate',
      client,
      '--org',
      ORGANIZATION,
      '--json',
      '--yes'
    ],
    {
      env: {
        CI: 'true',
        HOME: directory,
        NO_COLOR: '1',
        NODE_EXTRA_CA_CERTS: join(directory, 'cert.pem'),
        PATH: process.env.PATH,
        [config.apiTokenVariable]: KEY,
        TMPDIR: directory
      }
    },
    (child) => children.set(client, child)
  )

const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(3)} s`

const logAttempts = (testCase) => {
  for (const [number, attempt] of (
    attempts.get(testCase.client) ?? []
  ).entries()) {
    console.log(
      `${testCase.name}, attempt ${number + 1}: Idempotency-Key ${attempt.key}, started ${new Date(attempt.startedAt).toISOString()}, ended ${attempt.endedAt === undefined ? 'never' : `${new Date(attempt.endedAt).toISOString()}, after ${seconds(attempt.endedAt - attempt.startedAt)}`}`
    )
  }
}

test('ends each attempt at the per-attempt limit and retries with the same Idempotency-Key', {
  timeout: 300_000
}, async () => {
  const results = await Promise.all(CASES.map(runCase))
  for (const [index, testCase] of CASES.entries()) {
    logAttempts(testCase)
    const caseAttempts = attempts.get(testCase.client) ?? []
    assert.equal(caseAttempts.length, ATTEMPTS, testCase.name)
    assert.match(caseAttempts[0]?.key ?? '', UUID_PATTERN)
    for (const attempt of caseAttempts) {
      assert.equal(attempt.key, caseAttempts[0]?.key, testCase.name)
      assert.notEqual(attempt.endedAt, undefined, testCase.name)
      const duration = attempt.endedAt - attempt.startedAt
      assert.ok(
        duration > PER_ATTEMPT_LIMIT_MS - LATE_MS &&
          duration < PER_ATTEMPT_LIMIT_MS + LATE_MS,
        `${testCase.name}: an attempt took ${seconds(duration)}`
      )
    }
    const result = results[index]
    assert.equal(result?.code, 1, result?.stderr)
    const { error } = JSON.parse(result?.stdout ?? '')
    assert.equal(error.code, 'API_CONNECTION_ERROR')
    assert.equal(error.transportCode, 'TimeoutError')
  }
})

test('reads an answer that arrived while the binary was stopped past the per-attempt limit', {
  timeout: 300_000
}, async () => {
  const result = await runCase(PAUSED)
  logAttempts(PAUSED)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(attempts.get(PAUSED.client)?.length, 1)
  assert.equal(JSON.parse(result.stdout).value, SECRET)
})
