import stringWidth from 'fast-string-width'
import type { ArgSchema, ArgToken } from 'gunshi'
import { kebabnize } from 'gunshi/utils'
import { CLI_NAME } from '../meta.ts'
import type { CliOutput, TextStyle } from './output.ts'

interface HumanCell {
  style?: TextStyle
  text: string
}

interface DetailEntry {
  label: string
  value: unknown
}

interface TableOptions {
  bordered?: boolean
}

const CONTROL_OR_FORMAT_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/gu
const C1_CONTROL_START = 0x80
const DELETE = 0x7f
const CARET_OFFSET = 0x40

// C0 and C1 controls in caret notation, as gh's asciisanitizer writes them
// (ESC and CSI both become ^[), DEL as ^?, and format characters as the
// escape Rust's escape_debug writes (\u{202e}). Tab, line feed and carriage
// return are written out too: in a table cell or a one-line message they
// would break the layout or overwrite the line.
const inertCharacter = (character: string): string => {
  const codePoint = character.codePointAt(0) ?? 0
  if (codePoint === DELETE) {
    return '^?'
  }
  if (codePoint < C1_CONTROL_START + 0x20) {
    return `^${String.fromCodePoint((codePoint % C1_CONTROL_START) + CARET_OFFSET)}`
  }
  return `\\u{${codePoint.toString(16)}}`
}

/**
 * A string from the API made safe for a terminal: every control and format
 * character is written out as visible text, so none can move the cursor,
 * change colors, break a line or reorder what follows. Every API string in
 * text output goes through this; JSON output keeps the string as it is.
 */
export const inert = (text: string): string =>
  text.replace(CONTROL_OR_FORMAT_CHARACTER_PATTERN, inertCharacter)

const WHITESPACE_PATTERN = /\s+/gu
const PARTIAL_ESCAPE_PATTERN = /(?:\^|\\(?:u(?:\{[\da-f]*)?)?)$/u

/**
 * An API string on one line: each run of whitespace, line breaks included,
 * becomes one space, and every other control and format character is written
 * out. A line longer than maximumLength is cut with an ellipsis after it is
 * written out, never inside an escape.
 */
export const inertLine = (
  text: string,
  maximumLength = Number.POSITIVE_INFINITY
): string => {
  const line = inert(text.replace(WHITESPACE_PATTERN, ' ').trim())
  if (line.length <= maximumLength) {
    return line
  }
  return `${line.slice(0, maximumLength - 1).replace(PARTIAL_ESCAPE_PATTERN, '')}…`
}

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? '—'
      : value.map((item) => inert(String(item))).join(', ')
  }
  if (typeof value === 'object') {
    return inert(JSON.stringify(value))
  }
  return inert(String(value))
}

const cellText = (cell: HumanCell | string): string =>
  inert(typeof cell === 'string' ? cell : cell.text)

const padToWidth = (value: string, width: number): string =>
  `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`

/**
 * Lines of a table. With no rows it is the empty message, or no lines when
 * there is none: a list command's empty message goes to stderr through
 * `presentList`.
 */
export const table = (
  output: CliOutput,
  headings: string[],
  rows: (HumanCell | string)[][],
  emptyMessage?: string,
  options: TableOptions = {}
): string[] => {
  if (rows.length === 0) {
    return emptyMessage === undefined ? [] : [output.style('dim', emptyMessage)]
  }
  const titles = headings.map(inert)
  const widths = titles.map((heading, column) =>
    Math.max(
      stringWidth(heading),
      ...rows.map((row) => stringWidth(cellText(row[column] ?? '')))
    )
  )
  const renderCell = (cell: HumanCell | string, width: number): string => {
    const text = padToWidth(cellText(cell), width)
    return typeof cell === 'string' || cell.style === undefined
      ? text
      : output.style(cell.style, text)
  }
  const unborderedWidth = (column: number): number =>
    column === titles.length - 1 ? 0 : (widths[column] ?? 0)
  const renderRow = (row: (HumanCell | string)[]): string =>
    row
      .map((cell, column) => renderCell(cell, unborderedWidth(column)))
      .join('  ')
      .trimEnd()

  if (options.bordered === true) {
    const border = (value: string): string => output.style('dim', value)
    const horizontal = (
      left: string,
      separator: string,
      right: string
    ): string =>
      border(
        `${left}${widths.map((width) => '─'.repeat(width + 2)).join(separator)}${right}`
      )
    const vertical = border('│')
    const renderBorderedRow = (
      row: (HumanCell | string)[],
      heading = false
    ): string =>
      `${vertical} ${row
        .map((cell, column) => {
          const rendered = renderCell(cell, widths[column] ?? 0)
          return heading ? output.style('bold', rendered) : rendered
        })
        .join(` ${vertical} `)} ${vertical}`

    return [
      horizontal('┌', '┬', '┐'),
      renderBorderedRow(titles, true),
      horizontal('├', '┼', '┤'),
      ...rows.map((row) => renderBorderedRow(row)),
      horizontal('└', '┴', '┘')
    ]
  }

  return [
    titles
      .map((heading, column) =>
        output.style('bold', padToWidth(heading, unborderedWidth(column)))
      )
      .join('  ')
      .trimEnd(),
    ...rows.map(renderRow)
  ]
}

