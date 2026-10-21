# Changelog

## 0.5.4 preview — 2026-10-22

- 兼容 DSH Desktop 0.2.1-rc.2：`engines.dsh` 由精确的 `0.2.0-rc.2` 放宽为 `>=0.2.0-rc.2 <0.2.2-0`。0.2.1 起宿主会在装载时校验 `engines.dsh`，精确钉死的插件会被**静默跳过**（只在启动 stderr 留一行 `skipping profile bundle … incompatible with dsh 0.2.1-rc.2`，界面无任何提示），表现为插件行、工具和补丁层一起消失。`peerDependencies` 里的 `@deepseek-ai/dsh-tools` 同步放宽到同一区间。
- 核对过 0.2.1 的兼容面：`@deepseek-ai/dsh-tools` 仍导出插件唯一用到的 `validateJsonSchemaValue`（`index.mjs:59`），插件行在 0.2.1 宿主里能正常装载、`dragon_browser` / `dragon_desktop` 工具照常注册；本次只改兼容声明，未改任何动作、权限或审计逻辑。
- 未变更：CDP / UI Automation 后端、作用域权限、物理 Esc 急停、批量动作与脱敏审计均与 0.5.3 相同；0.5.3 的性能结论继续适用。
- 验证状态：本地 `npm run check` 与 `npm test` 通过；Windows 真机 UI 自动化回归（真实窗口、混合 DPI、管理员窗口）仍按 PUBLISHING.md 的稳定版前清单另外记录，不能用本地检查替代 GitHub CI。

## 0.5.3 preview — 2026-10-18

- 原生命令常驻：`DragonNative.exe` 与 `A11yProbe.exe` 改成同一进程内逐行收发请求（`native-session.mjs`），不再每次动作都新起 8–10 个进程。`A11yProbe.cs` 增加请求循环与 `{id, ok, value|error}` 信封，旧版一次性调用（不带 `id`）仍然返回原格式，所以升级途中新旧代码可以共存。
- 常驻进程的边界条件都写在 `native-session.mjs` 里并有测试：请求按序排队、响应按 `id` 匹配、单请求 12 s（UIA 6 s）超时、取消或超时直接杀掉进程（不能让可能还在输入的原生进程继续跑）、原生报错不弄死进程、空闲 60 s 自动退出、父进程结束即随 stdin EOF 退出、插件卸载时统一关闭。
- 校验一处没减：窗口身份、坐标、观察号过期、Esc 急停规则全部保留；省掉的是重复的进程启动和通信，不是核验。
- 实测（同机、同一套动作、单步 `key`）：
  - 插件层（`scripts/profile-action.mjs`，真实窗口 + 真实权限守卫）：1889 ms → 301 ms；其中守卫从每段约 386 ms 降到 13 ms，执行段 1111 ms → 279 ms。
  - 原生单次：冷启 96–100 ms，同进程后续 `foreground`/`inspect` 2–7 ms，`tree` 约 134 ms。
  - 真实 DSH 会话（重启后，客户录入器窗口，同场景 5 次）：`key` **648–720 ms（均值约 683 ms）**，0.5.2 同期是 2911–2967 ms；`a11y` 281 ms（0.5.2 是 828 ms），`set_element_value` 312 ms，`click_element` 369 ms，`windows` 170–259 ms，`observe`（截图）1186 ms（0.5.2 是 2184 ms，省下的是不再重复起进程）。
  - `observe` 剩下的 1.1 秒是 PNG 编码 + base64 传输，不属于本次优化范围。
