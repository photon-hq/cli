export const paginationArgs = {
  limit: {
    default: 30,
    description: 'Maximum number of records to return',
    type: 'number'
  },
  pageToken: {
    description: 'Start listing from this pagination token',
    toKebab: true,
    type: 'string'
  }
} as const

export const projectFilterArgs = {
  createdAfter: {
    description: 'Only include projects created at or after this timestamp',
    toKebab: true,
    type: 'string'
  },
  createdBefore: {
    description: 'Only include projects created before this timestamp',
    toKebab: true,
    type: 'string'
  },
  search: {
    description: 'Search project names',
    type: 'string'
  }
} as const
