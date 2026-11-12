#!/bin/sh

set -eu

program="photon"
default_repository="photon-hq/cli"
first_version="3.0.0"

repository="${PHOTON_REPOSITORY:-$default_repository}"
version="${PHOTON_VERSION:-latest}"
bin_dir="${PHOTON_BIN_DIR:-}"
github="${PHOTON_INSTALLER_GITHUB_BASE_URL:-https://github.com}"
local_binary=""
temporary_directory=""
staged_binary=""

usage() {
  cat <<EOF
Install the Photon CLI from a GitHub release or a local standalone binary.

Usage:
  install.sh [--version VERSION] [--repo OWNER/REPO] [--bin-dir DIR]
  install.sh --from FILE [--bin-dir DIR]

Environment:
  PHOTON_VERSION          Version to install (default: the latest release)
  PHOTON_BIN_DIR          Installation directory (default: ~/.local/bin)
  PHOTON_NO_MODIFY_PATH   Leave shell profiles unchanged when set
  PHOTON_REPOSITORY       GitHub repository (default: $default_repository)
  PHOTON_INSTALLER_GITHUB_BASE_URL
                          GitHub address to download from (default: https://github.com)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      bin_dir="${2:?--bin-dir requires a directory}"
      shift 2
      ;;
    --from)
      local_binary="${2:?--from requires a file}"
      shift 2
      ;;
    --repo)
      repository="${2:?--repo requires OWNER/REPO}"
      shift 2
      ;;
    --version)
      version="${2:?--version requires a version}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$bin_dir" ]; then
  if [ -n "${XDG_BIN_HOME:-}" ]; then
    bin_dir="$XDG_BIN_HOME"
  elif [ -n "${HOME:-}" ]; then
    bin_dir="$HOME/.local/bin"
  else
    printf 'Set --bin-dir, PHOTON_BIN_DIR, XDG_BIN_HOME, or HOME.\n' >&2
    exit 1
  fi
fi

cleanup() {
  if [ -n "$temporary_directory" ] && [ -d "$temporary_directory" ]; then
    rm -rf "$temporary_directory"
  fi
  if [ -n "$staged_binary" ] && [ -f "$staged_binary" ]; then
    rm -f "$staged_binary"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail 'curl or wget is required.'
  fi
}

latest_tag() {
  latest_url="$github/$repository/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    location="$(curl --fail --silent --show-error --head --output /dev/null \
      --write-out '%{redirect_url}' "$latest_url")"
  elif command -v wget >/dev/null 2>&1; then
    location="$(wget -S --spider "$latest_url" 2>&1 |
      awk 'tolower($1) == "location:" { print $2; exit }')"
  else
    fail 'curl or wget is required.'
  fi
  printf '%s' "${location##*/}" | tr -d '\r'
}

is_supported() {
  printf '%s\n' "$1" | awk -v first="$first_version" '
    function part(value, position,    parts) {
      split(value, parts, ".")
      return parts[position] + 0
    }
    /^[0-9]+\.[0-9]+\.[0-9]+$/ {
      for (i = 1; i <= 3; i++) {
        if (part($0, i) > part(first, i)) exit 0
        if (part($0, i) < part(first, i)) exit 1
      }
      exit 0
    }
    { exit 1 }
  '
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail 'sha256sum or shasum is required to verify the download.'
  fi
}

if [ -n "$local_binary" ]; then
  if [ ! -f "$local_binary" ]; then
    fail "Binary not found: $local_binary"
  fi
  binary_source="$local_binary"
  installed_version=""
