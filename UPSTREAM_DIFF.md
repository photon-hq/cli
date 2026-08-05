# Upstream API Diff

Sync range: `@photon-ai/dashboard-api` **1.6.12 → 1.6.22** (dashboard@v1.6.22).

## Added Routes

| Route | Method |
|-------|--------|
| `api.captcha.provider` | `GET` |
| `api.otp.phone2.send` | `POST` |

## Removed Routes

_(none)_

## Changed Routes

| Route | Method | Change |
|-------|--------|--------|
| `api.projects.:id` | `GET` | Response body gains `avatarUrl: string \| null`, `plan: PlanTier`, `platforms: SpectrumPlatformId[]`, `userCount: number` |
| `api.otp.phone2.send` | `POST` | Body gains optional `browserId?: string` (v1.6.21) |
| `api.otp.phone.send` | `POST` | Cosmetic field-order swap in decoy body (`code` / `captchaToken`) |

## Summary

- **2** added
- **0** removed
- **3** changed
- rest unchanged

## Notes per release

- **v1.6.13** — no-op (dashboard#250, signup dot-limit; server-side only)
- **v1.6.14** — additive: project-detail response gains `avatarUrl`, `plan`, `platforms`, `userCount` (dashboard#255). Surfaced in `photon projects show`.
- **v1.6.15** — additive: `POST /api/otp/phone2/send` route added (dashboard#259). CLI never touches OTP routes; no code change required.
- **v1.6.16 – v1.6.20** — no-ops: server-side OTP / captcha routing changes (dashboard#260–#266). No route or DTO change.
- **v1.6.21** — additive: `browserId?: string` added to `POST /api/otp/phone2/send` body (dashboard#267, browser-aware phone OTP abuse gate). Server-side auth flow; CLI does not call this route.
- **v1.6.22** — no-op vs v1.6.21 (identical published `@photon-ai/dashboard-api` dist). Dashboard release covers server-side forensic logging (dashboard#268) and a captcha-provider swap (reCAPTCHA → hCaptcha, dashboard#272); neither touches routes the CLI calls.
