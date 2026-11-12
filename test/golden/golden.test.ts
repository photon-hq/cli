import { describe, expect, test } from 'vitest'
import { GOLDEN_CASES } from './cases.ts'
import {
  type FakeRoute,
  type GoldenCase,
  PLANTED,
  startFakeApi
} from './support.ts'

const JSON_LINE = /^\s*[[{]/mu

// How text output writes PLANTED out.
const INERT = '^[[31m\\u{202e}'
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u

type Path = readonly (number | string)[]

const stringPaths = (value: unknown, path: Path = []): Path[] => {
  if (typeof value === 'string') {
    return [path]
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      stringPaths(item, [...path, Array.isArray(value) ? Number(key) : key])
    )
  }
  return []
}

const withString = (
  value: unknown,
  [key, ...rest]: Path,
  update: (text: string) => string
): unknown => {
  if (key === undefined) {
    return update(value as string)
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      index === key ? withString(item, rest, update) : item
    )
  }
  const record = value as Record<string, unknown>
  return { ...record, [key]: withString(record[key], rest, update) }
}

const parses = (golden: GoldenCase, document: unknown): boolean => {
  try {
    golden.schema.parse(document)
    return true
  } catch {
    return false
  }
}

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (current, key) => (current as Record<number | string, unknown>)[key],
    value
  )

const without = (value: object, keys: readonly string[]): object =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key))
  )

interface HeldResponse {
  readonly at: Path
  readonly response: object
}

// The API responses the document holds unchanged, and where: the whole
// document, each key the case embeds one under, the document but the keys
// the CLI adds, when every other field is the response's own value, or
// nowhere.
const heldResponses = (golden: GoldenCase): HeldResponse[] => {
  const responses = golden.routes.flatMap(({ body }) =>
    body === undefined ? [] : [body]
  )
  const whole = responses.find((response) => response === golden.document)
  if (whole !== undefined) {
    return [{ at: [], response: whole }]
  }
  const { adds, embeds } = golden
  const document = golden.document as Record<string, unknown>
  if (embeds !== undefined) {
    return (typeof embeds === 'string' ? [embeds] : embeds).flatMap((key) => {
      const embedded = responses.find((response) => response === document[key])
      return embedded === undefined ? [] : [{ at: [key], response: embedded }]
    })
  }
  if (adds?.every((key) => key in document)) {
    const own = Object.keys(without(document, adds))
    const extended = responses.find((response) => {
      const fields = Object.entries(response)
      return (
        fields.length === own.length &&
        fields.every(
          ([key, value]) => own.includes(key) && document[key] === value
        )
      )
    })
    return extended === undefined ? [] : [{ at: [], response: extended }]
  }
  return []
}

const plant = (text: string): string => `a${PLANTED}${text}`

// The strings of a planted body that carry the planted characters.
const plantedStrings = (body: object): string[] =>
  stringPaths(body)
    .map((path) => valueAt(body, path))
    .filter(
      (value): value is string =>
        typeof value === 'string' && value.includes(PLANTED)
    )

// Requests in an order that doesn't depend on the order they arrived in.
const inAnyOrder = <Request>(requests: readonly Request[]): Request[] =>
  [...requests].sort((first, second) =>
    JSON.stringify(first).localeCompare(JSON.stringify(second))
  )

// A document the CLI builds from responses, with the planted characters in
// each string of those responses that reaches the document, where the
// document still parses with its schema.
const plantedBuilt = (
  golden: GoldenCase,
  { build, routes }: NonNullable<GoldenCase['builtFrom']>
): GoldenCase => {
  let bodies = routes.map(({ body }) => body)
  for (const [index, route] of routes.entries()) {
    for (const path of stringPaths(route.body)) {
      const candidate = bodies.map((body, at) =>
        at === index ? (withString(body, path, plant) as object) : body
      )
      const document = build(...candidate)
      const reaches =
        JSON.stringify(document) !== JSON.stringify(build(...bodies))
      if (reaches && parses(golden, document)) {
        bodies = candidate
      }
    }
  }
  const from: readonly FakeRoute[] = routes
  return {
    ...golden,
    document: build(...bodies),
    routes: golden.routes.map((candidate) => {
      const body = bodies[from.indexOf(candidate)]
      return body === undefined ? candidate : { ...candidate, body }
    })
  }
}

