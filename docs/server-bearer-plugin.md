# Enable Better Auth `bearer()` plugin on the dashboard server

> **Audience**: dashboard maintainer (apps/api).
> **Status**: required to ship `dashboard-cli`. Without this change, every
> non-browser client (CLI, mobile, server-to-server) is blocked.
> **Effort**: ~5 lines, one file, no schema change, no migration.

## TL;DR

The dashboard server's `auth.ts` needs to load the `bearer()` plugin alongside
`deviceAuthorization()`. Two-line change in `apps/api/src/auth.ts`:

```diff
- import { deviceAuthorization } from "better-auth/plugins";
+ import { bearer, deviceAuthorization } from "better-auth/plugins";

  plugins: [
+   bearer(),
    deviceAuthorization({
      verificationUri: "/device",
      validateClient: (clientId) => ALLOWED_DEVICE_CLIENT_IDS.has(clientId),
    }),
  ],
```

This is the [officially recommended fix][bearer-required-quote] from the
better-auth team. A worktree branch (`feat/api-public-wrapper`,
commit [`8cb80db`][bearer-commit]) already has it applied and typechecks
clean — you can cherry-pick or rewrite as you prefer.

## Problem (symptom we observed)

End-to-end test of `dashboard login --env staging`:

```
◆ Authenticating to staging (https://staging-app.photon.codes)
  Visit: https://staging-app.photon.codes/device
  Code:  PEDNLHTX
✓ Authorized                              ← device flow succeeded
✗ Token issued but session lookup failed  ← but the token isn't usable
```

The CLI:

1. ✅ Calls `POST /api/auth/device/code` → server returns `device_code` + `user_code`.
2. ✅ User opens the verification URL, signs in, clicks Approve.
3. ✅ CLI polls `POST /api/auth/device/token` → server returns `access_token`.
4. ❌ CLI calls `GET /api/auth/get-session` with `Authorization: Bearer <access_token>` → server returns `null` (no session).

Step 4 fails on every other authenticated route too (`/api/projects`,
`/api/profile`, etc.) — they all share the same `resolveAuth` middleware
that calls `auth.api.getSession({ headers: request.headers })`.

## Root cause

The `deviceAuthorization` plugin issues a real, valid session token as its
`access_token` (verified in better-auth source — see
`node_modules/better-auth/dist/plugins/device-authorization/routes.mjs`):

```js
const session = await ctx.context.internalAdapter.createSession(user.id);
// ...
return {
  access_token: session.token,
  token_type: "Bearer",
  expires_in: ...,
};
```

But `auth.api.getSession()` only finds a session via the **session cookie**
unless the `bearer()` plugin is also loaded. The bearer plugin's job is
exactly this: read `Authorization: Bearer <token>` and translate it into
the session cookie internally so the rest of the auth pipeline finds it.

Without `bearer()`:

- `auth.api.getSession({ headers: { Authorization: "Bearer ..." } })` → ignores the header → `null`
- The token is real and unrevoked, but every endpoint that calls
  `getSession()` rejects it.

With `bearer()`:

- The header is parsed, the token is treated as the session token, and
  the session lookup succeeds — same code path as cookie-based browser auth.

## Why this is the right fix (not a workaround)

Better Auth's own device-authorization docs say:

