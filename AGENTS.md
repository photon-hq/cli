# Photon CLI

This is the guide for coding agents in this repository. Claude Code reads it
through the root `CLAUDE.md`. The Ultracite code standards after this section
apply too.

## What the CLI is

Photon 2.0's command-line client, built on [Gunshi](https://gunshi.dev/). One
code base builds two targets, set in `config/cli.production.json` and
`config/cli.staging.json` (`config/README.md` has the full table):

| | Production (the default) | Staging (internal) |
| --- | --- | --- |
| SDK | `@photon-ai/api` | The internal SDK, from GitHub Packages |
| API | `https://api.photon.codes` | The staging API, `apiOrigin` in `config/cli.staging.json` |
| npm package | `@photon-ai/cli`, not yet published from this repository | `@photon-hq/cli-staging`, on GitHub Packages |
| Commands | `photon` and `pho` | `photon-staging` |

3.0.0 will be published as `@photon-ai/cli` on npm's `latest` tag, from the
public repository `photon-hq/cli`, which each release exports this repository
to (`scripts/export/README.md`).

Source always imports the SDK as `@photon-ai/api`. `package.json` installs
that name as the internal SDK (an npm alias), and the public SDK as
`@photon-ai/api-public`. Production builds and `pnpm cli` swap in the public
one (`scripts/build-config.mjs`, `scripts/public-sdk.mjs`). `pnpm test` and
`pnpm cli:staging` run the staging target, and `pnpm test:production` runs
the tests on the production target.

## Layout

- Commands: each group is `src/commands/<group>/definition.ts`, which declares
  the command, its description and its options (`args`), and `run.ts` beside
  it, which holds the handler. Subcommands nest the same way, for example
  `src/commands/project/api-key/`. Handlers load lazily: through
  `lazyWithTypes` in each `definition.ts`, and through
  `src/commands/index.ts` for `login`, `logout` and `whoami`.
  `src/commands/registry.ts` lists the top-level commands for the CLI and the
  docs exporter.
- To add an option to an existing command, add it to `args` in its
  `definition.ts`, read it from `context.values` in `run.ts`, and test it in
  the command's `test/<area>-cli.test.ts`. If the command changes something,
  also check the intent it records in `src/operation/types.ts`. Update the
  command's guide in photon-hq/docs (see `docs/README.md`).
- Options several commands share are in `src/commands/args.ts`. The global
  options (`--json`, `--debug`, `--no-color`, `--org`, `--project`) are in
  `src/app/global-options.ts`.
- `src/app/plugin.ts` and `src/app/services.ts` build the services each
  command gets as `context.extensions.photon`, normalize errors and set the
  exit code.
- `src/core/` holds output (`output.ts`, `presenter.ts`), errors and exit
  codes (`errors.ts`, `api-problem.ts`, `sdk-error.ts`), polling
  (`poll.ts`), input checks (`validation.ts`, `input.ts`) and HTTP debug
  output (`http-debug.ts`).
- There is one service per API area, wrapping the SDK: `@photon-ai/api` in
  production builds, the internal SDK in staging builds. They are
  `service.ts` in `src/account/`, `src/oauth/`, `src/organization/` and
  `src/project/` (with `src/project/voice-service.ts`), with `presenter.ts`
  and, where an area needs one, `validation.ts` beside them. Sign-in and
  stored credentials are in `src/auth/` (`lifecycle-service.ts`,
  `device-flow.ts`, `token-manager.ts`, `storage/`).
- `src/operation/` is the local operation journal. Commands that change
  something record their intent there, so `photon operation` can inspect or
  replay them.
- `src/internal/` holds the internal-only commands (MFA, 10DLC, Call Registry
  and developer telemetry), whose operations `@photon-ai/api` doesn't have
  yet. Only staging builds include them, through the `#internal` import;
  production builds get `src/app/no-internal.ts`. Their tests are in
  `test/internal/`.
- `src/commands/moved.ts` keeps the old names of commands that moved to
  another group. Such a name only prints the new one and exits with code 2.
  The old names that still run (`project use`, `project clear` and
  `project create --use`, for `link`, `unlink` and `--link`) stay beside the
  new ones, hidden from help and the docs (Gunshi's `internal: true` on a
  command, which has nothing to do with the staging-only `#internal`
  commands, and `hidden: true` on an option), and print `renamedWarning` on
  stderr first.
  `src/commands/legacy.ts` points Photon CLI 1.0 commands back to 1.0.
