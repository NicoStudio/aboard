#!/usr/bin/env node

const pages = await fetch("http://127.0.0.1:9237/json/list").then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Dashboard window not found");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); callback(message); }
});
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    const frame = document.querySelector("#conversation-dashboard-surface iframe");
    const doc = frame?.contentDocument;
    const chatTarget = doc?.querySelector('[data-drop-kind="chat"]');
    if (!frame || !doc || !chatTarget) return { ok: false, reason: "target unavailable" };
    const before = JSON.parse(localStorage.getItem("conversation-dashboard-board-v1")).items.length;
    const rect = chatTarget.getBoundingClientRect();
    frame.contentWindow.postMessage({
      method: "conversation-dashboard/native-drop",
      sessionId: "type-guard-verification",
      payload: {
        id: "type-guard-verification",
        surfaceKind: "work",
        title: "Type guard verification",
        url: "codex://threads/type-guard-verification"
      },
      point: { x: rect.left + 24, y: rect.top + 24 }
    }, "*");
    await new Promise(resolve => setTimeout(resolve, 350));
    const board = JSON.parse(localStorage.getItem("conversation-dashboard-board-v1"));
    return {
      ok: board.items.length === before && !board.items.some(item => item.url === "codex://threads/type-guard-verification"),
      before,
      after: board.items.length,
      toast: doc.getElementById("toast")?.textContent || ""
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});
socket.close();
console.log(JSON.stringify(response.result?.result?.value, null, 2));
