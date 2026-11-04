#!/bin/bash
# Portable command doubles; never opens production SSH or touches a real Keychain.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_PARENT=$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)
TEST_ROOT=$(mktemp -d "$TEST_PARENT/webui-macos-test.XXXXXX")
CLIENT_PID=
cleanup() {
  if [ -n "$CLIENT_PID" ]; then kill -TERM "$CLIENT_PID" 2>/dev/null || :; wait "$CLIENT_PID" 2>/dev/null || :; fi
  case "$TEST_ROOT" in "$TEST_PARENT"/webui-macos-test.*) rm -rf -- "$TEST_ROOT" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
mkdir "$TEST_ROOT/bin" "$TEST_ROOT/client"
cp "$SCRIPT_DIR/macos.sh" "$SCRIPT_DIR/macos-keychain.js" "$SCRIPT_DIR/macos-askpass.command" "$TEST_ROOT/client/"
chmod +x "$TEST_ROOT/client/macos-askpass.command"
export MOCK_ROOT="$TEST_ROOT" PATH="$TEST_ROOT/bin:$PATH"

cat > "$TEST_ROOT/bin/ssh" <<'MOCK'
#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_ROOT/ssh.args"
if [ "$1" = -V ]; then printf '%s\n' "OpenSSH_${MOCK_VERSION:-9.9}p1 mock" >&2; exit 0; fi
if [ "$1" = -G ]; then
  printf '%s\n' 'hostname TEST.invalid'
  if [ -n "${MOCK_ALIAS:-}" ]; then printf 'hostkeyalias %s\n' "$MOCK_ALIAS"; fi
  if [ -n "${MOCK_FORWARD:-}" ]; then printf '%s 127.0.0.1:9999 [127.0.0.1]:9999\n' "$MOCK_FORWARD"; fi
  exit 0
fi
[ "${MOCK_SSH_EXIT:-0}" = 0 ] || exit 42
[ "${SSH_ASKPASS_REQUIRE:-}" = force ] || exit 43
[ "${CODEX_WEBUI_SSH_HOST:-}" = "${MOCK_ALIAS:-test.invalid}" ] || exit 44
printf '%s\n' "$$" > "$MOCK_ROOT/ssh.pid"
trap 'rm -f "$MOCK_ROOT/ssh.pid"; exit 0' TERM INT HUP
while :; do sleep 0.05; done
MOCK
cat > "$TEST_ROOT/bin/osascript" <<'MOCK'
#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_ROOT/osascript.args"
case "$4" in
  metadata)
    if [ "${MOCK_KEYCHAIN_ERROR:-0}" != 0 ]; then
      printf '%s\n' 'Secure connection operation failed (OSStatus -50). Invalid Keychain parameters.' >&2
      exit 1
    fi
    if [ "${MOCK_MISSING:-0}" = 1 ]; then printf 'MISSING\n'; exit 0; fi
    printf 'READY\n%s\n%s\n%s\n%s\n%s\n' "${MOCK_HOST-test.invalid}" "${MOCK_PORT-22}" \
      "${MOCK_USER-test-user}" "${MOCK_LOCAL-8443}" "${MOCK_REMOTE-8443}" ;;
  save) cat >/dev/null; printf 'STORED\n' ;;
  forget) touch "$MOCK_ROOT/forgotten"; printf 'DELETED\n' ;;
  *) exit 1 ;;
esac
MOCK
cat > "$TEST_ROOT/bin/lsof" <<'MOCK'
#!/bin/bash
case " $* " in
  *' -a '*)
    [ -f "$MOCK_ROOT/ssh.pid" ] || exit 1
    if [ "${MOCK_FOREIGN_OWNER:-0}" = 1 ]; then printf '999999\n'; else cat "$MOCK_ROOT/ssh.pid"; fi ;;
  *) [ "${MOCK_OCCUPIED:-0}" = 1 ] || exit 1; printf '999999\n' ;;
esac
MOCK
cat > "$TEST_ROOT/bin/curl" <<'MOCK'
#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_ROOT/curl.args"
touch "$MOCK_ROOT/probed"
printf '%s' "${MOCK_BODY:-valid-relay}"
MOCK
cat > "$TEST_ROOT/bin/plutil" <<'MOCK'
#!/bin/bash
body=$(cat)
[ "$body" = valid-relay ] || exit 1
case "$2" in
  mode) printf '%s\n' production ;;
  authTransport) printf '%s\n' bearer ;;
  eventTransport) printf '%s\n' poll ;;
  authenticated) printf '%s\n' false ;;
  capabilities.overview) printf '%s\n' true ;;
  csrf|sessionToken) printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *) exit 1 ;;
esac
MOCK
cat > "$TEST_ROOT/bin/open" <<'MOCK'
#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_ROOT/open.args"
MOCK
cat > "$TEST_ROOT/bin/sleep" <<'MOCK'
#!/bin/bash
exec /usr/bin/sleep 0.005
MOCK
chmod +x "$TEST_ROOT/bin/ssh" "$TEST_ROOT/bin/osascript" "$TEST_ROOT/bin/lsof" "$TEST_ROOT/bin/curl" \
  "$TEST_ROOT/bin/plutil" "$TEST_ROOT/bin/open" "$TEST_ROOT/bin/sleep"

