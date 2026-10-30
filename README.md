# Codex SSH WebUI

A mobile browser interface for your own Codex CLI, reached through an SSH tunnel. Run the gateway on your Linux server, forward its loopback port to your phone, and open `http://127.0.0.1:8443` in the phone's browser.

The gateway has no npm dependencies. It uses the official Codex `app-server` over stdio; it does not implement a separate model client or handle your ChatGPT sign-in. The interface is currently primarily Chinese.

## Try the mock UI

With Node.js 24 or newer, run from the repository root:

```sh
node src/server.mjs --mock
```

Open `http://127.0.0.1:8787`. Mock mode starts a local simulator and makes no SSH, Codex, or model calls. No `npm install` is needed.

## Use your server

The recommended setup needs Linux, Node.js 24+, OpenSSH, `/usr/bin/tmux`, and the official Codex CLI **0.165.0**, already signed in with ChatGPT under the gateway's OS account. Keep the gateway outside tmux; the application creates a separate tmux session for each browser-managed conversation, using the account's default tmux server.

Follow the [deployment guide](docs/DEPLOYMENT.md) to edit the example configuration, verify the pinned protocol, set a private recovery passphrase, and start the loopback gateway. Use your existing SSH port-forwarding setup on the phone. A public domain, Cloudflare service, or additional VPN service is not required.

The SSH tunnel and web authentication are separate. Log in with the recovery passphrase, then choose **信任此浏览器** (Trust this browser) in the sidebar to enable future browser-key sign-in. Each browser/profile pairs separately. An optional CLI can issue a single-use pairing link valid for ten minutes. See [authentication and security boundaries](docs/SECURITY.md).

## Conversations and running work

- The conversation library is persistent Codex history. Reading history does not start a runtime. Add a conversation to the running area to continue it in its own tmux session.
- **Close runtime** stops the execution shown in its preview and keeps the conversation in the library. It does not archive the conversation. For a discovered terminal session, inspect the preview: closing may affect other panes in that session.
- **Archive** previews the affected conversation and descendants, checks for active writers, and stops related managed runtimes before archiving. Read each result. `partial`, `failed`, and `unknown` are not success; rechecking reads results and does not repeat the archive request. An unresolved operation can keep affected conversations blocked from new work.
- Conversations active in another CLI/client are read-only here. Close the original client before reopening them for continuation. The WebUI does not promise to take over another live client.
- A timeout or disconnect can leave a submission's outcome unknown. Check history before sending again; the gateway does not automatically replay work.

## Development and scope

```sh
node --test test/*.test.mjs
python3 scripts/test_device_pairing.py
```

The automated tests exercise protocol filtering, authentication, runtime identity, lifecycle operations, and UI state using controlled fixtures. They do not establish that a new server, SSH tunnel, or browser works end to end. A real phone was used for acceptance of the original deployment; that evidence is specific to that deployment.

This is a self-hosted tool for one trusted OS account, not a public multi-user service. Production protocol support is pinned to Codex 0.165.0; new CLI versions require review. See [SECURITY.md](docs/SECURITY.md) before deployment.

MIT licensed. This project is independent of OpenAI.
