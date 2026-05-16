You are updating the Photon CLI (`@photon-ai/cli`) in response to upstream API changes.

## Instructions

1. Read `AGENTS.md` for the complete ruleset.
2. Read `UPSTREAM_DIFF.md` for what changed in the upstream API.
3. The file `types/api.d.ts` has already been synced to the latest version.

## Priority 1 — MUST DO (typecheck must pass)

1. Run `bun run typecheck` — fix ALL type errors in `src/commands/` and `src/lib/types.ts`
2. Focus on files that reference deleted or renamed routes
3. Run `bun run check` until it passes (typecheck + test + build)
4. Commit your changes

## Priority 2 — NICE TO HAVE (only if budget remains)

- Add new CLI commands for newly added API routes
- Add tests for changed commands

## Strategy

- Start with `bun run typecheck` to identify what's broken
- Fix BREAKING changes first (removed/renamed routes)
- Do NOT try to implement all new routes — focus on making existing code compile and tests pass
- Iterate: edit → `bun run check` → fix → repeat until green

## Constraints

- Follow `AGENTS.md` strictly
- Only modify files listed in `.agent-flow/allowed-files.json`
- Do NOT edit `types/api.d.ts`, `.github/`, or `scripts/`
- Use Eden treaty via `getApi()`, never raw `fetch()`
- Make the smallest correct change
