# Aboard

<p align="center">
  <img src="assets/Aboard.png" width="128" height="128" alt="Aboard app icon">
</p>

<p align="center"><strong>把散落在 ChatGPT 与 Codex 里的对话，整理成一张真正可操作的看板。</strong></p>

<p align="center">
  macOS 12+ · Chat + Work · 拖拽归类 · 深色模式 · 本地优先
</p>

Aboard 是 ChatGPT/Codex macOS 客户端的可视化会话看板。它把云端 Chat 分为专业与个人两个区域，把本地 Codex Work 按项目组织成紧凑卡片，并保留原生会话作为唯一数据源。

> Aboard 是独立社区项目，不是 OpenAI 官方产品。它不会把 ChatGPT/Codex 应用、账号凭据或你的会话内容打包进仓库。

![Aboard demo with synthetic conversations](docs/aboard-demo.png)

## 功能

- **统一整理 Chat 与 Work**：云端 Chat 使用专业/个人标签，本地 Work 使用项目卡片。
- **原生拖拽**：从客户端左侧会话列表直接拖入 Aboard，也可在看板内排序、跨项目移动。
- **紧凑项目布局**：不同高度的项目卡片按列紧凑排列，并支持拖到指定列与指定位置。
- **直接打开原会话**：点击条目后在 Aboard 窗口中进入对应本地或云端会话，左上角可返回看板。
- **运行状态**：显示正在运行、等待确认、等待输入和空闲状态；本地 Work 可显示上下文使用进度。
- **隐私显示**：每条会话可单独隐藏标题，隐藏后标题不会出现在可见 DOM 中。
- **优先级与置顶**：支持 P0/P1/P2、按区域置顶以及多种排序方式。
- **跟随系统主题**：与 ChatGPT/Codex 的明暗主题实时同步。
- **安全的单写入保护**：已被另一客户端占用的本地任务不会被 Aboard 再次恢复，避免重复弹窗与写入冲突。

## 安装要求

