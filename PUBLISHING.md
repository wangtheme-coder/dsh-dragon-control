# GitHub 与插件市场发布

本插件仅支持 Windows x64，当前为 0.5.1 预览版。发布材料、仓库描述和市场描述均须保留这一限制。

## GitHub

1. 运行 `npm run build:native`、`npm run check`、`npm test`、`npm run smoke:cdp`；Windows/DSH 集成另运行 `npm run test:integration`。
2. 审查暂存文件：只提交本项目源码、文档、测试、原生组件和公开验证报告。不得提交 DSH 运行环境、账号、个人路径、权限配置、浏览器配置、日志、截图、下载或安装记录。
3. 为公共仓库添加 `dsh-plugin`、`windows`、`computer-use`、`browser-automation` topics，设置仓库描述、MIT license 及私密漏洞报告入口。
4. `npm run pack:local` 生成 tgz、SHA256SUMS.txt 和逐文件 manifest。发布 GitHub prerelease `v0.5.1`，上传这三个文件。这里不执行 npm publish。
5. 等待真实 GitHub CI 完成，核对远端提交和 release 资产；不能把本地检查当作已通过 GitHub CI。

## 插件市场（dshmarket 实际读取的那个）

用户界面里的「插件市场」是 `dshmarket` 插件，它读取的目录源是 `https://awesome-dsh-plugin.com/plugins.json`（`dshmarket/lib/regions.js` 的 `CATALOG_OFFICIAL`）。这个 `plugins.json` 由 `awesome-dsh-plugin/awesome-dsh-plugin` 仓库的 `data/plugins/*.yml` 生成，README 也由脚本生成、不许手改。

收录方式：一个插件一个文件 `data/plugins/<owner>__<repo>.yml`，开 PR 只加这一个文件；仓库需声明 `dsh.bundle`、带 `dsh-plugin` topic、有 LICENSE、有真实代码、创建满 1 天（年龄门槛由 `regate.yml` 每 6 小时自动重跑，红了会自己变绿）。

- 条目内容：`publishing/awesome-dsh-plugin-entry.yml`
- PR 标题与正文：`publishing/PR-BODY.md`
- 有效分类里用 `browser`（没有 `computer-use`）
- 不发 npm 也行：Release 挂预构建 tgz，用 `tarball:` 钉到 tag

版号变化时必须同步三处：`awesome-dsh-plugin-entry.yml` 的 `tarball:`、PR 正文里的 yaml 块、以及新 tag 的 Release 资产，否则市场里下载到的还是旧版。

## DSH 发现页：格式 1 索引

DSH 的发现页读取用户配置的索引源，没有通用的“上传到全部市场”接口。官方格式见 [plugin-market-index](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/plugin-market-index)，发现页见 [ui-plugin-market](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-plugin-market)。

推送经过验证的源码提交后，使用**真实仓库 URL 和完整源码提交 SHA**生成索引：

```powershell
npm.cmd run market:index -- https://github.com/OWNER/dsh-dragon-control FULL_40_CHARACTER_SOURCE_SHA
```

生成的 `market-index.json` 固定到该源码提交，显示标题和描述明确注明 Windows x64 only，版本兼容范围来自 package.json。索引另做一个提交，因此不会产生“文件指向包含自身的提交”的循环。以 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验实际生成文件后发布。

用户可把仓库 default branch 上 `market-index.json` 的 raw HTTPS URL 添加为 DSH 的市场索引源。这意味着该自有索引可被使用，不等于已被其他社区市场自动收录，也不自动修改用户的 DSH 索引配置。

## dshbase 社区目录

依据其 [提交表单](https://github.com/ylwl1997/dshbase/blob/main/.github/ISSUE_TEMPLATE/plugin-submission.yml)，在 `ylwl1997/dshbase` 创建插件收录 Issue：

- 名称：dsh-dragon-control（龙爪控制）。
- GitHub 仓库：实际公开仓库 URL。
- npm 包：未发布 npm；通过 GitHub 固定提交或 Release tgz 安装。
- 描述：仅支持 Windows x64，为 DSH Desktop 提供 DOM/CDP 网页和 Windows UI Automation 桌面操作，保留两个工具、作用域权限、物理 Esc 急停、批量动作和脱敏审计。
- 分类：Automation（自动化）。
- 外部条件：需要 Windows 图形桌面、Node.js 24、DSH Desktop 0.2.0-rc.2，以及本机安装的 Microsoft Edge 或 Google Chrome（插件自带启动与 CDP 驱动，不需要其他插件）；插件无需额外 API key。模型由宿主提供；CDP 需用户主动开启调试端口。
- 确认：真实仓库已有 dsh-plugin topic、dsh.bundle/cordis.patch.yml 和 MIT LICENSE。
- 验证：链接公开验证报告与 CI，注明受控测试确认服务、无远程模型调用，以及尚需人工验收的项目。

提交后保存 Issue URL，状态只能记“已提交，待目录审核”；维护者确认收录并核对实际页面后才能记“已上架”。其他自动索引站点可能依据 dsh-plugin topic 抓取，索引时机不由本项目控制。

## 稳定版前的人工检查

物理 Esc、宿主真实确认 UI、混合 DPI/多显示器、管理员窗口矩阵、记事本保存、真实模型任务以及全新 profile 安装/卸载/回滚仍需补齐。当前预览版不能替代这些验证。
