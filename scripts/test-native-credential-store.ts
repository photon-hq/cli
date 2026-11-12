import { randomUUID } from 'node:crypto'
import {
  defaultSecureBackendKind,
  KeychainCredentialBackend,
  SecretServiceCredentialBackend
} from '../src/auth/storage/backends.ts'

const main = async (): Promise<void> => {
  const kind = defaultSecureBackendKind(process.platform)
  const locator = `credential-store-canary:${randomUUID()}`
  const backend =
    kind === 'secret-service'
      ? new SecretServiceCredentialBackend(locator)
      : new KeychainCredentialBackend(locator)
  const canary = `photon-cli-canary:${randomUUID()}`

  await backend.probe()
  try {
    await backend.write(canary)
    const stored = await backend.read()
    if (stored !== canary) {
      throw new Error('The native credential store returned the wrong value.')
    }
  } finally {
    await backend.delete().catch(() => false)
  }

  if ((await backend.read()) !== undefined) {
    throw new Error('The native credential store did not delete the canary.')
  }

  process.stdout.write(`Native ${kind} integration passed.\n`)
}

await main()
