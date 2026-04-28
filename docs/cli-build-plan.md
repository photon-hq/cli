# dashboard-cli Build Plan

> Companion to `cli-design.md`. That doc establishes principles; this one
> turns them into work items. Each capability has a concrete command shape,
> the API endpoint(s) it consumes, edge cases, files to add/modify, and an
> effort estimate. Pickable in any order within a phase.

## 0. Resolved decisions

The 5 open questions from `cli-design.md` §7 are answered here so the
plan can be acted on. Override any of them and adjust the plan accordingly.

| Question | Decision | Reason |
|---|---|---|
| Project linking model | **Adopt vercel pattern**: `.dashboard/project.json` in cwd, written by `dashboard link`. Resolution order: `--project` flag → `DASHBOARD_PROJECT_ID` env → linked file → error. | Single biggest UX win; pattern is mature, users already know it from vercel/next/etc. |
| `DASHBOARD_TOKEN` env name | **`DASHBOARD_TOKEN`** | Consistent with existing `DASHBOARD_API_URL`, `DASHBOARD_ENV`, `DASHBOARD_CONFIG_DIR`. Avoid `PHOTON_*` mix. |
| Binary name on npm | **`photon`** (package: `@photon/cli`, bin: `photon`) | Short, brand-aligned. `dashboard` is too generic; `photon-dashboard` is verbose. Acceptable risk: collision with existing `photon` packages on npm — verify before claiming. |
| CI auth path | **Defer**. v1 ships with `--token <T>` and `DASHBOARD_TOKEN` env that accept the same access token issued by `device/token`. Acceptable for solo / small-team CI. Long-term: add better-auth `apiKey` plugin server-side and `dashboard auth tokens create` to the CLI. | Server change is out of CLI scope. Device tokens work for now (default 7d expiry, re-issue via re-login). |
| Phase ordering | **link → projects writes → spectrum → billing → polish → distribute** | `link` makes everything else ergonomic; writes unblock spectrum (which is per-project); billing is small + URL-only; polish before publish. |

Two new decisions surfaced while writing this plan:

| Question | Decision | Reason |
|---|---|---|
| Should the linked project be persisted in cwd's `.dashboard/` or in user config keyed by directory? | **cwd's `.dashboard/`** like vercel. | Matches expectations; survives `git clone`; can be `.gitignore`d per-project; doesn't require central registry. |
| What's the right `.dashboard/` shape? | `{projectId, projectName, envName}` — projectName cached for display, envName scopes the link to one environment so prod-link in one repo + staging-link in another works. | Caching projectName means `dashboard projects show` doesn't need a round-trip just to print the header. |

---

## 1. Cross-cutting infrastructure

These land **first** because every command in §2 depends on them. Build them as a single PR before any new commands.

### 1.1 TTY-aware UX layer

**Goal**: every command behaves correctly piped, in CI, in interactive shell.

**File**: `src/lib/tty.ts` (new)

```ts
export const isTTY = (): boolean => Boolean(process.stdout.isTTY);
export const isCI = (): boolean => Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
export const useColors = (): boolean =>
  isTTY() && !process.env.NO_COLOR && !process.env.DASHBOARD_NO_COLOR;
```

**Modify**: `src/lib/output.ts` to honor `useColors()` — wrap picocolors so it no-ops when colors disabled. picocolors itself respects `NO_COLOR`, but our spinner/table emit ANSI directly; gate them on `isTTY()`.

**Effort**: 30 min.

### 1.2 Confirmation prompts (`--yes` / `-y`)

**Goal**: every destructive command (`delete`, `regenerate-secret`, `unlink`) requires explicit confirmation in TTY, requires `--yes` flag in non-TTY.

**File**: `src/lib/interactive.ts` (new)

