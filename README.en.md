# dsh-dragon-control

[中文](README.md) · 0.5.4 preview · MIT

**Windows x64 only. macOS, Linux, WSL and headless servers are unsupported, including for browser-only usage.**

Two tools for DSH Desktop conversations: `dragon_browser` and `dragon_desktop`. Use DOM browsing, native Windows UI Automation handles, or fresh screenshots for pixel input. Independent community project; not affiliated with DeepSeek or OpenAI.

## Requirements and installation

Adapted combination: Windows x64, Node.js 24, DSH Desktop 0.2.0-rc.2, and a system installation of Microsoft Edge or Google Chrome. The plugin now ships its own browser launcher and CDP client, so it runs standalone and does not need dsh-orb or dsh-builtin-browser.

```powershell
dsh plugin --profile desktop add C:/path/to/dsh-dragon-control-0.5.4.tgz
```

DSH plugin management can also install a local archive. On the first browser action the plugin looks for `DRAGON_BROWSER_PATH`, then the system Edge and Chrome, and launches it with its own profile directory, so your everyday browser logins are not reused. Data defaults to `<DSH_HOME>/dragon-control`; users can configure `dataDir`. The package includes native source and a prebuilt helper, with no install-time scripts.

Download the archive/checksums from [GitHub Releases](https://github.com/wangtheme-coder/dsh-dragon-control/releases), or install the version tag with `dsh plugin --profile desktop add github:wangtheme-coder/dsh-dragon-control#v0.5.4`. For immutable installation, use the full reviewed commit SHA instead of a tag.

Finish active work, fully quit DSH through its tray menu, restart and create a fresh conversation. `action=status` should return version 0.5.4, `backends.browser: dragon-cdp` and `Windows x64 only`.

## Features and usage

- DOM browsing, tab management, conditional waits, screenshots and confined URL downloads.
- Windows UIA Invoke, SetValue, Select, Toggle, Expand/Collapse and condition waits. Semantic actions do not need an image-capable model.
- Optional attachment to a user-enabled loopback Chrome/Edge debugging endpoint, preserving that browser profile's login state without exporting cookies.
- `batch` submits up to 50 actions. All parameter schemas are checked before any step executes. Execution stops on the first failure and each step is audited. Completed steps are not rolled back.
- App/origin scopes, default one-use confirmations, physical Escape stop and redacted local history.

Use `{ "action": "help", "args": { "action": "click" } }` to load an action schema. For desktop actions: `windows` → `a11y` → an element action with the returned `a11y_id` and `element_id`. Handles are consumed once; changed, expired, password or unsupported controls fail explicitly. Pixel actions require a fresh `observation_id` and an image-capable model. Batch pixel steps may use `observation_id: "previous"` from a prior step in that batch. Batch cannot contain batch/help/status.

0.5.0 makes the browser side self-contained: the plugin launches system Edge/Chrome with its own `user-data-dir` and drives it through its bundled CDP client. 0.4.1's fixes for CDP target selection, session isolation, tab metadata scopes, write confirmations, cancellation/timeouts, stale documents, mode changes and per-step validation remain in place.

## Permissions

Default `owner` mode asks the Host for exact executable-path / top-level HTTP(S)-origin scopes. Read grants last for the Session, control grants for the turn. Browser mutations, pixel input, UIA Invoke and other conservative sensitive actions additionally require one-use confirmation. Host policy `never` rejects operations requiring a prompt, even with static scope grants.

User-selected global `auto` mode skips this plugin's scope prompts and sensitive confirmations, **including with Host policy never**. Explicit target denials, platform limits, the stop latch and other hard restrictions still apply. The composer switch asks before enabling auto. Returning to owner revokes leases and invalidates pending approval. Users may also run `npm.cmd run mode -- owner|auto`; no model-facing action changes grants or modes.

The file is `<DSH_HOME>/dragon-control/permissions.json`. App keys are absolute executable paths, origin keys exact origins, no wildcards. Arbitrary separate-browser `execute` scripts are disabled unless the user enables `allowPageScript`. Built-in CDP DOM actions do not expose arbitrary script execution.

These checks are not an OS sandbox or network firewall. Approved websites can run scripts and make their own requests. Arbitrary local shell code can bypass plugin boundaries. The plugin blocks older parallel Orb GUI / `browser_*` tool entries while loaded. See [SECURITY.md](SECURITY.md).

## Attaching a browser

The user must start the browser with a debugging port and a dedicated profile. The plugin only connects to the specified `127.0.0.1` port, rejects redirects/remote debugger addresses, and never restarts an everyday browser or copies its profile. Chrome 136+ requires a non-default user-data directory for remote debugging; log in separately in that profile. Never share one profile between concurrent browser processes. See [Chrome's official guidance](https://developer.chrome.com/blog/remote-debugging-port).

```json
{"action":"attach","args":{"port":9222}}
{"action":"chrome","args":{"op":"tabs"}}
{"action":"chrome","args":{"op":"fill","selector":"#name","value":"Example"}}
{"action":"chrome","args":{"op":"click","selector":"#go"}}
{"action":"detach"}
```

Supported operations: tabs/current/content/text/screenshot/wait/click/fill/type/key/scroll/back/forward/reload/open/goto/switch/close/new_tab. Tab metadata needs every origin's read scope. Mutations need owner-mode confirmation. A closed target is never silently replaced. Page/loader changes during approval stop stale input. Connections belong to an Agent/Session; Escape and unload disconnect them without closing the user's browser. A debugger also grants other local processes substantial browser access; close it after use.

## Downloads, history and stop

Browser downloads and screenshots must stay inside `status.downloadsDirectory` (subdirectories allowed, escaping refused), use a new filename and are capped at 256 MB. File uploads, CDP transfers, click-triggered downloads and general Save As dialogs are not implemented.

Logs retain action/duration/outcome/error metadata for 14 days and approximately 10 MiB. They omit arguments, typed values, URLs, scripts and screenshots. Unwritable logs stop operations. `history` is Agent/Session-scoped and does not replay actions. Host chat, attachments and browser login profiles have separate retention rules.

Physical Escape cancels armed plugin GUI work, clears observations and blocks model retries until a later user message. Injected Escape is ignored. Cancellation cannot undo completed side effects; observe before retrying. Observation frames are hidden after actions, stop, turn end and unload.

## Validation and preview limits

67 regression tests, 10 real Windows integration groups, an isolated real Chrome CDP local-form smoke test and a new self-hosted headless Edge smoke test (open/snapshot/fill/click/wait/a11y/scrape/screenshot/execute, 22 assertions) passed. Reports: [release-verification.json](release-verification.json), [cdp-verification.json](cdp-verification.json). Tests use owned fixtures and controlled approval services, with zero remote model calls.

```powershell
npm.cmd run build:native
npm.cmd run check
npm.cmd test
npm.cmd run smoke:cdp
npm.cmd run smoke:self
$env:DSH_RUNTIME_ROOT = 'C:/path/to/official-dsh-runtime'
npm.cmd run test:integration
npm.cmd run pack:local
```

Pending manual acceptance: physical Escape, DSH approval UI, Notepad save workflow, mixed-DPI/multiple displays, elevated windows, real-model planning and clean-profile install/uninstall/rollback. Screenshot cropping/annotation and automatic updates are also unimplemented. No independent security audit or claim of marketplace leadership.

See [PUBLISHING.md](PUBLISHING.md) for GitHub and separate marketplace/index submission. Disabling/removing the plugin and restarting releases its hooks; permissions, logs and backend login storage remain. MIT; development assisted by Codex and DSH. [Contributing](CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md).

After publication, DSH builds supporting format-1 indexes can add `https://raw.githubusercontent.com/wangtheme-coder/dsh-dragon-control/main/market-index.json`. This independently maintained index pins the reviewed source commit; it does not replace users' existing market configuration.
