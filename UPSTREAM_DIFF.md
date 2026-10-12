# Upstream API Diff

> Bumping `@photon-ai/dashboard-api` from 1.6.12 → 1.6.17 (dashboard@v1.6.17).
> Spans upstream releases v1.6.13, v1.6.14, v1.6.15, v1.6.16, v1.6.17.

## Added Routes

| Route | Method |
|-------|--------|
| `api.otp.phone2.send` | `POST` |

`api.otp.phone2.send` is the real phone-OTP send path (dashboard#259). The
pre-existing `api.otp.phone.send` remains as a decoy honeypot for scraped
clients. The CLI does not call either route.

## Removed Routes

_(none)_

## Changed Routes

| Route | Method | Change |
|-------|--------|--------|
| `api.projects.:id` | `GET` | Response body adds `avatarUrl: string \| null`, `plan: PlanTier`, `platforms: SpectrumPlatformId[]`, `userCount: number` (dashboard#255). |

Surfaced in `photon projects show` as new `plan`, `platforms`, `userCount`
rows between `location` and `owner`. `avatarUrl` is intentionally not printed
— the CLI can't render images and it's redundant with `spectrum avatar`.

The `api.otp.phone.send` body field order swapped `code`/`captchaToken`
cosmetically; both fields are still present and optional/required as before.

## Summary

- **1** added
- **0** removed
- **1** changed (additive fields on `GET /api/projects/:id`)
- Server-side only (no CLI impact): dashboard#250 (>3-dot email local-part signup block, v1.6.13), dashboard#251 phone-OTP suspension (v1.6.14), dashboard#256 suspended-user redirect (v1.6.14), dashboard#257 email-domain OTP abuse controls (v1.6.14), dashboard#258 signup IP suspensions (v1.6.15), dashboard#260 log real phone sends after three OTP failures (v1.6.16), dashboard#261 block suspicious OTP IPs for seven days (v1.6.17).
