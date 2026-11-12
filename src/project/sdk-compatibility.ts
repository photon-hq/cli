const IDEMPOTENCY_HEADER = 'Idempotency-Key'
const IF_MATCH_HEADER = 'if-match'
const GENERATED_HEADER_PROPERTIES = new Map([
  [IDEMPOTENCY_HEADER.toLowerCase(), IDEMPOTENCY_HEADER],
  [IF_MATCH_HEADER, IF_MATCH_HEADER]
])
let compatibilityInstalled = false

const mirrorGeneratedHeader = (
  headers: Headers,
  property: string,
  value: string
): void => {
  Object.defineProperty(headers, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

/**
 * The pinned SDK validates generated header objects after converting them to
 * `Headers`, then object-spreads that instance. Mirror generated required
 * headers as enumerable properties so SDK write validation can read them.
 * Network serialization still uses the native header collection.
 */
export const installPhotonSdkHeaderCompatibility = (): void => {
  if (compatibilityInstalled) {
    return
  }

  const nativeDelete = Headers.prototype.delete
  const nativeSet = Headers.prototype.set
  const NativeHeaders = Headers
  Object.defineProperty(Headers.prototype, 'delete', {
    configurable: true,
    enumerable: false,
    value(this: Headers, name: string): void {
      nativeDelete.call(this, name)
      const property = GENERATED_HEADER_PROPERTIES.get(name.toLowerCase())
      if (property !== undefined) {
        Reflect.deleteProperty(this, property)
      }
    },
    writable: true
  })
  Object.defineProperty(Headers.prototype, 'set', {
    configurable: true,
    enumerable: false,
    value(this: Headers, name: string, value: string): void {
      nativeSet.call(this, name, value)
      const property = GENERATED_HEADER_PROPERTIES.get(name.toLowerCase())
      if (property === undefined) {
        return
      }
      mirrorGeneratedHeader(this, property, value)
    },
    writable: true
  })
  globalThis.Headers = new Proxy(NativeHeaders, {
    construct(Target, argumentsList) {
      const headers = Reflect.construct(
        Target,
        argumentsList,
        Target
      ) as Headers
      for (const [header, property] of GENERATED_HEADER_PROPERTIES) {
        const value = headers.get(header)
        if (value !== null) {
          mirrorGeneratedHeader(headers, property, value)
        }
      }
      return headers
    }
  })
  compatibilityInstalled = true
}
