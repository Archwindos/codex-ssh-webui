#!/bin/bash
# macOS system Bash 3.2; this client only owns its local SSH child.
set +x
set -u
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd) || exit 1
KEYCHAIN_HELPER="$SCRIPT_DIR/macos-keychain.js"
ASKPASS_HELPER="$SCRIPT_DIR/macos-askpass.command"
SSH_PID=
CONFIGURE=0
FORGET=0
NO_BROWSER=0
BATCH_MODE=0

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$SSH_PID" ]; then
    kill -TERM "$SSH_PID" 2>/dev/null || :
    wait "$SSH_PID" 2>/dev/null || :
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM

usage() {
  printf '%s\n' 'Usage: Open WebUI.command [--configure|--forget-credentials] [--no-browser] [--batch-mode]' \
    '  --configure   Save connection settings and password in Keychain, then exit.' \
    '  --forget-credentials  Delete only this client connection from Keychain.' \
    '  --no-browser  Verify the tunnel without opening a browser.' \
    '  --batch-mode  Disable SSH/password and configuration prompts.'
}
for arg in "$@"; do
  case "$arg" in
    --configure) CONFIGURE=1 ;;
    --forget-credentials) FORGET=1 ;;
    --no-browser) NO_BROWSER=1 ;;
    --batch-mode) BATCH_MODE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $arg" ;;
  esac
done
[ "$CONFIGURE" -eq 0 ] || [ "$FORGET" -eq 0 ] || fail '--configure and --forget-credentials cannot be combined.'

valid_port() {
  local pattern='^[1-9][0-9]{0,4}$'
  [[ $1 =~ $pattern ]] && (( 10#$1 >= $2 && 10#$1 <= 65535 ))
}
validate_config() {
  local host_pattern='^[A-Za-z0-9][A-Za-z0-9._-]*$' user_pattern='^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
  [ ${#SSH_HOST} -le 255 ] && [[ $SSH_HOST =~ $host_pattern ]] || fail 'Server address must be a hostname, IPv4 address or SSH alias without spaces or shell syntax.'
  [ ${#SSH_USER} -le 64 ] && [[ $SSH_USER =~ $user_pattern ]] || fail 'SSH username contains unsupported characters.'
  valid_port "$SSH_PORT" 1 || fail 'SSH port must be an integer from 1 to 65535, without leading zeros.'
  valid_port "$LOCAL_PORT" 1024 || fail 'LOCAL_PORT must be an integer from 1024 to 65535, without leading zeros.'
  valid_port "$REMOTE_PORT" 1 || fail 'REMOTE_PORT must be an integer from 1 to 65535, without leading zeros.'
}
read_metadata() {
  local line index=0
  SSH_HOST= SSH_PORT= SSH_USER= LOCAL_PORT= REMOTE_PORT=
  while IFS= read -r line; do
    case "$index" in
      0) [ "$line" = READY ] || fail 'Unexpected Keychain response.' ;;
      1) SSH_HOST=$line ;; 2) SSH_PORT=$line ;; 3) SSH_USER=$line ;;
      4) LOCAL_PORT=$line ;; 5) REMOTE_PORT=$line ;;
      *) fail 'Unexpected Keychain metadata.' ;;
    esac
    index=$((index + 1))
  done <<< "$METADATA"
  [ "$index" -eq 6 ] || fail 'Incomplete Keychain metadata.'
  validate_config
  unset METADATA
}
configure() {
  [ "$BATCH_MODE" -eq 0 ] || fail 'Configuration requires prompts; run --configure without --batch-mode.'
  [ -t 0 ] || fail 'No settings found. Run Open WebUI.command --configure in Terminal.'
  printf '%s\n' 'Enter your connection to the existing remote WebUI.' \
    'The complete connection, including the password, is stored in your macOS login Keychain.'
  IFS= read -r -p 'Server address: ' SSH_HOST || fail 'Configuration cancelled.'
  IFS= read -r -p 'SSH port: ' SSH_PORT || fail 'Configuration cancelled.'
  IFS= read -r -p 'SSH username: ' SSH_USER || fail 'Configuration cancelled.'
  printf '%s\n' 'WebUI ports are separate from the SSH port; change them only if your existing setup uses other ports.'
  IFS= read -r -p 'Local WebUI port [8443]: ' LOCAL_PORT || fail 'Configuration cancelled.'
  IFS= read -r -p 'Remote WebUI port [8443]: ' REMOTE_PORT || fail 'Configuration cancelled.'
  LOCAL_PORT=${LOCAL_PORT:-8443}; REMOTE_PORT=${REMOTE_PORT:-8443}
  validate_config
  # Clear a possibly inherited export attribute before reading any secret.
  unset CONNECTION_PASSWORD
  IFS= read -r -s -p 'SSH password (hidden): ' CONNECTION_PASSWORD || fail 'Configuration cancelled.'
  printf '\n'
  [ -n "$CONNECTION_PASSWORD" ] || fail 'SSH password is required.'
  local status=0
  # printf is a shell builtin: the password travels only through this pipe.
  printf '%s\n' "$SSH_HOST" "$SSH_PORT" "$SSH_USER" "$LOCAL_PORT" "$REMOTE_PORT" "$CONNECTION_PASSWORD" |
    osascript -l JavaScript "$KEYCHAIN_HELPER" save >/dev/null || status=$?
  unset CONNECTION_PASSWORD
  [ "$status" -eq 0 ] || fail 'Keychain did not save the connection. No plaintext settings were written.'
  printf '%s\n' 'Saved the connection securely in Keychain.'
}

