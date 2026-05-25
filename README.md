# Photon CLI

Typed terminal UI for the [Photon Dashboard](https://photon.codes). Replaces the web UI for everyday work — manage projects, Spectrum users / lines / platforms, billing, and your developer profile from a terminal.

```sh
npx @photon-ai/cli login          # try it without installing
npm install -g @photon-ai/cli     # or install for daily use
```

Runs on Node.js >= 18. Bun is also supported but not required.

---

## Install

### One-off — no install

```sh
npx @photon-ai/cli login
npx @photon-ai/cli projects ls
```

Each invocation pulls the latest release on demand. Good for scripts, throwaway machines, or trying the CLI before committing. Works with `npx`, `pnpx`, or `bunx`.

### Global install

```sh
npm install -g @photon-ai/cli
photon login
```

After install, `photon` is on your `PATH`. The `pho` alias (see below) is created automatically the first time you run `photon`.

Also works with other package managers:

```sh
pnpm add -g @photon-ai/cli
yarn global add @photon-ai/cli
bun add -g @photon-ai/cli
```

### Standalone binary

For CI environments or systems where you don't want any runtime. Replace `<os>` and `<arch>` with your platform:

```sh
# <os>: darwin | linux    <arch>: arm64 | x64
curl -L -o /usr/local/bin/photon \
  https://github.com/photon-hq/cli/releases/latest/download/photon-<os>-<arch>
chmod +x /usr/local/bin/photon
photon --version
```

Available for macOS (arm64 / x64) and Linux (x64 / arm64). Each binary ships with a corresponding `.sha256` checksum on the same release page.

---

## Update

The CLI shows a notification when a new version is available. To update:

```sh
npm update -g @photon-ai/cli
photon --version
```

Or with other package managers:

```sh
pnpm update -g @photon-ai/cli
yarn global upgrade @photon-ai/cli
bun update -g @photon-ai/cli
```

If you're using a standalone binary, re-download the latest release:

```sh
curl -L -o /usr/local/bin/photon \
  https://github.com/photon-hq/cli/releases/latest/download/photon-<os>-<arch>
chmod +x /usr/local/bin/photon
```

`npx` / `pnpx` / `bunx` users always get the latest release automatically — no manual update needed.

To suppress the update notification, set `PHOTON_NO_UPDATE_NOTIFIER=1`.

---

## Quickstart

```sh
# 1. Log in (opens a browser to approve the device)
photon login

# 2. Pick a project for this shell session
photon projects ls
export PHOTON_PROJECT_ID=<project-id>

# 3. Off you go
photon projects show
photon spectrum users ls
photon billing show
```

### The `pho` alias

`pho` is a shortcut for `photon`, useful for high-frequency commands. It's created automatically as a sibling symlink the first time you run `photon` after installing — so no setup needed for global installs:

```sh
pho ls          # photon projects ls
pho whoami
```

(`npx` / `bunx` users don't get `pho` since they're already typing the full package name; the alias is only created when running through an installed `photon` binary.)

---

## Concepts

### Backend host

Every command talks to a backend URL. The default — and the only URL baked into the public bundle — is production (`https://app.photon.codes`). To target any other backend (your own deployment, a staging environment, a local dev server), set `PHOTON_API_HOST`:

```sh
export PHOTON_API_HOST=https://your.backend.tld
photon login
photon projects ls

# Or one-off, per command:
photon projects ls --api-host https://your.backend.tld

# Or inline:
PHOTON_API_HOST=https://your.backend.tld photon projects ls
```

Resolution order: `--api-host <url>` flag → `PHOTON_API_HOST` env var → built-in production.

`photon env current` prints the resolved host:

```sh
$ photon env current
production (https://app.photon.codes)
$ PHOTON_API_HOST=http://localhost:3000 photon env current
localhost_3000 (http://localhost:3000)
```

Credentials are stored **per host** (`$PHOTON_CONFIG_DIR/credentials/<key>.json` by default — see [config dir](#config-dir) below — mode 600), so you can be logged into multiple backends simultaneously. The `<key>` is derived from the URL — production keeps the literal name `production` for back-compat; other hosts get a sanitized hostname where `.`, `:`, and `%` are replaced with `_` (e.g. `staging-app_photon_codes`, `localhost_3000`). The `_` substitution avoids collisions between distinct hosts like `a-b.com` and `a.b-com`.

### Setting an active project

Most commands operate on a single project. Two ways to specify it:

```sh
# Per command — explicit, scoped to one invocation
photon spectrum users ls --project abc123

# Per shell — set once, applies to every photon invocation in this shell
export PHOTON_PROJECT_ID='abc123'
photon spectrum users ls
photon projects show
```

Resolution order: `--project <id>` flag → `$PHOTON_PROJECT_ID` → friendly error.

Put `export PHOTON_PROJECT_ID='…'` in your shell rc, or use [`direnv`](https://direnv.net/) to scope it to a directory. Agents and scripts should pass `--project <id>` explicitly per call (or set the env var on the spawn).

**Multi-backend note.** `$PHOTON_PROJECT_ID` is shell-global and single-valued. If you switch `PHOTON_API_HOST` between backends in the same shell, prefer `--project <id>` for the off-default calls, or use a separate shell per backend.

### CI / scripting

Authenticate once locally, copy the token from your credentials file (under `$PHOTON_CONFIG_DIR/credentials/<key>.json`), and use it in CI:

```sh
photon projects ls --token "$PHOTON_TOKEN"
# or
PHOTON_TOKEN=… photon projects ls
```

Pair with `--json` for machine-readable output:

```sh
photon projects ls --json | jq '.[] | .id'
photon billing show --json
```

`PHOTON_TOKEN` reuses the same access token issued by the device flow (default 7d expiry — re-run `photon login` when it expires). A long-lived API-key path is on the roadmap.

---

## Command reference

```text
photon
├── ping                                                hit /api/health
├── env current                                         print resolved API host
├── login [--api-host] [--no-browser]                   device-auth login
├── logout [--api-host]                                 clear creds
├── whoami [--api-host]                                 who am I on this backend
├── auth status                                         login state across backends
├── config show                                         dump active config
├── projects
│   ├── ls                                              list projects
│   ├── show [id]                                       project detail
│   ├── create [--name <n> --location <loc> --spectrum] new project
│   ├── update [id] [...]                               rename / toggle flags
│   ├── delete [id] [-y]                                permanent delete
│   ├── regenerate-secret [id] [-y]                     rotate Spectrum secret
│   ├── open [id]                                       open dashboard in browser
│   ├── upgrade [id] [tier]                             subscribe / open Stripe portal
│   └── check-phone <number>                            availability check
├── profile show / init / update                        developer / org profile
├── spectrum
│   ├── users ls / add / remove
│   ├── lines ls / add / remove
│   ├── platforms ls / enable / disable
│   ├── profile show / update
│   └── avatar upload <file>
└── billing
    ├── plans                                           available plans
    ├── show                                            current subscription
    ├── checkout [tier] [--plan <price-id>]             Stripe Checkout (browser)
    └── manage                                          Stripe Customer Portal
```

Run `photon <cmd> --help` for the full flag list of any command.

---

## Flags

Only `--debug` is truly **program-level** (works in any position). Every other flag is **per-command** and must come after the subcommand:

```sh
photon --debug projects ls --api-host https://x.tld --json    # ✓ --debug global, others per-cmd
photon --api-host https://x.tld projects ls                   # ✗ won't work (--api-host is per-cmd)
```

| Flag | Env var | Scope | Effect |
|---|---|---|---|
| `--debug` | `PHOTON_DEBUG=1` | program | verbose HTTP logs to stderr |
| `--api-host <url>` | `PHOTON_API_HOST` | per-cmd | override the backend URL |
| `-p, --project <id>` | `PHOTON_PROJECT_ID` | per-cmd | project id for this command; defaults to `$PHOTON_PROJECT_ID` |
| `-t, --token <token>` | `PHOTON_TOKEN` | per-cmd | bypass stored creds (CI) |
| `--json` | — | per-cmd | structured output (opt-in) |
| `--yes`, `-y` | — | per-cmd | skip destructive-action confirmation |
| `--no-browser` | — | per-cmd | don't auto-open browser (login, billing, projects open) |
| `--no-color` | `NO_COLOR=1`, `PHOTON_NO_COLOR=1` | program (env-driven) | disable colors (NO_COLOR standard) |

### config dir

The CLI's config root is resolved in this order:

1. `$PHOTON_CONFIG_DIR` (explicit override)
2. `$XDG_CONFIG_HOME/photon` (XDG standard)
3. `~/.config/photon/` (default)

If a legacy `~/.config/photon-dashboard/` directory exists from a prior pre-rename install, it migrates automatically to the new path on first run.

Other env vars: `PHOTON_TYPES_SRC` (maintainer-only, for `bun run sync:api`), `PHOTON_NO_UPDATE_NOTIFIER=1` (mute update prompt).

---

## Development

```sh
git clone https://github.com/photon-hq/cli
cd cli
bun install

# Run from source
bun run src/index.ts --help

# Watch
bun run dev

# Typecheck
bun run typecheck

# Build (produces dist/photon.js)
bun run build

# Sync API types from a sibling `dashboard` checkout (maintainer)
bun run sync:api
```

The CLI's API contract comes from the `@photon-ai/api-public` type bundle, vendored at `types/api.d.ts`. To refresh after the dashboard's API surface changes, run `bun run sync:api` (looks for the sibling checkout by default; set `PHOTON_TYPES_SRC` to override).

See [`docs/cli-design.md`](docs/cli-design.md) and [`docs/cli-build-plan.md`](docs/cli-build-plan.md) for the full architecture notes.

---

## Releases

Tagged via PR labels. Add the `release` label to any PR; on merge to `main`, the [Release workflow](.github/workflows/release.yaml) (a thin caller of [`photon-hq/buildspace`'s `typescript-service-release`](https://github.com/photon-hq/buildspace)) generates a version + notes, bumps `package.json`, creates a GitHub Release, and publishes to npm. Standalone binaries are uploaded by [`release-binaries.yaml`](.github/workflows/release-binaries.yaml) on each release.