> **"To use the access token for API requests, ensure you have added the
> [Bearer plugin](https://better-auth.com/docs/plugins/bearer) to your
> auth instance."**
>
> — [Device Authorization plugin docs][device-auth-docs]

This requirement was previously buried; the better-auth team filed and
closed [issue #6348][issue-6348] specifically to surface it. PR [#6351][pr-6351]
updated the device-auth docs to call it out.

The pattern (`bearer()` + `deviceAuthorization()`) is the standard
better-auth setup for any non-browser client.

## Security considerations

The `bearer()` plugin docs note:

> "Use this cautiously; it is intended only for APIs that don't support
> cookies or require Bearer tokens for authentication. Improper
> implementation could easily lead to security vulnerabilities."
>
> — [Bearer plugin docs][bearer-docs]

What "use cautiously" actually means in practice for our setup:

| Concern | How dashboard handles it today | Recommendation |
|---|---|---|
| **HTTPS-only** — Bearer tokens leak if sent over HTTP | ✅ Already enforced on staging/prod | Keep |
| **Logging** — access logs / proxy logs may capture `Authorization` headers | ⚠️ Verify nginx / Vercel logs strip the header. Check `apps/api/src/index.ts` and any reverse proxy config. | Audit before merging |
| **Token signing** — by default the token is unsigned; if leaked, anyone can replay it | Default `requireSignature: false` | Consider `bearer({ requireSignature: true })` for prod (see below) |
| **CSRF** — Bearer tokens skip browser-attached cookies, so no CSRF concern in CLI | Native to design | Keep cookies for browser, Bearer for CLI |
| **Token expiry** — device-auth tokens are session tokens, default 7d | Already enforced via better-auth `session.expiresIn` | OK to start; consider lowering to 1d for CLI tokens later |

### Optional hardening: `requireSignature: true`

If you want issued tokens to be HMAC-signed (same as the cookie does for
browsers), use:

```ts
plugins: [
  bearer({ requireSignature: true }),
  deviceAuthorization({...}),
],
```

**Caveat**: this requires the CLI to receive a signed token from the
device-auth flow. Better-auth's deviceAuthorization plugin returns
`session.token` raw (unsigned) by default. If you flip `requireSignature: true`
without a corresponding sign-on-issue change, CLI logins will start
failing. **Don't enable this in the same PR as the basic fix.** Do it as
a follow-up after confirming end-to-end flow works.

### Audit-friendly: separate cookie name (defense-in-depth, optional)

`bearer()` accepts options to map to a non-default cookie. Default works.
Only consider customizing if you want to distinguish browser sessions from
CLI sessions in the session table (none of our current code paths need this).

## Verification steps

After deploying the change to staging:

```sh
# In dashboard-cli, against staging:
DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts login --env staging --no-browser

# Expect: device code, you approve in browser, then:
# ✓ Authorized
# ✓ Logged in to staging as <your-email>

DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts whoami --env staging
# Expect: name <email>, environment, signed-in time

DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts projects ls --env staging
# Expect: table of your projects (or "No projects yet.")

DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts profile show --env staging
# Expect: developer / organization profile detail

DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts logout --env staging
# Expect: ✓ Logged out

DASHBOARD_CONFIG_DIR=/tmp/dashboard-cli-e2e \
  bun run src/index.ts whoami --env staging
# Expect: ✗ Not authenticated for environment "staging".
```

A failed `whoami` after a successful `login` means the bearer plugin still
isn't picking up the token — double-check the plugins array order isn't
the issue (it shouldn't matter, but `bearer()` first is safest).

## What this does NOT change

- **Browser/cookie auth** is untouched. `apps/web` continues to work
  exactly as before — better-auth still sets and reads the session cookie.
- **Database schema** is untouched. No migrations.
- **Existing API routes** are untouched. They already call
  `auth.api.getSession({ headers })`; once `bearer()` rewrites
  `Authorization` into a cookie header, every existing route accepts the
  token transparently.
- **Other plugins** are untouched. `bearer()` is a passive header
  translator; it has no interactions with `deviceAuthorization` beyond
  enabling its issued tokens to be used.

## What's needed beyond this fix

Nothing. After this 2-line change deploys to staging:

1. The dashboard-cli's E2E auth flow works end-to-end.
2. `dashboard login` / `whoami` / `projects ls` / `profile show` / `logout`
   all succeed against staging.
3. No further server changes are required for the CLI's currently-planned
   feature set (read commands now, mutations + spectrum + billing later).

## References

- [Better Auth — Device Authorization plugin][device-auth-docs] (the
  "ensure you have added the Bearer plugin" quote lives in the
  *Example: CLI Application* section)
- [Better Auth — Bearer plugin][bearer-docs]
- [GitHub issue #6348 — Documentation gap on bearer requirement][issue-6348]
- [GitHub PR #6351 — Doc update closing #6348][pr-6351]
- [Discussion #5068 — Token expiration & limitations][discussion-5068]

[device-auth-docs]: https://better-auth.com/docs/plugins/device-authorization
[bearer-docs]: https://better-auth.com/docs/plugins/bearer
[bearer-required-quote]: https://better-auth.com/docs/plugins/device-authorization
[issue-6348]: https://github.com/better-auth/better-auth/issues/6348
[pr-6351]: https://github.com/better-auth/better-auth/pull/6351
[discussion-5068]: https://github.com/better-auth/better-auth/discussions/5068
[bearer-commit]: https://github.com/photon-hq/dashboard/commit/8cb80db