for tool in ssh curl lsof plutil osascript; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required macOS system tool is missing: $tool"
done
[ -f "$KEYCHAIN_HELPER" ] && [ -x "$ASKPASS_HELPER" ] || fail 'Mac helper files are missing or macos-askpass.command is not executable. Extract the complete macOS ZIP with its Unix permissions.'
if [ "$FORGET" -eq 1 ]; then
  osascript -l JavaScript "$KEYCHAIN_HELPER" forget >/dev/null || fail 'Keychain did not delete the saved connection.'
  printf '%s\n' 'Deleted this client connection from Keychain.'
  exit 0
fi
if [ "$CONFIGURE" -eq 1 ]; then configure; exit 0; fi
METADATA=$(osascript -l JavaScript "$KEYCHAIN_HELPER" metadata) || fail 'Cannot read Keychain. See the specific error above before changing access or connection settings.'
if [ "$METADATA" = MISSING ]; then
  configure
  METADATA=$(osascript -l JavaScript "$KEYCHAIN_HELPER" metadata) || fail 'Cannot read the saved Keychain connection.'
fi
read_metadata
if [ "$NO_BROWSER" -eq 0 ]; then command -v open >/dev/null 2>&1 || fail 'The macOS open command is missing.'; fi

URL="http://127.0.0.1:$LOCAL_PORT"
SSH_TARGET="$SSH_USER@$SSH_HOST"
SSH_VERSION=$(ssh -V 2>&1) || fail 'Cannot identify the installed OpenSSH version.'
version_pattern='OpenSSH_([0-9]+)\.([0-9]+)'
if [[ $SSH_VERSION =~ $version_pattern ]]; then
  major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}
  (( major > 8 || (major == 8 && minor >= 4) )) || fail 'Automatic Keychain password entry requires macOS OpenSSH 8.4 or newer.'
else
  fail 'Cannot verify OpenSSH 8.4+ support for the secure password helper.'
fi
unset SSH_VERSION
SSH_OPTIONS=(-N -T -S none
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3
  -o ConnectTimeout=12 -o StrictHostKeyChecking=ask -o FingerprintHash=sha256 -o EscapeChar=none
  -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=1
  -o ControlMaster=no -o ControlPersist=no -o ForkAfterAuthentication=no
  -o PermitLocalCommand=no -o ForwardAgent=no -o ForwardX11=no -o Tunnel=no
  -o ClearAllForwardings=no)
