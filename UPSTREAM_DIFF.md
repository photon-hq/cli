# Upstream diff — @photon-ai/dashboard-api 1.6.13 → 1.6.14

Dashboard release: [v1.6.14](https://github.com/photon-hq/dashboard/releases/tag/v1.6.14)
Dashboard SHA: `bf18b4a3b72c4ddb03ebee09b0c176959daa847b`

## Summary

Additive DTO change on the project-detail endpoint plus server-side
security hardening in the dashboard that doesn't touch the public
API surface.

## Changed routes

- `GET /api/projects/:id` — response body gained four fields:
  - `avatarUrl: string | null`
  - `plan: PlanTier` (`"free" | "pro" | "business" | "enterprise"`)
  - `platforms: SpectrumPlatformId[]`
  - `userCount: number`

  Source: dashboard#255 ("include plan and platforms in project details").

## Added / removed routes

- Added: (none)
- Removed: (none)

## Non-API dashboard changes (no CLI impact)

- dashboard#251 — suspend accounts after six phone-OTP failures (server-side rate limit).
- dashboard#253 — scaffold install commands now use `--yes` instead of `-y` (dashboard-generated shell snippets; CLI is unaffected).
- dashboard#256 — redirect suspended users to a reason page (dashboard UI).
- dashboard#257 — suspicious email-domain OTP abuse controls (server-side signup validation).

## Snapshot changes

(none)

## New runtime dependencies

(none)
