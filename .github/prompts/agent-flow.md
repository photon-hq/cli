You are updating the Photon CLI (`@photon-ai/cli`) in response to upstream API changes.

## Instructions

1. Read `AGENTS.md` for the complete ruleset.
2. Read `UPSTREAM_DIFF.md` for what changed in the upstream API.
3. The file `types/api.d.ts` has already been synced to the latest version.

## Your task

1. Run `bun run typecheck` — fix any type errors in `src/commands/` and `src/lib/types.ts`
2. Update or add CLI commands for new/changed API endpoints
3. Update or add tests in `tests/` for changed functionality
4. Run `bun run check` until it passes (typecheck + test + build)
5. Commit your changes with a descriptive message

## Constraints

- Follow `AGENTS.md` strictly
- Only modify files listed in `.agent-flow/allowed-files.json`
- Do NOT edit `types/api.d.ts`, `.github/`, or `scripts/`
- Use Eden treaty via `getApi()`, never raw `fetch()`
- Budget: make the smallest correct change
