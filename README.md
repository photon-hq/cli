# Photon CLI

Photon CLI is the command-line client for [Photon](https://photon.codes). It
signs you in, manages your organizations and projects, and calls the Photon API
from a terminal, a script or an agent.

## Install

Install the npm package with your package manager. It runs on Node.js 22 or
newer.

```sh
npm install --global @photon-ai/cli
```

```sh
pnpm add --global @photon-ai/cli
```

```sh
bun add --global @photon-ai/cli
```

With Yarn, add it to a project, and run every `photon` command in this README
as `yarn photon` from that project's folder:

```sh
yarn add --dev @photon-ai/cli
yarn photon --version
```

Or install the standalone binary, which doesn't need Node.js. The installer
downloads the latest [release](https://github.com/photon-hq/cli/releases),
checks its SHA-256 checksum and installs `photon` in `~/.local/bin` by default.

On macOS and Linux:

```sh
curl -fsSL https://github.com/photon-hq/cli/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/photon-hq/cli/releases/latest/download/install.ps1 | iex
```

To install the binary by hand, download the archive for your platform from the
[latest release](https://github.com/photon-hq/cli/releases/latest), check it
against the release's `checksums.txt`, and put `photon` on your `PATH`.

Open a new terminal so it picks up the new `PATH`, then check that it runs:

```sh
photon --version
```

A `2.x` version is Photon CLI 1.0. By default, pnpm and Yarn install a release
only once it has been on npm for a day, and an older `photon` on your `PATH` can
run first.
The installation guide's
[troubleshooting](https://photon.codes/docs/cli/installation#troubleshooting)
covers both.

## Get started

```sh
photon login                         # sign in, approving the device code in a browser
photon project list                  # list the projects in your organization
photon link --project <project-id>   # use that project for commands in this folder
```

Where no one can approve a sign-in, as in CI, put a Photon key in
`PHOTON_API_TOKEN` instead of running `photon login`. Add `--json` to any
command for output a program can read, and `--help` to see its options.

## Documentation

- [CLI guide](https://photon.codes/docs/cli): installation, sign-in, projects,
  JSON output and automation.
- [Command reference](https://photon.codes/docs/cli/reference): every command
  and option.

## Photon CLI 1.0

Photon CLI 1.0 is the previous CLI, published as `@photon-ai/cli` versions
2.x. Its source lives on the
[`legacy`](https://github.com/photon-hq/cli/tree/legacy) branch. To install
it:

```sh
npm i -g @photon-ai/cli@legacy
```

## Issues and security

Report bugs and request features in
[issues](https://github.com/photon-hq/cli/issues). Report security problems
privately, as [SECURITY.md](SECURITY.md) describes.

## Contributing

This repository holds the CLI's source as published with each release. Changes
are made in Photon's private repository and reach this one with the next
release, so pull requests aren't accepted here; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). The npm package and the binaries ship the licenses of the
packages they bundle in `THIRD_PARTY_NOTICES.txt`.
