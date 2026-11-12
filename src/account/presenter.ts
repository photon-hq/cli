import type { GetAccountOutput } from '@photon-ai/api'
import type { CliOutput } from '../core/output.ts'
import { detail } from '../core/presenter.ts'

export const accountDetails = (
  output: CliOutput,
  account: GetAccountOutput
): string[] =>
  detail(output, 'Account', [
    { label: 'ID', value: account.accountId },
    { label: 'First name', value: account.firstName },
    { label: 'Last name', value: account.lastName },
    { label: 'Email', value: account.email },
    { label: 'Phone', value: account.phoneNumber },
    { label: 'Phone verified', value: account.phoneVerifiedAt },
    { label: 'Avatar', value: account.pictureUrl },
    { label: 'Created', value: account.createdAt },
    { label: 'Updated', value: account.updatedAt },
    { label: 'Deleted', value: account.deletedAt }
  ])
