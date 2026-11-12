#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'

const UPSTREAM_REGISTRY = 'https://registry.npmjs.org'
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u
const TARBALL_PATTERN = /^\/(.+)\/-\/([^/]+\.tgz)$/u

const versionParts = (version) =>
  VERSION_PATTERN.exec(version)?.slice(1).map(Number) ?? [0, 0, 0]

const compareVersions = (left, right) => {
  const a = versionParts(left)
  const b = versionParts(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

const readPackages = (directory, origin) => {
  const packages = new Map()
  if (directory === undefined) {
    return packages
  }
  const files = readdirSync(directory).filter((name) => name.endsWith('.tgz'))
  for (const file of files) {
    const path = join(directory, file)
    const manifest = JSON.parse(
      execFileSync(tar, ['-xzOf', path, 'package/package.json'], {
        encoding: 'utf8'
      })
    )
    const contents = readFileSync(path)
    const entry = packages.get(manifest.name) ?? {
      files: new Map(),
      versions: {}
    }
    entry.files.set(file, path)
    entry.versions[manifest.version] = {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      dist: {
        integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
        shasum: createHash('sha1').update(contents).digest('hex'),
        tarball: `${origin}/${manifest.name}/-/${file}`
      }
    }
    packages.set(manifest.name, entry)
  }
  return packages
}

const packument = (name, entry) => {
  const newest = Object.keys(entry.versions).sort(compareVersions).at(-1)
  return {
    'dist-tags': { latest: newest, staging: newest },
    name,
    versions: entry.versions
  }
}

const sendFile = (response, path) => {
  if (path === undefined || !existsSync(path)) {
    response.writeHead(404).end('Not Found')
    return
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  createReadStream(path).pipe(response)
}

const proxy = async (request, response) => {
  const upstream = await fetch(`${UPSTREAM_REGISTRY}${request.url}`, {
    headers: { accept: request.headers.accept ?? 'application/json' }
  })
  response.writeHead(upstream.status, {
    'content-type':
      upstream.headers.get('content-type') ?? 'application/octet-stream'
  })
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

// Stands in for photon-hq/cli's GitHub releases and for the npm registry, so
// tests install this branch's own builds. "releases" holds a folder per tag
// and a "latest" file naming the tag GitHub marks latest. "packages" holds npm
// tarballs; every other package comes from the public registry.
export const startReleaseServer = async ({
  packages,
  releases,
  repository = 'photon-hq/cli'
}) => {
  let origin = ''
  let localPackages = new Map()
  const releasePrefix = `/${repository}/releases/`
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, origin).pathname)
    if (releases !== undefined && path === `${releasePrefix}latest`) {
      const tag = readFileSync(join(releases, 'latest'), 'utf8').trim()
      response
        .writeHead(302, { location: `${origin}${releasePrefix}tag/${tag}` })
        .end()
      return
    }
    if (
      releases !== undefined &&
      path.startsWith(`${releasePrefix}download/`)
    ) {
      const target = resolve(
        releases,
        path.slice(`${releasePrefix}download/`.length)
      )
      sendFile(
        response,
        target.startsWith(`${resolve(releases)}${sep}`) ? target : undefined
      )
      return
    }
    const tarball = TARBALL_PATTERN.exec(path)
    const local = localPackages.get(tarball?.[1] ?? path.slice(1))
    if (local !== undefined && tarball !== null) {
      sendFile(response, local.files.get(tarball[2]))
      return
    }
    if (local !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(packument(path.slice(1), local)))
      return
    }
    proxy(request, response).catch(() => {
      response.writeHead(502).end()
    })
  })
  await new Promise((listening) => {
    server.listen(0, '127.0.0.1', listening)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  localPackages = readPackages(packages, origin)
  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise((closed) => {
        server.close(closed)
      })
    },
    url: origin
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      packages: { type: 'string' },
      releases: { type: 'string' },
      repository: { type: 'string' },
      'url-file': { type: 'string' }
    }
  })
  const { url } = await startReleaseServer(values)
  if (values['url-file'] !== undefined) {
    await writeFile(values['url-file'], url)
  }
  console.log(`Release server listening on ${url}`)
}
