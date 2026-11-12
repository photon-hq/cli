import { mkdir, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { AuthRepository } from '../../src/auth/storage/repository.ts'
import { runCli } from '../../src/main.ts'
import { OperationRepository } from '../../src/operation/repository.ts'
import type { OperationRecord } from '../../src/operation/types.ts'
import { PHOTON_PACKAGE } from '../../src/update/release.ts'
import {
  type CliInvocation,
  collector,
  createAuthenticatedConfig,
  instantPollClock,
  TEST_NOW
} from '../project-test-support.ts'

/**
 * An SDK output type as the SDK declares it: the index signature a loose
 * object adds is left out, at every depth. A fixture typed with
 * `satisfies Declared<Output>` stops compiling when an SDK update removes a
 * field it uses or changes that field's type.
 */
export type Declared<Output> = Output extends readonly (infer Item)[]
  ? Declared<Item>[]
  : Output extends object
    ? {
        [Key in keyof Output as string extends Key
          ? never
          : number extends Key
            ? never
            : Key]: Declared<Output[Key]>
      }
    : Output

/**
 * A field the API sends that the SDK doesn't declare yet, as a newer API
 * would. The CLI prints it like any other field.
 */
export const NEW_API_FIELD = { addedByNewerApi: 'not in this SDK yet' }

/** The value with NEW_API_FIELD added, as a newer API would send it. */
export const withNewField = <Value extends object>(
  value: Value
): Value & typeof NEW_API_FIELD => ({ ...value, ...NEW_API_FIELD })

/**
 * The folder the CLI runs in. A case writes it in arguments and documents;
 * the fake API puts in the real folder's path, and writes it back as this in
 * what the CLI prints.
 */
export const CWD = '[CWD]'

/**
 * The API origin the CLI calls. A case writes it in documents, files and
 * response bodies; the fake API puts in its own origin, and writes it back as
 * this in what the CLI prints.
 */
export const API = '[API]'

/** An escape sequence and a right-to-left override, for the planted test. */
export const PLANTED = '\u001b[31m\u202e'

/**
 * A storage provider the API hands out presigned upload URLs for. The CLI
 * uploads only to https URLs, so the fake API answers for this origin too:
 * the CLI's fetch sends its requests to the fake API, path unchanged.
 */
export const STORAGE_ORIGIN = 'https://storage.golden.test'

/**
 * The package registry the CLI asks for its newest version. The fake API
 * answers for it too, path unchanged, as it does for the storage provider.
 */
export const REGISTRY_ORIGIN = new URL(PHOTON_PACKAGE.registry).origin

/**
 * A local operation record, as the CLI writes it to the journal of the
 * signed-in account at the API it calls. The fake API fills in that API
 * origin and account.
 */
export type JournalRecord = OperationRecord extends infer Item
  ? Item extends OperationRecord
    ? Omit<Item, 'apiOrigin' | 'identityId'>
    : never
  : never

/**
 * The random bytes the CLI gets on its nth call for them in a golden run: n,
 * size times. Each run starts again at 1, so every run makes the same values.
 */
export const goldenRandomBytes = (call: number, size: number): Buffer =>
  Buffer.alloc(size, call)

export interface FakeRoute {
  /**
   * The JSON body the fake API answers with, or none for a 204. In it, API
   * stands for the fake API's origin.
   */
  readonly body?: object
  /** Response headers the fake API adds, such as an ETag. */
  readonly headers?: Readonly<Record<string, string>>
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'
  /** The path and query string the command requests. */
  readonly path: string
  /**
   * For a response whose strings the command writes to stderr: the same body
   * with PLANTED in the strings it writes there. The planted test answers
   * with this body, and expects stderr to write the characters out.
   */
  readonly planted?: object
  /**
   * Set for a planted body whose strings text output writes to stdout
   * instead: a response the document doesn't hold or build from, whose
   * strings text output shows. The planted test expects stdout in text mode
   * to write out each string the planted body plants.
   */
  readonly plantedOn?: 'stdout'
  /**
   * The JSON body the command sends, for a request that has one. A form the
   * command posts reads as its fields, with each file as its file name.
   */
  readonly requestBody?: object
  readonly status?: number
  /**
   * A response the command reads but whose strings its text never shows; the
   * planted test doesn't plant in it.
   */
  readonly unshown?: true
}

export interface GoldenCase {
  /**
   * The top-level keys a document the CLI builds adds beside every field of
   * one route's response, each the response's own value. The planted test
   * plants its characters in that response and adds these keys back.
   */
  readonly adds?: readonly string[]
  /** The arguments after the command path. */
  readonly args: readonly string[]
  /**
   * For a document the CLI builds from the responses of one or more routes:
   * those routes, and how the CLI builds the document from their responses,
   * taken in the same order. The planted test plants its characters in each
   * string of those responses that reaches the document, where the document
   * still parses with its schema, and expects the document built from the
   * planted responses. Unless showsNoApiText is set, it expects each of the
   * responses to carry planted characters, so a route listed here that the
   * document isn't built from fails.
   */
  readonly builtFrom?: {
    readonly build: (...responses: object[]) => object
    readonly routes: readonly (FakeRoute & { readonly body: object })[]
  }
  /**
   * The top-level key of the document that holds a secret the CLI checks
   * before it prints, rejecting one with control characters. The planted test
   * leaves it as it is.
   */
  readonly checkedSecret?: string
  /** The command path, as the registry names it. */
  readonly command: string
  /**
   * The number of requests at the start that the command sends at once, so
   * they reach the API in any order. The --json test expects the first that
   * many requests to be those routes' requests, each exactly once, in any
   * order, and every request after them in order.
   */
  readonly concurrent?: number
  /** What --json prints. */
  readonly document: object
  /**
   * The top-level key of a document the CLI builds that holds one route's
   * response unchanged, or several keys that each hold one. The planted test
   * plants its characters in each of those responses.
   */
  readonly embeds?: string | readonly string[]
  /**
   * Files the command reads, written to the folder it runs in first. In a
   * file given as text, API stands for the fake API's origin.
   */
  readonly files?: Readonly<Record<string, string | Uint8Array>>
  /** Local operations the journal holds before the command runs. */
  readonly journal?: readonly JournalRecord[]
  /**
   * For a command that sends later requests to an ID one of its routes
   * returns: that route, and the field of its body that holds the ID. The
   * planted test plants its characters in that field too, puts the planted
   * ID, URL-encoded, in place of the ID in the path of each route after it,
   * and expects text output to write the planted ID out. A command that
   * drops, changes or double-encodes the ID gets a 404.
   */
  readonly plantedId?: {
    readonly field: string
    readonly route: FakeRoute & { readonly body: object }
  }
  /** Every request the command sends, in order, and the API's answer. */
  readonly routes: readonly FakeRoute[]
  /**
   * The public SDK's output schema for the document, or, for a document the
   * CLI defines, a schema beside the case. Where the CLI checks a string
   * before it prints it, the schema checks it the same way.
   */
  readonly schema: { parse: (value: unknown) => unknown }
  /** A value text output shows. */
  readonly shows: string
  /**
   * Set when text output shows no string from the API that could carry
   * control characters: the API answers with no body, or text shows only the
   * command's own words, values from its command line or standard input,
   * values whose schema rejects planted characters (an enum, a number, a
   * checked format) and the checked secret. Every response of such a case
   * that has a body is the one its document holds or is built from, has a
   * planted body, or is marked unshown. The planted test plants its
   * characters in each of them but the unshown ones and expects none in text
   * output's stdout, so a response whose strings text could show can't skip
   * the planted test.
   */
  readonly showsNoApiText?: true
  /** What the command reads from standard input, which isn't a terminal. */
  readonly stdin?: string
}

/**
 * A command that makes one API call and prints that call's response body
 * exactly as the API sent it.
 */
export const printsResponse = ({
  route,
  ...golden
}: Omit<GoldenCase, 'document' | 'routes'> & {
  readonly route: FakeRoute & { readonly body: object }
}): GoldenCase => ({ ...golden, document: route.body, routes: [route] })

/**
 * A command that prints a document it builds from the responses of the
 * routes `from`, each one of `routes`. `build` takes their bodies in the
 * order `from` lists them.
 */
export const buildsDocument = <const Bodies extends readonly object[]>({
  build,
  from,
  ...golden
}: Omit<GoldenCase, 'builtFrom' | 'document'> & {
  readonly build: (...responses: Bodies) => object
  readonly from: {
    readonly [Index in keyof Bodies]: FakeRoute & {
      readonly body: Bodies[Index]
    }
  }
}): GoldenCase => ({
  ...golden,
  builtFrom: {
    build: build as unknown as (...responses: object[]) => object,
    routes: from
  },
  document: build(...(from.map(({ body }) => body) as unknown as Bodies))
})

export interface RecordedRequest {
  readonly body: unknown
  readonly method: string
  readonly path: string
}

export interface FakeApi {
  readonly close: () => Promise<void>
  readonly requests: RecordedRequest[]
  readonly run: (
    args: readonly string[],
    stdin?: string
  ) => Promise<CliInvocation>
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks)
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.startsWith('multipart/form-data')) {
    const form = await new Response(body, {
      headers: { 'content-type': contentType }
    }).formData()
    return Object.fromEntries(
      [...form].map(([name, value]) => [
        name,
        typeof value === 'string' ? value : value.name
      ])
    )
  }
  return body.length === 0 ? undefined : JSON.parse(body.toString('utf8'))
}

