# Deployment

Run the gateway beside your existing Codex daemon on Linux, then reach its loopback HTTP listener through SSH. Names and paths below are examples; replace them with your installation's values.

中文提示：先确认各客户端使用同一个原生 daemon，再启动网页网关。桌面入口只负责 SSH 隧道；SSH 密码、网页恢复口令与 Codex 账号分别管理。

## 1. Prepare the account

You need Linux, Node.js 24+, OpenSSH, and the Codex 0.165.0 build whose protocol you will verify. Codex must already be signed in with ChatGPT as the daemon/gateway account. The WebUI supplies neither a ChatGPT login flow nor an API-key fallback.

Copy or clone the repository to a private directory. From its root:

```sh
umask 077
chmod 700 .
install -d -m 700 runtime
node --version
command -v codex
codex --version
codex login status
```

There are no npm dependencies. Keep local configuration, `runtime/`, logs, device records, uploads, and Codex credentials out of Git. Use real directories owned by your account, without symlinks for private runtime storage.

## 2. Identify the shared native daemon

Use the same executable, account, and Codex home as your existing clients. A custom wrapper may select a different home from the shell default; verify its actual configuration first. Do not create a second home as a shortcut to connecting.

The tested 0.165.0 CLI exposes:

```sh
codex app-server daemon --help
codex app-server daemon version
codex app-server proxy --help
codex resume --help
```

Reuse a compatible running daemon. For a new installation, after verifying the account and CLI, the native start command is:

```sh
codex app-server daemon start
```

Do not run `restart`, `update`, or `stop` merely to attach this gateway. `bootstrap` installs durable daemon management and is a separate operator decision; the WebUI does not require a new startup service.

For the default socket layout, use your existing Codex home:

```sh
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_SOCKET="$CODEX_HOME/app-server-control/app-server-control.sock"
test -S "$CODEX_SOCKET"
```

Use the daemon's actual socket if its location differs. Keep the control socket private; this guide does not expose it on TCP.

On the server, explicitly attach a CLI to that endpoint:

```sh
codex --remote "unix://$CODEX_SOCKET"
codex resume --remote "unix://$CODEX_SOCKET"
```

The second command opens a resume picker. Choose the intended thread; do not supply a prompt just to check connectivity. Clients implementing app-server stdio can use `codex app-server proxy --sock "$CODEX_SOCKET"` where their own integration supports it. Official desktop-client setup is client-specific and must select this same daemon.

An independent `app-server --stdio` process or CLI using `--no-daemon` is a separate backend. Its saved chats may be readable, but native writer conflicts can prevent continuation. The gateway does not kill or take over that process. Shared mode needs no per-conversation tmux sessions and does not require tmux.

## 3. Configure the gateway

```sh
cp config/shared-daemon.example.json config/local.json
chmod 600 config/local.json
```

Edit `config/local.json`:

- Keep `transport: "local"`, `accessMode: "ssh-loopback-http"`, and `eventTransport: "poll"`. Omit `publicOrigin` and TLS fields in this mode.
- Set `remoteCodex` to the trusted absolute executable path ending in `codex`. Components accept ASCII letters, digits, `_`, `.`, and `-`; spaces and `..` components are not accepted. Shared transport connects to the socket rather than spawning this executable per chat.
- Set `sharedDaemonSocket` to the verified Unix socket. JSON does not expand `$HOME` or shell variables: enter the actual absolute path.
- Set `workspace.roots` to the directories you intend the WebUI to admit, and choose an existing `workspace.defaultCwd` within them. Use `/` only if you deliberately intend account-wide browsing and admission.
- Set the seed project's `cwd` inside those roots. Native projects created in the UI may have no roots or multiple roots. Project membership does not rewrite chat execution directories.
- Set `temporaryTerminal` to `false` unless you explicitly want the optional interactive shell as this OS account.
- Leave `verifiedProtocol.verified` and `verifiedProtocol.schemaVerified` false until the next checks are complete. The supported version is `0.165.0`.

Other example configurations describe legacy stdio/SSH transports. Use the shared example for this guide; a private stdio server does not become shared simply by pointing a browser at it.

## 4. Verify compatibility

Generate the installed CLI's schema privately, then run the tests:

```sh
codex app-server generate-json-schema --out runtime/protocol-schema
node --test test/*.test.mjs
```

Compare the generated requests and responses with `src/shared-rpc.mjs`, `src/server.mjs`, `src/composer.mjs`, `src/projects.mjs`, and `src/library.mjs`. Include initialization, ChatGPT account detection, subscriptions, item pagination, model/effort/profile fields, approvals and questions, native projects, and descendant/archive semantics. Builds with the same version number can expose different fields.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) explains the protocol; current online examples may target a newer build. Simulator tests do not verify your daemon.

