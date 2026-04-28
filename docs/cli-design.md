# dashboard-cli Design

> Goal: replace the dashboard web UI for end-user interaction with a typed,
> ergonomic terminal experience. This doc grounds the design in (a) the
> dashboard's actual API and web surface and (b) the established patterns
> in `gh` (GitHub CLI) and `vercel` CLI.

## 1. Source-of-truth maps

### 1.1 What the API exposes today

After `photon-hq/dashboard@a440152` (post-bearer-plugin merge):

| Domain | Method + path | Notes |
|---|---|---|
| **Auth** (mounted, `auth.ts` → better-auth + `bearer()` + `deviceAuthorization()`) | `POST /api/auth/sign-in/email` | email+password browser flow |
|   | `POST /api/auth/sign-up/email` | sign-up browser flow |
|   | `POST /api/auth/sign-out` | session revoke |
|   | `GET  /api/auth/get-session` | session lookup (cookie or `Authorization: Bearer`) |
|   | OAuth Google routes | browser only |
|   | `POST /api/auth/device/code` | RFC 8628 device-code request |
|   | `POST /api/auth/device/token` | poll for access_token |
|   | `POST /api/auth/device/approve` | (web) approve a code |
|   | `POST /api/auth/device/deny` | (web) deny a code |
|   | `GET  /api/auth/device` | (web) verify a code |
| **Profile** (`profile.ts`) | `GET  /api/profile` | returns `{type:'developer'\|'organization', profile}` or `null` |
|   | `POST /api/profile/developer` | upsert developer profile |
|   | `POST /api/profile/organization` | upsert org profile |
| **OTP** (`otp.ts`) ⚠️ S1 | `POST /api/otp/email/send` | unauthed, unrate-limited (architecture-review S1) |
|   | `POST /api/otp/email/verify` | unauthed, unrate-limited |
|   | `POST /api/otp/phone/send` | unauthed, unrate-limited |
|   | `POST /api/otp/phone/verify` | authenticated |
| **Projects** (`projects.ts`) | `GET    /api/projects` | list user's projects |
|   | `GET    /api/projects/check-availability` | spectrum number probe |
|   | `GET    /api/projects/:id` | get one |
|   | `POST   /api/projects` | create (body: name, location, spectrum, template, observability) |
|   | `PATCH  /api/projects/:id` | update |
|   | `DELETE /api/projects/:id` | delete |
|   | `POST   /api/projects/:id/regenerate-secret` | rotate `projectSecret` |
| **Spectrum** (sub-resource of project) | `GET   /api/projects/:id/spectrum/profile` | spectrum profile metadata |
|   | `PATCH /api/projects/:id/spectrum/profile` | update spectrum metadata |
|   | `GET   /api/projects/:id/spectrum/avatar-upload-url` | signed S3 PUT URL |
|   | `GET   /api/projects/:id/spectrum/users` | list users |
|   | `POST  /api/projects/:id/spectrum/users` | add user |
|   | `DELETE /api/projects/:id/spectrum/users/:userId` | remove user |
|   | `GET   /api/projects/:id/platforms` | list integrated platforms |
|   | `POST  /api/projects/:id/platforms` | add platform |
|   | `GET   /api/projects/:id/lines` | list phone lines |
|   | `POST  /api/projects/:id/lines` | add line |
|   | `DELETE /api/projects/:id/lines/:lineId` | remove line |
| **Billing** (`billing.ts`) | `GET  /api/billing/plans` | available products |
|   | `POST /api/billing/checkout` | returns Stripe Checkout URL |
|   | `GET  /api/projects/:id/subscription` | current subscription |
|   | `GET  /api/projects/:id/subscription/poll` | long-poll Stripe sync (web only) |
|   | `POST /api/projects/:id/subscription/manage` | returns Stripe Portal URL |
| **System** | `GET /api/health` | `{status:"ok"}` |
|   | `GET /api/info` | `{environment}` (excluded from public spec) |

> 💡 The `architecture-review.md` flags **S1, S2, S3** as critical: OTP unrate-limited, web TS errors silenced, billing fallback resolves to `"unknown"` tier. **None block CLI v1**, but S3 affects how `dashboard billing` renders subscription state — flag it.

### 1.2 What the web does (user flows the CLI must mirror)