export const detail = (
  output: CliOutput,
  heading: string,
  entries: DetailEntry[]
): string[] => {
  const labelWidth = entries.reduce(
    (width, { label }) => Math.max(width, label.length),
    0
  )
  return [
    output.style('bold', inert(heading)),
    ...entries.map(({ label, value }) => {
      const renderedLabel = output.style('dim', label.padEnd(labelWidth))
      return `${renderedLabel}  ${displayValue(value)}`
    })
  ]
}

const SHELL_SAFE_ARGUMENT = /^[\w@%+=:,./-]+$/u

export const shellArgument = (arg: string): string =>
  SHELL_SAFE_ARGUMENT.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`

/** The arguments a command was typed with, as Gunshi gives them to it. */
export interface TypedCommand {
  /** Every argument after the CLI's name, the command path first. */
  readonly _: readonly string[]
  readonly args: Readonly<Record<string, ArgSchema>>
  readonly commandPath: readonly string[]
  readonly tokens: readonly ArgToken[]
}

/**
 * The command as it was typed, ready to copy: its arguments in the order and
 * spelling typed, each quoted for the shell, without the options `without`
 * names (as `args` names them) and their values, and with `add` before any
 * `--`. `add` is written as it is, so it can hold a placeholder such as
 * `<resource-id>`. `rerunCommand`, by contrast, rebuilds a command from the
 * values it was run with.
 */
export const typedCommand = (
  command: TypedCommand,
  change: { readonly add?: string; readonly without?: readonly string[] } = {}
): string => {
  const omitted = new Set<number>()
  for (const token of command.tokens) {
    const name = change.without?.find(
      (option) => token.name === option || token.name === kebabnize(option)
    )
    if (token.kind !== 'option' || name === undefined) {
      continue
    }
    omitted.add(token.index)
    if (token.inlineValue !== true && command.args[name]?.type !== 'boolean') {
      omitted.add(token.index + 1)
    }
  }
  const words = command._.map((arg, index) =>
    omitted.has(index) ? undefined : shellArgument(arg)
  )
  if (change.add !== undefined) {
    const terminator = command.tokens.find(
      (token) => token.kind === 'option-terminator'
    )
    words.splice(terminator?.index ?? words.length, 0, change.add)
  }
  return [CLI_NAME, ...words.filter((word) => word !== undefined)].join(' ')
}

/** What a command was run with, as Gunshi gives it to the command. */
export interface CommandRun {
  readonly args: Readonly<Record<string, ArgSchema>>
  readonly commandPath: readonly string[]
  readonly explicit: Readonly<Record<string, boolean>>
  readonly toKebab?: boolean | undefined
  readonly values: Readonly<Record<string, unknown>>
}

/** The organization or project a command acted on. */
export type CommandScope =
  | { readonly org: string }
  | { readonly project: string }

export interface ListPage {
  readonly command: CommandRun
  /**
   * The document already holds the token, under the API's own name for it
   * (`nextCursor`, `listMetadata.after`). Otherwise it's added to the document
   * as `nextPageToken`, the API's name for it in every other list.
   */
  readonly inDocument?: true
  readonly scope?: CommandScope
  /** The API's token for the next page; undefined on the last page. */
  readonly token: string | undefined
}

export interface ListPresentation {
  /** The JSON document; the page token is added to it here, if it lacks it. */
  readonly document: object
  /** Said on stderr in text mode when `items` is empty. */
  readonly emptyMessage: string
  readonly items: readonly unknown[]
  /** The text-mode answer for stdout; none when there is nothing to show. */
  readonly lines: string[]
  readonly page?: ListPage
}

const PAGE_TOKEN_ARG = 'pageToken'

const scopeOption = (scope: CommandScope): ['org' | 'project', string] =>
  'org' in scope ? ['org', scope.org] : ['project', scope.project]

const optionArguments = (
  option: string,
  schema: ArgSchema,
  value: unknown
): string[] => {
  if (schema.type === 'boolean') {
    return [value === false ? `--no-${option}` : `--${option}`]
  }
  return (Array.isArray(value) ? value : [value]).flatMap((item) => {
    const text = String(item)
    return text.startsWith('-')
      ? [`--${option}=${text}`]
      : [`--${option}`, text]
  })
}

export interface Rerun {
  /** Arguments to add at the end, such as `--yes`. */
  readonly append: readonly string[]
  readonly scope?: CommandScope | undefined
  /** Options given to the command that are left out, by their names. */
  readonly without: readonly string[]
}

/**
 * The same command again, ready to copy: every option it was given except
 * those left out and a flag set to its default (`--json=false`), the
 * organization or project it acted on written in as --org or --project
 * whatever its source, and the added arguments.
 */
export const rerunCommand = (command: CommandRun, rerun: Rerun): string => {
  const { args, commandPath, explicit, toKebab, values } = command
  const scope = rerun.scope === undefined ? undefined : scopeOption(rerun.scope)
  const positionals: string[] = []
  const options: string[] = []
  for (const [name, schema] of Object.entries(args)) {
    if (explicit[name] !== true || rerun.without.includes(name)) {
      continue
    }
    if (name === scope?.[0]) {
      continue
    }
    if (
      schema.type === 'boolean' &&
      values[name] === (schema.default ?? false)
    ) {
      continue
    }
    if (schema.type === 'positional') {
      positionals.push(String(values[name]))
      continue
    }
    const option =
      toKebab === true || schema.toKebab === true ? kebabnize(name) : name
    options.push(...optionArguments(option, schema, values[name]))
  }
  return [
    CLI_NAME,
    ...commandPath,
    ...positionals,
    ...options,
    ...(scope === undefined ? [] : [`--${scope[0]}`, scope[1]]),
    ...rerun.append
  ]
    .map(shellArgument)
    .join(' ')
}

/**
 * The command for the next page: the same command with --page-token set to
 * the next page's token, without the options that conflict with it, whichever
 * side declares the conflict.
 */
const nextPageCommand = (page: ListPage, token: string): string => {
  const { args } = page.command
  const conflicting = Object.entries(args)
    .filter(([, schema]) => [schema.conflicts].flat().includes(PAGE_TOKEN_ARG))
    .map(([name]) => name)
  return rerunCommand(page.command, {
    append: ['--page-token', token],
    scope: page.scope,
    without: [
      PAGE_TOKEN_ARG,
      ...[args[PAGE_TOKEN_ARG]?.conflicts ?? []].flat(),
      ...conflicting
    ]
  })
}

/**
 * Writes a list command's result. JSON mode prints the document, with
 * `nextPageToken` when there is a next page. Text mode prints only the lines
 * on stdout; the empty message and the next page's command go to stderr.
 */
export const presentList = (
  output: CliOutput,
  list: ListPresentation
): void => {
  const token = list.page?.token
  output.success(
    token === undefined || list.page?.inDocument === true
      ? list.document
      : { ...list.document, nextPageToken: token },
    list.lines
  )
  if (list.items.length === 0) {
    output.notice(output.style('dim', list.emptyMessage, 'stderr'))
  }
  if (list.page !== undefined && token !== undefined) {
    output.notice(inert(`More results: ${nextPageCommand(list.page, token)}`))
  }
}