// The golden case with the planted characters in every string of the API's
// response in its document that the SDK's schema still accepts with them. A
// string the schema constrains (an enum, a timestamp, a URL) can't carry
// them: the SDK rejects that response before anything prints. The case's
// checked secret keeps its value too, since the CLI rejects one with them. A
// document the CLI builds gets none outside the response it holds or builds
// it from.
const plantedDocument = (golden: GoldenCase): GoldenCase => {
  if (golden.builtFrom !== undefined) {
    return plantedBuilt(golden, golden.builtFrom)
  }
  const held = heldResponses(golden)
  const document = held
    .flatMap(({ at, response }) => stringPaths(response, at))
    .filter((path) => path.join('.') !== golden.checkedSecret)
    .reduce<unknown>((current, path) => {
      const candidate = withString(current, path, plant)
      return parses(golden, candidate) ? candidate : current
    }, golden.document) as object
  return {
    ...golden,
    document,
    routes: golden.routes.map((route) => {
      const response = held.find((entry) => entry.response === route.body)
      if (response === undefined) {
        return route
      }
      return {
        ...route,
        body:
          golden.adds === undefined
            ? (valueAt(document, response.at) as object)
            : without(document, golden.adds)
      }
    })
  }
}

// The ID a case's plantedId names, as its route returns it.
const plantedIdValue = ({
  field,
  route
}: NonNullable<GoldenCase['plantedId']>) =>
  (route.body as Record<string, unknown>)[field]

// The routes with the planted characters in the ID the case's plantedId
// names, and that ID, planted and URL-encoded, in the paths after it.
const withPlantedId = (
  golden: GoldenCase,
  routes: readonly FakeRoute[]
): readonly FakeRoute[] => {
  if (golden.plantedId === undefined) {
    return routes
  }
  const { field } = golden.plantedId
  const index = golden.routes.indexOf(golden.plantedId.route)
  const id = plantedIdValue(golden.plantedId) as string
  const path = encodeURIComponent(plant(id))
  return routes.map((route, at) => {
    if (at === index) {
      return { ...route, body: { ...route.body, [field]: plant(id) } }
    }
    return at > index
      ? { ...route, path: route.path.replaceAll(id, path) }
      : route
  })
}

// The golden case with the planted characters in its document, the planted
// bodies of the responses whose strings go to stderr, and the planted ID its
// later requests carry.
const planted = (golden: GoldenCase): GoldenCase => {
  const plantedGolden = plantedDocument(golden)
  return {
    ...plantedGolden,
    routes: withPlantedId(
      golden,
      plantedGolden.routes.map((route) =>
        route.planted === undefined ? route : { ...route, body: route.planted }
      )
    )
  }
}

const runGolden = async (golden: GoldenCase, flag: '--json' | '--no-color') => {
  const api = await startFakeApi(golden.routes, golden.files, golden.journal)
  try {
    const result = await api.run(
      [...golden.command.split(' '), ...golden.args, flag],
      golden.stdin
    )
    return { ...result, requests: api.requests }
  } finally {
    await api.close()
  }
}

