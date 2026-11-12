# CLI build targets

`cli.production.json` and `cli.staging.json` configure the two build targets.
Production is the default: `pnpm build`, `pnpm build:binary`,
`pnpm build:binaries` and source runs (`pnpm cli`, `pnpm dev`) build it, and
each has a `:staging` variant for internal builds. The build scripts read and
validate the target's file (`src/config-validation.mjs`), and the application
bundles the same JSON through the `#build-config` import (`src/build-config.ts`),
which `package.json` "imports" resolves like `#internal` below.
`pnpm check:config` validates both files, checks `package.json` against
staging, and checks `scripts/install.sh` and `scripts/install.ps1` against
production. This repository's npm package is the staging build's, and the
production package is built from the public repository. The committed
installers carry the production defaults: they install `photon` from
`photon-hq/cli` releases, 3.0.0 or newer. The staging release attaches copies
that `node scripts/build-installers.mjs staging` renders into `artifacts/`
with the staging defaults: `photon-staging` from the staging release
repository, 0.0.0 or newer. `pnpm test:release` tests the rules.

| | Staging (internal) | Production (public) |
| --- | --- | --- |
| Package | `@photon-hq/cli-staging`, GitHub Packages, restricted | `@photon-ai/cli`, npm, public |
| Commands | `photon-staging` | `photon` and `pho` |
| API | The staging API, `apiOrigin` in `cli.staging.json` | `https://api.photon.codes` |
| SDK | The internal SDK, GitHub Packages | `@photon-ai/api` |
| Release channel and npm tag | `staging` | `latest`, stable `3.x.y` versions only |
| State directory | `envPaths('photon-v3-staging')` | `envPaths('photon-v3-production')` |
| Keychain service | `photon-cli-v3-staging` | `photon-cli-v3-production` |
| API key variable | `PHOTON_STAGING_API_TOKEN` | `PHOTON_API_TOKEN` |
| Release repository | `releaseRepository` in `cli.staging.json` | `photon-hq/cli` |
| Package registry (`packageRegistry`) | GitHub Packages | `https://registry.npmjs.org` |

Sign-in, the selected project and organization, the operation journal and its
locks all live under the target's state directory, so a staging and a
production build on one machine never share credentials. Each target also
reads its own API key variable, so a staging key in the environment can't
reach production by accident. Credentials saved by
earlier builds (`photon` state, `photon-cli` keychain service) are not read,
moved or deleted: log in again with the new build.

Production's API origin is the public SDK's own default. Its app origin, which
WhatsApp Business onboarding links to, is the production dashboard
(`app.beta.photon.codes`). Validation refuses a production config that points
at a staging host. The configuration never holds credentials; unknown fields
are rejected.

## Internal-only code

Commands that call an operation `@photon-ai/api` doesn't have yet (MFA, 10DLC,
Call Registry and developer telemetry) live in `src/internal/`. Public code
reaches them only through the `#internal` import (`package.json` "imports"):
builds with the `photon-internal` condition resolve it to
`src/internal/index.ts`, every other build to `src/app/no-internal.ts`, which
registers nothing. The build scripts set the condition for the staging target
only (`resolveTarget` in `scripts/build-config.mjs`), so a production build
contains no internal-only code.

The SDK follows the target the same way. Source imports `@photon-ai/api`, which
`package.json` installs as the internal SDK (an npm alias). Production builds
swap in the public SDK, installed as `@photon-ai/api-public`: esbuild through
its `alias` option, Bun through a plugin, and `pnpm cli` and `pnpm dev` through
a resolve hook (`scripts/public-sdk.mjs`). The SDK version in the User-Agent
(`photon-api-ts/<version>`) follows it through the `#sdk-version` import:
`src/internal/sdk-version.ts` reads the internal SDK's version under the
condition, and `src/sdk-version.ts` the public SDK's otherwise.

`pnpm test`, `pnpm cli:staging` and the main type check use the condition and
the internal SDK. `pnpm test:production` runs the tests without it, against the
public SDK, and skips the ones that need `src/internal/` or the staging
configuration. The second type check (`tsconfig.public.json`) covers everything
outside `src/internal/` and `test/internal/` without the condition and against
the public SDK, so a public file or test that calls an operation production
doesn't publish fails `pnpm typecheck`. `pnpm docs:reference` runs without the
condition too, so the published reference is the production CLI's.
`test/internal-boundary.test.ts` fails when public code or a public test imports
`src/internal/` directly, or when a production bundle contains any of it or the
internal SDK.
