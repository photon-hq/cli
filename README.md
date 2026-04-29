# Photon CLI

Typed terminal UI for the [Photon Dashboard](https://photon.codes). Replaces the web UI for everyday work — manage projects, Spectrum users / lines / platforms, billing, and your developer profile from a terminal.

```sh
bun add -g @photon-ai/cli
photon login
photon projects ls
```

> **Bun required.** This CLI ships as a Bun bundle. Install Bun: `curl -fsSL https://bun.sh/install | bash`. Standalone binaries (no Bun needed) are attached to each [GitHub Release](https://github.com/photon-hq/cli/releases) for macOS (arm64 / x64) and Linux (x64 / arm64).

---

## Quickstart

```sh
# 1. Install
bun add -g @photon-ai/cli

# 2. Log in (opens a browser to approve the device)
photon login

# 3. Link a project so future commands default to it
photon projects ls
photon link <project-id>

# 4. Off you go
photon projects show
photon spectrum users ls
photon billing show
```

`pho` is an alias for `photon` for high-frequency commands:

```sh
pho ls          # photon projects ls
pho whoami
```

---

## Concepts

### Environments

Every command operates against an **environment** (production by default). Built-ins:

| Name | URL |
|---|---|
| `production` | `https://app.photon.codes` |
| `staging` | `https://staging-app.photon.codes` |
| `dev` | `http://localhost:3001` |

```sh
photon env list                              # show all
photon env use staging                       # persist as default
photon env add my-test https://my.test.tld   # add a custom env
photon --env staging projects ls             # one-off override
PHOTON_ENV=staging photon projects ls        # same, via env var
```

Credentials are stored **per environment** (`~/.config/photon/credentials/<env>.json`, mode 600), so you can be logged into prod and dev simultaneously.

### Project linking

Most commands operate on a single project. Rather than passing `--project <id>` every time, link a project for the current env:

```sh
photon link abc123                  # writes ~/.config/photon/links/<env>.json
photon spectrum users ls            # implicit project from link
photon projects show                # same
photon link:status                  # see what's linked across envs
photon unlink                       # clear the link
```

Resolution order: `--project <id>` flag → `$PHOTON_PROJECT_ID` → linked project → friendly error.

### CI / scripting

Authenticate once locally, copy the token from `~/.config/photon/credentials/<env>.json`, and use it in CI:

```sh
photon --token "$PHOTON_TOKEN" projects ls
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
├── env list/use/add/remove/current                     env management
├── login [--env] [--no-browser]                        device-auth login
├── logout [--env]                                      clear creds
├── whoami [--env]                                      who am I on this env
├── auth status                                         login state across envs
├── config show                                         dump active config
├── link <id>                                           link project for env
├── unlink                                              clear link
├── link:status                                         linked projects (all envs)
├── projects
│   ├── ls                                              list projects
│   ├── show [id]                                       project detail
│   ├── create [-n --location --spectrum ...] [--link]  new project
│   ├── update [id] [...]                               rename / toggle flags
│   ├── delete [id] [-y]                                permanent delete
│   ├── regenerate-secret [id] [-y]                     rotate Spectrum secret
│   ├── open [id]                                       open dashboard in browser
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
    ├── checkout --plan <price-id>                      Stripe Checkout (browser)
    └── manage                                          Stripe Customer Portal
```

Run `photon <cmd> --help` for the full flag list of any command.

---

## Global flags

| Flag | Env var | Effect |
|---|---|---|
| `-e, --env <name>` | `PHOTON_ENV` | override active env |
| `-p, --project <id>` | `PHOTON_PROJECT_ID` | override linked project (per-command) |
| `-t, --token <token>` | `PHOTON_TOKEN` | bypass stored creds (CI) |
| `--json` | — | structured output (per-command, opt-in) |
| `--yes`, `-y` | — | skip destructive-action confirmation |
| `--no-browser` | — | don't auto-open browser (login, billing, projects open) |
| `--no-color` | `NO_COLOR=1`, `PHOTON_NO_COLOR=1` | disable colors (NO_COLOR standard) |
| `--debug` | `PHOTON_DEBUG=1` | verbose HTTP logs to stderr |

Other env vars: `PHOTON_CONFIG_DIR` (defaults to `~/.config/photon/`), `PHOTON_TYPES_SRC` (maintainer-only, for `bun run sync:api`), `PHOTON_NO_UPDATE_NOTIFIER=1` (mute update prompt).

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
