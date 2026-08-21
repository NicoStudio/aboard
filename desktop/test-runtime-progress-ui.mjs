#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const dashboardPath = process.env.ABOARD_DASHBOARD_PATH
  || "/Applications/Aboard.app/Contents/Resources/dashboard/web/dashboard.html";
const requireHostIntegration = !process.env.ABOARD_DASHBOARD_PATH;
const dashboardTemplate = await readFile(dashboardPath, "utf8");
const ids = {
  chat: "33333333-3333-4333-8333-333333333333",
  work: "44444444-4444-4444-8444-444444444444"
};
const fixture = {
  version: 2,
  defaultTab: "professional",
  chatSortBy: { professional: "updated", personal: "updated" },
  projects: [{ id: "runtime-project", name: "Runtime", accent: "#2F8069", order: 1, sortBy: "updated" }],
  items: [
    { id: "runtime-chat", title: "Runtime Chat", kind: "chat", topic: "professional", projectId: null, pinned: false, marker: "p2", progress: 0, runtimeStatus: "idle", url: `codex://threads/${ids.chat}` },
    { id: "runtime-work", title: "Runtime Work", kind: "work", topic: null, projectId: "runtime-project", pinned: false, marker: "p2", progress: 0, runtimeStatus: "idle", url: `codex://threads/${ids.work}` }
  ]
};
const source = dashboardTemplate.replace("__BOARD_JSON__", JSON.stringify(fixture).replaceAll("</script", "<\\/script"));

const pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3_000) }).then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Aboard window not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Aboard runtime progress test connection timed out")), 4_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  waiter(message);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Aboard runtime progress test ${method} timed out`));
  }, 5_000);
  pending.set(id, message => { clearTimeout(timer); resolve(message); });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  return response.result?.result?.value;
};

let result;
try {
  result = await evaluate(`(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const storageKey = "conversation-dashboard-board-v1";
    const originalBoard = localStorage.getItem(storageKey);
    let hostIntegration = true;
    if (${JSON.stringify(requireHostIntegration)}) {
      const liveFrame = document.querySelector("#conversation-dashboard-surface iframe");
      const liveChild = liveFrame?.contentWindow;
      if (!liveChild) hostIntegration = false;
      else {
        const requestedIds = liveChild.eval("localRuntimeThreadIds()");
        hostIntegration = await new Promise(resolve => {
          const timer = setTimeout(() => {
            liveChild.removeEventListener("message", onMessage);
            resolve(false);
          }, 8_000);
          const onMessage = event => {
            if (event.data?.method !== "conversation-dashboard/native-runtime-status") return;
            const returnedIds = new Set((event.data?.payload || []).map(entry => entry?.id));
            if (!requestedIds.length || !requestedIds.every(id => returnedIds.has(id))) return;
            clearTimeout(timer);
            liveChild.removeEventListener("message", onMessage);
            resolve(true);
          };
          liveChild.addEventListener("message", onMessage);
          liveChild.requestNativeRuntimeStatus?.();
        });
      }
    }
    const frame = document.createElement("iframe");
    frame.id = "aboard-runtime-progress-test";
    frame.style.cssText = "position:fixed;left:-2000px;top:0;width:900px;height:700px;visibility:hidden;border:0";
    frame.srcdoc = ${JSON.stringify(source)};
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime progress fixture load timed out")), 4_000);
      frame.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const child = frame.contentWindow;
    const doc = frame.contentDocument;
    child.postMessage({
      method: "conversation-dashboard/native-runtime-status",
      payload: [
        { id: ${JSON.stringify(ids.chat)}, runtimeStatus: "active", progress: 50 },
        { id: ${JSON.stringify(ids.work)}, runtimeStatus: "active", progress: 50 }
      ]
    }, "*");
    const deadline = performance.now() + 1_500;
    while (performance.now() < deadline && doc.querySelectorAll('[data-progress="50"].is-running').length !== 2) await sleep(20);
    const snapshot = id => {
      const row = doc.querySelector('[data-drag-item="' + id + '"]');
      const width = Number.parseFloat(child.getComputedStyle(row, "::before").width);
      const rowWidth = row.getBoundingClientRect().width;
      return {
        exists: Boolean(row),
        running: row?.classList.contains("is-running") || false,
        progress: row?.dataset.progress || "",
        fillRatio: rowWidth > 0 ? width / rowWidth : 0,
        status: row?.querySelector(".runtime-status")?.textContent || "",
        progressText: row?.querySelector(".runtime-progress")?.textContent || "",
        progressTitle: row?.querySelector(".runtime-progress")?.getAttribute("title") || ""
      };
    };
    const active = { chat: snapshot("runtime-chat"), work: snapshot("runtime-work") };
    child.postMessage({
      method: "conversation-dashboard/native-runtime-status",
      payload: [
        { id: ${JSON.stringify(ids.chat)}, runtimeStatus: "idle", progress: null },
        { id: ${JSON.stringify(ids.work)}, runtimeStatus: "idle", progress: null }
      ]
    }, "*");
    await sleep(80);
    const idle = { chat: snapshot("runtime-chat"), work: snapshot("runtime-work") };
    frame.remove();
    return {
      active,
      idle,
      hostIntegration,
      boardExact: localStorage.getItem(storageKey) === originalBoard,
      fixtureRemoved: !document.getElementById("aboard-runtime-progress-test")
    };
  })()`);
} finally {
  try { await evaluate(`document.getElementById("aboard-runtime-progress-test")?.remove()`); } catch {}
  socket.close();
}

const activeRows = [result?.active?.chat, result?.active?.work];
const idleRows = [result?.idle?.chat, result?.idle?.work];
result.ok = activeRows.every(row => row?.exists
    && row.running
    && row.progress === "50"
    && row.fillRatio > 0.47
    && row.fillRatio < 0.53
    && row.status === "进行中"
    && row.progressText === "50%"
    && row.progressTitle === "上下文使用量 50%")
  && idleRows.every(row => row?.exists && !row.running && row.progress === "0" && !row.status && !row.progressText)
  && result.hostIntegration
  && result.boardExact
  && result.fixtureRemoved;

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