// The CLI's fetch, with requests to the storage provider and the package
// registry sent to the fake API.
const routedFetch =
  (origin: string): typeof globalThis.fetch =>
  async (input, init) => {
    const url = input instanceof Request ? undefined : new URL(input)
    return await globalThis.fetch(
      url?.origin === STORAGE_ORIGIN || url?.origin === REGISTRY_ORIGIN
        ? new URL(`${url.pathname}${url.search}`, origin)
        : input,
      init
    )
  }

// Answers with the body as JSON, with the fake API's origin in place of API.
const writeJson = (
  response: ServerResponse,
  origin: string,
  status: number,
  body: object | undefined,
  headers: Readonly<Record<string, string>> = {}
): void => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'req_golden',
    ...headers
  })
  response.end(
    body === undefined
      ? undefined
      : JSON.stringify(body).replaceAll(API, origin)
  )
}

/**
 * A Photon API on localhost that answers each request with the first route
 * for it that hasn't answered yet and records every request, and a signed-in
 * CLI that calls it, in a folder that holds the given files, with the given
 * local operations in its journal. A request no route is left for gets a 404.
 * The CLI's browser opens nothing, and its random bytes are
 * goldenRandomBytes'.
 */
export const startFakeApi = async (
  routes: readonly FakeRoute[],
  files: Readonly<Record<string, string | Uint8Array>> = {},
  journal: readonly JournalRecord[] = []
): Promise<FakeApi> => {
  const requests: RecordedRequest[] = []
  const answered = new Set<FakeRoute>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const method = request.method ?? 'GET'
    const path = `${url.pathname}${url.search}`
    requests.push({ body: await readBody(request), method, path })
    const route = routes.find(
      (candidate) =>
        !answered.has(candidate) &&
        candidate.method === method &&
        candidate.path === path
    )
    if (route === undefined) {
      writeJson(response, origin, 404, { code: 'NOT_FOUND', status: 404 })
      return
    }
    answered.add(route)
    writeJson(response, origin, route.status ?? 200, route.body, route.headers)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`
  const authenticated = await createAuthenticatedConfig('user_ada', origin)
  const cwd = authenticated.configDirectory
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      const path = join(cwd, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        typeof contents === 'string'
          ? contents.replaceAll(API, origin)
          : contents
      )
    })
  )
  if (journal.length > 0) {
    const operations = new OperationRepository({
      apiOrigin: origin,
      authRepository: new AuthRepository({
        apiOrigin: origin,
        configDirectory: cwd,
        platform: 'linux'
      }),
      now: () => TEST_NOW
    })
    const { identityId } = await operations.identity()
    for (const record of journal) {
      // biome-ignore lint/performance/noAwaitInLoops: the journal takes one write at a time, as the CLI writes it.
      await operations.create({
        ...record,
        apiOrigin: origin,
        identityId
      } satisfies OperationRecord)
    }
  }
  const withCwd = (text: string): string =>
    text
      .replaceAll(JSON.stringify(cwd).slice(1, -1), CWD)
      .replaceAll(cwd, CWD)
      .replaceAll(origin, API)
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await authenticated.remove()
    },
    requests,
    run: async (args, stdin) => {
      const stderr = collector()
      const stdout = collector()
      const exitCodes: number[] = []
      let randomCalls = 0
      await runCli(
        args.map((arg) => arg.replaceAll(CWD, cwd)),
        {
          baseUrl: origin,
          browserLauncher: async () => undefined,
          clock: instantPollClock(),
          configDirectory: cwd,
          cwd,
          env: {},
          fetch: routedFetch(origin),
          now: () => TEST_NOW,
          platform: 'linux',
          randomBytes: (size) => {
            randomCalls += 1
            return goldenRandomBytes(randomCalls, size)
          },
          setExitCode: (exitCode) => exitCodes.push(exitCode),
          stderr,
          ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) }),
          stdout
        }
      )
      return {
        exitCodes,
        stderr: withCwd(stderr.value()),
        stdout: withCwd(stdout.value())
      }
    }
  }
}
