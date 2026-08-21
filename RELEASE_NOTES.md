# Aboard 1.0.0

Aboard 1.0.0 is the first stable macOS release of the visual ChatGPT/Codex conversation board.

## Highlights

- Organize cloud Chat conversations into Professional and Personal.
- Organize local Codex Work into compact, reorderable project cards.
- Drag conversations directly from the native sidebar.
- See running/waiting states and context-use progress.
- Hide individual titles, set priorities, pin important items and follow the host theme.
- Open the original local or cloud conversation inside Aboard and return to the board.
- Create Chat or Work from its final Aboard destination, continue the native conversation without an automatic return, and let Aboard file it once the real conversation ID and title are ready.
- Protect local Work from cross-window writer conflicts while allowing Aboard to reopen a task already owned by its own runtime.
- Reliably return to the board even after the native host sidebar or workspace rerenders.

## Installation

Download `Aboard-macOS-1.0.0.zip`, extract it and double-click `Install Aboard.command`.

The installer requires Python 3 and the official ChatGPT/Codex macOS app in `/Applications/ChatGPT.app`. It builds Aboard locally and does not redistribute or modify the OpenAI-signed runtime.

## Privacy

The archive contains an empty default board, synthetic tests and a synthetic screenshot. It contains no user board, project name, conversation title, conversation ID, log, cache, database or machine-specific absolute path.

## Distribution note

The Aboard shell is built locally with an ad-hoc signature. This is not a Developer ID notarized binary distribution. The official ChatGPT runtime keeps its original OpenAI signature.
