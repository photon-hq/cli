# Upstream API Diff — dashboard@v1.6.19

Bump `@photon-ai/dashboard-api` 1.6.12 → 1.6.19.

## Changes since 1.6.12

- **1.6.13** — Server-side signup validation (dashboard#250, suspend signups with >3 email-local dots). No route/DTO change.
- **1.6.14** — Additive fields on `GET /api/projects/:id` (dashboard#255): `avatarUrl`, `plan`, `platforms`, `userCount`. Surfaced by `photon projects show` (already on main).
- **1.6.15** — Additive OTP route `POST /api/otp/phone2/send` (dashboard#259) plus old `POST /api/otp/phone/send` kept as decoy. Server-side signup IP suspensions (dashboard#258). No CLI impact — CLI never called `api.otp.*`.
- **1.6.16** — Server-side logging on real phone OTP send after three failures (dashboard#260). No route/DTO change.
- **1.6.17** — Server-side block list for suspicious OTP IPs for seven days (dashboard#261). No route/DTO change.
- **1.6.18** — Server-side swap of OTP send captcha provider to Google reCAPTCHA (dashboard#262). No route/DTO change.
- **1.6.19** — Add CAPTCHA method to phone OTP forensic logs (dashboard#263). No route/DTO change.

`diff -rq` on the bundled dist between 1.6.18 and 1.6.19 is empty, confirming no
public API surface change in this release.

## Added / Removed / Changed Routes

_(none in 1.6.19)_

The cumulative 1.6.12 → 1.6.19 delta (additive project-detail fields in 1.6.14
and additive OTP route in 1.6.15) is unchanged from the v1.6.18 sync and is
already reflected on main.
