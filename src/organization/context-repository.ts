import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  atomicWritePrivateFile,
  readPrivateFile,
  safeUnlink
} from '../auth/storage/atomic-file.ts'
import { CliError } from '../core/errors.ts'
import { ID_FORMATS } from '../core/photon-id.ts'
import { CLI_NAME } from '../meta.ts'

const ORGANIZATION_CONTEXT_SCHEMA_VERSION = 1

const organizationContextSchema = z.strictObject({
  apiOrigin: z.url(),
  identityId: z.string().min(1),
  organizationId: z
    .string()
    .regex(
      ID_FORMATS.organization.pattern,
      'Organization ID must be a canonical pho_org_ identifier.'
    ),
  schemaVersion: z.literal(ORGANIZATION_CONTEXT_SCHEMA_VERSION),
  selectedAt: z.iso.datetime()
})

export type StoredOrganizationContext = z.infer<
  typeof organizationContextSchema
>

interface OrganizationContextRepositoryOptions {
  apiOrigin: string
  configDirectory: string
}

const storageError = (cause: unknown): CliError =>
  new CliError(
    'ORGANIZATION_CONTEXT_UNAVAILABLE',
    'Photon could not access the active organization context.',
    { cause }
  )

const corruptContextError = (cause: unknown): CliError =>
  new CliError(
    'ORGANIZATION_CONTEXT_CORRUPT',
    `The active organization context is malformed. Run ${CLI_NAME} org clear, or ${CLI_NAME} org use <organization-id> to select it again.`,
    { cause }
  )

const invalidContextError = (cause: unknown): CliError =>
  new CliError(
    'ARGUMENT_VALIDATION',
    'The active organization context contains invalid input.',
    { cause, exitCode: 2 }
  )

const serialize = (value: StoredOrganizationContext): string =>
  `${JSON.stringify(value, undefined, 2)}\n`

export class OrganizationContextRepository {
  readonly #apiOrigin: string
  readonly #contextDirectory: string

  constructor(options: OrganizationContextRepositoryOptions) {
    this.#apiOrigin = options.apiOrigin
    this.#contextDirectory = join(
      options.configDirectory,
      'organization-contexts'
    )
  }

  async clear(identityId: string): Promise<boolean> {
    try {
      return await safeUnlink(this.#path(identityId))
    } catch (error) {
      throw storageError(error)
    }
  }

  async load(
    identityId: string
  ): Promise<StoredOrganizationContext | undefined> {
    let serialized: string | undefined
    try {
      serialized = await readPrivateFile(this.#path(identityId))
    } catch (error) {
      throw storageError(error)
    }
    if (serialized === undefined) {
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(serialized) as unknown
    } catch (error) {
      throw corruptContextError(error)
    }
    const result = organizationContextSchema.safeParse(parsed)
    if (!result.success) {
      throw corruptContextError(result.error)
    }
    if (
      result.data.apiOrigin !== this.#apiOrigin ||
      result.data.identityId !== identityId
    ) {
      throw corruptContextError(
        new Error('The stored context identity does not match its path.')
      )
    }
    return result.data
  }

  async save(
    identityId: string,
    organizationId: string,
    selectedAt: string
  ): Promise<StoredOrganizationContext> {
    let context: StoredOrganizationContext
    try {
      context = organizationContextSchema.parse({
        apiOrigin: this.#apiOrigin,
        identityId,
        organizationId,
        schemaVersion: ORGANIZATION_CONTEXT_SCHEMA_VERSION,
        selectedAt
      })
    } catch (error) {
      throw invalidContextError(error)
    }
    try {
      await atomicWritePrivateFile(this.#path(identityId), serialize(context))
    } catch (error) {
      throw storageError(error)
    }
    return context
  }

  #path(identityId: string): string {
    const digest = createHash('sha256')
      .update(`${this.#apiOrigin}\0${identityId}`)
      .digest('hex')
    return join(this.#contextDirectory, `${digest}.json`)
  }
}
