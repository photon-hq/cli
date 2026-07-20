# Upstream API Diff

> Sync target: dashboard@v1.6.15 (82d51e40947c35def51e38c92fb9edadc89b1408)
> Previous CLI pin: `@photon-ai/dashboard-api@1.6.12` (last CLI sync landed at v1.6.14 upstream but never merged to `main`).

## Added Routes (v1.6.14 → v1.6.15)

| Route | Method |
|-------|--------|
| `api.otp.phone2.send` | `POST` |

## Removed Routes (v1.6.14 → v1.6.15)

_(none — the old `api.otp.phone.send` route is kept as a decoy by dashboard#259.)_

## Changed Routes (v1.6.14 → v1.6.15)

_(none — the body field-ordering shuffle on `api.otp.phone.send` is cosmetic only.)_

## Notes

- **dashboard#258 — signup IP suspensions.** Pure server-side abuse control. No public route surface change.
- **dashboard#259 — phone OTP send route move + decoy.** The real send path becomes `POST /api/otp/phone2/send` (same body shape as before). The old `POST /api/otp/phone/send` is kept as a honeypot / decoy for scraped clients. The CLI never called either route (`otp` is a browser/mobile auth flow, not CLI), so no command edits are required.

## Cumulative delta vs. `main` (`@photon-ai/dashboard-api@1.2.0` → `1.6.15`)

- **24** added
- **1** removed
- **2** changed
- **34** unchanged