```ts
import { confirm, isCancel } from "@clack/prompts";
import { isTTY } from "~/lib/tty.ts";
import { die } from "~/lib/output.ts";

export async function confirmDestructive(opts: {
  message: string;
  yes: boolean;          // --yes / -y flag
  fallbackHint?: string; // shown in non-TTY when --yes not passed
}): Promise<void> {
  if (opts.yes) return;
  if (!isTTY()) {
    die(opts.fallbackHint ?? `Pass --yes to confirm.`);
  }
  const answer = await confirm({ message: opts.message, initialValue: false });
  if (isCancel(answer) || !answer) die("Aborted.");
}
```

**Effort**: 30 min.

### 1.3 `--token` flag + `DASHBOARD_TOKEN` env (CI auth)

**Goal**: scriptable invocation without `dashboard login`. Token is the same `access_token` from `device/token` (which is a session token, since `bearer()` is loaded server-side).

**Modify**: `src/lib/api.ts` `getApi()` to accept `opts.token`:

```ts
export async function getApi(opts: ApiOptions = {}): Promise<ApiContext> {
  const token = opts.token ?? process.env.DASHBOARD_TOKEN;
  // ... if token set, skip credential lookup, build headers from it directly
}
```

**Modify**: every command's `.option(...)` chain to add:

```ts
.option("-t, --token <token>", "API token (overrides stored creds)")
```

**Caveat**: if both `--token` and stored creds present, `--token` wins. If `--token` invalid, server returns 401 — surface as `Invalid token (env=production)`.

**Effort**: 1 h (touches every command, but mechanical).

### 1.4 `--debug` flag + `DASHBOARD_DEBUG=1`

**Goal**: dump every HTTP request/response with timing for troubleshooting.

**File**: `src/lib/debug.ts` (new) — exposes `debug(msg, ...)` that writes to stderr when enabled.

**Modify**: `src/lib/api.ts` to wrap `fetch` and log method/url/status/duration. Also log Eden treaty's resolved request shape.

**Modify**: `src/lib/auth-client.ts` similar treatment for `authClient.device.code` / `device.token` calls.

**Effort**: 1 h.

### 1.5 Error UX with hints + context

**Goal**: every error has a one-liner + optional hint + optional context, like the design doc shows.

**File**: `src/lib/output.ts` extend `die()` to support hints:

```ts
export function die(message: string, opts?: { hint?: string; context?: string }): never {
  console.error(c.error(message));
  if (opts?.hint) console.error(c.hint(`  Hint: ${opts.hint}`));
  if (opts?.context) console.error(c.dim(`  ${opts.context}`));
  process.exit(1);
}
```

Also add a top-level error handler in `src/index.ts` that:
- 401 → `Session expired. Run dashboard login --env <name>.`
- 403 → `You don't have permission to do that.`
- 404 → `Not found: <resource>.`
- 5xx → `Server error. Try again or contact support.`
- network → `Could not reach <url>. Check your connection.`

**Effort**: 1 h (mostly migration of existing `die()` calls + the central handler).

### 1.6 Project linking (foundational for §2)

**Goal**: persist the active project in cwd, resolve it on every command.

**File**: `src/lib/link.ts` (new):

```ts
export interface ProjectLink {
  projectId: string;
  projectName: string; // display-only cache
  envName: string;     // scopes link to an env
  linkedAt: string;    // ISO
}

export async function loadLink(cwd = process.cwd()): Promise<ProjectLink | null>;
export async function saveLink(link: ProjectLink, cwd = process.cwd()): Promise<void>;
export async function clearLink(cwd = process.cwd()): Promise<void>;
```

Storage: `<cwd>/.dashboard/project.json`. Add `.dashboard/` to the README's recommended `.gitignore` snippet.

**File**: `src/lib/api-context.ts` (new) — central project resolution:

```ts
export async function resolveProject(opts: {
  flagProjectId?: string;
  envOverride?: string;
}): Promise<{ projectId: string; envName: string }> {
  // 1. --project flag
  if (opts.flagProjectId) return { projectId: opts.flagProjectId, envName: ... };
  // 2. DASHBOARD_PROJECT_ID env
  if (process.env.DASHBOARD_PROJECT_ID) return { ... };
  // 3. .dashboard/project.json (must match resolved env)
  const link = await loadLink();
  if (link) {
    if (link.envName !== resolvedEnv) {
      die(`Linked project is for env "${link.envName}" but current env is "${resolvedEnv}".`,
          { hint: `Pass --env ${link.envName}, or re-link: dashboard link <id>` });
    }
    return { projectId: link.projectId, envName: link.envName };
  }
  // 4. error
  die("No project linked.", { hint: "Run `dashboard link <id>` or pass --project <id>." });
}
```

