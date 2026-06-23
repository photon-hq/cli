# Upstream API Diff

> `@photon-ai/dashboard-api` `1.2.0` → `1.3.0` (dashboard `v1.3.0`)

## Added Routes

| Route | Method |
|-------|--------|
| `api.profile.promotional-status` | `GET` |
| `api.profile.promotional-emails` | `PATCH` |

## Removed Routes

_(none)_

## Schema Changes

The 1.3.0 type-contract drop dropped every named response interface
(`SpectrumUser`, `WhatsAppTemplate`, etc.) and degraded most route response
bodies to opaque records (`{ [x: string]: any; ... }`). Two CLI list commands
relied on the previously inferred Eden treaty types and now need explicit
casts at the API boundary:

- `src/commands/projects.ts` — `GET /api/projects` (list)
- `src/commands/spectrum/users.ts` — `GET /api/projects/:id/spectrum/users`

DTOs added in `src/lib/types.ts`: `Project`, `SpectrumUser`, `SpectrumUsersPage`.

## Summary

- **2** added
- **0** removed
- **0** otherwise changed
- All other routes unchanged at the route level; response typing degraded across the board (see Schema Changes)