| Web page | User intent | CLI equivalent |
|---|---|---|
| `/(auth)/sign-up` | First-time signup with email+password+OTP+phone | `dashboard signup` (interactive) — but device-flow login skips this; new users must visit web once |
| `/(auth)/sign-in` | Returning login | `dashboard login` (already shipped — device flow) |
| `/onboarding` | Choose developer-vs-organization profile | `dashboard onboard` (interactive prompts) |
| `/dashboard` (root) | List projects | `dashboard projects ls` ✅ |
| `/dashboard/new` | Create project (name, location, spectrum, template) | `dashboard projects create` |
| `/dashboard/[id]` | Project home / overview | `dashboard projects show <id>` ✅ |
| `/dashboard/[id]/settings` | Rename, danger zone, subscription overview | `dashboard projects update`, `dashboard projects delete` |
| `/dashboard/[id]/spectrum` | Manage Spectrum users / lines / platforms | `dashboard spectrum users/lines/platforms <subcmd>` |
| `/dashboard/[id]/billing` | View subscription + manage | `dashboard billing show / checkout / manage` (the latter two open browser) |
| `/dashboard/[id]/template` | Template gallery | `dashboard template ls / use` (low priority) |
| `/dashboard/[id]/observability` | Logs / traces | `dashboard logs` (out of scope v1; needs more API) |
| `/dashboard/[id]/debug` | Debug info | likely out of scope; admin-ish |
| `/device` + `/device/approve` | Device approve flow | already integrated server-side |

→ **CLI v1 needs to cover everything except observability/debug/template-gallery and signup-from-zero** (signup goes to web). That's still a big scope; we'll phase it.

---

## 2. Design principles (from `gh` + `vercel` study)

### 2.1 Command grammar

Both `gh` and `vercel` converged on `<noun> <verb> [args] [flags]`, with verbs being a small CRUD vocabulary plus a few specials. We adopt:

| Verb | Meaning | Aliases |
|---|---|---|
| `list` | enumerate things | `ls` |
| `show` | display one thing in detail | `get`, `view` |
| `create` | make a new thing | `add`, `new` |
| `update` | mutate a thing | `edit`, `set` |
| `delete` | remove a thing | `rm`, `remove` |
| `open` | open in browser (vercel-style) | — |
| `pull` / `push` | sync local↔remote (vercel `pull`/`pull-env`) | — |

Default verb is `list` for collection nouns, like vercel: `vercel project` ≡ `vercel project ls`. Already used today in `env list`.

### 2.2 Auth model

Both CLIs support **two paths**: interactive login + token for CI.

| | gh | vercel | dashboard-cli |
|---|---|---|---|
| Interactive login | `gh auth login` (browser flow) | `vercel login` (email magic link) | `dashboard login` (RFC 8628 device flow) ✅ |
| CI / scriptable | `GH_TOKEN` env, `--with-token` flag | `VERCEL_TOKEN` env, `--token` flag | `DASHBOARD_TOKEN` env, `--token` flag (TODO) |
| Multi-account | per-host (`--hostname`) | per-team (`--scope`) | per-environment ✅ |
| Status | `gh auth status` | `vercel whoami` | `dashboard whoami` ✅ + `dashboard auth status` (TODO: cross-env) |
| Logout | `gh auth logout` | `vercel logout` | `dashboard logout` ✅ |

**Add for v1.5:** `--token <t>` flag and `DASHBOARD_TOKEN` env, both bypassing stored credentials. Critical for CI (architecture-review will probably want CLI-driven seeding tests).

### 2.3 Output: `--json [fields]` is the standard

`gh` defines a strong pattern that has been broadly adopted:
- `--json` with no fields lists available fields and exits.
- `--json field1,field2` returns structured JSON.
- `--jq <expr>` filters server-side (jq syntax, no system jq required — they bundle it).
- `--template <go-template>` for shell-friendly output.

`vercel` is simpler: most commands have `--format json` flag. Less expressive, less effort.

**Recommendation for dashboard-cli:** start with vercel-style `--json` (boolean) per command + accept piping to `jq`. Adopt gh's `--jq` integration if community asks. Don't bother with go templates.

### 2.4 Project linking (vercel's secret weapon)

