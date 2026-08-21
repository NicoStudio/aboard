#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";

const command = process.argv[2];
const filePath = process.argv[3];
if (!new Set(["backup", "restore"]).has(command) || !filePath) {
  throw new Error("Usage: board-storage.mjs <backup|restore> <file>");
}

const pages = await fetch("http://localhost:9237/json/list", {
  signal: AbortSignal.timeout(5_000)
}).then(response => {
  if (!response.ok) throw new Error(`Dashboard debugging endpoint returned ${response.status}`);
  return response.json();
});
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
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
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  const evaluationFailure = cdpEvaluationFailure(message);
  if (message.error) request.reject(new Error(message.error.message || "CDP request failed"));
  else if (evaluationFailure) request.reject(evaluationFailure);
  else request.resolve(message);
});
socket.addEventListener("close", () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Aboard renderer disconnected"));
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

const key = "conversation-dashboard-board-v1";
const emptyBoard = JSON.stringify({
  version: 2,
  defaultTab: "professional",
  chatSortBy: { professional: "updated", personal: "updated" },
  projects: [],
  items: []
});

function cdpEvaluationFailure(message) {
  const details = message?.result?.exceptionDetails;
  if (!details) return null;
  const description = details.exception?.description || details.text || "Aboard renderer evaluation failed";
  return new Error(String(description));
}

function serializedBoardBackup(storedBoard) {
  if (storedBoard === null) return emptyBoard;
  if (typeof storedBoard === "string") return storedBoard;
  throw new Error("Aboard renderer returned an invalid board backup value");
}

try {
  if (command === "backup") {
    const response = await send("Runtime.evaluate", {
      expression: `localStorage.getItem(${JSON.stringify(key)})`,
      returnByValue: true
    });
    const storedBoard = response.result?.result?.value;
    await writeFile(filePath, serializedBoardBackup(storedBoard), { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);
  } else {
    const board = await readFile(filePath, "utf8");
    await send("Runtime.evaluate", {
      expression: `(() => {
        localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(board)});
        const frame = document.querySelector("#conversation-dashboard-surface iframe");
        if (frame?.srcdoc) frame.srcdoc = frame.srcdoc;
        document.getElementById("conversation-dashboard-sidebar-entry")?.click();
      })()`,
      returnByValue: true
    });
  }
} finally {
  socket.close();
}
