# Changelog

## 0.5.1 preview — 2026-10-18（0.5.0 未公开发布，内容并入本版）

- 首发热修：上一行 `0.5.0` 的网页自立化内容与本条一并发布为 0.5.1。
- 修复工具结果被多包一层数组的问题：`desktop-defs.mjs` 里 `wait`（桌面的 `observe`/`wait`）与 `list_apps`（`apps`）的 `render` 返回了 `[[{type:"text"}]]`。DSH 会把工具内容的每一项直接当成消息块写进会话历史，嵌套数组会让**下一次模型请求整轮失败**（`UNSUPPORTED_CONTENT`：`DeepSeek Messages cannot represent user/tool-result content undefined`），而且这条坏记录会永久留在会话里，此后每轮都失败——只能改会话日志才能救回来。
- `control.mjs` 现在统一用 `contentBlocks()` 归一化渲染结果（`flat(Infinity)` 并丢弃没有 `type` 的块），dispatcher 与工具级 `render` 都走这一层，以后再有自定义 render 也不会把非法结构写进会话。
- 新增 `test/desktop-defs.test.mjs`：真实执行 `wait`/`list_apps`，并检查每个定义的渲染结果都是一维、带 `type` 的块；回归测试 72 项通过。

## 0.5.0 preview — 2026-10-18

- 网页侧自立：新增 `browser-launch.mjs`，直接启动本机 Microsoft Edge / Google Chrome（独立 `user-data-dir`、随机调试端口、复用上次启动的实例）；新增 `browser-self.mjs`，用插件自带的 CdpClient 实现 open/snapshot/a11y/content/click/type/fill/set_value/get_value/check/select/clear/scroll/key/wait/back/forward/reload/tabs/switch_tab/close_tab/screenshot/scrape/challenge/download/execute。不再加载 `dsh-builtin-browser` 的 `BrowserRuntime` / Electron provider，也不再需要 `dsh-orb` 的 Electron 运行时。
- 新增 `browser-defs.mjs`：把自立实现注册成原有 `browser_*` 定义集合，动作名和参数保持兼容；help、batch、权限与审计路径不变。
- 桌面侧继续使用上一版的 `DragonNative.exe`；GUI 锁改用插件自己的 key（`dragon-control.gui-lock`），不再借用 `dsh-orb.gui-lock`。删除 `compatibility.mjs`，`package.json` 去掉 `dsh-builtin-browser` peer 依赖。
- 网页层安装失败时只记录 `browser-error.log` 并保留 `dragon_desktop`，不会因此让整个插件加载失败；`status` 会报告 `backends.browser: dragon-cdp` 与启动状态。
- 浏览器动作全部在隔离世界执行 DOM 读写；密码框拒绝读写，下载/截图限制在插件下载目录，`execute` 仍由 `allowPageScript` 门控。关闭插件时会关掉自己启动的浏览器，复用的用户浏览器不动。
- 验证：67 项回归测试；新增 `scripts/self-browser-smoke.mjs`，在真实无头 Edge 上跑 open/snapshot/fill/get_value/a11y/scrape/screenshot/execute/challenge/click/wait/list_tabs（22 项断言）。

## 0.4.1 preview — 2026-10-17

- Windows x64 only is explicit in both READMEs, package metadata and runtime status.
- Bind CDP connections/selected targets to an Agent/Session; preserve explicit selection and refuse closed/replaced documents.
- Require origin read scopes for tab metadata, control scopes plus owner-mode one-use confirmation for mutations. Restrict endpoints to the specified loopback port, reject redirects and add command timeouts/cancellation.
- Disconnect CDP on Esc/unload; omit raw screenshot base64 from text output. Built-in DOM scripts use isolated worlds and unique, visible non-password targets.
- Reject unrecognized Host admission and cross-origin mode requests. Enabling auto requires explicit UI acknowledgement; returning to owner revokes leases and pending approvals. Auto respects explicit read denials and cancellation.
- Validate the entire batch before any step runs; audit each step including failures, and read observation IDs from full output.
- Recheck desktop accessibility after approval; revalidate browser tab lists before disclosure.
- Test CDP against a new browser's own dynamically assigned port, avoiding accidental attachment to a previously running browser.
- Add Windows CI and GitHub / community directory / DSH format-1 index publication instructions. Native source and prebuilt helper are included without install hooks.
- Validation: 57 regression tests, 10 real Windows/browser integration groups and an isolated real Chrome CDP smoke test. Manual acceptance limits remain documented.

