#!/bin/bash

# Install Video Downloader on Linux: register the native host that starts the
# local download server, and load the extension in Chromium-based browsers that
# read ~/.config/<browser>-flags.conf (Arch packages, Omarchy).
#
# Usage: ./install.sh [--uninstall]

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
FLAG_FILES=(chromium chrome google-chrome brave brave-beta brave-nightly brave-origin-beta microsoft-edge-stable vivaldi-stable)

uninstall=0
case "${1:-}" in
  --uninstall) uninstall=1 ;;
  "") ;;
  -h | --help)
    echo "Usage: ./install.sh [--uninstall]"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 1
    ;;
esac

if [[ $(uname -s) != "Linux" ]]; then
  echo "install.sh is for Linux. On macOS, double-click 'Install Native Host.command'." >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js 18 or newer is required. Install it first (e.g. 'sudo pacman -S nodejs')." >&2
  exit 1
fi

# Add or remove this project from a flags file's --load-extension list, keeping
# every other extension already listed there.
update_flags_file() {
  local file=$1 action=$2 line rest entry kept=()

  [[ -f $file ]] || return 0
  line=$(grep -m1 '^--load-extension=' "$file" || true)

  if [[ $action == "add" ]]; then
    if [[ -z $line ]]; then
      printf -- '--load-extension=%s\n' "$PROJECT_DIR" >>"$file"
    elif [[ ",${line#--load-extension=}," != *",$PROJECT_DIR,"* ]]; then
      sed -i --follow-symlinks "s|^--load-extension=.*$|&,$PROJECT_DIR|" "$file"
    else
      return 0
    fi
  else
    [[ -n $line ]] || return 0
    rest=${line#--load-extension=}
    IFS=',' read -ra entries <<<"$rest"
    for entry in "${entries[@]}"; do
      [[ $entry == "$PROJECT_DIR" ]] || kept+=("$entry")
    done
    (( ${#kept[@]} < ${#entries[@]} )) || return 0
    if (( ${#kept[@]} == 0 )); then
      sed -i --follow-symlinks '/^--load-extension=/d' "$file"
    else
      local joined
      joined=$(IFS=','; echo "${kept[*]}")
      sed -i --follow-symlinks "s|^--load-extension=.*$|--load-extension=$joined|" "$file"
    fi
  fi
  echo "- ${file/#$HOME/\~}"
}

if (( uninstall )); then
  node "$PROJECT_DIR/native-host/install.js" --uninstall
  echo "Removed the extension from:"
  for name in "${FLAG_FILES[@]}"; do
    update_flags_file "$CONFIG_DIR/$name-flags.conf" remove
  done
  echo
  echo "Restart your browser to finish."
  exit 0
fi

node "$PROJECT_DIR/native-host/install.js"

echo
echo "Loading the extension through browser flags:"
loaded=0
for name in "${FLAG_FILES[@]}"; do
  file="$CONFIG_DIR/$name-flags.conf"
  if [[ -f $file ]]; then
    update_flags_file "$file" add
    loaded=1
  fi
done
if (( ! loaded )); then
  echo "- No *-flags.conf found. Load it manually: open brave://extensions (or chrome://extensions),"
  echo "  turn on Developer mode, click Load unpacked and choose $PROJECT_DIR"
fi

missing=()
for tool in yt-dlp ffmpeg; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  echo
  echo "Also install: ${missing[*]} (e.g. 'sudo pacman -S ${missing[*]}')"
fi

echo
echo "Restart your browser, then click the Video Downloader icon. The server starts on demand."
