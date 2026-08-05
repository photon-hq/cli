# Upstream API Diff

> dashboard@v1.6.23 (bump from @photon-ai/dashboard-api 1.6.22 → 1.6.23)

## Added Routes

_(none)_

## Removed Routes

_(none)_

## Changed Routes

_(none — no route surface changes)_

## Other type changes

- `CaptchaProvider` union changed from `"google-recaptcha" | "turnstile"` to `"hcaptcha" | "turnstile"` (dashboard#272/#273/#274 hCaptcha rollout). Not referenced by the CLI, no code impact.

## Summary

- **0** added
- **0** removed
- **0** changed (route surface)
- 1 non-route type refinement (`CaptchaProvider`)
