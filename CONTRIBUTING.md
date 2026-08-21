# Contributing

1. Keep user board data outside the repository.
2. Use only synthetic titles and identifiers in tests and screenshots.
3. Run `./scripts/privacy-check.sh` and `./scripts/verify.sh` before committing.
4. Preserve the single-writer guard: never resume a local Work task already owned by another client.
5. Do not copy, modify or re-sign the official ChatGPT application.

## Versioning

Aboard follows semantic versioning after 1.0.0:

- `1.0.1` for compatible bug fixes and small visual or interaction refinements.
- `1.1.0` for new backward-compatible capabilities.
- `2.0.0` for changes that require migration or break compatibility.
- `+codex.<timestamp>` is an internal plugin-cache identifier. It does not change the user-facing version.

Bug reports must not contain real conversation titles, IDs, board backups or screenshots of a personal board. Reproduce issues with synthetic fixtures whenever possible.
