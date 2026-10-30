# Authentication and security boundaries

This application is intended for one trusted Linux account, reached through SSH. The gateway listens on `127.0.0.1`; the documented HTTP route is for an SSH tunnel to that loopback listener. Keep the SSH client, browser, server account, and forwarded loopback port under your control.

## Browser authentication

`RELAY_ACCESS_SECRET` is a separate recovery passphrase of at least 32 characters. SSH access does not replace web login. Keep the passphrase outside source control and retain it for browser recovery and server restarts.

After recovery login, **信任此浏览器** (Trust this browser) enrolls a P-256 signing key. The browser stores a non-exportable private key in IndexedDB; the server stores its public key and trust metadata. Later sign-in proves possession of that browser key using a short-lived challenge bound to the session and origin. This is browser-profile authentication, not iPhone hardware attestation, a passkey, or a guarantee of hardware-backed key storage.

Each browser/profile pairs separately. Clearing site storage, switching profiles, or using private browsing can remove access to the key. Trust expires and can be revoked. **取消信任并退出** (Revoke trust and sign out) revokes the current browser. Ordinary logout ends the session without deleting its trust record.

An optional pairing link lets the owner enroll a browser without entering the recovery passphrase there. With Python 3, run this from the repository root on the Linux host as the same owner of the private app directory:

```sh
python3 scripts/device-pairing.py --approved create
```

The app root and `runtime/` must already be owned by that user with mode `700`, without symlinks. The issuer does not change existing directory permissions. Its stdout JSON contains `pairingUrl` and `expiresAt`; open the URL in the intended browser while its SSH tunnel is connected, then choose **信任此浏览器**. The capability is single-use and expires after ten minutes. Treat the entire returned URL as a login credential; do not put it in an issue, screenshot, log, or committed file. Use `--port 9443` only if you deliberately use that alternative forwarded port.

## Execution boundary

- Host/Origin checks, CSRF checks, request allowlists, workspace restrictions, and authentication remain enabled. A tunnel is not a reason to remove them.
- The relay accepts only its supported methods and approval types. Unknown server requests fail closed. Approval replies are checked against the active conversation and turn.
- Production is pinned to Codex 0.165.0, with explicit version/schema verification gates and a startup handshake check. Upgrading the CLI requires compatibility review rather than changing the version string alone.
- Upstream stderr is consumed but not forwarded to the browser because it can contain account or path details. This can limit browser-side diagnosis; inspect only sanitized information when reporting a problem.
- There is no automatic replay of a turn after a timeout or disconnect. An unknown outcome must be checked in history before another submission.
- Runtime close and archive operations act on processes and stored conversations. Read the impact preview, including other panes and child conversations, and retain `partial` or `unknown` results as unresolved.

`runtime/` contains private device records, run identities, IPC state, and operation receipts. Its directory and the app root should be owned by the gateway user with mode `700`; sensitive runtime files use mode `600`. Codex keeps its own account credentials and history. Do not publish either store, local configuration, gateway logs, recovery passphrases, or pairing URLs.

Workspace roots constrain the WebUI's selection and admission of conversations. They are not an OS isolation boundary against trusted code running as the same account. This project does not provide tenant isolation or support an unauthenticated public endpoint.

When reporting a defect, include sanitized reproduction steps and relevant software versions. Remove credentials, account details, private hostnames, paths, and conversation content from reports.
