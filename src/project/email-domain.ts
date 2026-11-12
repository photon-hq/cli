import { z } from 'zod'

const cnameRecordSchema = z.object({
  name: z.string().min(1),
  type: z.literal('CNAME'),
  value: z.string().min(1)
})

const mxRecordSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().min(0).max(65_535),
  type: z.literal('MX'),
  value: z.string().min(1)
})

const txtRecordSchema = z.object({
  name: z.string().min(1),
  type: z.literal('TXT'),
  value: z.string().min(1)
})

const emailDomainDnsRecordSchema = z.discriminatedUnion('type', [
  cnameRecordSchema,
  mxRecordSchema,
  txtRecordSchema
])

const emailDomainVerificationSnapshotSchema = z.object({
  dkimReady: z.boolean(),
  dnsReady: z.boolean(),
  identityReady: z.boolean(),
  lastCheckedAt: z.iso.datetime(),
  mailFromReady: z.boolean()
})

const emailDomainAutomaticSetupSchema = z.object({
  applyUrl: z
    .string()
    .max(8192)
    .pipe(
      z.url().refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          url.username.length === 0 &&
          url.password.length === 0 &&
          url.hash.length === 0
        )
      })
    ),
  dnsProviderId: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/u),
  providerDisplayName: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => value === value.trim())
})

const emailDomainOperationDetailSchema = z.object({
  automaticSetup: emailDomainAutomaticSetupSchema.optional(),
  dnsRecords: z.array(emailDomainDnsRecordSchema).length(6),
  verification: emailDomainVerificationSnapshotSchema.optional()
})

export type EmailDomainAutomaticSetup = z.infer<
  typeof emailDomainAutomaticSetupSchema
>
export type EmailDomainDnsRecord = z.infer<typeof emailDomainDnsRecordSchema>
export type EmailDomainVerificationSnapshot = z.infer<
  typeof emailDomainVerificationSnapshotSchema
>

export type EmailDomainOperationDetailSelection =
  | { status: 'absent' }
  | { status: 'invalid' }
  | {
      automaticSetup?: EmailDomainAutomaticSetup
      records: EmailDomainDnsRecord[]
      status: 'present'
      verification?: EmailDomainVerificationSnapshot
    }

export const selectEmailDomainOperationDetail = (
  detail: Record<string, unknown> | undefined
): EmailDomainOperationDetailSelection => {
  if (detail?.dnsRecords === undefined) {
    return { status: 'absent' }
  }
  const parsed = emailDomainOperationDetailSchema.safeParse(detail)
  return parsed.success
    ? {
        ...(parsed.data.automaticSetup === undefined
          ? {}
          : { automaticSetup: parsed.data.automaticSetup }),
        records: parsed.data.dnsRecords,
        status: 'present',
        ...(parsed.data.verification === undefined
          ? {}
          : { verification: parsed.data.verification })
      }
    : { status: 'invalid' }
}
