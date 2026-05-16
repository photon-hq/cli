# Agent Guide for @photon-ai/cli

## Mission
You're updating this CLI in response to upstream API changes in `@photon-dashboard/api-public`. The fresh `types/api.d.ts` is in your working tree. Your job: make `bun run check` pass.

## Hard Rules (CI will fail if violated)
1. Use Bun exclusively — never Node, npm, pnpm, yarn
2. Never edit `types/api.d.ts` by hand — it's vendored via `bun run sync:api`
3. Never add forbidden dependencies: axios, chalk, zod, jest, vitest, ts-node, ws, express, dotenv, ioredis, pg, better-sqlite3
4. Every command must use `getApi()` from `~/lib/api.ts` + Eden treaty pattern — never raw `fetch()`
5. Destructure Eden responses as `{ data, error, status }` — check error before using data
6. Handle 401 by throwing `SessionExpiredError` (caught centrally in `handleTopLevelError`)
7. Never delete or rewrite snapshot files without justification in PR body under "## Snapshot changes"
8. One PR = one upstream version bump — don't bundle refactors
9. Never modify files in `.github/workflows/` or `scripts/agent-flow/`

## Soft Rules (reviewer will flag)
- Match the style in `src/commands/projects.ts`: same option ordering (--api-host, -t/--token, --json), same error handling
- New DTOs go in `src/lib/types.ts`, cast at the API boundary
- Prefer adding fields to existing DTOs over creating parallel types
- All user-facing output uses `c.dim()`, `c.success()`, `c.error()` from `~/lib/output.ts`
- Comments only when intent isn't obvious from the code

## Anti-patterns (we've seen AI do these — don't)
- Splitting the `Project` DTO into one type per command
- Adding try/catch around every `getApi()` call (handled centrally in `src/index.ts#handleTopLevelError`)
- Using `console.log(JSON.stringify(...))` instead of the output helpers
- Replacing `picocolors` with `chalk`
- Using `node:fs` instead of `Bun.file`
- Adding `dotenv` (Bun auto-loads .env)
- Importing from `@elysiajs/eden` directly instead of using `getApi()`

## Workflow
1. Read `UPSTREAM_DIFF.md` (committed at the root of your branch)
2. Run `bun install && bun run check`. Note what breaks.
3. Update DTOs in `src/lib/types.ts` if the API surface changed
4. Update command files in `src/commands/` to match new routes
5. Update or add tests in `tests/` to cover changes
6. Run `bun run check` until green
7. If you can't make it green within 20 iterations, create `AGENT_NOTES.md` explaining where you got stuck

## Tooling
- Package manager: `bun` only
- Test runner: `bun test`
- Type check: `tsc --noEmit`
- Build: `bun run build`
- Aggregate: `bun run check` (runs typecheck + test + build)