describe.each(GOLDEN_CASES)('$command', (golden) => {
  test('the document parses with its schema, unchanged', () => {
    expect(golden.schema.parse(golden.document)).toEqual(golden.document)
  })

  test('--json prints the document as the one JSON document on stdout', async () => {
    const result = await runGolden(golden, '--json')
    const expected = golden.routes.map(({ method, path, requestBody }) => ({
      body: requestBody,
      method,
      path
    }))
    const concurrent = golden.concurrent ?? 0

    expect(result.exitCodes, result.stdout + result.stderr).toEqual([])
    expect(JSON.parse(result.stdout)).toEqual(golden.document)
    expect(result.stderr).not.toMatch(JSON_LINE)
    expect(inAnyOrder(result.requests.slice(0, concurrent))).toEqual(
      inAnyOrder(expected.slice(0, concurrent))
    )
    expect(result.requests.slice(concurrent)).toEqual(
      expected.slice(concurrent)
    )
  })

  test('text output shows the response', async () => {
    const result = await runGolden(golden, '--no-color')

    expect(result.exitCodes, result.stdout + result.stderr).toEqual([])
    expect(result.stdout).toContain(golden.shows)
    expect(result.stdout).not.toMatch(JSON_LINE)
  })

  test('text output writes planted control characters out, and --json keeps them', async () => {
    if (golden.showsNoApiText === true) {
      const held =
        golden.builtFrom === undefined
          ? heldResponses(golden).map(({ response }) => response)
          : golden.builtFrom.routes.map(({ body }) => body)
      expect(
        golden.routes.every(
          ({ body, planted: plantedBody, unshown }) =>
            body === undefined ||
            held.includes(body) ||
            plantedBody !== undefined ||
            unshown === true
        ),
        'with showsNoApiText, every response with a body is the one the document holds or is built from, has a planted body, or is marked unshown'
      ).toBe(true)
    }
    if (golden.embeds !== undefined) {
      expect(
        heldResponses(golden).map(({ at }) => at),
        'embeds names the keys that each hold a response'
      ).toEqual(
        (typeof golden.embeds === 'string'
          ? [golden.embeds]
          : golden.embeds
        ).map((key) => [key])
      )
    }
    if (golden.adds !== undefined) {
      expect(
        heldResponses(golden).map(({ at }) => at),
        'adds names the keys the CLI adds beside a response'
      ).toEqual([[]])
    }
    const id =
      golden.plantedId === undefined
        ? undefined
        : plantedIdValue(golden.plantedId)
    if (golden.plantedId !== undefined) {
      const later = golden.routes.slice(
        golden.routes.indexOf(golden.plantedId.route) + 1
      )
      expect(
        golden.routes.includes(golden.plantedId.route) &&
          typeof id === 'string' &&
          later.some(({ path }) => path.includes(id)),
        'plantedId names a route of the case, and a string field of its body that a later path holds'
      ).toBe(true)
    }
    const plantedGolden = planted(golden)
    if (heldResponses(golden).length > 0) {
      expect(plantedGolden.document).not.toEqual(golden.document)
    }
    if (golden.builtFrom !== undefined && golden.showsNoApiText !== true) {
      for (const route of golden.builtFrom.routes) {
        expect(
          plantedGolden.routes[golden.routes.indexOf(route)]?.body,
          `the response to ${route.method} ${route.path} carries planted characters, so the document is built from it`
        ).not.toEqual(route.body)
      }
    }
    for (const { at } of heldResponses(golden)) {
      const [key] = at
      if (typeof key === 'string') {
        expect(
          (plantedGolden.document as Record<string, unknown>)[key],
          `the response under ${key} carries planted characters`
        ).not.toEqual((golden.document as Record<string, unknown>)[key])
      }
    }
    const text = await runGolden(plantedGolden, '--no-color')
    const json = await runGolden(plantedGolden, '--json')

    expect(text.exitCodes, text.stdout + text.stderr).toEqual([])
    expect(text.stdout.includes(INERT), text.stdout).toBe(
      golden.showsNoApiText !== true
    )
    expect(text.stdout.replaceAll('\n', '')).not.toMatch(CONTROL_OR_FORMAT)
    expect(text.stderr.replaceAll('\n', '')).not.toMatch(CONTROL_OR_FORMAT)
    expect(json.stderr.replaceAll('\n', '')).not.toMatch(CONTROL_OR_FORMAT)
    if (
      golden.routes.some(
        (route) => route.planted !== undefined && route.plantedOn === undefined
      )
    ) {
      expect(text.stderr).toContain(INERT)
      expect(json.stderr).toContain(INERT)
    }
    for (const route of golden.routes) {
      if (route.planted !== undefined && route.plantedOn === 'stdout') {
        for (const shown of plantedStrings(route.planted)) {
          expect(text.stdout).toContain(shown.replace(PLANTED, INERT))
        }
      }
    }
    if (id !== undefined) {
      expect(text.stdout).toContain(`a${INERT}${String(id)}`)
    }
    expect(json.exitCodes, json.stdout + json.stderr).toEqual([])
    expect(JSON.parse(json.stdout)).toEqual(plantedGolden.document)
  })
})
