import { deepStrictEqual } from 'node:assert/strict'
import type { Server } from 'node:http'
import { onTestFinished } from 'vitest'

export const captureApiVersions = (server: Server) => {
  const captured: {
    method: string | undefined
    url: string | undefined
    versions: string[]
  }[] = []
  server.on('request', ({ headersDistinct, method, url }) => {
    captured.push({
      method,
      url,
      versions: headersDistinct['photon-version'] ?? []
    })
  })
  return captured
}

export const expectPinnedApiRequests = (server: Server): void => {
  const captured = captureApiVersions(server)
  onTestFinished(() => {
    for (const { method, url, versions } of captured) {
      deepStrictEqual(
        versions,
        ['2026-07-01'],
        `${method ?? '?'} ${url ?? '?'}`
      )
    }
  })
}
