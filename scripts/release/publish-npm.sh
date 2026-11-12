#!/usr/bin/env bash
# Publishes a release's npm tarball, or, with --dry-run, checks that npm
# accepts it without publishing anything. release.yml publishes with this
# script, and every release candidate runs it with --dry-run before any
# approval, so both give npm the same argument.
#
# Usage: scripts/release/publish-npm.sh <files directory> <version> [--dry-run]
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]] || [[ $# -eq 3 && $3 != --dry-run ]]; then
  echo "Usage: $0 <files directory> <version> [--dry-run]" >&2
  exit 2
fi

# npm reads an argument like files/photon-ai-cli-3.0.0.tgz, which doesn't
# start with ./ or /, as a GitHub repository (github.com/files/...). An
# absolute path is always a file.
tarball="$(cd "$1" && pwd -P)/photon-ai-cli-$2.tgz"
if [[ ! -f $tarball ]]; then
  echo "No npm tarball at $tarball" >&2
  exit 1
fi
npm publish "$tarball" --access public --tag latest --ignore-scripts "${@:3}"