`vercel link` writes `.vercel/project.json` to cwd. Subsequent commands like `vercel deploy` automatically know which project. Resolution order:
1. `--project <id>` flag (highest)
2. `VERCEL_PROJECT_ID` env
3. `.vercel/project.json` from `vercel link`

This eliminates `--project <id>` from 80% of invocations. **dashboard-cli should adopt this.**

```sh
# Without linking — every command needs --project:
dashboard spectrum users ls --project abc123
dashboard projects show --project abc123
dashboard billing show --project abc123

# With linking:
cd my-project-workspace/
dashboard link abc123             # writes .dashboard/project.json
dashboard spectrum users ls       # implicit project
dashboard projects show           # implicit project
```

Resolution order:
1. `--project <id>` flag
2. `DASHBOARD_PROJECT_ID` env
3. `.dashboard/project.json` from `dashboard link`
4. (none → error: "no project linked. Run `dashboard link <id>` or pass `--project`")

### 2.5 Interactive vs non-interactive

Both `gh` and `vercel` detect `process.stdout.isTTY`:
- TTY: spinners, prompts, colors, banner ASCII.
- Non-TTY (pipe, CI): silent, no prompts (require flags or fail), no colors (also `NO_COLOR=1`).

vercel global flag `--yes` skips confirmation prompts ("are you sure?"). gh uses `--force` in some places. **We should adopt `--yes`/`-y` since vercel's idiom is more common in the broader CLI ecosystem.**

### 2.6 Browser handoff for inherently visual flows

Both CLIs hand off to browser when the operation is fundamentally interactive:
- `vercel open` opens project in dashboard
- `vercel login` opens browser for OAuth
- `gh pr view --web` opens PR page

Our analogues:
- `dashboard login` opens device-approve page ✅
- `dashboard billing checkout` opens Stripe checkout (already planned)
- `dashboard billing manage` opens Stripe portal
- `dashboard projects open <id>` — opens project page in dashboard web (NEW idea, vercel-inspired)

### 2.7 The "raw API" escape hatch

`vercel api <path>` and `gh api <path>` let power users hit the API directly with auth handled. Not v1, but worth noting — when something isn't covered by a typed command, the escape hatch saves the day.

```sh
dashboard api /api/projects/abc/spectrum/users
dashboard api /api/projects -X POST -F name=test
```

---

## 3. Command surface design

Reading order: top to bottom roughly mirrors a new user's discovery path.

### 3.1 Auth + identity

| Command | Status | Notes |
|---|---|---|
| `dashboard login [--env] [--no-browser]` | ✅ | RFC 8628 device flow. Per-env credentials. |
| `dashboard logout [--env]` | ✅ | server signOut + clear local. |
| `dashboard whoami [--env]` | ✅ | validates session via `/api/profile`. |
| `dashboard auth status` | TODO | shows status across all envs (which are logged in, when). |
| `dashboard auth refresh` | future | token refresh — not supported by better-auth device-auth today; track upstream. |

### 3.2 Environments & scope

| Command | Status | Notes |
|---|---|---|
| `dashboard env list` | ✅ | table with current marker + logged-in flag. |
| `dashboard env use <name>` | ✅ | persists currentEnv. |
| `dashboard env add <name> <url>` | ✅ | custom env. |
| `dashboard env remove <name>` (`rm`) | ✅ | custom env only. |
| `dashboard env current` | ✅ | print active env. |

### 3.3 Project linking

| Command | Status | Notes |
|---|---|---|
| `dashboard link <id>` | TODO | writes `.dashboard/project.json` to cwd; like `vercel link`. |
| `dashboard unlink` | TODO | removes the file. |
| `dashboard link --status` | TODO | shows current link, if any. |

After this lands, `--project <id>` becomes optional on every command below.

### 3.4 Profile (the user, not a project)

| Command | Status | Notes |
|---|---|---|
| `dashboard profile show` | ✅ | renders developer or organization profile. |
| `dashboard profile init` | TODO | interactive prompt → calls `/api/profile/developer` or `/organization`. Used during onboarding. |
| `dashboard profile update [--field=value...]` | TODO | non-interactive PATCH-style update. |

### 3.5 Projects

