import { describe, expect, test } from 'vitest'
import { installPhotonSdkHeaderCompatibility } from '../src/project/sdk-compatibility.ts'

describe('project SDK header compatibility', () => {
  test('keeps prototype methods hidden and removes deleted mirrors', () => {
    installPhotonSdkHeaderCompatibility()
    const headers = new Headers()

    expect(
      Object.getOwnPropertyDescriptor(Headers.prototype, 'set')?.enumerable
    ).toBe(false)
    headers.set('idempotency-key', 'request-key')
    headers.set('If-Match', '"version"')
    expect(Object.hasOwn(headers, 'Idempotency-Key')).toBe(true)
    expect(Object.hasOwn(headers, 'if-match')).toBe(true)

    const copied = new Headers(headers)
    expect({ ...copied }).toMatchObject({
      'Idempotency-Key': 'request-key',
      'if-match': '"version"'
    })

    headers.delete('IDEMPOTENCY-KEY')
    headers.delete('IF-MATCH')

    expect(headers.has('idempotency-key')).toBe(false)
    expect(headers.has('if-match')).toBe(false)
    expect(Object.hasOwn(headers, 'Idempotency-Key')).toBe(false)
    expect(Object.hasOwn(headers, 'if-match')).toBe(false)
  })
})