- macOS 12 Monterey 或更高版本
- 已安装并登录官方 [ChatGPT/Codex macOS 客户端](https://openai.com/chatgpt/desktop/)
- 官方应用位于 `/Applications/ChatGPT.app`
- 已安装 Python 3（安装器和本地 MCP 服务需要）
- 安装时需要当前 macOS 用户对 `/Applications` 的写入权限

Aboard 不复制、不修改、也不重新签名官方 ChatGPT 运行时。安装器只创建一个轻量 Aboard 外壳，并在启动时校验官方应用的 Bundle ID、Developer ID Team 和签名完整性。

## 安装

### 图形方式

1. 下载 GitHub Release 中的 `Aboard-macOS-<版本>.zip` 并解压。
2. 打开解压后的文件夹。
3. 双击 **Install Aboard.command**。
4. 安装完成后，从“应用程序”或程序坞打开 Aboard。
5. 如果安装器提示插件已更新，请完整退出并重新打开一次 ChatGPT/Codex。

### 终端方式

```bash
git clone https://github.com/NicoStudio/aboard.git
cd aboard
./scripts/install-on-mac.sh
```

如果旧版 Aboard 正在运行且能正常读取，安装器会先为 **Desktop 看板**创建权限为 `0600` 的私有备份；Aboard 未运行时不会创建这份自动备份。安装器不会删除或主动重置原有资料目录。随后安装器构建临时应用、验证签名与运行状态，再原子替换 `/Applications/Aboard.app`。如果在应用替换或验证阶段失败，会恢复上一版应用。

新应用验证通过后，应用更新即视为已完成，之后的 Codex 插件刷新是独立步骤。如果插件刷新被中断或失败，已验证的新版 Aboard 会保留；重新运行安装器即可安全完成插件刷新。

## 更新

```bash
git pull --ff-only
./scripts/install-on-mac.sh
```

更新不会覆盖本地看板。Aboard 根据打开方式使用两套独立的本地存储：

- **Aboard Desktop 看板**：保存在 Aboard 隔离浏览资料目录的 `localStorage` 中，资料目录为：

  ```text
  ~/Library/Application Support/Conversation Dashboard/ChatGPT Profile
  ```

- **Codex MCP 插件看板**：默认保存在：

  ```text
  ~/.codex/plugin-data/conversation-dashboard/dashboard.json
  ```

两套看板当前不会自动合并或同步，但原始会话始终以官方 ChatGPT/Codex 客户端为准。

版本遵循 SemVer：兼容 Bug 修复发布为 `1.0.1`，向后兼容的新功能发布为 `1.1.0`，需要迁移或不兼容的改动才发布为 `2.0.0`。插件版本末尾的 `+codex.<时间戳>` 仅用于刷新 Codex 缓存，不改变用户看到的版本号。

## 备份与恢复

`export-board.sh` 只导出 **Aboard Desktop 看板**，不导出 Codex MCP 的 `dashboard.json`。运行命令时需要先打开 Aboard；备份文件默认写到桌面，而不是项目目录：

```bash
./scripts/export-board.sh
```

恢复命令同样只作用于 Desktop 看板：

```bash
./scripts/import-board.sh "$HOME/Desktop/Aboard Backup 2026-08-20.json"
```

备份包含标题、项目归类和会话标识，不包含消息正文。请把它当作私密文件保管，**不要提交到 Git**。安装器在旧版 Aboard 正在运行且可读取时，也会在 `~/Library/Application Support/Conversation Dashboard/` 下创建 `board-before-install-*.json` Desktop 备份；这一步不备份 Codex MCP 看板。

## 卸载

双击 **Uninstall Aboard.command**，或运行：

```bash
./scripts/uninstall-on-mac.sh
```

默认卸载会保留两套本地看板数据和本机诊断日志。脚本结束时会显示三个位置，方便日后重新安装或排查问题。如果确认不再需要任何备份并希望彻底删除，请先退出 Aboard，再由你自己将以下三个精确目录移到废纸篓（卸载脚本不会代为删除）：

```text
~/Library/Application Support/Conversation Dashboard
~/.codex/plugin-data/conversation-dashboard
~/Library/Logs/Conversation Dashboard
```

## 隐私与安全

- 仓库和发布包只包含空白默认看板与合成测试数据。
- 不包含真实项目名称、会话标题、会话 ID、日志、缓存、数据库或本机绝对路径。
- Aboard 不读取或复制 macOS 钥匙串内容。
- Aboard Desktop 的独立浏览资料位于 `~/Library/Application Support/Conversation Dashboard/ChatGPT Profile`；Codex MCP 看板默认位于 `~/.codex/plugin-data/conversation-dashboard/dashboard.json`。
- 本机启动与诊断日志位于 `~/Library/Logs/Conversation Dashboard`，权限仅限当前 macOS 账户；日志不随源码或发布包上传。官方 ChatGPT 运行时的诊断输出可能包含操作标识，公开分享前请先检查。
- 发布前会运行 `./scripts/privacy-check.sh`，发现疑似用户数据时构建会直接失败。
- 当前分发方式是**从源码在本机构建**；Aboard 外壳使用本机临时签名，并非 Developer ID 公证应用。官方 ChatGPT 运行时始终保持其原始 OpenAI 签名。

详见 [隐私说明](PRIVACY.md) 与 [安全架构](SECURITY.md)。

## 开发

```bash
./scripts/verify.sh
./scripts/privacy-check.sh
./scripts/package-release.sh
```

安装后的完整回归：

```bash
./scripts/verify.sh --installed
```

核心目录：

- `web/dashboard.html` — 看板界面和交互
- `desktop/inject.js` — 客户端侧边栏、拖拽、主题与导航桥
- `desktop/launcher.mjs` — Aboard 运行时注入、单实例和安全路由
- `server/dashboard_mcp.py` — Codex 插件 UI 与本地看板读写
- `scripts/install-on-mac.sh` — 可回滚安装器
- `desktop/` 下的 `test-*` — 交互、数据恢复和安全回归

## 已知限制

- 依赖当前已安装的官方 ChatGPT/Codex macOS 客户端。
- 官方客户端更新后，如果其签名、页面结构或路由发生变化，Aboard 可能需要同步更新。
- 从源码构建的 Aboard 外壳没有 Apple Developer ID 公证；若需要面向大众分发的免提示安装包，需要单独配置 Developer ID 签名与 notarization。

## License

[MIT](LICENSE) © Aboard contributors
