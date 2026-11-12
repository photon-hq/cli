import type { ApiError } from '@photon-ai/api'
import type {
  CliErrorOptions,
  CliIssue,
  NextStep,
  ProblemDetails
} from './errors.ts'
import {
  isSensitiveKey,
  redactCredentials,
  redactDiagnosticText,
  sanitizeJsonValue
} from './http-debug.ts'

interface ApiProblemBody {
  code?: string
  detail?: string
  issues: CliIssue[]
  problemType?: string
  reason?: string
  remediation?: NextStep
  title?: string
}

const MAXIMUM_CODE_LENGTH = 128
const MAXIMUM_DETAIL_LENGTH = 4096
const MAXIMUM_ISSUES = 50
const MAXIMUM_ISSUE_TEXT_LENGTH = 1024
const MAXIMUM_TITLE_LENGTH = 256
const MAXIMUM_URL_LENGTH = 2048
const CREDENTIAL_QUERY_NAMES = new Set(['jwt', 'key', 'sig'])
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u
const SAFE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u
const SAFE_PROBLEM_PROTOCOLS = new Set(['about:', 'http:', 'https:', 'urn:'])
const WEB_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u

const cleanText = (
  value: unknown,
  maximumLength: number
): string | undefined => {
  if (typeof value !== 'string') {
    return
  }
  const normalized = redactDiagnosticText(value).replace(/\s+/gu, ' ').trim()
  return normalized.length === 0
    ? undefined
    : normalized.slice(0, maximumLength)
}

const safeCode = (value: unknown): string | undefined => {
  const code = cleanText(value, MAXIMUM_CODE_LENGTH)
  return code !== undefined && SAFE_CODE_PATTERN.test(code) ? code : undefined
}

const safeUrl = (
  value: unknown,
  protocols: ReadonlySet<string>
): string | undefined => {
  const url = cleanText(value, MAXIMUM_URL_LENGTH)
  if (url === undefined) {
    return
  }
  try {
    const parsed = new URL(url)
    return parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      protocols.has(parsed.protocol)
      ? url
      : undefined
  } catch {
    // Invalid URLs are ignored rather than exposed verbatim.
  }
}

// A remediation link is a page to open, so it keeps the query and fragment
// that cleanText would drop. A link that carries a credential isn't shown.
const remediationUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return
  }
  try {
    const url = new URL(value)
    const decoded = decodeURIComponent(url.href)
    return WEB_PROTOCOLS.has(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.href.length <= MAXIMUM_URL_LENGTH &&
      ![...url.searchParams.keys()].some(
        (name) =>
          CREDENTIAL_QUERY_NAMES.has(name.toLowerCase()) || isSensitiveKey(name)
      ) &&
      redactCredentials(decoded) === decoded
      ? url.href
      : undefined
  } catch {
    // Invalid URLs are ignored rather than exposed verbatim.
  }
}

const safeReason = (value: unknown): string | undefined => {
  const reason = cleanText(value, 128)
  return reason !== undefined && SAFE_REASON_PATTERN.test(reason)
    ? reason
    : undefined
}

/**
 * The problem's `remediation` as a step: its action sentence, with a link
 * when the fix works only in a browser (an `href` and no request) or when
 * the action has a documentation page. A fix sent as a method and path is
 * shown as its sentence; turning it into a command is milestone 2's.
 */
const remediationStep = (value: unknown): NextStep | undefined => {
  if (typeof value !== 'object' || value === null || !('action' in value)) {
    return
  }
  const description = cleanText(value.action, MAXIMUM_ISSUE_TEXT_LENGTH)
  if (description === undefined) {
    return
  }
  const browserOnly = 'href' in value && !('method' in value)
  const url =
    (browserOnly ? remediationUrl(value.href) : undefined) ??
    ('documentation' in value ? remediationUrl(value.documentation) : undefined)
  const person = 'person' in value && value.person === true
  return {
    description,
    ...(person ? { person: true } : {}),
    ...(url === undefined ? {} : { url })
  }
}

const issuePath = (value: unknown): (number | string)[] | undefined => {
  if (Array.isArray(value)) {
    if (value.length > 32) {
      return
    }
    const path: (number | string)[] = []
    for (const part of value) {
      if (typeof part === 'number' && Number.isSafeInteger(part)) {
        path.push(part)
        continue
      }
      const textPart = cleanText(part, MAXIMUM_ISSUE_TEXT_LENGTH)
      if (textPart === undefined) {
        return
      }
      path.push(textPart)
    }
    return path
  }
  const path = cleanText(value, MAXIMUM_ISSUE_TEXT_LENGTH)
  return path === undefined ? undefined : [path]
}

