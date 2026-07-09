# Upstream API Diff

Comparing `@photon-ai/dashboard-api` **1.2.0 → 1.6.1** (packaged for
`photon-hq/dashboard@v1.6.4`, sha `44c3931589ed3c77bb553016706c9334d1a8bd27`).

Note: dashboard `v1.6.4` did not publish a new `@photon-ai/dashboard-api`
version. The API type contract is unchanged from `v1.6.3`; the release only
tightens SMS OTP send handling to require an authenticated session
([dashboard#233](https://github.com/photon-hq/dashboard/pull/233)). The
`1.2.0 → 1.6.1` bump below therefore catches this CLI up to the current
published contract.

> Old routes: 80 · New routes: 87

## Added Routes

| Route | Method |
|-------|--------|
| `api.profile.promotional-emails` | `PATCH` |
| `api.profile.promotional-status` | `GET` |
| `api.projects.:id.call-registry.profile` | `GET` |
| `api.projects.:id.call-registry.profile` | `PATCH` |
| `api.projects.:id.call-registry.profile` | `PUT` |
| `api.projects.:id.call-registry.registrations` | `GET` |
| `api.projects.:id.call-registry.registrations` | `POST` |

## Removed Routes

_(none)_

## Response-shape Changes

All route response bodies in the 1.6.x bundled `.d.ts` are exposed as
`Record<string, any>` (index-signature only) rather than the concrete
per-status objects that shipped in 1.2.0. Commands that previously read
strongly-typed fields off `data` still compile (index access is permitted),
but `Array.prototype.map` callbacks lose their inferred element type, which
is the concrete typecheck fallout addressed in this PR (see
`src/commands/projects.ts` list command and `src/commands/spectrum/users.ts`
list command — both now cast `data` to a `Project[]` / `SpectrumUser[]` DTO
at the API boundary).

## Summary

- **7** added
- **0** removed
- **0** route paths changed
- **80** unchanged paths (all with degraded response typing)
