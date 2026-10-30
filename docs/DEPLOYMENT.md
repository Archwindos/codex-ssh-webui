# Deployment

This guide runs the gateway and Codex on the same Linux host. Your phone reaches the gateway through its existing SSH forwarding setup. All example paths are placeholders; replace them with paths belonging to your account.

## 1. Prepare the host

Use Node.js 24+, OpenSSH, `/usr/bin/tmux`, and the official Codex CLI 0.165.0. Sign in to Codex with ChatGPT as the same OS user that will run the gateway. The WebUI does not provide a ChatGPT login flow or an API-key fallback. See [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Clone or copy this repository to a private, real directory owned by that user. Start in an ordinary SSH shell **outside tmux**. For a fresh checkout:

```sh
cd /home/demo/codex-ssh-webui
chmod 700 .
umask 077
install -d -m 700 runtime
cp config/workspace.example.json config/local.json
chmod 600 config/local.json
node --version
/usr/bin/tmux -V
/home/demo/.local/bin/codex --version
/home/demo/.local/bin/codex login status
```

Use your actual Codex executable path in the last two commands. Keep `runtime/`, local configuration, logs, pairing links, and Codex credentials out of Git. Do not share the app directory or use symlinks for its private runtime storage.

## 2. Configure and verify

Edit `config/local.json`:

- Set `remoteCodex` to your absolute Linux executable path. Despite the field name, `transport: "local"` executes it on this host. The basename must be `codex`; only ASCII letters, digits, `_`, `.`, `-`, and `/` are accepted, without `..` path segments or spaces.
- Set each project's `cwd`, `workspace.defaultCwd`, and `workspace.roots` to existing directories you intend to expose. The default directory and project directories must be within the roots. Folder selection and project registration stay within those roots.
- Keep `transport: "local"`, `accessMode: "ssh-loopback-http"`, and `eventTransport: "poll"`. Omit `publicOrigin` and TLS settings in this mode.
- Keep both `verifiedProtocol.verified` and `verifiedProtocol.schemaVerified` false until verification is complete. The version is pinned to `0.165.0`.

Check the exact executable and generate its schema privately:

```sh
/home/demo/.local/bin/codex app-server generate-json-schema --out runtime/protocol-schema
node --test test/*.test.mjs
```

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) explains schema generation and the initialization sequence. Generated schemas describe the installed CLI version; current online examples may describe a newer version.

Before enabling production, compare that schema with the requests and responses consumed by `src/protocol.mjs`, `src/server.mjs`, `src/runtimes.mjs`, and `src/library.mjs`. Check initialization, ChatGPT account detection, history pagination, turn events, approvals, and archive/descendant semantics. The local library client opts into `experimentalApi`; review its metadata and descendant-filter fields as well. Tests with the bundled simulator alone do not verify your installed CLI.

A no-model handshake checks version and authentication only. Run the configured executable with `app-server`, send the following first, then wait for the response and confirm its `userAgent` reports 0.165.0:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_ssh_webui_check","title":"Codex SSH WebUI check","version":"0.1.0"},"capabilities":{"experimentalApi":false}}}
```

Then send these two lines and confirm the account response has `account.type: "chatgpt"`. Keep any account details private, then stop the probe with Ctrl+C.

```json
{"method":"initialized","params":{}}
{"id":2,"method":"account/read","params":{"refreshToken":false}}
```

Only after the version, schema, and supported behavior have been explicitly checked should you change both verification flags to `true` and enable the environment gate below. If you cannot establish compatibility, leave production disabled. Do not set the flags solely to clear a startup error.

## 3. Start the gateway

Choose a recovery passphrase of at least 32 characters and keep a recoverable copy privately. In Bash, enter it without placing its value in command history or process arguments:

```sh
read -r -s -p 'Recovery passphrase (32+ characters): ' RELAY_ACCESS_SECRET
printf '\n'
export RELAY_ACCESS_SECRET
export RELAY_VERIFIED_PROTOCOL=0.165.0
nohup node src/server.mjs --config config/local.json --port 8443 >runtime/gateway.log 2>&1 < /dev/null &
printf '%s\n' "$!" >runtime/gateway.pid
unset RELAY_ACCESS_SECRET
```

This starts only when you run it; no service or scheduled task is installed. Check the private log for startup errors and use `ss -ltn` to confirm the listener is **127.0.0.1:8443**. Preserve the recovery passphrase across restarts. Environment variables are not protection from the same OS account or an administrator.

Run the gateway outside tmux so runtime controls cannot close the gateway's own terminal session. The managed conversations share the account's default tmux server at `/tmp/tmux-<uid>/default`, with independent `codex-chat-...` sessions. Do not use `tmux kill-server` to close an individual conversation.

## 4. Connect the phone

In your phone's SSH client, configure a local forward from **127.0.0.1:8443 on the phone** to **127.0.0.1:8443 on the server**. Keep the tunnel connected, then open `http://127.0.0.1:8443` in that phone's browser. Use the exact hostname and port consistently; browser trust is scoped to the browser profile and origin.

For comparison, an OpenSSH client with a configured `codex-server` alias uses:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:8443 codex-server
```

That command forwards the port on the device running it. A tunnel on your laptop does not create a loopback port on your phone.

Select **使用恢复口令** (Use recovery passphrase) if needed, log in, and use **信任此浏览器** (Trust this browser) in the sidebar for future sign-in. Browser WebCrypto and IndexedDB must be available. Safari, Chrome, private browsing, and different browser profiles do not share trust.

Optionally, the server owner can issue a single-use pairing link with `scripts/device-pairing.py`; see [SECURITY.md](SECURITY.md). First verify the setup with a disposable workspace: create a conversation, send an intentional test prompt, inspect approval handling, reload history, and close its runtime. Any model turn uses the signed-in account.

## Alternative: SSH transport

`config/ssh-loopback-http.example.json` launches Codex through OpenSSH using fixed project directories. Configure its `sshTarget` as a trusted SSH config alias, such as `codex-server`; accepted aliases start with a letter or digit and contain only letters, digits, `_`, `.`, and `-`. Direct `user@host` values and SSH options are not accepted. Host-key checking and noninteractive SSH authentication remain enabled.

This alternative does not provide the local workspace runtime/library management described above. The browser-facing connection remains a loopback SSH forward. Apply the same protocol verification and web authentication requirements.