**Effort**: 2 h (file + integration into commands that need it, see §2).

### 1.7 `--no-color` standard

picocolors auto-respects `NO_COLOR`. We just need to make sure cli-table3 and @clack/prompts also respect it (clack does; cli-table3 honors it via the `style.head: []` we already use). Nothing to do beyond keeping the codepath clean.

**Effort**: 0 (verify only).

**Total Phase 1.x infrastructure: ~5-6 h.**

---

## 2. Command specs

Every TODO command from `cli-design.md` §3, fully specified.

For each command:
- **Cmd line**: exact commander definition (the registration call).
- **Args / Options**: argument names, flag definitions, defaults.
- **Behavior**: TTY interactive vs non-TTY scriptable.
- **API**: which endpoint(s).
- **Errors**: exit codes + UX.
- **Files**: what to add/modify.
- **Test plan**: explicit checks.
- **Effort**: ~rough hours.

### 2.1 `dashboard link <id>` / `dashboard unlink`

**Goal**: persist the active project for the cwd so subsequent commands don't need `--project`.

**Cmd line**:
```ts
program.command("link <id>")
  .description("link this directory to a dashboard project")
  .option("-e, --env <name>", "environment for the link (defaults to current)")
  .action(...)

program.command("unlink")
  .description("remove the project link for this directory")
  .option("-y, --yes", "skip confirmation")
  .action(...)
```

**Behavior**:
- `link <id>`: validates the project exists by calling `GET /api/projects/:id` with current env's auth. If 401: `Not authenticated for env=<x>`. If 404: `Project not found`. If 200: write `.dashboard/project.json` with `{projectId, projectName, envName, linkedAt}`. Print: `✓ Linked to <name> (id=<id>) on <env>.`
- `unlink`: confirm in TTY (`--yes` to skip), then `clearLink()`. Print: `✓ Unlinked.`
- `link --status` (subcommand): show current link if any, else "No link." Useful for scripts.

**API**: `GET /api/projects/:id` for validation only.

**Errors**: 401, 404, network, refusing to overwrite without `--force` if a different project is already linked.

**Files**:
- `src/commands/link.ts` (new)
- `src/index.ts` register

**Effort**: 1.5 h.

### 2.2 `dashboard projects create`

**Goal**: provision a new project.

**Cmd line**:
```ts
.command("create")
.description("create a new project")
.option("-n, --name <name>", "project name")
.option("-l, --location <location>", "location (default: United States)")
.option("--spectrum", "enable Spectrum")
.option("--no-spectrum", "disable Spectrum")
.option("--template", "use as template")
.option("--observability", "enable observability")
.option("--link", "link the new project after creation")
.option("--json", "output JSON")
.action(...)
```

**Behavior**:
- TTY + missing flags: prompt for `name` (required, non-empty), `location` (default "United States"), `spectrum` (default false), `template` (default false), `observability` (default false). Use `@clack/prompts`.
- Non-TTY: `--name` required. Other flags default to false / "United States" if unset.
- Calls `POST /api/projects` with body.
- On success: render created project (table-style or JSON). If `--link`, additionally write the link file.
- On failure: surface server error, e.g. `Project name is required` returned as `{error: "..."}`.

**API**: `POST /api/projects`.

**Files**: `src/commands/projects.ts` extend.

**Effort**: 2 h (interactive prompts are most of it).

### 2.3 `dashboard projects update [<id>]`

