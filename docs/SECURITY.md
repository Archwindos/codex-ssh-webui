# Authentication and security boundaries

This tool is intended for one trusted Linux OS account. The documented gateway listens on `127.0.0.1` and is reached through SSH. It is not a tenant-isolated public service. Protect the server account, SSH client, browser, and forwarded loopback port.

中文提示：SSH 隧道、网页登录、Codex 账号分别管理。断线后结果可能未知，请先核对历史，不要直接重复发送。

## SSH and browser login

`RELAY_ACCESS_SECRET` is a separate recovery passphrase of at least 32 characters. Retain it privately across gateway restarts. SSH access does not replace web login; browser trust does not provide SSH access.

After recovery login, **信任此浏览器** (Trust this browser) enrolls a P-256 signing key. The browser keeps a non-exportable private key in IndexedDB; the gateway stores its public key and trust metadata. Sign-in uses a short-lived challenge bound to the session and origin. This is browser-profile authentication, not a passkey, hardware attestation, or a guarantee of hardware-backed key storage.

Each browser/profile enrolls separately. Clearing site storage, changing the local port or profile, and private browsing can require enrollment again. Trust can expire or be revoked. **取消信任并退出** (Revoke trust and sign out) removes the current browser's trust; ordinary logout ends its web session.

The optional issuer creates a single-use browser enrollment link:

```sh
python3 scripts/device-pairing.py --approved create
```

Run it from the repository root as the same owner of the private app directory. The app root and `runtime/` must already be real, owner-only directories with mode `700`. Its JSON contains `pairingUrl` and `expiresAt`. Open the URL in the intended browser through its SSH tunnel, then select **信任此浏览器**. The link expires after ten minutes. Treat the whole URL as a login credential: do not commit, screenshot, or put it in an issue. Alternative forwarded ports must match the issuer's supported port setting and browser origin.

## Desktop credentials

A first-seen SSH host-key fingerprint requires a human decision. Verify it through a trusted source; do not accept an unexpected key merely to make a connection work.

Windows stores connection settings with current-user DPAPI and restricted ACLs. macOS uses the user's Keychain. Helpers supply saved passwords only to recognized SSH prompts; ordinary configuration files and command-line arguments do not carry passwords. Forgetting saved settings affects that device, not the server or Codex account. These stores cannot protect against code already running as the same user or an administrator.

The launchers check tunnel ownership and gateway identity before opening the browser. They do not install a server daemon, change its settings, or replay model work. Native Windows behavior has checks; full macOS Keychain/Terminal integration remains a platform acceptance requirement. Follow the deployment guide's executable-permission step for Mac launchers and their askpass helper.

## Native daemon and execution

- Shared mode connects to an existing native Unix socket under the gateway account. Protect the socket and Codex home with owner-only access. The gateway does not own, stop, or restart that daemon.
- Clients must connect to the same daemon to share live state. An independent stdio/TUI writer may hold a conversation lock; the gateway does not stop it or bypass that lock.
- Host/Origin validation, CSRF checks, session validation, supported-method allowlists, and workspace checks remain enabled behind SSH.
- Approval and question replies are tied to the verified thread, current turn, and connection generation. Unsupported or unverified shared requests remain pending for an official client; another client's request is not automatically declined.
- A timeout can leave a turn or steering result unknown. Reconnect reads state without automatically replaying the message. Check history before sending again.
- Models, reasoning levels, and permission profiles come from native capabilities. Selecting a profile can change that thread's execution permissions; review the choice. The WebUI does not rewrite global Codex settings.
- An enabled temporary terminal runs as the gateway account. Set `temporaryTerminal` to `false` unless that browser access is intended.

Workspace roots constrain WebUI browsing and admission. They are not an OS sandbox against trusted code under the same account. Codex permissions, approvals, account rules, and model access still apply.

## Uploads and retained history

Uploads are authenticated, session-owned, and addressed by opaque IDs. Browser requests cannot select an arbitrary server path. Directories use mode `700`, files use `600`, and stored ownership is hashed rather than a raw session token. Upload responses omit storage paths.

Limits are 10 MiB per file, five attachments per message, and 50 MiB pending per login session. Images use extension/signature checks and native `localImage` input when the selected model accepts them. This is not a full image decoder or malware scanner. Office files receive a ZIP-signature check without extraction. Documents, UTF-8 code/text, and supported research text formats remain private files referenced in a native text manifest; PDFs are not disguised as images. Original names remain available for history display.

Partial, failed, or canceled uploads are cleaned up before publication where possible. Unreferenced uploads can be canceled and become eligible for cleanup after 24 hours. Referenced files survive disconnects, gateway restarts, and uncertain submissions because Codex may need to read them later. They are not automatically deleted when a turn completes. Budget disk space and use deliberate maintenance for retained files. No generic file-download or arbitrary-path read endpoint is provided for attachments.

The context indicator uses the latest request's `last` token usage, not the lifetime cumulative total. If live usage is missing, a bounded native-rollout tail read may provide a value; path, ownership, and link checks constrain it. Missing or incompatible values stay unknown. This is not a billing report.

## Projects and lifecycle actions

Project pins are WebUI-only preferences. Native project names, order, roots, and membership remain separate. Projects form a flat list; grouping/sections are not enabled.

Archive previews include native descendants, internal reviews, and children outside the selected project. Inspect the unique affected-ID list. Project-wide archive requires explicit confirmation of outside associations and executes independent roots without repeating an ancestor's cascade. Active tasks or unresolved operations can block archive; shared mode does not stop running work to make it proceed.

Project removal deletes project metadata while retaining conversations and workspace files, then checks each confirmed chat's assignment. It is separate from archiving or deleting chats. Concurrent native-client changes can leave partial or unknown results.

Confirmation freezes relevant gateway admissions, not every other native client. Scope and membership are checked again before dispatch, but the operation is not a cross-client atomic transaction. Keep `partial`, `failed`, `notAttempted`, and `unknown` outcomes distinct. Recheck reads receipts and state; it does not resend operations or execute remaining roots. Unresolved receipts may keep related WebUI changes frozen until verified.

## Private files and reporting

Protect the app root and `runtime/` as owner-only directories. Runtime data includes device records, attachments, web preferences, and operation receipts. Codex keeps its own authentication and conversation stores. Do not publish either store, local configuration, logs, SSH credentials, recovery passphrases, or pairing URLs.

Production is pinned to the verified Codex 0.165.0 protocol and explicit startup gates. Upgrades require compatibility review; changing a version string or flag is not verification. Fixtures and sanitization cover particular risks, not every deployment.

Report defects with minimal reproduction steps and software versions. Remove credentials, account details, private hosts and paths, session IDs, and conversation content. Use disposable demo data for screenshots.