const apiIssues = (value: unknown): CliIssue[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const issues: CliIssue[] = []
  for (const candidate of value.slice(0, MAXIMUM_ISSUES)) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue
    }
    const message =
      'message' in candidate
        ? cleanText(candidate.message, MAXIMUM_ISSUE_TEXT_LENGTH)
        : undefined
    if (message === undefined) {
      continue
    }
    const code = 'code' in candidate ? safeCode(candidate.code) : undefined
    const path = 'path' in candidate ? issuePath(candidate.path) : undefined
    issues.push({
      message,
      ...(code === undefined ? {} : { code }),
      ...(path === undefined ? {} : { path })
    })
  }
  return issues
}

export const parseApiProblem = (error: ApiError): ApiProblemBody => {
  const { body } = error
  if (typeof body !== 'object' || body === null) {
    return { issues: [] }
  }
  const code = 'code' in body ? safeCode(body.code) : undefined
  const detail =
    'detail' in body ? cleanText(body.detail, MAXIMUM_DETAIL_LENGTH) : undefined
  const problemType =
    'type' in body ? safeUrl(body.type, SAFE_PROBLEM_PROTOCOLS) : undefined
  const reason = 'reason' in body ? safeReason(body.reason) : undefined
  const remediation =
    'remediation' in body ? remediationStep(body.remediation) : undefined
  const title =
    'title' in body ? cleanText(body.title, MAXIMUM_TITLE_LENGTH) : undefined
  const issues = 'issues' in body ? apiIssues(body.issues) : []
  return {
    issues,
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
    ...(problemType === undefined ? {} : { problemType }),
    ...(reason === undefined ? {} : { reason }),
    ...(remediation === undefined ? {} : { remediation }),
    ...(title === undefined ? {} : { title })
  }
}

/**
 * The API's problem as the error's `problem`, after the redaction every
 * diagnostic gets. A response that isn't a problem object keeps its status,
 * and a sensitive request keeps only the fields that can't echo its input.
 */
const problemDetails = (
  error: ApiError,
  problem: ApiProblemBody,
  sensitive: boolean
): ProblemDetails => {
  if (sensitive) {
    return {
      ...(problem.problemType === undefined
        ? {}
        : { type: problem.problemType }),
      ...(problem.code === undefined ? {} : { code: problem.code }),
      ...(problem.reason === undefined ? {} : { reason: problem.reason }),
      status: error.status
    }
  }
  const { body } = error
  const sanitized =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? sanitizeJsonValue(body)
      : undefined
  if (
    typeof sanitized !== 'object' ||
    sanitized === null ||
    Array.isArray(sanitized)
  ) {
    return { status: error.status }
  }
  return 'status' in sanitized
    ? sanitized
    : { ...sanitized, status: error.status }
}

const retryAfterSeconds = (error: ApiError): number | undefined => {
  const value = error.headers.get('retry-after')
  if (value === null) {
    return
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) {
    return
  }
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

export const isRetryableApiError = (
  error: ApiError,
  problem: ApiProblemBody = parseApiProblem(error)
): boolean => {
  if (problem.code === 'UPSTREAM_UNAVAILABLE') {
    return false
  }
  return (
    error.status === 408 ||
    error.status === 429 ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504 ||
    problem.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
  )
}

export const safeRequestId = (value: string | undefined): string | undefined =>
  value !== undefined &&
  SAFE_REQUEST_ID_PATTERN.test(value) &&
  redactDiagnosticText(value) === value
    ? value
    : undefined

const environmentKeyAnswers = new WeakSet<ApiError>()

/**
 * Records that Photon gave this answer to a request sent with the key from the
 * environment, so the error built from it says so.
 */
export const markEnvironmentKeyAnswer = (error: ApiError): void => {
  environmentKeyAnswers.add(error)
}

export const apiErrorOptions = (
  error: ApiError,
  sensitive = false
): CliErrorOptions => {
  const problem = parseApiProblem(error)
  const requestId = safeRequestId(error.requestId)
  const retryAfter = retryAfterSeconds(error)
  const safeDetail = problem.detail ?? problem.title
  return {
    ...(sensitive ? {} : { cause: error }),
    debugSafe: !sensitive,
    httpStatus: error.status,
    retryable: isRetryableApiError(error, problem),
    ...(environmentKeyAnswers.has(error) ? { sentEnvironmentKey: true } : {}),
    ...(sensitive || safeDetail === undefined ? {} : { detail: safeDetail }),
    ...(sensitive || problem.issues.length === 0
      ? {}
      : { issues: problem.issues }),
    ...(problem.remediation === undefined
      ? {}
      : { next: [problem.remediation] }),
    problem: problemDetails(error, problem, sensitive),
    ...(problem.problemType === undefined
      ? {}
      : { problemType: problem.problemType }),
    ...(problem.reason === undefined ? {} : { reason: problem.reason }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter })
  }
}

export const transportCode = (error: unknown): string | undefined => {
  const visited = new Set<unknown>()
  let current = error
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current)
    if ('code' in current && typeof current.code === 'string') {
      return current.code
    }
    // A timeout is a DOMException, whose code is a legacy number.
    if (current instanceof DOMException && current.name === 'TimeoutError') {
      return current.name
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return error instanceof Error ? error.name : undefined
}