| Command | Status | Notes |
|---|---|---|
| `dashboard projects list` (`ls`) | ✅ | table + `--json`. |
| `dashboard projects show <id>` (`get`) | ✅ | detail + `--json`. |
| `dashboard projects create [--name] [--location] [--spectrum] [--template]` | TODO | interactive if flags missing; non-interactive with all flags. |
| `dashboard projects update [<id>] --name <new>` (`edit`) | TODO | uses linked project if `<id>` omitted. |
| `dashboard projects delete [<id>] [--yes]` (`rm`) | TODO | requires `--yes` in non-TTY; confirmation prompt in TTY. |
| `dashboard projects regenerate-secret [<id>]` | TODO | rotates `projectSecret`. Destructive — same `--yes` rule. |
| `dashboard projects open [<id>]` | TODO | opens project page in browser. |
| `dashboard projects link [<id>]` | TODO alias of `dashboard link`. |
| `dashboard projects check-phone <number>` | TODO | calls `/check-availability`. |

### 3.6 Spectrum (sub-resource of project)

The CLI groups Spectrum by sub-noun (user/platform/line) since each has its own CRUD lifecycle.

| Command | Status | Notes |
|---|---|---|
| `dashboard spectrum profile show` | TODO | spectrum-side metadata. |
| `dashboard spectrum profile update [--field]` | TODO | mirrors web's spectrum settings panel. |
| `dashboard spectrum users list` (`ls`) | TODO | |
| `dashboard spectrum users add [--email] [--phone] [--first-name] [--last-name] [--invite]` | TODO | interactive if missing flags. |
| `dashboard spectrum users remove <user-id>` (`rm`) | TODO | `--yes` for non-TTY. |
| `dashboard spectrum platforms list` (`ls`) | TODO | |
| `dashboard spectrum platforms add [...]` | TODO | |
| `dashboard spectrum lines list` (`ls`) | TODO | |
| `dashboard spectrum lines add [...]` | TODO | |
| `dashboard spectrum lines remove <line-id>` (`rm`) | TODO | |
| `dashboard spectrum avatar upload <file>` | TODO | gets signed S3 URL, PUTs file. |

### 3.7 Billing

| Command | Status | Notes |
|---|---|---|
| `dashboard billing plans` | TODO | `--json` for scripting. |
| `dashboard billing show [<id>]` | TODO | current subscription summary. ⚠️ until S3 fixed, "unknown" tier may show — surface that warning prominently. |
| `dashboard billing checkout [<id>] [--plan <id>] [--qty N]` | TODO | gets Stripe URL → `open()` it (with `--no-browser` opt-out). |
| `dashboard billing manage [<id>]` | TODO | gets Stripe portal URL → `open()` it. |

### 3.8 Connectivity / debug

| Command | Status | Notes |
|---|---|---|
| `dashboard ping [--env] [--url]` | ✅ | `/api/health`. |
| `dashboard api <path> [-X METHOD] [-d body] [-F field=val]` | TODO (v2) | raw authed call. |
| `dashboard --version` | ✅ | |
| `dashboard help [<cmd>]` | ✅ via commander | |
| `dashboard config show` | TODO | dumps current config + active env + linked project (no secrets). |

---

## 4. Global UX

### 4.1 Global flags (consistent across every command)

| Flag | Env var | Effect |
|---|---|---|
| `-e, --env <name>` | `DASHBOARD_ENV` | override active env |
| `-p, --project <id>` | `DASHBOARD_PROJECT_ID` | override linked project |
| `-t, --token <token>` | `DASHBOARD_TOKEN` | bypass stored creds (CI) |
| `--json` | — | output JSON instead of formatted text (per-command, opt-in) |
| `--yes`, `-y` | — | skip confirmation prompts (required in non-TTY for destructive ops) |
| `--no-browser` | — | don't auto-open browser (login, billing, projects open) |
| `--no-color` | `NO_COLOR=1` | disable colors (NO_COLOR standard) |
| `--debug` | `DASHBOARD_DEBUG=1` | verbose output incl. HTTP request/response |
| `-v, --version` | — | print version + exit |
| `-h, --help` | — | per-command help |

### 4.2 Output design

**Default (TTY)**:
- Colors via `picocolors`
- Tables via `cli-table3`
- Spinners + prompts via `@clack/prompts`
- Quiet success: just `✓ Logged in to staging as soleil@photon.codes` — no banner
- Errors: `✗ <message>` in red, exit 1

