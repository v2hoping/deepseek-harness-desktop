#!/usr/bin/env bash
# Install the unsigned DeepSeek Harness desktop application on macOS.
#
# The application carries an ad-hoc signature, so Gatekeeper rejects it as
# damaged while the download quarantine attribute is present. This script
# mounts the disk image, copies the application, and removes that attribute,
# which is the only way to start an unsigned application on macOS 15 and later.
#
#   ./install.sh                       # download the latest release for this Mac
#   ./install.sh <path-to.dmg>         # install a locally built disk image
#   ./install.sh <https://…/x.dmg>     # install a specific published image
#
# DSH_DESKTOP_REPO overrides the GitHub repository releases are read from.

set -euo pipefail

readonly APP_NAME="DeepSeek Harness"
readonly INSTALL_DIR="/Applications"
readonly REPO="${DSH_DESKTOP_REPO:-v2hoping/deepseek-harness-desktop}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
abort() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || abort "this installer only supports macOS"
}

# The published image name carries the architecture, so a Mac installs its own build.
current_arch() {
  case "$(uname -m)" in
    arm64) printf 'arm64' ;;
    x86_64) printf 'x64' ;;
    *) abort "unsupported architecture: $(uname -m)" ;;
  esac
}

# Resolve the newest release asset for this architecture from the GitHub API.
latest_asset_url() {
  local arch api url
  arch="$(current_arch)"
  api="https://api.github.com/repos/${REPO}/releases/latest"
  url="$(curl -fsSL "$api" \
    | grep -o "https://[^\"]*-${arch}\.dmg" \
    | head -n 1)" || true
  [ -n "$url" ] || abort "no ${arch} disk image found in the latest release of ${REPO}"
  printf '%s' "$url"
}

main() {
  require_macos

  local source="${1:-}" image cleanup_image=0
  if [ -z "$source" ]; then
    log "resolving the latest $(current_arch) release of ${REPO}"
    source="$(latest_asset_url)"
  fi

  case "$source" in
    http://*|https://*)
      image="$(mktemp -d)/download.dmg"
      cleanup_image=1
      log "downloading ${source}"
      curl -fL --progress-bar "$source" -o "$image"
      ;;
    *)
      [ -f "$source" ] || abort "disk image not found: ${source}"
      image="$source"
      ;;
  esac

  local mount_point
  mount_point="$(mktemp -d)"
  log "mounting $(basename "$image")"
  hdiutil attach "$image" -mountpoint "$mount_point" -nobrowse -readonly -quiet

  # Unmount before exiting for any reason; a leaked mount blocks the next install.
  # shellcheck disable=SC2064
  trap "hdiutil detach '$mount_point' -quiet >/dev/null 2>&1 || true; rmdir '$mount_point' 2>/dev/null || true; [ $cleanup_image -eq 1 ] && rm -rf '$(dirname "$image")' || true" EXIT

  local staged="${mount_point}/${APP_NAME}.app"
  [ -d "$staged" ] || abort "the disk image does not contain ${APP_NAME}.app"

  local target="${INSTALL_DIR}/${APP_NAME}.app"
  if [ -d "$target" ]; then
    log "replacing the existing ${target}"
    rm -rf "$target"
  fi

  # ditto, not cp: the application bundle contains framework symbolic links.
  log "installing to ${target}"
  ditto "$staged" "$target"

  log "removing the download quarantine attribute"
  xattr -dr com.apple.quarantine "$target"

  log "installed. Open it from Launchpad or run: open -a '${APP_NAME}'"
}

main "$@"