- `src/commands/beta.ts` labels beta commands (`beta()`), and
  `test/beta.test.ts` lists them.
- The user guides live in photon-hq/docs under `cli/`, not in this repository
  (`docs/README.md` says how they and the command reference are published). A
  change that changes what a guide says comes with a photon-hq/docs pull
  request. `scripts/export-docs.ts` exports the command reference. Internal
  notes go in `notes/`.

## Commands

- `pnpm install` installs the dependencies. The internal SDK comes from GitHub
  Packages, so `NODE_AUTH_TOKEN` must hold a token that can read
  `photon-hq` packages, for example `export NODE_AUTH_TOKEN="$(gh auth token)"`.
  Never write the token into `.npmrc`.
- `pnpm cli <args>` runs the production target from source, for example
  `pnpm cli project api-key create --help`. Don't put `--` before the
  arguments: pnpm passes it on, and the CLI reads it as the end of the options
  (`pnpm cli -- --version` fails with "Command not found: --version").
  `pnpm cli:staging <args>` runs the staging target, with the internal-only
  commands.
- `pnpm check` runs what CI's `test` job runs before its smoke tests: the
  build config check, lint (Ultracite), both type checks, the tests on both
  targets, the release-rule tests, and the staging and production builds. The
  second type check (`tsconfig.public.json`) fails when code outside
  `src/internal/` uses an operation the public SDK doesn't have.
- `pnpm test` runs the Vitest suite on the staging target, and
  `pnpm test:production` on the production target.
  `pnpm test test/api-key-cli.test.ts` runs one file. `pnpm check:fix` applies Ultracite's fixes.
- `pnpm docs:reference` writes the command reference to
  `artifacts/docs-reference.json`, which a release attaches for the docs
  repository.

## Tests

The tests use Vitest against fake APIs: nothing calls the real Photon API.
`pnpm test` runs the staging target (`vitest.config.ts` sets the
`photon-internal` condition). `pnpm test:production` runs the production
target (`vitest.production.config.ts`), without `test/internal/`, as the
exported public repository can.

- A test that needs `src/internal/` or the staging configuration skips on
  production: `skip(!stagingTarget)` from the test context, or
  `describe.runIf(stagingTarget)` (`test/target-support.ts`).
- The export stops on staging hosts, internal names and key-shaped strings in
  any exported file, and CI dry-runs it on every pull request
  (`scripts/export/README.md`). Tests take hosts, names and
  origins from `BUILD_CONFIG`, and build key-shaped data with `photonKey`
  (`test/key-support.ts`). A test that must name a staging-only value (a
  staging host, the internal SDK) goes in `test/internal/`, which the export
  leaves out, as `test/internal/staging-target.test.ts` and the staging
  build's help snapshot (`test/internal/__snapshots__/help.staging.txt`) do.

- `test/<area>-cli.test.ts` runs the command line through `runCli`
  (`src/main.ts`) with fake service scopes (`vi.fn`) and a temporary
  signed-in config. The helpers are in `test/project-test-support.ts`
  (`cliInvoker`, `createAuthenticatedConfig`, `asProjectScope`,
  `collector`).
- `test/<area>-sdk-integration.test.ts` runs the real SDK against a local
  `node:http` server.
- `test/internal-boundary.test.ts` fails when public code imports
  `src/internal/`, or when a production bundle contains it.

## Rules for agents

- Work on a branch from `main`, and open a pull request. Run `pnpm check`
  before pushing.
- Never publish packages, push tags or create releases.
- Never run commands against production or use real credentials unless the
  issue says to. The one exception is the GitHub Packages token that
  `pnpm install` needs (`NODE_AUTH_TOKEN`). `pnpm cli` is the production target,
  so a command that calls the API from it reaches `https://api.photon.codes`.
- Never print or commit secrets.
- Milestone 1 fixes existing commands and adds no new plain API commands. Those
  come from the API contract in milestone 2.
- A renamed command keeps its old name: as a pointer through
  `src/commands/moved.ts`, or as a hidden alias that still runs and warns,
  as `project use` does.

---

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.