- 审计日志的 `end` 记录新增 `timings`（`guard` / `execute` / `render` / `image` / `after` 各段毫秒数，不含参数），方便下一次在真实会话里核对宿主层开销。
- `batch` 的观察号补全：首步省略 `observation_id` 时沿用工具层那一个，后续步省略等同于 `previous`。之前首步不带 id 会直接报「观察已过期」，把工具层的 id 白给了。
- 抢焦点不再被当成新目标：输入动作结束后如果前台已经不是本轮目标窗口，立刻报 `DRAGON_FOREGROUND_CHANGED` 并清掉观察，后续步骤一律停下，不会再像以前那样把抢到焦点的窗口当成下一次输入的目标。`type` 在「点下去 → 开始打字」这 60 ms 缝隙里也补了一次前台核对，前台不对就一个字都不发。主动切换窗口（`focus_window` / 重新 `observe`）不受影响。代价是每次 `type` 多一次 `foreground` 查询（常驻进程内 2–7 ms）。
- 同一任务端到端复测（客户录入器 5 条 + 导出 + 报告 + 三端核对，同一台机器）：界面操作 **5 分 01 秒 → 2 分 11 秒**，全流程 **16 分 01 秒 → 2 分 39 秒**，仍 40/40 通过；做法改成「一条记录一次 batch + 保存前 a11y 回读」。
- 回归测试 80 项通过（新增 `native-session` 5 项、`batch` 默认观察号 1 项、抢焦点 2 项）。
- 守卫失败也带专用错误码：过期记 `DRAGON_OBSERVATION_STALE`，窗口变化记 `DRAGON_WINDOW_CHANGED`（原来只有一句中文、审计里归成 `DRAGON_ACTION_FAILED`）；分段 `timings` 在阶段抛错时也会记录耗时。
- 重启后实测（客户录入器，20:2x）：
  - batch 只给工具层观察号、两步都不写 `id`：跑通，文字正确落在「客户名称」，回读 `验证测试` 后清空；
  - 用置顶遮挡窗压住「客户名称」再 `type`：报 `DRAGON_FOREGROUND_CHANGED`，**遮挡窗输入框和目标字段都没收到文字**，审计里该次记录 `timings.guard=420 ms`；
  - 最小化目标窗口后 `type`：被拒（当时记 `DRAGON_ACTION_FAILED`，新版记 `DRAGON_WINDOW_CHANGED`）。

## 0.5.2 preview — 2026-10-18

- 按需截图（默认 light）：`click` / `type`（`input_text`）/ `key`（`hotkey`）/ `scroll` / `drag` / `hold` / `open_app` / `open_in_browser` / `open_in_finder` 动作后不再抓 2560×1440 的窗口 PNG，只取窗口信息并续上 `observation_id`；`observe`（`wait`）、`apps`（`list_apps`）和 `focus_window` 仍然截图。观察号、坐标校验、过期与窗口身份检查逻辑不变，模型想看图时显式 `observe`。
- 实测分两层：
  - 插件层（`scripts/bench-shots.mjs`，真实 `客户录入器.exe` 窗口，5 次 `key`）：单步 1029 ms → 439 ms。
  - 真实 DSH 会话（重启后同机会话 `history`）：`key` 稳定 2.91–2.97 秒，`observe`（截图）2.18 秒，`windows` 0.26 秒；0.5.1 同期 `type` 是 4.45 秒。
  - 结论：图片那一步省掉了，但每步仍有约 2.5 秒花在原生命令逐个起进程（`DragonNative.exe` / `A11yProbe.exe` 每次约 95–100 ms，一次输入动作要 8–10 次）和宿主层开销上。再降需要原生层常驻进程 + 单轮内复用窗口身份，属下一步，不在本版。
- light 模式下动作后的固定等待从 350 ms 降到 120 ms（没有图片要等渲染），`full` 模式仍是 350 ms。
- 恢复旧行为：`~/.dsh/dragon-control/config.json` 写 `{ "desktopShots": "full" }`，或启动 DSH 前设 `DRAGON_DESKTOP_SHOTS=full`。
- 新增 `scripts/bench-shots.mjs`（不启动 DSH，直接测 lower layer，可对 fixture 或任意 exe 窗口跑）；回归测试 72 项通过。
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