## Unreleased — 0.4.0

- Add `batch`: up to 50 ordered steps in one call, stop at the first failure, short summary per step plus the full result of the last one (or any step marked `final: true`). `observation_id: "previous"` reuses the previous `observe` handle for desktop pixel steps. Nested batches and `help`/`status` steps are refused before anything runs; the whole batch is one audit entry while each step still passes validation, scope checks and Esc cancellation.
- Add `attach` / `chrome` / `detach`: drive a browser the user started with `--remote-debugging-port` over CDP (tabs, current, content, text, screenshot, wait, click, fill, type, key, scroll, back, forward, reload, open, goto, switch, close, new_tab). Reads ask for the origin's `read` scope, mutations for `control`; non-http(s) pages are refused. Chrome 136+ ignores the debug port on the default data directory, so the README documents the Chrome for Testing / dedicated-profile route instead of promising the everyday profile.
- `chrome-cdp.mjs` has no native dependency: `fetch` for `/json/version`, the built-in WebSocket for CDP, id-multiplexed calls with per-target sessions.
- Add `scripts/cdp-smoke.mjs`, which starts a real headless Chrome/Edge on a debug port and asserts attach, open, fill, click, text, wait, screenshot, `file://` refusal and clean detach.
- Tests: 45 regression tests (batch 4, CDP 4, existing 37).

## Unreleased — 2026-10-17

- Document the product stance for hosts and users: the agent should call these tools on its own initiative when a task needs a page or the desktop instead of waiting to be told. Added to the injected guidance and to both READMEs (design principles).
- Add a client half: a「龙爪 主人｜自动」chip in the composer's right toolbar (`conversation.input.right`), separate from DSH's own permission-mode dropdown. It calls `GET/POST /dragon-control/mode`, which writes the same `permissions.json` the CLI uses.
- Add a `mode` switch in `permissions.json`: `owner` (default, one-use host approval for sensitive actions) and `auto` (the plugin decides by itself; explicit `false` denials still apply). Switch with `npm run mode -- auto|owner`; the file is re-read on every request, so no restart.
- `wait_for` no longer requires `window_id`; omitting it waits on the frontmost window, matching `a11y` and the documented behaviour. Previously the schema rejected the call before the frontmost-window path could run.
- A refused `open`/`navigate`/`download` is authorized before the browser runtime is touched, so a rejected destination no longer launches Electron or leaves a blank window behind.
- Regression tests: frontmost-window wait, and refused navigation starting zero browser sessions.

## 0.3.0 — 2026-10-17

- Add observation-bound UIA Invoke, SetValue, SelectionItem, Toggle and Expand/Collapse; return fresh state and reject stale targets without coordinate fallback.
- Make semantic observation/actions usable without an image model; add bounded native control-condition waits.
- Add exact application/top-level-origin read/control scopes, host one-use confirmation and fail-closed handling for denied/unavailable approval.
- Reuse the official DSH argument validator at dispatch, close unspecified known-object fields and bound input sizes/depth.
- Add redacted local action history with retention/size limits; do not capture screenshots for logs.
- Diagnose higher-integrity/inaccessible windows and unavailable interactive desktops before input.
- Unify browser download confinement, refuse overwrite and disable arbitrary page scripts by default.
- Add explicit backend compatibility checks, public integration fixtures and developer-supplied official runtime resolution.
- Keep two tools and the existing top-level action API. Preserve Esc cancellation and overlay cleanup.

Breaking behavior: scopes start empty; a `never` host approval policy blocks requests requiring approval. Static grants do not bypass sensitive confirmation. Parallel original GUI/browser tool entries are denied while this plugin is active. `a11y` now returns semantic state without an automatic screenshot; use `observe` for images.

## 0.2.1

Clear the observation overlay after actions, cancellation, turn end and disposal; prevent late captures from restoring stopped frames.

## 0.2.0

Add physical-Escape emergency cancellation, exact window selection, read-only UIA and capability diagnostics.
