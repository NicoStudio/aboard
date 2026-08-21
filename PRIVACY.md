# Privacy

Aboard is designed to keep the board and conversation metadata on the local Mac.

## Stored locally

Aboard has two independent local board stores outside the source repository:

- **Aboard Desktop:** the `conversation-dashboard-board-v1` localStorage entry inside the isolated browser profile at `~/Library/Application Support/Conversation Dashboard/ChatGPT Profile`.
- **Codex MCP plugin:** `~/.codex/plugin-data/conversation-dashboard/dashboard.json` by default (or the directory explicitly supplied to the MCP server through `PLUGIN_DATA`).

These stores are not automatically merged or synchronized. The official ChatGPT/Codex application remains the source of truth for the underlying conversations.

Either board store can contain:

- conversation titles;
- ChatGPT/Codex conversation identifiers and links;
- project names and ordering;
- priority, pin, visibility and layout settings;
- locally observed runtime status.

Neither board store contains full conversation message bodies.

## Technical logs

Aboard writes local startup and diagnostic logs under `~/Library/Logs/Conversation Dashboard`. The directory and its files are restricted to the current macOS account. Aboard does not deliberately write conversation titles, links, identifiers or message bodies to its own launcher log; the underlying official ChatGPT runtime may include operational identifiers in its diagnostic output, so treat this directory as private and do not attach it to a public issue without reviewing it first.

## Not collected

Aboard does not include analytics, advertising, remote telemetry or an Aboard cloud service. It does not read or export macOS Keychain secrets.

## Backups

`scripts/export-board.sh` exports only the Aboard Desktop board and requires a running Aboard instance. It does not export the Codex MCP `dashboard.json`. The backup is written outside the repository with permissions limited to the current user. Treat that JSON file as sensitive because it contains titles and conversation identifiers. Never commit it to Git or attach it to a public issue.

When an existing Aboard instance is running and readable, the installer also creates a private `board-before-install-*.json` Desktop-board backup under `~/Library/Application Support/Conversation Dashboard/`. No automatic installer backup is created when Aboard is not running, and this step does not back up the Codex MCP board.

## Repository privacy gate

Every release runs `scripts/privacy-check.sh`. The check rejects board exports, logs, databases, caches, absolute user paths and non-synthetic conversation links. Release archives are assembled from an explicit allowlist, not from the entire working directory.

## Removing local data

Uninstalling Aboard preserves both local stores and the technical logs by default. After quitting Aboard and confirming that no backup is needed, removing all local Aboard data requires manually moving these three exact directories to Trash:

```text
~/Library/Application Support/Conversation Dashboard
~/.codex/plugin-data/conversation-dashboard
~/Library/Logs/Conversation Dashboard
```

The uninstall script reports these paths but does not delete them.