pass=0
passed() { pass=$((pass + 1)); printf 'ok %s - %s\n' "$pass" "$1"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reset_case() {
  rm -f "$TEST_ROOT/ssh.args" "$TEST_ROOT/osascript.args" "$TEST_ROOT/curl.args" "$TEST_ROOT/open.args" \
    "$TEST_ROOT/probed" "$TEST_ROOT/ssh.pid" "$TEST_ROOT/forgotten"
  unset MOCK_VERSION MOCK_ALIAS MOCK_FORWARD MOCK_SSH_EXIT MOCK_OCCUPIED MOCK_FOREIGN_OWNER MOCK_BODY \
    MOCK_HOST MOCK_PORT MOCK_USER MOCK_LOCAL MOCK_REMOTE MOCK_KEYCHAIN_ERROR MOCK_MISSING
}
reject() {
  local expected=$1
  shift
  if bash "$TEST_ROOT/client/macos.sh" "$@" > "$TEST_ROOT/output" 2>&1; then fail 'Expected launch to fail.'; fi
  grep -F "$expected" "$TEST_ROOT/output" >/dev/null || fail "Expected error: $expected"
  [ ! -e "$TEST_ROOT/open.args" ] || fail 'Opened a browser on failure.'
}
wait_file() {
  local file=$1 n
  for ((n=0; n<150; n++)); do [ ! -f "$file" ] || return 0; /usr/bin/sleep 0.02; done
  fail "Timed out: $file"
}
stop_client() {
  local owned
  owned=$(cat "$TEST_ROOT/ssh.pid")
  kill -TERM "$CLIENT_PID"
  wait "$CLIENT_PID" 2>/dev/null || :
  CLIENT_PID=
  [ ! -f "$TEST_ROOT/ssh.pid" ] || fail 'Owned SSH child did not clean up.'
  if kill -0 "$owned" 2>/dev/null; then fail 'Owned SSH child is still alive.'; fi
}

reset_case
bash "$TEST_ROOT/client/macos.sh" --help > "$TEST_ROOT/output"
[ ! -e "$TEST_ROOT/ssh.args" ] || fail 'Help started SSH.'
reject 'Unknown argument' --unknown
reject 'cannot be combined' --configure --forget-credentials
passed 'help and invalid arguments never start SSH'

for host in '-oProxyCommand=bad' 'host;touch_bad' '$(touch_bad)' 'host extra' 'host/other' ''; do
  reset_case; export MOCK_HOST="$host"
  reject 'Server address must' --batch-mode
  [ ! -e "$TEST_ROOT/ssh.args" ] || fail 'Invalid host reached SSH.'
done
reset_case; export MOCK_USER='root;bad'
reject 'SSH username' --batch-mode
passed 'metadata rejects shell syntax and unsafe addresses/users'

for port in 0 80 08443 65536 '8443;bad' ''; do
  reset_case; export MOCK_LOCAL="$port"
  reject 'LOCAL_PORT must' --batch-mode
done
reset_case; export MOCK_REMOTE=65536
reject 'REMOTE_PORT must' --batch-mode
reset_case; export MOCK_PORT=''
reject 'SSH port must' --batch-mode
passed 'ports have canonical numeric ranges and SSH port is required'

reset_case; export MOCK_MISSING=1
reject 'Configuration requires prompts' --batch-mode
reset_case
reject 'Configuration requires prompts' --configure --batch-mode
reset_case; export MOCK_KEYCHAIN_ERROR=1
reject 'Cannot read Keychain' --batch-mode
grep -F 'OSStatus -50' "$TEST_ROOT/output" >/dev/null || fail 'Launcher hid the Keychain error code.'
if grep -i 'unlock\|grant access' "$TEST_ROOT/output" >/dev/null; then fail 'Launcher mislabeled parameter errors as access errors.'; fi
passed 'missing, locked or denied Keychain never silently connects'

reset_case
bash "$TEST_ROOT/client/macos.sh" --forget-credentials > "$TEST_ROOT/output"
[ -e "$TEST_ROOT/forgotten" ] && [ ! -e "$TEST_ROOT/ssh.args" ] || fail 'Forget did not stay local.'
[ ! -e "$TEST_ROOT/client/connection.local.conf" ] || fail 'Wrote plaintext settings.'
passed 'explicit forget deletes only the client credential and never starts SSH'

reset_case; export MOCK_VERSION=8.3
reject 'OpenSSH 8.4 or newer' --batch-mode
passed 'old OpenSSH fails before relying on unsupported askpass routing'

for forwarding in localforward remoteforward dynamicforward; do
  reset_case; export MOCK_FORWARD="$forwarding"
  reject 'SSH config contains extra forwards' --batch-mode
  [ ! -e "$TEST_ROOT/ssh.pid" ] || fail 'Started SSH despite inherited forwarding.'
done
passed 'rejects all inherited forward types before connecting'

reset_case; export MOCK_OCCUPIED=1
reject 'Local port 8443 is occupied' --batch-mode
[ ! -e "$TEST_ROOT/probed" ] && [ ! -e "$TEST_ROOT/ssh.pid" ] || fail 'Touched an occupied port.'
passed 'occupied ports are never probed, opened or killed'

reset_case; export MOCK_SSH_EXIT=1
reject 'SSH exited before the tunnel was ready' --batch-mode
[ ! -e "$TEST_ROOT/probed" ] || fail 'Probed after SSH failure.'
passed 'SSH failure never opens a browser'

reset_case; export MOCK_FOREIGN_OWNER=1
reject 'Timed out waiting' --batch-mode
[ ! -e "$TEST_ROOT/probed" ] && [ ! -e "$TEST_ROOT/ssh.pid" ] || fail 'Ownership failure leaked SSH or probed another owner.'
passed 'listener ownership mismatch fails and cleans up'

reset_case; export MOCK_BODY=foreign-service
reject 'did not identify itself' --batch-mode
[ ! -e "$TEST_ROOT/ssh.pid" ] || fail 'Failed health check leaked SSH.'
[ "$(wc -l < "$TEST_ROOT/curl.args")" -eq 12 ] || fail 'Health checks exceeded the retry bound.'
passed 'invalid relay response is bounded and cleans up'

reset_case
export MOCK_PORT=2222 MOCK_LOCAL=9443 MOCK_ALIAS=key-name.example
bash "$TEST_ROOT/client/macos.sh" --batch-mode > "$TEST_ROOT/output" 2>&1 &
CLIENT_PID=$!
wait_file "$TEST_ROOT/open.args"
grep -F 'http://127.0.0.1:9443' "$TEST_ROOT/open.args" >/dev/null || fail 'Wrong browser URL.'
grep -F -- '-L 127.0.0.1:9443:127.0.0.1:8443' "$TEST_ROOT/ssh.args" >/dev/null || fail 'Wrong forward.'
grep -F -- '-S none' "$TEST_ROOT/ssh.args" >/dev/null || fail 'Multiplexing not disabled.'
grep -F -- '-p 2222' "$TEST_ROOT/ssh.args" >/dev/null || fail 'Explicit SSH port lost.'
grep -F -- 'BatchMode=yes' "$TEST_ROOT/ssh.args" >/dev/null || fail 'Batch mode lost.'
grep -F -- 'KbdInteractiveAuthentication=no' "$TEST_ROOT/ssh.args" >/dev/null || fail 'Keyboard-interactive not disabled.'
grep -F -- '--noproxy * --proxy  --proto =http' "$TEST_ROOT/curl.args" >/dev/null || fail 'Probe can use proxies.'
grep -F -- 'X-Relay-Origin: http://127.0.0.1:9443' "$TEST_ROOT/curl.args" >/dev/null || fail 'Origin header missing.'
if grep -F aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$TEST_ROOT/output" >/dev/null; then fail 'Session token appeared in output.'; fi
stop_client
passed 'HostKeyAlias, ports, proxy bypass, verified open and own-child cleanup'

reset_case
bash "$TEST_ROOT/client/macos.sh" --no-browser --batch-mode > "$TEST_ROOT/output" 2>&1 &
CLIENT_PID=$!
wait_file "$TEST_ROOT/probed"
for ((n=0; n<150; n++)); do grep -F 'WebUI is ready:' "$TEST_ROOT/output" >/dev/null && break; /usr/bin/sleep 0.02; done
grep -F 'WebUI is ready:' "$TEST_ROOT/output" >/dev/null || fail 'Tunnel did not become ready.'
[ ! -e "$TEST_ROOT/open.args" ] || fail '--no-browser opened a browser.'
stop_client
passed 'effective hostname lowercasing and --no-browser lifecycle'

# Load only the real helper's pure classifier, without its UI dispatch.
source <(sed -n '/^is_host_key_question()/,/^}/p' "$SCRIPT_DIR/macos-askpass.command")
fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
host_prompt="The authenticity of host 'test.invalid (192.0.2.1)' can't be established."$'\n'"ED25519 key fingerprint is SHA256:$fingerprint."$'\n'"This key is not known by any other names."$'\n''Are you sure you want to continue connecting (yes/no/[fingerprint])? '
is_host_key_question "$host_prompt" || fail 'Rejected the real multiline fingerprint question.'
is_host_key_question "Please type 'yes', 'no' or the fingerprint: " || fail 'Rejected host-key retry question.'
for bad_prompt in "test-user@test.invalid's password: " 'Enter passphrase for key: ' 'Verification code: ' \
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? '; do
  if is_host_key_question "$bad_prompt"; then fail 'Misclassified an unknown prompt as host-key confirmation.'; fi
done
passed 'real multiline SSH fingerprint questions remain manual and password-free'

# Node is a repository test dependency, never a delivered client dependency.
node --test "$SCRIPT_DIR/test-macos-keychain.cjs"
passed 'JXA CF-reference bridging, Keychain operations, secret routing and safe OSStatus errors'

printf '%s\n' "$pass test groups passed. Real macOS Keychain/JXA bridge, plutil, SSH prompts and Terminal UI still require a Mac."
