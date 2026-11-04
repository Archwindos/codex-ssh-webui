#!/bin/bash
set -u

is_host_key_question() {
  local prompt=$1
  local fingerprint='key fingerprint is SHA256:[A-Za-z0-9+/]{43}'
  case "$prompt" in
    "Please type 'yes', 'no' or the fingerprint: " | "Please type 'yes' or 'no': ") return 0 ;;
    "The authenticity of host '"*) ;;
    *) return 1 ;;
  esac
  [[ $prompt =~ $fingerprint ]] || return 1
  case "$prompt" in
    *$'\n''Are you sure you want to continue connecting (yes/no/[fingerprint])? ' | \
    *$'\n''Are you sure you want to continue connecting (yes/no)? ') return 0 ;;
    *) return 1 ;;
  esac
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd) || exit 1
[ "$#" -eq 1 ] || exit 1
if is_host_key_question "$1"; then
    # Display SSH's own host-key question and let SSH validate the user's answer.
    # A first host-key question must never receive the saved account password.
    printf '\n%s' "$1" > /dev/tty 2>/dev/null || exit 1
    IFS= read -r answer < /dev/tty || exit 1
    printf '%s\n' "$answer"
else
  exec /usr/bin/osascript -l JavaScript "$SCRIPT_DIR/macos-keychain.js" password "$1" "${CODEX_WEBUI_SSH_HOST:-}"
fi