**Cmd line**:
```ts
.command("update [id]").alias("edit").alias("set")
.option("-n, --name <name>", "new name")
.option("-l, --location <location>", "new location")
.option("--spectrum", "enable Spectrum")
.option("--no-spectrum", "disable Spectrum")
.option("--observability")
.option("--no-observability")
.option("-p, --project <id>", "project (defaults to linked)")
.option("--json")
.action(...)
```

**Behavior**:
- `id` arg or `--project` or linked. At least one mutation flag required (else: error with hint).
- Calls `PATCH /api/projects/:id` with only the changed fields.

**API**: `PATCH /api/projects/:id`.

**Files**: extend `projects.ts`.

**Effort**: 1 h.

### 2.4 `dashboard projects delete [<id>]`

**Cmd line**:
```ts
.command("delete [id]").alias("rm").alias("remove")
.option("-p, --project <id>")
.option("-y, --yes", "skip confirmation")
.action(...)
```

**Behavior**:
- Resolves project (id arg / --project / linked).
- TTY: prompt `Delete project "<name>"? This cannot be undone.` requires "yes" typed (not just y/n) — gh's pattern for high-stakes deletes.
- Non-TTY: requires `--yes`.
- Calls `DELETE /api/projects/:id`.
- If linked project deleted, also clears the link.

**API**: `DELETE /api/projects/:id`.