SSH_OPTIONS[${#SSH_OPTIONS[@]}]=-p; SSH_OPTIONS[${#SSH_OPTIONS[@]}]=$SSH_PORT
if [ "$BATCH_MODE" -eq 1 ]; then SSH_OPTIONS[${#SSH_OPTIONS[@]}]=-o; SSH_OPTIONS[${#SSH_OPTIONS[@]}]=BatchMode=yes; fi

# Inspect inherited forwards before adding the one intentional local forward.
EFFECTIVE=$(ssh -G "${SSH_OPTIONS[@]}" -- "$SSH_TARGET") || fail 'Cannot inspect effective SSH configuration (ssh -G).'
EFFECTIVE_HOST=
HOST_KEY_ALIAS=
while IFS= read -r line; do
  case "$line" in
    localforward\ *|remoteforward\ *|dynamicforward\ *)
      fail 'SSH config contains extra forwards. Use a dedicated alias without LocalForward, RemoteForward or DynamicForward.' ;;
    hostname\ *)
      [ -z "$EFFECTIVE_HOST" ] || fail 'SSH reported multiple effective hostnames.'
      EFFECTIVE_HOST=${line#hostname } ;;
    hostkeyalias\ *) HOST_KEY_ALIAS=${line#hostkeyalias } ;;
  esac
done <<< "$EFFECTIVE"
unset EFFECTIVE
effective_host_pattern='^[A-Za-z0-9:][A-Za-z0-9._:%-]*$'
[[ $EFFECTIVE_HOST =~ $effective_host_pattern ]] || fail 'SSH did not report a safe effective hostname.'
if [ -n "$HOST_KEY_ALIAS" ]; then
  [[ $HOST_KEY_ALIAS =~ $effective_host_pattern ]] || fail 'SSH HostKeyAlias contains unsupported characters.'
  PASSWORD_HOST=$HOST_KEY_ALIAS
else
  PASSWORD_HOST=$(printf '%s' "$EFFECTIVE_HOST" | LC_ALL=C tr '[:upper:]' '[:lower:]')
fi

# Refuse every occupied port, including a tunnel from a previous click.
if [ -n "$(lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN -t 2>/dev/null)" ]; then
  fail "Local port $LOCAL_PORT is occupied. Keep the existing launcher open, or close it yourself and retry. No process was stopped."
fi
printf 'Connecting to %s. Keep this Terminal window open; Ctrl+C disconnects this tunnel.\n' "$SSH_TARGET"
# Force routes password prompts only through our Keychain helper. The helper
# passes the genuine SSH host-key question back to this terminal for your answer.
export SSH_ASKPASS="$ASKPASS_HELPER" SSH_ASKPASS_REQUIRE=force
export CODEX_WEBUI_SSH_HOST="$PASSWORD_HOST"
export DISPLAY="${DISPLAY:-codex-webui-client:0}"
export LC_ALL=C
if [ -t 0 ]; then
  ssh "${SSH_OPTIONS[@]}" -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" -- "$SSH_TARGET" < /dev/tty &
else
  ssh "${SSH_OPTIONS[@]}" -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" -- "$SSH_TARGET" < /dev/null &
fi
SSH_PID=$!

own_listener() {
  local pids
  kill -0 "$SSH_PID" 2>/dev/null || return 1
  pids=$(lsof -nP -a -p "$SSH_PID" -iTCP@127.0.0.1:"$LOCAL_PORT" -sTCP:LISTEN -t 2>/dev/null) || return 1
  [ "$pids" = "$SSH_PID" ]
}
# Allow time for the human host-key confirmation and Keychain access prompts.
ready=0
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$SSH_PID" 2>/dev/null || fail 'SSH exited before the tunnel was ready. Check the SSH message above; if authentication failed, run --configure to correct the connection.'
  if own_listener; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail 'Timed out waiting for SSH authentication and the local listener.'

json_field() { printf '%s' "$SESSION_BODY" | plutil -extract "$1" raw -o - - 2>/dev/null; }
relay_ready() {
  local token_pattern='^[A-Za-z0-9_-]{43}$' csrf session_token
  # -q ignores .curlrc; both proxy options bypass system/proxy environment routes.
  SESSION_BODY=$(curl -q --silent --fail --noproxy '*' --proxy '' --proto '=http' \
    --connect-timeout 1 --max-time 2 --max-filesize 32768 \
    --header "X-Relay-Origin: $URL" --url "$URL/api/session" 2>/dev/null) || return 1
  [ ${#SESSION_BODY} -le 32768 ] || return 1
  [ "$(json_field mode)" = production ] && [ "$(json_field authTransport)" = bearer ] &&
    [ "$(json_field eventTransport)" = poll ] && [ "$(json_field authenticated)" = false ] &&
    [ "$(json_field capabilities.overview)" = true ] || return 1
  csrf=$(json_field csrf) && session_token=$(json_field sessionToken) || return 1
  [[ $csrf =~ $token_pattern ]] && [[ $session_token =~ $token_pattern ]]
}
ready=0
for ((attempt=0; attempt<12; attempt++)); do
  own_listener || fail 'The SSH child no longer owns the local listener.'
  if relay_ready && own_listener; then ready=1; break; fi
  SESSION_BODY=
  sleep 1
done
SESSION_BODY=
[ "$ready" -eq 1 ] || fail 'The remote endpoint did not identify itself as the production WebUI. Check its HTTP port and availability.'
if [ "$NO_BROWSER" -eq 0 ]; then
  own_listener || fail 'The tunnel closed before the browser could open.'
  open "$URL" || fail 'Cannot open the browser.'
fi
printf 'WebUI is ready: %s\n' "$URL"
printf '%s\n' 'Closing this window or pressing Ctrl+C stops only this local tunnel.'
status=0
wait "$SSH_PID" || status=$?
SSH_PID=
if [ "$status" -ne 0 ]; then fail "SSH disconnected (exit $status). If the password was rejected, run --configure to correct it. Relaunch manually; tasks are never replayed."; fi
