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
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const pointer = (view, type, pointerId, x, y, buttons) => new view.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y
    });
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    entry?.click();
    await sleep(80);

    const frame = surface?.querySelector("iframe");
    const doc = frame?.contentDocument;
    const target = doc?.querySelector('[data-drop-kind="chat"]');
    const baseRow = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(row =>
      row.dataset.appActionSidebarThreadKind === "local"
      || /(^|\\s)(Work|Codex)($|\\s)/i.test(row.textContent || "")
    );
    if (!frame || !doc || !target || !baseRow) return { ok: false, reason: "work source or chat target unavailable" };

    const originalBoard = localStorage.getItem("conversation-dashboard-board-v1");
    const verificationId = "44444444-4444-4444-8444-444444444452";
    const verificationUrl = "codex://threads/" + verificationId;
    const row = baseRow.cloneNode(true);
    row.removeAttribute("draggable");
    row.removeAttribute("aria-selected");
    row.removeAttribute("aria-checked");
    row.removeAttribute("data-state");
    delete row.dataset.conversationDashboardDraggable;
    delete row.dataset.conversationDashboardDragListener;
    delete row.dataset.aboardDragging;
    row.dataset.appActionSidebarThreadId = "local:" + verificationId;
    row.dataset.appActionSidebarThreadKind = "local";
    row.dataset.appActionSidebarThreadTitle = "Pointer invalid import";
    row.dataset.appActionSidebarThreadSelected = "false";
    baseRow.parentElement.appendChild(row);
    await sleep(60);

    let result;
    try {
      const rowRect = row.getBoundingClientRect();
      const startX = rowRect.left + 8;
      const startY = rowRect.top + 8;
      const pointerId = 4401;
      row.dispatchEvent(pointer(window, "pointerdown", pointerId, startX, startY, 1));
      document.dispatchEvent(pointer(window, "pointermove", pointerId, startX + 9, startY, 1));
      await sleep(40);
      const activeAfterOpen = surface?.dataset.active === "true";
      const startedAsHostPointer = window.__conversationDashboardDragSession?.source === "host-pointer";

      const targetRect = target.getBoundingClientRect();
      const targetX = targetRect.left + Math.min(28, targetRect.width / 2);
      const targetY = targetRect.top + Math.min(28, targetRect.height / 2);
      target.dispatchEvent(pointer(frame.contentWindow, "pointermove", pointerId, targetX, targetY, 1));
      await sleep(40);
      const invalidHighlighted = target.classList.contains("is-drop-invalid");
      target.dispatchEvent(pointer(frame.contentWindow, "pointerup", pointerId, targetX, targetY, 0));
      await sleep(160);

      const boardUnchanged = localStorage.getItem("conversation-dashboard-board-v1") === originalBoard;
      const importedCount = frame.contentWindow.eval("board.items.filter(item => item.url === " + JSON.stringify(verificationUrl) + ").length");
      const sessionCleared = !window.__conversationDashboardDragSession
        && !window.__conversationDashboardDraggedThread;
      const sourceCleared = !document.documentElement.dataset.conversationDashboardDragging;
      const feedbackCleared = doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0;
      const guideCleared = doc.getElementById("drag-guide")?.classList.contains("show") !== true;

      const probe = doc.createElement("button");
      let clickCount = 0;
      let clickPrevented = null;
      probe.addEventListener("click", event => {
        clickCount += 1;
        clickPrevented = event.defaultPrevented;
      });
      doc.body.appendChild(probe);
      probe.dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
      probe.remove();

      const allRowsNeverDraggable = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].every(candidate =>
        candidate.getAttribute("draggable") !== "true"
        && !candidate.dataset.conversationDashboardDraggable
      );
      const catcherCount = document.querySelectorAll("#conversation-dashboard-drop-catcher").length;
      result = {
        ok: activeAfterOpen && startedAsHostPointer && invalidHighlighted && boardUnchanged
          && importedCount === 0 && sessionCleared && sourceCleared
          && row.dataset.aboardDragging !== "true"
          && feedbackCleared && guideCleared
          && clickCount === 1 && clickPrevented === false
          && allRowsNeverDraggable && catcherCount === 0,
        version: window.__conversationDashboardVersion,
        activeAfterOpen,
        startedAsHostPointer,
        invalidHighlighted,
        boardUnchanged,
        importedCount,
        sessionCleared,
        sourceCleared,
        sourceRowClearedAfterDrop: row.dataset.aboardDragging !== "true",
        feedbackCleared,
        guideCleared,
        toast: doc.getElementById("toast")?.textContent || "",
        clickCount,
        clickDefaultPrevented: clickPrevented,
        allRowsNeverDraggable,
        catcherCount
      };
    } finally {
      frame.contentWindow.eval("clearTimeout(saveTimer)");
      if (originalBoard == null) localStorage.removeItem("conversation-dashboard-board-v1");
      else localStorage.setItem("conversation-dashboard-board-v1", originalBoard);
      frame.contentWindow.eval("board = normalizeBoard(JSON.parse(window.parent.localStorage.getItem(storageKey))); activeTab = board.defaultTab || 'professional'; query = ''; floatingMenu = null; internalDrag = null; render()");
      row.remove();
      await sleep(20);
    }
    result.boardRestored = localStorage.getItem("conversation-dashboard-board-v1") === originalBoard;
    result.ok = result.ok && result.boardRestored;
    return result;
  })()`,
  awaitPromise: true,
  returnByValue: true
});
socket.close();
const result = response.result?.result?.value;
console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
