# Aboard development handoff

Read this file before changing Aboard on another computer.

## Current product definition

- Product name: **Aboard**.
- Tagline: **A more efficient interface for AI conversations.**
- Top-level areas: **Chats** and **Work**.
- Chats tabs: **专业会话** and **个人会话**; default is Professional.
- Work is grouped by draggable project cards.
- Information hierarchy stays shallow: conversation titles are visible in the first view.
- Chat and Work are strict native types. A Chat cannot be moved into Work; Work/Codex cannot be moved into Chats.
- Codex belongs to Work in Aboard.

## Implemented behavior

- Native sidebar entry below Plugins and above Projects.
- Clicking an Aboard item opens the corresponding original local or cloud conversation inside the current Aboard window.
- The Aboard entry below Plugins is the only return action. It shows the board as an overlay while preserving the mounted native conversation underneath; do not add a floating return control.
- Native Chat/Work creation from the destination where the add button was clicked.
- Drag native sidebar conversations into the correct Aboard destination.
- Drag Chat entries between Professional and Personal.
- Drag Work entries between projects.
- Drag Work project cards to reorder them from non-interactive card areas.
- Per-scope pinning, P0/P1/P2 priority menu, title synchronization, and project sorting.
- Global title-only Chinese search with Command-S focus.
- Live native runtime states: active, waiting for approval, waiting for input, or idle. Local running conversations also show their measured context-window usage as a determinate background fill; this is not presented as task-completion percentage.
- Project names are limited to 30 characters and visually truncated with an ellipsis.
- Each area/tab/project shows its conversation count.
- Project item lists scroll independently.

## Drag safety rule

Never reintroduce a transparent full-frame drop catcher, force `draggable=true` on native sidebar rows, or start a competing HTML5 drag session. macOS trackpad three-finger drag can strand that second gesture and block clicks. Current v59 piggybacks the host sidebar's existing drag sensor: passive Pointer Event listeners handle the standard path, while passive Mouse Event listeners cover macOS accessibility drags that Electron exposes as mouse-only input. Neither path calls `preventDefault` or stops propagation. Work uses the host preview; Chat receives an equivalent Aboard-owned, pointer-transparent preview when the host provides no visible one. Both send only coordinates plus the selected thread payload to the same-origin Aboard iframe. The native-row adapter supports Work, Chat Recents, and Project Chat rows. Only real Chat/Work targets highlight. A child-frame terminal event releases the matching host sensor once, while Aboard independently commits or rejects the classification. Escape, blur, visibility change, timeout, navigation, and a new input all cancel safely. There is no overlay or catcher, and Aboard never changes the native row's `draggable` attribute.

## Single-writer rule

`/Applications/Aboard.app` is a lightweight local shell that executes the untouched OpenAI-signed `/Applications/ChatGPT.app` runtime with an isolated Aboard profile; never copy, modify, or ad-hoc re-sign that runtime. Cold startup confirms the neutral `/` route once before injection so a stale task is not resumed accidentally. After the user opens a conversation, returning through the Aboard entry must only cover the native page; it must not navigate to `/`, detach the task, or interrupt an active response. Selecting that same conversation simply removes the overlay with zero navigation.

Before Aboard opens a different local Work conversation, the launcher checks the shared Codex writer locks. An unclaimed task may open on `/local/<id>`. A task owned by this Aboard runtime may only reuse its current route or an already-mounted native row; never dispatch a blind second resume. A task owned by another Codex process stays on the board with a clear message and is never handed off automatically. Cloud Chat opens on `/work/conversation/<id>`. Mounted-row reuse is allowed only after these checks and must confirm that the target route arrived. Two independent app servers must never write the same Work task concurrently.

The plugin MCP starts from the stable installed path under `/Applications/Aboard.app/Contents/Resources/dashboard`, not from the versioned plugin cache. After the first upgrade to this architecture, fully quit and reopen ChatGPT/Codex once so existing tasks discard their old cached MCP process.

## Local paths and data

- Source checkout: arbitrary after cloning.
- Built app: `/Applications/Aboard.app`.
- Runtime: the untouched OpenAI-signed `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`, launched by the lightweight `/Applications/Aboard.app` with its own profile and debugging endpoint; there is no copied or hidden runtime app.
- Aboard Desktop profile: `~/Library/Application Support/Conversation Dashboard/ChatGPT Profile`.
- Aboard Desktop board: the `conversation-dashboard-board-v1` localStorage entry inside that isolated profile.
- Installer-created Desktop backups: `~/Library/Application Support/Conversation Dashboard/board-before-install-*.json`; they are created only when an existing Aboard runtime is running and readable.
- Codex MCP board: `~/.codex/plugin-data/conversation-dashboard/dashboard.json` by default, or the directory supplied through `PLUGIN_DATA`.
- Local startup and diagnostic logs: `~/Library/Logs/Conversation Dashboard`; the directory is mode `0700` and log files are mode `0600`. Aboard's launcher log intentionally omits conversation titles, links and identifiers, but upstream runtime diagnostics must still be treated as private.
- The Desktop and MCP stores are independent and are not automatically merged or synchronized. `scripts/export-board.sh` and `scripts/import-board.sh` operate only on the Desktop board.
- Both stores, every private board backup and all diagnostic logs live outside the repository and must never be committed.

The historical support-directory name is deliberately retained to preserve existing data.

During installation, app replacement and installed-app verification are one rollback boundary: failure in that phase restores the previous app. After the new app passes verification it remains installed; Codex plugin refresh is a separate step, and rerunning the installer safely completes it if it was interrupted or failed.

## Restore at home

Run:

```bash
./scripts/install-on-mac.sh
```

Then verify that:

- Aboard appears below Plugins and above Projects.
- A fresh installation starts with an empty board unless the user explicitly restores a private backup from outside the repository.
- Clicking either an Aboard item or a native sidebar conversation opens the exact task inside Aboard; clicking the Aboard entry below Plugins returns to the board without changing the task route.
- Opening the same task while both apps are running produces no active-writer retry or repeated dialog.
- A wrong-type drop shows an error and imports nothing.

## Verification

`./scripts/verify.sh` checks JavaScript syntax and the plugin manifest. `./scripts/verify.sh --installed` additionally runs installed-window, hover/drag safety, type-guard, and feature tests when Aboard is running.

The last verified injection version is **66**. The plugin cachebuster changes independently in `.codex-plugin/plugin.json`.

## Continuing work

Use Codex to work in this repository. GitHub is the durable source-history layer; Codex is the interactive development interface. Never commit board backups, conversation identifiers, logs, screenshots of real boards, or local profile data.
