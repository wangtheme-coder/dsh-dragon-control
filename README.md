# 龙爪控制 · dsh-dragon-control

[English](README.en.md) · 0.5.4 preview · MIT

**仅支持 Windows x64。不适用于 macOS、Linux、WSL 或无桌面的服务器。即使只用网页功能，目前也需要 Windows 后端。**

为 DSH Desktop 普通会话提供 `dragon_browser` 和 `dragon_desktop` 两个工具：通过 DOM 操作网页，通过 Windows UI Automation 操作控件，必要时使用截图和坐标。独立社区项目，与 DeepSeek、OpenAI 无隶属关系。

## 能做什么

- 网页：打开、读取、DOM 点击、填表、多标签、条件等待、截图及 URL 下载。
- 桌面：列出和选择窗口；按 UIA 控件句柄执行 Invoke、SetValue、Select、Toggle、Expand/Collapse；等待控件出现或消失。语义路线无需视觉模型。
- 按需截图：点击、输入、按键、拖拽、打开应用默认只续上 `observation_id`，不抓图；要画面时再用 `observe`（始终截图）。省掉每一步 2560×1440 的 PNG，实测单步（`key`）从 1.0 秒降到 0.44 秒；会话内还要再省下每帧图片的传输与落盘。
- 原生层常驻：`DragonNative.exe` / `A11yProbe.exe` 同进程复用，插件层单步（`key`，含守卫）从 1.89 秒降到 0.30 秒，真实会话单步 `key` 从约 2.94 秒降到 **约 0.68 秒**（同机 5 次，648–720 ms）；窗口身份、坐标、观察号与 Esc 急停的校验一条没减。
- 接入用户主动开启调试端口的 Chrome/Edge；连接复用该浏览器配置中的登录态，不导出或复制 Cookie。
- `batch` 一次提交最多 50 步，先校验所有步骤，依次执行、遇错即停，并逐步记录脱敏日志。已执行的步骤不会回滚。
- 精确应用路径、网站顶层来源的 read/control 授权；默认敏感动作逐次确认；用户物理 Esc 急停。

0.5.0 把网页侧也改为自立：插件自己启动本机 Edge/Chrome（独立 `user-data-dir`）并用自带的 CDP 客户端驱动，不再需要 `dsh-builtin-browser` 或 `dsh-orb` 的 Electron。0.4.1 修复的 CDP 标签选择、跨会话隔离、标签元数据权限、写操作确认、超时取消及页面变化后的过期操作仍然有效。详见 [CHANGELOG](CHANGELOG.md)。

## 环境与安装

目前适配的组合：**Windows x64、Node.js 24、DSH Desktop 0.2.0-rc.2、本机已安装的 Microsoft Edge 或 Google Chrome**。插件自带浏览器启动层和 CDP 客户端，不依赖其他插件；装好本插件即可单独运行。其他版本不承诺兼容。

直接在目标 DSH profile 安装本插件即可。使用默认的 `desktop` profile 时，可在兼容的 DSH CLI 中执行：

