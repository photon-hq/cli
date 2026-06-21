# Upstream API Diff

> `@photon-ai/dashboard-api` `1.2.0` → `1.2.3` (dashboard@v1.2.3)
> Old routes: 80 · New routes: 82

## Added Routes

| Route | Method |
|-------|--------|
| `api.profile.promotional-emails` | `PATCH` |
| `api.profile.promotional-status` | `GET` |

## Removed Routes

_(none)_

## Summary

- **2** added
- **0** removed
- **80** unchanged

## Type-level notes

The bundled `.d.ts` shipped in `1.2.3` widens many response/body shapes to
`{ [x: string]: any }` (the rolldown / dts-bundler can no longer carry
Drizzle-inferred shapes through). Runtime behaviour is unchanged, but TS
inference at `.map()` / `.filter()` callbacks now falls through to `any`.

We compensate by casting at the API boundary to local DTOs (the same
pattern already in `src/commands/spectrum/lines.ts`), per the rule in
`AGENTS.md` ("New DTOs go in `src/lib/types.ts`, cast at the API
boundary").

Files touched for the `1.2.3` sync:

- `src/commands/projects.ts` — cast `data ?? []` to `ProjectListItem[]`
  in `projects list` so the row builder keeps its types.
- `src/commands/spectrum/users.ts` — cast `data?.users ?? []` to the
  existing inline `SpectrumUser[]` for the same reason.

No command logic, routes, or surface area changed.
