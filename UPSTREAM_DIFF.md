# Upstream API Diff

> `@photon-ai/dashboard-api@1.6.12` → `@photon-ai/dashboard-api@1.6.16`
> Spans dashboard releases v1.6.13 (no-op), v1.6.14 (additive), v1.6.15 (additive), v1.6.16 (no-op).

## Added Routes

| Route | Method |
|-------|--------|
| `api.otp.phone2.send` | `POST` |

## Removed Routes

_(none)_

## Changed Routes

| Route | Method | Change |
|-------|--------|--------|
| `api.projects.:id` | `GET` | response body gained `avatarUrl: string \| null`, `plan: PlanTier`, `platforms: SpectrumPlatformId[]`, `userCount: number` |
| `api.otp.phone.send` | `POST` | body field ordering swap (`code` / `captchaToken`); cosmetic only |

## Summary

- **1** added
- **0** removed
- **2** changed
- **rest** unchanged
