# Upstream API Diff

> `@photon-ai/dashboard-api` 1.2.0 → 1.3.1 (dashboard release `v1.3.1`, sha `c2b68e9`)

## Summary

- The upstream **runtime** API surface is effectively unchanged between
  dashboard `v1.2.0` and `v1.3.1`. The notable PRs in this window are
  app-layer (UI / CI / auth-hardening) and don't touch route shapes the CLI
  consumes:
  - #194 `fix(ci): publish api-public via buildspace publish-npm block`
  - #191 `fix(auth): harden rate limiting on authentication endpoints`
  - #199 `Keep WhatsApp enabled on connect failure; default unrated lines to healthy`
  - #190 `add promotional email opt-in toggle` (PATCH `api.profile.spectrum-updates` body now accepts the toggle field)
- The **published type contract** for `@photon-ai/dashboard-api` got
  noticeably looser starting with `1.2.3` — request/response bodies are
  emitted as `any` and response status maps as `{ [x: string]: any }` rather
  than the rich DTOs the `1.2.0` bundle carried. This is the source of the
  CLI type breakage, not a route-level change.

## Routes added / removed / changed

| Category | Count |
|----------|-------|
| Added    | 0 |
| Removed  | 0 |
| Changed (signature)  | 0 |

The route map exposed by `PublicApp` is structurally identical between the
two versions; only the response payload precision changed.

## CLI impact

- Two `data.map(...)` callsites picked up implicit-`any` errors because
  Eden treaty now infers `data` as `{ [x: string]: any }` instead of an
  array-of-DTOs. Fixed by casting at the API boundary (see
  `src/commands/projects.ts` and `src/commands/spectrum/users.ts`).
- No tests were rewritten; existing fixtures still match the runtime
  contract.
- No new runtime dependencies.

## Snapshot changes

(none)