**Pipe / non-TTY**:
- No colors, no spinners
- For collection commands (`ls`): plain TSV-style fallback (or recommend `--json`)
- For mutation commands: refuse without explicit flags (e.g., `--yes`)

**`--json`**:
- Output is exactly the API response body (or array of items). No wrapping.
- Errors: `{ "error": { "message": "...", "status": 401 } }` instead of friendly text. Exit 1.

### 4.3 Error UX

Inspired by Rust's compiler messages and `gh`:

```
✗ Project not found: abc123

  Hint: list available projects with `dashboard projects ls`
  Env:  staging (https://staging-app.photon.codes)
```

Each error has:
- `✗ <one-line>` (red)
- Optional hint (dim) — what to try next
- Optional context (dim) — env, linked project, etc.

For 401:
```
✗ Session expired for staging.

  Run: dashboard login --env staging
```

For network failures:
```
✗ Could not reach https://api.photon.codes — Unable to connect.

  Hint: check your connection or pass --env to use a different one.
```

### 4.4 Update notifier

Adopt `update-notifier`. On every command after fetch (cached for 24h), if a new version is available print:

```
┌─────────────────────────────────────────────────┐
│  Update available  0.1.0  →  0.2.0              │
│  Run: bun install -g @photon/cli                │
└─────────────────────────────────────────────────┘
```

Disabled in non-TTY and via `DASHBOARD_NO_UPDATE_NOTIFIER=1`.

### 4.5 Telemetry — DECLINE for v1

vercel has it (opt-in), gh doesn't. Not worth the privacy / engineering trade-off until we have actual usage.

---

## 5. Architecture

### 5.1 Layout (current)

```
src/
├── index.ts                  ← commander wiring
├── lib/
│   ├── env.ts                ← built-in envs + path-traversal-safe name validation
│   ├── config.ts             ← persistent {currentEnv, customEnvs}
│   ├── credentials.ts        ← per-env access tokens (chmod 600)
│   ├── auth-client.ts        ← better-auth/client + deviceAuthorizationClient
│   ├── api.ts                ← Eden treaty + Bearer injection
│   ├── output.ts             ← picocolors + cli-table3 + die()
│   ├── errors.ts             ← typed errors
│   └── types.ts              ← DTOs (workaround for Eden type degradation)
├── commands/
│   ├── env.ts
│   ├── login.ts
│   ├── logout.ts
│   ├── whoami.ts
│   ├── projects.ts           ← will grow with create/update/delete/regenerate
│   ├── profile.ts
│   ├── ping.ts
│   └── hello.ts              ← dev placeholder, drop before v1
└── types/
    └── api.d.ts              ← vendored from @photon-dashboard/api-public
```

### 5.2 Layout (planned additions)

```
src/
├── lib/
│   ├── link.ts               ← .dashboard/project.json read/write
│   ├── interactive.ts        ← @clack/prompts wrappers (TTY-aware)
│   ├── browser.ts            ← `open()` wrapper with --no-browser respect
│   └── api-context.ts        ← resolveProject(): flag → env → linked → error
└── commands/
    ├── link.ts               ← dashboard link / unlink
    ├── billing.ts            ← plans / show / checkout / manage
    ├── spectrum/
    │   ├── index.ts          ← `dashboard spectrum` group
    │   ├── users.ts
    │   ├── platforms.ts
    │   ├── lines.ts
    │   ├── profile.ts
    │   └── avatar.ts
    └── api.ts                ← raw passthrough (v2)
```

### 5.3 Type strategy

The vendored `types/api.d.ts` from `@photon-dashboard/api-public` gives us Eden treaty types. But many endpoints' response types degrade to `Record<string, any>` because handlers infer from Drizzle. Today we work around with hand-rolled DTOs in `src/lib/types.ts`. Two paths to upgrade:

1. **Server adds `response: t.Object(...)` schemas** (tracked at apps/api side, low priority).
2. **CLI keeps growing `lib/types.ts`** as new endpoints are integrated.

Either is fine. Both improve over time without churn.

---

## 6. What's done vs what's next

### ✅ Shipped (PR #1, merged)