else
  case "$(uname -s)" in
    Darwin)
      platform="darwin"
      libc_suffix=""
      ;;
    Linux)
      platform="linux"
      if ldd --version 2>&1 | grep -qi musl; then
        libc_suffix="-musl"
      else
        libc_suffix=""
      fi
      ;;
    *)
      fail "Unsupported operating system: $(uname -s)"
      ;;
  esac

  case "$(uname -m)" in
    arm64 | aarch64)
      architecture="arm64"
      ;;
    x86_64 | amd64)
      architecture="x64"
      ;;
    *)
      fail "Unsupported architecture: $(uname -m)"
      ;;
  esac

  if [ "$version" = "latest" ]; then
    tag="$(latest_tag)"
    installed_version="${tag#v}"
    if ! is_supported "$installed_version"; then
      fail "No Photon CLI release $first_version or newer was found: the latest release of $repository is ${tag:-missing}."
    fi
  else
    installed_version="${version#v}"
    if ! is_supported "$installed_version"; then
      fail "Photon CLI $version can't be installed: this installer installs stable releases, version $first_version or newer."
    fi
  fi

  artifact="${program}-${platform}-${architecture}${libc_suffix}.tar.gz"
  release_url="$github/$repository/releases/download/v$installed_version"
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/photon.XXXXXX")"
  archive="$temporary_directory/$artifact"
  checksum_file="$temporary_directory/checksums.txt"

  download "$release_url/$artifact" "$archive"
  download "$release_url/checksums.txt" "$checksum_file"

  expected_checksum="$(
    awk -v artifact="$artifact" '$2 == artifact || $2 == "*" artifact { print $1 }' "$checksum_file"
  )"
  if [ -z "$expected_checksum" ]; then
    fail "No checksum found for $artifact, so nothing was installed."
  fi
  actual_checksum="$(sha256 "$archive")"
  if [ "$actual_checksum" != "$expected_checksum" ]; then
    fail "The download of $artifact failed its checksum check, so nothing was installed."
  fi

  tar -xozf "$archive" -C "$temporary_directory" "$program"
  binary_source="$temporary_directory/$program"
fi

mkdir -p "$bin_dir"
bin_dir="$(cd "$bin_dir" && pwd)"
staged_binary="$bin_dir/.${program}.$$"
install -m 0755 "$binary_source" "$staged_binary"
mv -f "$staged_binary" "$bin_dir/$program"
staged_binary=""

if [ -n "$installed_version" ]; then
  printf 'Installed Photon CLI %s at %s\n' "$installed_version" "$bin_dir/$program"
else
  printf 'Installed Photon CLI at %s\n' "$bin_dir/$program"
fi

case ":${PATH:-}:" in
  *":$bin_dir:"*) exit 0 ;;
esac

export_line="export PATH=\"$bin_dir:\$PATH\""
if [ -n "${PHOTON_NO_MODIFY_PATH:-}" ] || [ -z "${HOME:-}" ]; then
  printf 'To run %s by name, add %s to PATH:\n  %s\n' "$program" "$bin_dir" "$export_line"
  exit 0
fi
case "$bin_dir" in
  *[\"\$\`\\]*)
    printf 'To run %s by name, add %s to PATH.\n' "$program" "$bin_dir"
    exit 0
    ;;
esac

profile_line="case \":\$PATH:\" in *\":$bin_dir:\"*) ;; *) $export_line ;; esac"
fish_line="contains -- \"$bin_dir\" \$PATH; or set -gx PATH \"$bin_dir\" \$PATH"
changed=""
configured=""
unwritable=""

add_line() {
  if [ -f "$1" ] && grep -qxF "$2" "$1"; then
    configured="yes"
    return 0
  fi
  if (
    mkdir -p "$(dirname "$1")" &&
      printf '\n# Added by the Photon CLI installer\n%s\n' "$2" >>"$1"
  ) 2>/dev/null; then
    changed="$changed $1"
    configured="yes"
  else
    unwritable="$unwritable $1"
  fi
}

shell_name="$(basename "${SHELL:-sh}")"
add_line "$HOME/.profile" "$profile_line"
for profile in "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$profile" ]; then
    add_line "$profile" "$profile_line"
  fi
done
zshrc="${ZDOTDIR:-$HOME}/.zshrc"
if [ "$shell_name" = "zsh" ] || [ -f "$zshrc" ]; then
  add_line "$zshrc" "$profile_line"
fi
fish_directory="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
if [ "$shell_name" = "fish" ] || [ -d "$fish_directory" ]; then
  add_line "$fish_directory/conf.d/$program.fish" "$fish_line"
fi

if [ -n "$unwritable" ]; then
  printf 'Could not add %s to PATH in:%s\n' "$bin_dir" "$unwritable" >&2
fi
if [ -z "$configured" ]; then
  printf 'To run %s by name, add %s to PATH:\n  %s\n' "$program" "$bin_dir" "$export_line"
  exit 0
fi
if [ -n "$changed" ]; then
  printf 'Added %s to PATH in:%s\n' "$bin_dir" "$changed"
fi
printf 'Open a new terminal to run %s, or run this in the current one:\n  %s\n' "$program" "$export_line"