This probe checks the configured socket, version, and existing ChatGPT sign-in without submitting a model turn:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { SharedRpcClient } from './src/shared-rpc.mjs';
const config = JSON.parse(await readFile('config/local.json', 'utf8'));
const rpc = new SharedRpcClient(config, { mock: false });
try {
  await rpc.start();
  console.log('Shared daemon handshake and ChatGPT account check passed.');
} finally {
  rpc.close();
}
JS
```

It closes only its own connection. It does not prove model access or all lifecycle behavior. After checking the schema and supported behavior, set both verification flags to `true`. If compatibility remains unknown, keep production disabled rather than setting flags solely to clear an error.

## 5. Start the loopback gateway

Choose a recovery passphrase of at least 32 characters and retain a private copy. Enter it in Bash without putting its value in history or process arguments:

```sh
read -r -s -p 'Recovery passphrase (32+ characters): ' RELAY_ACCESS_SECRET
printf '\n'
export RELAY_ACCESS_SECRET
export RELAY_VERIFIED_PROTOCOL=0.165.0
nohup node src/server.mjs --config config/local.json --port 8443 >runtime/gateway.log 2>&1 < /dev/null &
printf '%s\n' "$!" >runtime/gateway.pid
unset RELAY_ACCESS_SECRET
```

`--config` selects production mode; there is no `--production` switch. Preserve the recovery passphrase across restarts. Check the private log and use `ss -ltn` to confirm **127.0.0.1:8443**. This command installs no service or scheduled task.

The gateway owns its HTTP process and client connection, not the native daemon. Restarting it interrupts browser sessions, rather than stopping daemon-owned tasks. Do not use broad process or tmux kill commands as a gateway shutdown method.

## 6. Connect a desktop or phone

### Desktop launchers

Keep the complete `scripts/desktop-client` folder and its helpers together. Use this checkout or the repository ZIP; no packaged GitHub Release is required.

On **Windows**, install the native OpenSSH Client optional feature if needed, then double-click `Open WebUI.cmd`. Automatic saved-password entry requires native Windows OpenSSH 8.4+ and PowerShell 5.1+.

On **macOS**, first run this from the repository root, including after extracting a ZIP. The SSH askpass helper also needs its executable bit:

```sh
chmod +x "scripts/desktop-client/Open WebUI.command" \
  "scripts/desktop-client/Connection settings.command" \
  scripts/desktop-client/macos-askpass.command \
  scripts/desktop-client/macos.sh
```

Then double-click `Open WebUI.command`. macOS automatic password entry requires OpenSSH 8.4+. Running `/bin/bash scripts/desktop-client/macos.sh` is an alternative entry, but the askpass helper still needs executable permission.

On first launch:

1. Enter the server address or SSH alias, SSH port, username, SSH password, and local/server gateway ports. Both gateway ports default to `8443`; the SSH port is separate.
2. Verify a first-connection host-key fingerprint through a trusted source before accepting it.
3. Once tunnel and gateway checks pass, the launcher opens the browser. Complete web login separately.

Windows saves connection settings with current-user DPAPI and restricted ACLs; macOS uses that user's Keychain. Helpers do not save a plain-text password configuration, install Codex, or modify server startup settings.

Use `Connection settings.cmd` or `Connection settings.command` to replace saved settings. To forget only this launcher's local credentials:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/desktop-client/windows.ps1 -ForgetCredentials
```

```sh
/bin/bash scripts/desktop-client/macos.sh --forget-credentials
```

Keep the connection window open or minimized. Closing it disconnects that device's tunnel; server tasks remain with the native daemon. If SSH exits or the network fails, relaunch manually. The launcher does not replay model messages. Windows has native checks and the scripts have fixture tests; the complete macOS Keychain/Terminal/browser workflow still needs verification on a real Mac.

### Phone or manual forwarding

In a phone SSH app, forward **127.0.0.1:8443 on the phone** to **127.0.0.1:8443 on the server**, keep the tunnel active, and open <http://127.0.0.1:8443> in that phone's browser.

An OpenSSH client with a configured example alias uses:

```sh
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:8443 codex-server
```

A laptop forward does not create a loopback port on a phone. Use the same browser origin and port consistently; browser trust is scoped to that origin and profile.

Log in with the recovery passphrase, then select **信任此浏览器** (Trust this browser). WebCrypto and IndexedDB must be available. Optional single-use enrollment links are described in [SECURITY.md](SECURITY.md).

## 7. Accept the installation

Use a disposable workspace and a new test conversation. Intentionally send a small task, inspect it from two clients connected to the same daemon, reload paginated history, and verify reconnect without resending. Check an image and text attachment if needed. Test lifecycle actions only on disposable chats and projects after reviewing their impact previews.

Any model turn uses the signed-in account. A handshake, passing fixtures, or an open browser alone is not end-to-end acceptance. Keep credentials and private conversations out of screenshots and reports.