- Foundations: env system, per-env credentials, Eden client with Bearer, output utilities
- Auth: `login` (device flow), `logout`, `whoami`, full RFC 8628 with 429 backoff
- Env: `list / use / add / remove / current`
- Projects: `ls` / `show` (with `--json`)
- Profile: `show` (with `--json`)
- `ping` (health check)
- E2E verified against staging

### 📋 Phase 5 — Project linking + writes (next)

1. `dashboard link` / `unlink`
2. `dashboard projects create / update / delete / regenerate-secret`
3. `dashboard projects open` (browser)
4. `dashboard profile init / update`
5. Add `--token` flag + `DASHBOARD_TOKEN` env
6. Add `--yes` for destructive ops; require it in non-TTY
7. Add `--debug` for HTTP tracing

Estimated: ~6-8 hours.

### 📋 Phase 6 — Spectrum

1. `dashboard spectrum users / platforms / lines / profile / avatar`
2. Decide whether to expose `check-phone` as `dashboard projects check-phone <num>` or `dashboard spectrum check <num>`. Recommendation: latter (it's a Spectrum capability).

Estimated: ~4-6 hours, biggest set of endpoints.

### 📋 Phase 7 — Billing

1. `dashboard billing plans`
2. `dashboard billing show` — render subscription with the S3 caveat
3. `dashboard billing checkout` — open Stripe URL
4. `dashboard billing manage` — open portal

Estimated: ~2 hours.

### 📋 Phase 8 — UX polish

1. Update notifier
2. `--no-color` + `NO_COLOR=1` standard support
3. `dashboard auth status` (cross-env summary)
4. `dashboard config show`
5. Polish error UX with hints + context

Estimated: ~2 hours.

### 📋 Phase 9 — Distribution

1. `bun publish` to npm
2. GitHub Actions release workflow
3. README quickstart + screenshots
4. `npx dashboard-cli` no-install onboarding path

### 📋 Phase 10 (deferred) — Power-user features

1. `dashboard api <path>` raw passthrough
2. `dashboard alias set` user-defined shortcuts (gh-style)
3. Telemetry (only if we have a real reason)
4. `dashboard logs` (needs server-side log streaming API first)
5. Auto-update flow

---

## 7. Open questions for you

1. **Project linking** — adopt vercel's `.dashboard/project.json` model in cwd? My recommendation: **yes**, it's the single biggest UX win.
2. **`--token` env var name** — `DASHBOARD_TOKEN` vs `PHOTON_TOKEN`? I lean `DASHBOARD_TOKEN` for consistency with `DASHBOARD_API_URL` / `DASHBOARD_ENV` already in use.
3. **CLI binary name when published** — `dashboard` (collision risk on PATH? it's a generic word) or `photon-dashboard` or just `photon`? My recommendation: **`photon`** — short, brand-aligned, low collision.
4. **CI auth** — accept `--token` value generated where? Better-auth doesn't have first-class API tokens. Options: (a) reuse device-flow tokens (just persist longer), (b) add a server-side `apiKey` plugin to better-auth and a `dashboard auth tokens create` command, (c) use the access_token from `device/token` indefinitely. My recommendation: **(b) — add `apiKey` plugin** when CI need is real.
5. **Phase 5+ ordering** — link → projects writes → spectrum → billing? Or projects writes → billing → spectrum (to ship checkout sooner)? I'd default to writes-first since spectrum depends on project ownership and link makes spectrum ergonomic.

---

## 8. References

- [GitHub CLI manual](https://cli.github.com/manual/) — command grouping + `--json`/`--jq`/`--template` patterns
- [GitHub CLI output formatting](https://cli.github.com/manual/gh_help_formatting) — how `--json` discovery works
- [Vercel CLI](https://vercel.com/docs/cli) — full command surface (~50 commands)
- [Vercel CLI global options](https://vercel.com/docs/cli/global-options) — `--token`, `--scope`, `--project`, `--cwd`, `--no-color`, etc.
- [NO_COLOR standard](https://no-color.org)
- [RFC 8628 — Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [Better Auth — Device Authorization plugin](https://better-auth.com/docs/plugins/device-authorization)
- [photon-hq/dashboard architecture review](../../../Photon-Codes/dashboard/docs/architecture-review.md) — S1/S2/S3 + 9 majors
