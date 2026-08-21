# Changelog

## 1.0.4 — 2026-08-21

- Opens Chat and Work inside the current Aboard window again instead of handing every click to a second app.
- Keeps the mounted native conversation underneath the board overlay, so an active response continues and the same task reopens without another resume.
- Uses the Aboard sidebar entry as the only return action; no floating return control is added.
- Adds ordered open-attempt cancellation, route confirmation, safer writer-lock race handling, and clear cross-process conflict feedback.
- Reliably captures newly created Chat conversations without timestamps and places them in the requested tab or project.
- Merges native active/waiting states with local Work context progress without overwriting either source.

## 1.0.3 — 2026-08-21

- Opens every Chat and Work item in the official ChatGPT/Codex client, including conversations that are already running.
- Removes the in-window conversation route and floating return control; reopen the board from Aboard below Plugins.
- Keeps the board available while handing off and allows the same running conversation to be opened again later.
- Adds simple public screenshots for Chat labels, privacy, priority, project movement and live progress.

## 1.0.2 — 2026-08-21

- Preloads the native Recents virtual list once when Aboard opens, so cached conversations appear immediately instead of mounting a few rows at a time.
- Expands Recents before treating unrelated Work rows as proof that the native sidebar is ready.
- Restores the user's exact sidebar scroll position and does not issue any additional conversation API request.
- Repeats the local preload only when the native sidebar is replaced or its cached conversation set grows.

## 1.0.1 — 2026-08-21

- Rewrote the public guide around a three-step installation for ordinary Mac users.
- Added a bilingual double-click installer with prerequisite checks, visible progress and clear success or recovery messages.
- Moved architecture, storage, backup and developer details into a separate technical guide.
- Kept the existing Aboard data model and local board data unchanged during the update.

## 1.0.0 — 2026-08-21

First stable release.

- Creating Chat or Work from Aboard now stays in the native conversation while the response is running.
- New Work rows resolve provisional `client-new-thread:*` values to the real conversation UUID before being saved.
- Created conversations are acknowledged only after the target board location is durably saved.
- Aboard distinguishes its own local Work writer from a task owned by another Codex window.
- The left-corner return control remains functional after native host rerenders.
- Installer verification now restores board data transactionally and keeps backups and diagnostics private to the current macOS account.
- Added stable semantic versioning, safer source-directory upgrades and post-install plugin version verification.
- Includes the complete visual board, compact project lanes, precise drag placement, live runtime progress, privacy controls, dark mode and the Aboard app identity.

## 0.1.0 — 2026-08-20

First packaged macOS release.

- Visual Chat and Work board with compact project lanes.
- Native and internal drag-and-drop with exact insertion feedback.
- Direct local/cloud conversation opening inside Aboard and a return-to-board control.
- Local Work writer-conflict protection.
- Live runtime state and context-use progress display.
- Per-item title privacy, priority, pinning and sorting.
- Automatic light/dark theme synchronization.
- Thin local macOS shell that preserves the official ChatGPT runtime signature.
- Rollback-safe installer, privacy scan and source release archive.
