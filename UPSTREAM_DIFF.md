# Upstream API Diff

> Old routes: 58 · New routes: 75

## Added Routes

| Route | Method |
|-------|--------|
| `.well-known.openid-configuration.api.auth` | `GET` |
| `api.account.set-password` | `POST` |
| `api.billing.max-plan` | `GET` |
| `api.oauth-clients.:clientId.metadata` | `PATCH` |
| `api.oauth-clients.:clientId.scope-tiers` | `GET` |
| `api.oauth-clients.authorized` | `GET` |
| `api.oauth-clients.authorized.:clientId` | `DELETE` |
| `api.onboarding.details` | `POST` |
| `api.onboarding.name` | `POST` |
| `api.onboarding.referral` | `POST` |
| `api.onboarding.state` | `GET` |
| `api.posthog.identity-snapshot` | `GET` |
| `api.privacy-requests` | `POST` |
| `api.projects` | `GET` |
| `api.projects.:id.imessage.auto-scale` | `PATCH` |
| `api.projects.:id.imessage.settings` | `GET` |
| `api.projects.:id.slack.setup` | `POST` |
| `api.projects.:id.slack.support-channel` | `GET` |
| `api.projects.:id.slack.support-channel.open` | `GET` |
| `api.signup.abandon` | `POST` |
| `api.slack.features` | `GET` |
| `api.slack.oidc.callback` | `GET` |
| `schema.standaloneSchema.macro.macroFn.parser.response..well-known.oauth-authorization-server.api.auth` | `GET` |

## Removed Routes

| Route | Method |
|-------|--------|
| `api.otp.email.send` | `POST` |
| `api.otp.email.verify` | `POST` |
| `api.profile.developer` | `POST` |
| `api.profile.organization` | `POST` |
| `api.projects.:id.spectrum.toggle` | `POST` |
| `schema.standaloneSchema.macro.macroFn.parser.response.api.projects` | `GET` |

## Changed Routes

| Route | Method | Detail |
|-------|--------|--------|
| `api.projects.:id.spectrum.users` | `GET` | response shape changed |

## Summary

- **23** added
- **6** removed
- **1** changed
- **51** unchanged
