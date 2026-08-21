# Security architecture

## Official runtime integrity

Aboard does not redistribute or patch the ChatGPT/Codex desktop runtime. At launch it uses the untouched executable already installed at `/Applications/ChatGPT.app` and verifies:

- Bundle identifier `com.openai.codex`;
- OpenAI Developer ID Team `2DC432GLL2`;
- a strict valid code signature;
- a regular, non-symbolic-link application path.

The lightweight Aboard shell is built locally and ad-hoc signed. It is not represented as an Apple-notarized binary.

## Conversation ownership

Before opening a local Work task, Aboard checks the shared Codex writer lock. A task already owned by another client is not resumed in Aboard. Returning to the board moves the isolated workspace to a neutral route so the writer is released.

## Local bridge

The production renderer bridge uses a random per-launch CDP binding and validates the target, execution context, operation and payload. The localhost endpoint is limited to health and compatibility functions. Conversation URLs are allowlisted and validated before navigation.

## Data boundaries

- Board data is local and outside the repository.
- Message bodies are not copied into the board file.
- User data is excluded from release archives by an allowlist and privacy scan.
- The installer backs up an existing board before replacing the app.

## Reporting a vulnerability

Open a private GitHub security advisory for the repository. Do not include real conversation titles, identifiers, screenshots or board backups in a public issue.
