#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const outputPath = process.argv[2];
const deadline = Date.now() + 20_000;
let pages = null;
let page = null;
while (Date.now() < deadline) {
  try {
    pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(1_000)
    }).then(response => {
      if (!response.ok) throw new Error(`Dashboard debugging endpoint returned ${response.status}`);
      return response.json();
    });
    page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
    if (page) {
      const probe = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          probe.close();
          reject(new Error("Timed out connecting to the Aboard renderer"));
        }, 2_000);
        probe.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        probe.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
      });
      let ready;
      try {
        ready = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out probing the Aboard renderer")), 3_000);
          probe.addEventListener("message", event => {
            clearTimeout(timer);
            resolve(JSON.parse(event.data));
          }, { once: true });
          probe.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: "Boolean(document.getElementById('conversation-dashboard-sidebar-entry') && document.querySelector('#conversation-dashboard-surface iframe')?.srcdoc)",
              returnByValue: true
            }
          }));
        });
      } finally {
        probe.close();
        probe.unref?.();
      }
      if (ready.result?.result?.value === true) break;
      page = null;
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 300));
}
if (!pages) throw new Error("Dashboard debugging endpoint not ready");
if (!page) throw new Error("Dashboard window not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error("Timed out connecting to the Aboard renderer"));
  }, 5_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const callback = pending.get(message.id);
  if (callback) {
    pending.delete(message.id);
    clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(message.error.message || "CDP request failed"));
    else callback.resolve(message);
  }
});
socket.addEventListener("close", () => {
  for (const callback of pending.values()) {
    clearTimeout(callback.timer);
    callback.reject(new Error("Aboard renderer disconnected"));
  }
  pending.clear();
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Timed out waiting for ${method}`));
  }, 10_000);
  pending.set(id, { resolve, reject, timer });
  try { socket.send(JSON.stringify({ id, method, params })); }
  catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    reject(error);
  }
});

let result;
try {
  await send("Page.enable");
  await send("Page.bringToFront");
  await new Promise(resolve => setTimeout(resolve, 800));
  const evaluation = await send("Runtime.evaluate", {
    expression: `(() => {
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    const frame = surface?.querySelector("iframe");
    const frameDocument = frame?.contentDocument;
    return {
      version: window.__conversationDashboardVersion,
      entryReady: entry?.textContent?.trim() === "Aboard",
      active: surface?.dataset?.active,
      frameHasSrcdoc: Boolean(frame?.srcdoc),
      frameTitleReady: frameDocument?.title === "Aboard",
      frameReadyState: frameDocument?.readyState,
      storedBoard: Boolean(localStorage.getItem("conversation-dashboard-board-v1")),
      storageRoundTrip: (() => {
        const key = "conversation-dashboard-verification";
        localStorage.setItem(key, "ok");
        const saved = localStorage.getItem(key) === "ok";
        localStorage.removeItem(key);
        return saved;
      })(),
      nativeThreadRows: document.querySelectorAll('[data-app-action-sidebar-thread-row]').length,
      nativeChatRows: document.querySelectorAll('[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"] .sidebar-item').length,
      nativeRowsForcedDraggable: document.querySelectorAll('[data-app-action-sidebar-thread-row][draggable]').length,
      dropCatchers: document.querySelectorAll('#conversation-dashboard-drop-catcher').length
    };
    })()`,
    returnByValue: true
  });

  result = evaluation.result?.result?.value;
  try {
    await fetch("http://127.0.0.1:9238/json/list", { signal: AbortSignal.timeout(400) });
    result.dockInspectorClosed = false;
  } catch {
    result.dockInspectorClosed = true;
  }
  if (!result?.version || !result.entryReady || !result.frameHasSrcdoc || !result.frameTitleReady) {
    throw new Error(`Aboard renderer is not ready: ${JSON.stringify(result)}`);
  }
  if (!result.dockInspectorClosed) throw new Error("Aboard left its temporary Dock inspector open");
  if (outputPath) {
    const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.result.data, "base64"));
  }
} finally {
  socket.close();
  socket.unref?.();
}
console.log(JSON.stringify(result, null, 2));
// Node's built-in WebSocket can keep the CDP connection referenced even
// after the close frame is sent. The verification result is complete here,
// so flush stdout and exit instead of leaving installers waiting forever.
await new Promise(resolve => process.stdout.write("", resolve));
process.exit(0);