**Errors**: 404, 403 (other user's project).

**Files**: extend `projects.ts`.

**Effort**: 1 h.

### 2.5 `dashboard projects regenerate-secret [<id>]`

**Cmd line**:
```ts
.command("regenerate-secret [id]").alias("rotate-secret")
.option("-p, --project <id>")
.option("-y, --yes")
.option("--json")
.action(...)
```

**Behavior**:
- Confirm destructive (same pattern as delete).
- Calls `POST /api/projects/:id/regenerate-secret`.
- Prints new secret on success. **Warn user it's shown only once** (or, if response includes it every time, drop the warning).
- `--json` outputs `{secret: "..."}`.

**API**: `POST /api/projects/:id/regenerate-secret`.

**Files**: extend `projects.ts`.

**Effort**: 1 h.

### 2.6 `dashboard projects open [<id>]`

**Cmd line**:
```ts
.command("open [id]")
.option("-p, --project <id>")
.option("--no-browser", "print URL instead of opening")
.action(...)
```

**Behavior**:
- Resolves project.
- Computes URL: `${envBaseUrl}/dashboard/${projectId}`.
- Calls `open(url)` unless `--no-browser`.
- Prints the URL either way.

**API**: none (URL is constructed locally).

**Files**: extend `projects.ts` + a `src/lib/browser.ts` helper.

**Effort**: 30 min.

### 2.7 `dashboard projects check-phone <number>`

**Cmd line**:
```ts
.command("check-phone <number>")
.option("--json")
.action(...)
```

**Behavior**:
- `GET /api/projects/check-availability?phoneNumber=<num>`.
- Prints `Available` or `Taken (project: <name>)` based on response.

**API**: `GET /api/projects/check-availability`.

**Caveat**: this endpoint is currently authenticated with no per-user filtering — server-side concern noted in `cli-design.md` §1.1. CLI just consumes it; doesn't make it worse.

**Effort**: 30 min.

### 2.8 `dashboard profile init`

**Goal**: replace the web `/onboarding` flow.

**Cmd line**:
```ts
.command("init").description("set up your developer or organization profile")
.option("--type <type>", "developer | organization")
.option("--json")
.action(...)
```

**Behavior**:
- TTY: prompt: "Are you setting up as a developer or organization?" then prompt for relevant fields based on choice. Submit to `POST /api/profile/developer` or `/organization`.
- Non-TTY: requires `--type` and all required fields as flags. (Open question: which fields are required server-side? Need to scan profile schema.)
- Refuses to run if profile already exists (suggest `dashboard profile update`).

**API**: `POST /api/profile/developer` or `POST /api/profile/organization`.

**Files**: `src/commands/profile.ts` extend.

**Effort**: 2 h (depends on field count; if many fields, longer).

### 2.9 `dashboard profile update [--field=value...]`

**Cmd line**:
```ts
.command("update").alias("edit")
.option("--<field> <value>", "...")  // dynamic: see notes
.option("--json")
.action(...)
```

**Notes**: profile schema isn't enumerated in this plan (would need to read `apps/api/src/db/schema.ts` for developer / organization profile fields). Approach: provide both
- `--field key=value` repeatable for arbitrary fields, OR
- explicit `--name`, `--bio`, `--website`, etc. — preferable for IDE-typed UX.

Recommend **explicit flags** with a TODO to keep them in sync with the schema.

**API**: `POST /api/profile/developer` or `/organization` (it's an upsert).

**Effort**: 1 h.

### 2.10 `dashboard auth status`

**Goal**: cross-environment login summary, like `gh auth status`.

**Cmd line**:
```ts
.command("status")
.option("--json")
.action(...)
```

**Behavior**:
- Lists all envs (built-in + custom).
- For each: shows whether logged in, the email if so, the last-login time.
- If `--json`, structured array.

**API**: optionally calls `/api/profile` for each authed env to validate live status (skip if expensive).

**Files**: `src/commands/auth.ts` (new file, registers an `auth` subgroup so this and future `auth tokens` commands live together. Note: existing `login`/`logout` could move under `auth` group too — but breaking changes are bad; keep them at top-level AND add `dashboard auth login` as alias for compat).

**Effort**: 1 h.

### 2.11 Spectrum: `users / platforms / lines / profile / avatar`

The biggest sub-surface. Group as `dashboard spectrum <noun> <verb>`. Every command takes `[--project <id>]` (defaults to linked).

#### 2.11.a `spectrum users`

```
dashboard spectrum users list                           # GET /api/projects/:id/spectrum/users
dashboard spectrum users add [opts]                     # POST .../spectrum/users
dashboard spectrum users remove <user-id> [-y]          # DELETE .../spectrum/users/:userId
```

**Add flags** (need to confirm against `apps/api/src/plugins/projects.ts` line 426 area for the actual body schema): `--phone`, `--email`, `--first-name`, `--last-name`, `--invite` (boolean: send onboarding email?).

**Effort**: 2 h.

#### 2.11.b `spectrum platforms`

```
dashboard spectrum platforms list                       # GET .../platforms
dashboard spectrum platforms add [opts]                 # POST .../platforms
```

**Open question**: server doesn't currently expose DELETE for platforms (only POST). Either advocate for adding it server-side, or document the limitation in the help text.

**Effort**: 1 h.

#### 2.11.c `spectrum lines`

```
dashboard spectrum lines list                           # GET .../lines
dashboard spectrum lines add [opts]                     # POST .../lines
dashboard spectrum lines remove <line-id> [-y]          # DELETE .../lines/:lineId
```

**Effort**: 1.5 h.

#### 2.11.d `spectrum profile`

```
dashboard spectrum profile show                         # GET .../spectrum/profile
dashboard spectrum profile update [opts]                # PATCH .../spectrum/profile
```

**Effort**: 1 h.

#### 2.11.e `spectrum avatar upload <file>`

```
dashboard spectrum avatar upload <file>                 # GET .../spectrum/avatar-upload-url, then PUT to S3
```

**Behavior**:
- `GET .../avatar-upload-url` returns `{url, fields, key, ...}` (presigned).
- CLI then `PUT` to that URL with the file body. Need to use `Bun.file(path)` and standard fetch.
- Print `✓ Uploaded`. Optionally print the resulting public URL if returned.

**Effort**: 1.5 h (presigned upload is fiddly; need to inspect actual response shape first).

**Total Spectrum subgroup**: ~7 h (large surface area).

### 2.12 Billing: `plans / show / checkout / manage`

```
dashboard billing plans                                 # GET /api/billing/plans
dashboard billing show [-p <id>]                        # GET /api/projects/:id/subscription
dashboard billing checkout [-p <id>] [--plan <id>] [--qty N] [--no-browser]   # POST /api/billing/checkout
dashboard billing manage [-p <id>] [--no-browser]       # POST /api/projects/:id/subscription/manage
```

**Special handling for `show`**: until architecture-review S3 is fixed, the API may return tier `"unknown"` for paying users. **Print a warning** below the result: `(server may return "unknown" while subscription syncs — see architecture-review S3.)`. Drop the warning once S3 lands.

**Special handling for `checkout` / `manage`**:
- Response includes a Stripe URL.
- CLI prints the URL prominently and `open()`s it (unless `--no-browser`).
- Exits 0 immediately — does NOT poll for completion.

**Files**: `src/commands/billing.ts` (new).

**Effort**: 2 h.

### 2.13 `dashboard config show`

**Goal**: dump active configuration for support / debugging. **Never** print secrets.

```
dashboard config show
```

Output (text):
```
Current env:        staging (https://staging-app.photon.codes)
Linked project:     my-app (id=abc123)
Logged in envs:     production, staging
Config dir:         ~/.config/photon-dashboard
```

`--json` for scripts.

**Effort**: 30 min.

### 2.14 `dashboard api <path>` — power user escape hatch (v2)

```
dashboard api <path> [-X METHOD] [-d <body>] [-F field=value]
```

Authenticated raw request. Useful when a command isn't yet implemented or for one-off scripts. Defer to v2.

**Effort**: 2 h when prioritized.

---

## 3. Phase ordering with rationale

### Phase 5 — Cross-cutting infrastructure + project linking
**Items**: §1.1, §1.2, §1.3, §1.4, §1.5, §1.6
**Why first**: every other command depends on `--token`, `--yes`, project resolution, error UX.
**Effort**: ~5-6 h
**Blocks**: nothing

### Phase 6 — Project writes
**Items**: §2.2, §2.3, §2.4, §2.5, §2.6, §2.7, §2.8, §2.9
**Why next**: closes the gap with the web `/dashboard/new` and `/dashboard/[id]/settings` flows. Independently shippable; doesn't require Spectrum/Billing.
**Effort**: ~8 h
**Blocks**: Spectrum (link makes spectrum ergonomic, but the sub-resources can technically be hit with `--project` too)

### Phase 7 — Spectrum
**Items**: §2.11
**Why third**: largest endpoint count; needs link + project writes to feel right; users typically don't manage Spectrum until after they have a project.
**Effort**: ~7 h
**Blocks**: nothing

### Phase 8 — Billing
**Items**: §2.12
**Why fourth**: smallest, mostly URL-handoff-to-browser. Needs `dashboard billing show` to look right, which depends on architecture-review S3 server fix for production correctness — but ship anyway and warn.
**Effort**: ~2 h
**Blocks**: nothing

### Phase 9 — Polish
**Items**: §2.10 (`auth status`), §2.13 (`config show`), update-notifier, error UX refinement, `dashboard --version` improvement (show node/bun versions for support)
**Effort**: ~3 h
**Blocks**: nothing

### Phase 10 — Distribution
- Verify `photon` is available on npm. Reserve early.
- Add `release-please` or manual semver process.
- GitHub Actions: publish to npm on tag.
- README quickstart with screencast.
- `bunx photon login` flow tested.
- Eventually: standalone binary via `bun build --compile` and put on GitHub Releases for users without bun.

**Effort**: ~3 h.

### Phase 11 (deferred)
- §2.14 `dashboard api`
- `dashboard alias set` (gh-style)
- `dashboard logs` (needs server-side log streaming first)
- `dashboard auth tokens create` (needs better-auth `apiKey` plugin server-side)
- Telemetry (only with strong reason)

---

## 4. File-by-file changelist

### New files (Phase 5)

| File | Purpose | Lines (rough) |
|---|---|---|
| `src/lib/tty.ts` | TTY/CI/color detection | ~20 |
| `src/lib/interactive.ts` | clack wrappers, confirmDestructive | ~40 |
| `src/lib/debug.ts` | `--debug` logger | ~25 |
| `src/lib/link.ts` | `.dashboard/project.json` r/w | ~70 |
| `src/lib/api-context.ts` | `resolveProject()` central | ~60 |
| `src/lib/browser.ts` | `open()` wrapper | ~20 |
| `src/commands/link.ts` | `link` / `unlink` | ~80 |

### New files (Phase 6)

| File | Purpose |
|---|---|
| (extend `src/commands/projects.ts`) | create / update / delete / regenerate-secret / open / check-phone |
| (extend `src/commands/profile.ts`) | init / update |

### New files (Phase 7)

| File | Purpose |
|---|---|
| `src/commands/spectrum/index.ts` | group registration |
| `src/commands/spectrum/users.ts` | spectrum users CRUD |
| `src/commands/spectrum/platforms.ts` | spectrum platforms |
| `src/commands/spectrum/lines.ts` | spectrum lines |
| `src/commands/spectrum/profile.ts` | spectrum profile |
| `src/commands/spectrum/avatar.ts` | avatar upload |

### New files (Phase 8)

| File | Purpose |
|---|---|
| `src/commands/billing.ts` | plans / show / checkout / manage |

### New files (Phase 9)

| File | Purpose |
|---|---|
| `src/commands/auth.ts` | auth status (and home for future apiKey commands) |
| `src/commands/config.ts` | config show |
| `src/lib/update-notifier.ts` | npm update check |

### Modified globally

| File | Reason |
|---|---|
| `src/lib/api.ts` | `--token` support, `--debug` logging, retry on transient network |
| `src/lib/output.ts` | `die()` with hints, `printJson` for non-array shapes |
| `src/index.ts` | register all new groups, central error handler |
| `src/lib/credentials.ts` | drop `hello.ts` placeholder reference if any leaked |
| `src/commands/hello.ts` | **delete** before v1 publish |
| `package.json` | new deps: `update-notifier`, possibly `@inquirer/select` if `@clack/prompts` insufficient (unlikely) |
| `README.md` | full rewrite for end-user audience |

---

## 5. Test plan (per phase)

Manual + automated. Until we have a CI test harness, manual is the pragmatic choice.

### Phase 5 manual

- `dashboard --token <bad>` → `Invalid token` (401 from server)
- `dashboard projects ls --token <good>` → works, no stored creds touched
- `DASHBOARD_TOKEN=<good> dashboard projects ls` → same
- `dashboard projects ls | cat` (non-TTY) → no spinners, no colors
- `NO_COLOR=1 dashboard projects ls` → no colors even in TTY
- `dashboard --debug projects ls` → request/response logged to stderr
- `dashboard link abc123` then `dashboard projects show` (no args) → uses link
- `cd /tmp && dashboard projects show` (no link) → friendly error with hint
- `dashboard unlink` (TTY) → confirms; `--yes` skips
- Path traversal: `dashboard env add ../foo https://x` → rejected by `assertSafeEnvName`

### Phase 6 manual

- `dashboard projects create` (TTY, no flags) → all prompts; project created; `dashboard projects ls` shows it.
- `dashboard projects create --name X --location US --spectrum --link` (non-TTY) → created and linked.
- `dashboard projects update --name "Y"` (with link) → renamed.
- `dashboard projects delete` (TTY) → "yes" confirm; project gone.
- `dashboard projects delete --yes` (non-TTY) → no prompt.
- `dashboard projects open` → browser opens to `.../dashboard/<id>`.
- `dashboard projects regenerate-secret -y` → new secret printed.

### Phase 7 manual

- Each `spectrum` subcommand against the linked project.
- `dashboard spectrum avatar upload ./photo.jpg` → success; visible on web `/spectrum`.

### Phase 8 manual

- `dashboard billing plans` → list.
- `dashboard billing show` → tier + status.
- `dashboard billing checkout --plan <id>` → URL printed + browser opens.
- `dashboard billing manage` → portal URL.

### Phase 9 manual

- `dashboard auth status` (logged into multiple envs) → table.
- `dashboard config show` → no secrets, structured.
- Trigger update-notifier by faking version; ensure banner appears in TTY only.

### Automated tests (deferred to Phase 10 setup)

- Bun-test based unit tests for `lib/env.ts` (env name validation), `lib/credentials.ts` (round-trip), `lib/link.ts`.
- Mock the server with a tiny Elysia app for integration tests of `lib/api.ts`.
- E2E against a `dev` env via docker-compose (dashboard's existing setup) — gated behind a separate npm script so default `bun test` doesn't need docker.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Eden treaty types degrade for new endpoints we add (Drizzle inference) | Continue using `src/lib/types.ts` DTO casts at the boundary. If it gets unwieldy, push for `response: t.Object(...)` schemas server-side. |
| better-auth device tokens default 7d expiry; CI breakage when tokens silently expire | Document in README. Plan apiKey plugin server-side for v2. |
| `photon` npm package name collision | Verify `npm view photon` early. Fallback names: `@photon/cli`, `@photon-codes/cli`. |
| Spectrum endpoint shapes shift while we're integrating | Vendored types (`types/api.d.ts`) is a snapshot — `bun run sync:api` rebuilds. Add a CI check that fails if the shape changed without a matching CLI fix. |
| Commander.js becomes a constraint as command count grows | If we hit a wall (custom help formatting, dynamic completions), migrate to `clipanion` or `@oclif`. Not v1 concern. |
| Rate limiting on staging during heavy test cycles | Already handled via 429 → slow_down. Document. |

---

## 7. What's *not* in scope

To keep v1 shippable:

- **No** server-side changes (besides the one-time `bearer()` plugin add, already done in dashboard#58)
- **No** `dashboard logs` (needs a streaming endpoint server-side)
- **No** template gallery beyond what dashboard exposes via projects
- **No** observability surface (`/dashboard/[id]/observability` is out)
- **No** debug page (`/dashboard/[id]/debug` is internal)
- **No** GUI mode / TUI
- **No** offline cache
- **No** plugin/extension system
- **No** auto-update (publish, but don't auto-run on update)
- **No** telemetry

When any of these become real needs, they get their own design pass.

---

## 8. Open questions remaining

After this plan, two things genuinely require product input before I can proceed past Phase 6:

1. **Profile schema fields** — what's the canonical list of developer / organization profile fields? Need to read `apps/api/src/db/schema.ts` and confirm with the team which are user-editable. Drives the flag set for `profile init` and `profile update`.

2. **Spectrum endpoint body shapes** — `POST /api/projects/:id/spectrum/users`, `POST /api/projects/:id/lines`, `POST /api/projects/:id/platforms` body validation isn't documented here. Need to read each endpoint and translate to flags. Light work but requires reading the actual handlers.

Both are things to resolve at the start of Phase 6 / Phase 7 respectively, not blockers for Phase 5.

---

## 9. Total effort estimate

| Phase | Hours |
|---|---|
| Phase 5 (infrastructure + linking) | 5-6 |
| Phase 6 (project writes + profile) | 8 |
| Phase 7 (Spectrum) | 7 |
| Phase 8 (Billing) | 2 |
| Phase 9 (Polish) | 3 |
| Phase 10 (Distribution) | 3 |
| **Total to v1.0 publish** | **28-30** |

That's ~1 dev-week of focused work, or 2-3 weeks part-time.

---

## 10. Definition of done for v1.0

- [ ] All commands in §2 implemented and manually tested against staging
- [ ] All cross-cutting flags (`--token`, `--yes`, `--no-color`, `--debug`, `--json`) work consistently
- [ ] `dashboard link` works; project resolution order verified with all 4 cases
- [ ] README rewritten for end-user audience with quickstart + screencast
- [ ] Published to npm under `@photon/cli` (or fallback name)
- [ ] `npx @photon/cli login` runs the device flow successfully
- [ ] `bun install -g @photon/cli && photon login` works on a clean machine
- [ ] `update-notifier` shows on outdated versions
- [ ] All known E2E paths verified against production env (not just staging)
- [ ] CI check that runs `bun run sync:api` and fails if `types/api.d.ts` would change (forces explicit sync commits)

When all 10 are checked, ship the announcement.
