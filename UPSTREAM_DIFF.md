# Upstream API Diff

> Old routes: 36 · New routes: 58

## Added Routes

| Route | Method |
|-------|--------|
| `api.profile.spectrum-updates` | `PATCH` |
| `api.projects.:id.members` | `GET` |
| `api.projects.:id.members` | `POST` |
| `api.projects.:id.members.:memberUserId` | `DELETE` |
| `api.projects.:id.slack` | `DELETE` |
| `api.projects.:id.slack` | `GET` |
| `api.projects.:id.slack` | `PUT` |
| `api.projects.:id.slack.installations` | `GET` |
| `api.projects.:id.slack.installations.:teamId` | `DELETE` |
| `api.projects.:id.spectrum.avatar` | `DELETE` |
| `api.projects.:id.spectrum.avatar.commit` | `POST` |
| `api.projects.:id.spectrum.avatar.upload` | `POST` |
| `api.projects.:id.voice.imessage-enabled` | `PATCH` |
| `api.projects.:id.voice.settings` | `GET` |
| `api.projects.:id.voice.sip-inbound` | `DELETE` |
| `api.projects.:id.voice.sip-inbound` | `PATCH` |
| `api.projects.:id.webhooks` | `GET` |
| `api.projects.:id.webhooks` | `POST` |
| `api.projects.:id.webhooks.:webhookId` | `DELETE` |
| `api.projects.:id.whatsapp.templates` | `GET` |
| `api.projects.:id.whatsapp.templates` | `POST` |
| `api.projects.:id.whatsapp.templates.:templateId` | `DELETE` |
| `api.projects.:id.whatsapp.templates.:templateId` | `PATCH` |

## Removed Routes

| Route | Method |
|-------|--------|
| `api.projects.:id.spectrum.avatar-upload-url` | `GET` |

## Changed Routes

| Route | Method | Change |
|-------|--------|--------|
| `api.projects.:id.spectrum.profile` | `PATCH` | body no longer accepts `avatarUrl` (only `firstName` / `lastName`); avatar URL is set server-side by `spectrum/avatar/commit` |
| `api.projects.:id.lines` | `GET` | response is now `{ lines, pendingRegistrations }` instead of a bare `SpectrumLine[]` array |

## Summary

- **23** added
- **1** removed
- **2** changed
- **33** unchanged
