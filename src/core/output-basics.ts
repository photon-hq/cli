// The output rules that need no other module, so bin.ts can follow them before
// it loads the CLI.

/** Where an error with no docs page of its own points: the CLI's error reference. */
export const CLI_ERROR_REFERENCE_URL =
  'https://photon.codes/docs/cli/output#errors'

// The last value given for a boolean flag, read the way the parser reads the
// command line: the first "--" ends the options, and everything after it is an
// operand even when it starts with a dash (POSIX Utility Syntax Guideline 10).
// The parser never takes "--" as an option's value ("--org -- x" fails with
// "Option '--org' requires a value"), so the first one always ends them.
// Reading past it printed "nosuchcommand -- --json" as a JSON error, while
// "whoami -- --json", which parses and then fails on the unexpected argument,
// printed as text.
export const lastFlagValue = (
  args: readonly string[],
  name: string,
  negatable = false
): boolean | undefined => {
  let value: boolean | undefined
  for (const arg of args) {
    if (arg === '--') {
      break
    }
    if (arg === `--${name}` || arg === `--${name}=true`) {
      value = true
    } else if (
      arg === `--${name}=false` ||
      (negatable && arg === `--no-${name}`)
    ) {
      value = false
    }
  }
  return value
}