首选 npm 安装：dsh plugin --profile desktop add dsh-dragon-control。也可以从 [GitHub Releases](https://github.com/wangtheme-coder/dsh-dragon-control/releases) 下载 tgz 和校验文件，或按版本标签安装：`dsh plugin --profile desktop add github:wangtheme-coder/dsh-dragon-control#v0.5.4`。需要不可变安装时，将标签换成完整源码提交 SHA。

```powershell
dsh plugin --profile desktop add C:/path/to/dsh-dragon-control-0.5.4.tgz
```

也可通过 DSH 插件管理安装本地 tgz。首次执行网页动作时，插件会查找 `DRAGON_BROWSER_PATH`，否则依次尝试系统 Edge、Chrome；用独立配置目录启动，不读取你日常浏览器的登录态。软件包包含原生组件的源码及预编译文件，没有安装时执行的脚本。

非默认 profile 需要在插件行配置 `profileDir`，指向实际 profile 绝对路径。插件数据默认放在 `<DSH_HOME>/dragon-control`，也可由用户配置 `dataDir`。不要将个人路径写进公共发布文件。

更新后，先结束当前任务，再从系统托盘完整退出 DSH、重新打开并新建会话。`action=status` 应显示 `version: 0.5.4`、`backends.browser: dragon-cdp` 和 `supportedPlatform: Windows x64 only`。

## 权限模式

默认 `owner`（手动确认）。没有预置应用或网站允许项。read 授权保持当前会话，control 授权保持当前任务轮次；网页写操作、原始坐标/键盘输入、语义 Invoke 等敏感动作另外逐次确认。应用启动等动作也需要确认。

`auto` 是用户主动选择的全局模式：跳过插件自己的范围询问和敏感动作确认，**也适用于 DSH 的 never 策略**。显式 `false` 拒绝项、管理员窗口限制、下载边界、急停等仍然生效。它不会替模型证明一个操作正确或安全。输入框旁「龙爪 · 手动 / 自动」切换到自动时会先提示确认；切回手动会清除已有授权并使待处理确认失效。

用户也可自行执行 `npm.cmd run mode -- owner` 或 `npm.cmd run mode -- auto`。工具没有修改模式或允许项的动作；模型不应通过其他工具给自己授权。

在 `owner` 模式下，DSH 必须允许询问。宿主 `approval/policy: never` 遇到未授权范围或需要逐次确认的动作会拒绝，不会自动放行。静态允许项只放行指定范围，不跳过敏感动作确认。

配置文件 `<DSH_HOME>/dragon-control/permissions.json` 示例：

```json
{
  "version": 1,
  "mode": "owner",
  "apps": {},
  "origins": {"https://example.com": {"read": true, "control": false}},
  "allowPageScript": false
}
```

应用键须为 exe 绝对路径，网站键须为精确 HTTP(S) origin，不支持通配符。任意 `execute` 页面脚本默认关闭，需要在 `permissions.json` 里把 `allowPageScript` 设为 `true`；打开后也不能读取密码输入框。独立浏览器只通过 CDP 驱动，不上传文件。

这些是插件自身的操作检查，**不是操作系统沙箱或网络防火墙**。被允许的页面仍可能运行自己的脚本和请求；拥有任意 Shell 执行权限的本地代码也能绕过插件。详见 [SECURITY.md](SECURITY.md)。插件加载时会拦截并行的旧 GUI 和 `browser_*` 工具入口，引导模型使用本插件。

## 使用

保持两个工具，细节通过 `help` 按需读取：

```json
{"action":"help","args":{"action":"click"}}
```

桌面流程：`windows` 找到窗口 → `a11y` 读取控件 → 使用返回的 `a11y_id`、`element_id` 执行 `set_element_value` 等动作 → 读取新状态。旧句柄一次性消费，跨会话、过期、身份变化或不支持的 Pattern 均明确拒绝，不自动改用猜测坐标。密码、验证码、登录和 UAC 由用户处理。

需要坐标时先 `observe`，输入引用最新 `observation_id`，按返回的坐标模式操作。窗口移动、大小或 DPI 变化后重新观察；截图路线需要当前模型支持图像。

截图默认按需：`click`/`type`/`key`/`scroll`/`drag`/`hold`/`open_*` 动作后只返回新的窗口信息和观察号，不抓图；`observe`（即 `wait`）、`apps`、`wait` 和窗口切换始终截图。想恢复旧行为（每步都截图），在 `~/.dsh/dragon-control/config.json` 写 `{ "desktopShots": "full" }`，或启动 DSH 前设 `DRAGON_DESKTOP_SHOTS=full`。改配置后重启 DSH 生效；`status.desktopShots` 显示当前模式。

批量浏览器示例（每步参数仍遵循对应动作的 help）：

```json
{"action":"batch","args":{"steps":[
  {"action":"content","args":{"format":"txt"}},
  {"action":"wait","args":{"selector":"#done","timeoutMs":1000}}
]}}
```

桌面像素步骤可用 `observation_id: "previous"` 引用本批次之前步骤返回的新观察号；首步省略则沿用工具层请求里的 `observation_id`，后续步省略等同于 `previous`。不能嵌套 batch，不能在 batch 中调用 help/status。失败或超时可能已经产生副作用，须先观察，不能盲目重试提交。

抢焦点有硬保护：桌面输入只有在目标窗口仍是前台时才执行；输入结束（以及 `type` 点下去到开始打字之间）如果前台换成了别的窗口，直接报 `DRAGON_FOREGROUND_CHANGED` 并清掉观察，后续步骤停下，绝不会把抢到焦点的窗口当成新目标继续操作。要换窗口就显式 `focus_window` 或重新 `observe`。

## 连接已有浏览器

需由用户开启调试端口。仅连接指定端口的 `127.0.0.1`，拒绝远程端点和重定向；不会自动重启日常浏览器或搬运个人配置。

Chrome 136 起，默认数据目录不支持这些调试开关，应使用单独的 `--user-data-dir`，并在该配置中自行登录。不要让两个进程同时使用同一个配置目录。参见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。

```json
{"action":"attach","args":{"port":9222}}
{"action":"chrome","args":{"op":"tabs"}}
{"action":"chrome","args":{"op":"fill","selector":"#name","value":"示例"}}
{"action":"chrome","args":{"op":"click","selector":"#go"}}
{"action":"detach"}
```

支持 tabs/current/content/text/screenshot/wait/click/fill/type/key/scroll/back/forward/reload/open/goto/switch/close/new_tab。每个标签的元数据也要 read 授权；写操作在手动模式逐次确认。选择的标签关闭后不会自动换到别的页面；确认期间 URL 或文档变化会拒绝过期操作。连接按 Agent/会话隔离，Esc/卸载时断开连接，不关闭用户浏览器。调试端口对本机其他进程同样有较高权限，用完应由用户关闭调试浏览器。

## 下载、日志和急停

浏览器下载和截图只能写入 `status.downloadsDirectory`（可含子目录，不能越界），不覆盖已有文件，上限 256MB。没有文件上传、CDP 文件传输、点击触发下载或通用另存为对话框封装。

日志只保留动作、耗时、结果和错误码，保留 14 天、总量约 10 MiB；不记录参数值、完整 URL、脚本或截图。日志不可写时停止动作。`history` 查看当前 Agent/会话的记录，不执行回放。DSH 会话附件、聊天日志及浏览器登录配置有各自的存储生命周期。

物理 Esc 取消所有已布防的本插件 GUI 任务，清除旧观察，禁止本轮模型重试；更新的用户消息才可恢复。程序注入的 Escape 不算用户急停。已完成的点击或远程请求无法撤回。观察蓝框在动作结束、急停、任务结束和卸载时请求隐藏。

## 测试与限制

本次 67 项回归测试通过；10 组真实 Windows 集成检查、真实 Chrome CDP 本地表单测试，以及新的自立浏览器真实无头 Edge 冒烟（open/snapshot/fill/click/wait/a11y/scrape/screenshot/execute，22 项断言）通过。报告见 [release-verification.json](release-verification.json) 和 [cdp-verification.json](cdp-verification.json)。使用自建窗口、本地网页、受控测试确认服务，未调用远程模型。

重新编译原生组件前请先退出 DSH：常驻模式下 `A11yProbe.exe` / `DragonNative.exe` 正在运行，Windows 会锁住 exe 导致编译写入失败。

```powershell
npm.cmd run build:native
npm.cmd run check
npm.cmd test
npm.cmd run smoke:cdp
npm.cmd run smoke:self
# DSH 完整集成还需要指定官方运行环境：
$env:DSH_RUNTIME_ROOT = 'C:/path/to/official-dsh-runtime'
npm.cmd run test:integration
npm.cmd run pack:local
```

仍需人工验收：物理 Esc、DSH 确认界面、记事本完整保存流程、混合 DPI/多显示器、管理员窗口矩阵、真实模型任务规划，以及全新 DSH profile 的安装/卸载/回滚。文件上传、截图裁剪/标注和自动更新尚未实现。当前为预览版，不声明“市场最先进”或已完成独立安全审计。

## 开源、市场和卸载

GitHub 发布与市场收录是不同步骤。DSH 的发现页读取用户配置的市场索引；社区目录也有各自的收录审核。发布流程见 [PUBLISHING.md](PUBLISHING.md)，不会把“已提交审核”表述成“已上架”。

发布后，支持格式 1 索引的 DSH 发现页可添加此源：`https://raw.githubusercontent.com/wangtheme-coder/dsh-dragon-control/main/market-index.json`。这是本项目自有索引，固定到已审查的源码提交；不会自动修改你已有的市场配置。

在 DSH 插件管理禁用/移除本插件并重启，可解除工具守卫并释放监听；插件自己启动的浏览器会随插件卸载关闭，复用的用户浏览器不会。权限文件、日志和独立浏览器配置保留，不静默删除用户数据。

MIT 许可；开发和测试由 Codex 与 DSH 辅助完成。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
