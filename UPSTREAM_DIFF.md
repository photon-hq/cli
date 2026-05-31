# Upstream API Diff

> Old routes: 58 · New routes: 67

## Added Routes

| Route | Method |
|-------|--------|
| `.well-known.openid-configuration.api.auth` | `GET` |
| `api.account.set-password` | `POST` |
| `api.oauth-clients.:clientId.metadata` | `PATCH` |
| `api.oauth-clients.:clientId.scope-tiers` | `GET` |
| `api.oauth-clients.authorized` | `GET` |
| `api.oauth-clients.authorized.:clientId` | `DELETE` |
| `api.privacy-requests` | `POST` |
| `api.projects` | `GET` |
| `api.projects.:id.slack.setup` | `POST` |
| `api.signup.abandon` | `POST` |
| `api.slack.features` | `GET` |
| `schema.standaloneSchema.macro.macroFn.parser.response..well-known.oauth-authorization-server.api.auth` | `GET` |

## Removed Routes

| Route | Method |
|-------|--------|
| `api.otp.email.send` | `POST` |
| `api.otp.email.verify` | `POST` |
| `schema.standaloneSchema.macro.macroFn.parser.response.api.projects` | `GET` |

## Summary

- **12** added
- **3** removed
- **0** changed
- **55** unchanged
