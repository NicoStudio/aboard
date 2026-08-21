# Aboard 技术说明

这份文档面向需要排查、备份或参与开发的用户。普通安装请直接阅读项目首页的“三步安装”。

## 运行方式

Aboard 不复制、不修改、也不重新签名官方 ChatGPT 运行时。安装器创建一个轻量 Aboard 外壳，启动时校验官方应用的 Bundle ID、Developer ID Team 和签名完整性，再使用独立浏览资料目录运行。

当前分发方式是从源码在本机构建。Aboard 外壳使用本机临时签名，并非 Developer ID 公证应用；官方 ChatGPT 运行时始终保持原始 OpenAI 签名。

## 安装要求

- macOS 12 Monterey 或更高版本
- 官方 ChatGPT/Codex 应用位于 `/Applications/ChatGPT.app`
- Python 3
- 当前 macOS 用户可以写入 `/Applications`

终端安装：

```bash
git clone https://github.com/NicoStudio/aboard.git
cd aboard
./scripts/install-on-mac.sh
```

安装器会构建临时应用、验证签名和运行状态，再原子替换 `/Applications/Aboard.app`。应用替换或验证失败时会恢复上一版。新版应用验证完成后，Codex 插件刷新是独立步骤；刷新中断时重新运行安装器即可。

## 本地数据

Aboard 根据打开方式使用两套独立存储：

- Aboard Desktop 看板：

  ```text
  ~/Library/Application Support/Conversation Dashboard/ChatGPT Profile
  ```

- Codex MCP 插件看板：

  ```text
  ~/.codex/plugin-data/conversation-dashboard/dashboard.json
  ```

两套看板当前不会自动合并或同步。原始会话始终以官方 ChatGPT/Codex 为准。

本机诊断日志位于：

```text
~/Library/Logs/Conversation Dashboard
```

## 备份与恢复

`export-board.sh` 和 `import-board.sh` 只处理 Aboard Desktop 看板，不处理 Codex MCP 的 `dashboard.json`。

```bash
./scripts/export-board.sh
./scripts/import-board.sh "$HOME/Desktop/Aboard Backup 2026-08-21.json"
```

备份包含标题、项目归类和会话标识，不包含消息正文。请勿将备份提交到 Git。

如果旧版 Aboard 正在运行且可读取，安装器会先在以下目录创建权限为 `0600` 的 Desktop 看板备份：

```text
~/Library/Application Support/Conversation Dashboard
```

## 完全删除本地数据

卸载脚本默认保留数据。如果确认不再需要，请先退出 Aboard，再自行把以下三个精确目录移到废纸篓：

```text
~/Library/Application Support/Conversation Dashboard
~/.codex/plugin-data/conversation-dashboard
~/Library/Logs/Conversation Dashboard
```

## 开发与验证

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

- `web/dashboard.html`：看板界面和交互
- `desktop/inject.js`：侧边栏、拖拽、主题与导航桥
- `desktop/launcher.mjs`：运行时注入、单实例和安全路由
- `server/dashboard_mcp.py`：Codex 插件 UI 与本地看板读写
- `scripts/install-on-mac.sh`：可回滚安装器

## 已知限制

- 依赖当前官方 ChatGPT/Codex macOS 客户端的页面结构和路由。
- 官方客户端升级后，Aboard 可能需要同步适配。
- 未配置 Apple Developer ID 和 notarization，因此首次打开下载的安装器时，macOS 可能要求用户右键选择“打开”。
