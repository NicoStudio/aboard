#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const profileRoot = process.argv[2];
if (!profileRoot) throw new Error("Aboard profile path is required");

const statePath = path.join(profileRoot, "browser-sidebar-page-states.json");

try {
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  if (!state || typeof state !== "object" || !state.pages || typeof state.pages !== "object") {
    process.exit(0);
  }

  const safePages = Object.fromEntries(Object.entries(state.pages).filter(([, page]) => {
    const conversationId = String(page?.conversationId || "");
    return !conversationId || conversationId.startsWith("client-new-thread:");
  }));
  if (Object.keys(safePages).length === Object.keys(state.pages).length) process.exit(0);

  const nextState = { ...state, pages: safePages };
  const temporaryPath = `${statePath}.aboard-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(nextState)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
} catch (error) {
  // This is only startup hygiene. A truncated state file must not prevent the
  // dashboard from launching; the neutral-route guard is still the authority
  // for releasing any restored conversation.
  if (error?.code !== "ENOENT") {
    console.warn(`Aboard could not sanitize the saved sidebar state: ${error instanceof Error ? error.message : String(error)}`);
  }
}
