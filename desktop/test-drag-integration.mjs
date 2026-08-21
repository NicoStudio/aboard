#!/usr/bin/env node

const pages = await fetch("http://127.0.0.1:9237/json/list", {
  signal: AbortSignal.timeout(3_000)
}).then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Dashboard window not found");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Drag integration CDP connection timed out")), 4_000);
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
    if (message.error) callback.reject(new Error(`${callback.method}: ${message.error.message || "CDP request failed"}`));
    else callback.resolve(message);
  }
});
socket.addEventListener("close", () => {
  for (const callback of pending.values()) {
    clearTimeout(callback.timer);
    callback.reject(new Error(`${callback.method}: Aboard renderer disconnected`));
  }
  pending.clear();
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method}: CDP response timed out`));
  }, 5_000);
  pending.set(id, { resolve, reject, timer, method });
  try { socket.send(JSON.stringify({ id, method, params })); }
  catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    reject(error);
  }
});

// The installed suite runs several synthetic pointer tests in the same renderer.
// Release any browser-level input state and cancel the preceding gesture before
// creating this test's source row. This is a phase boundary, not a retry: the
// drag below is still dispatched exactly once and must satisfy every assertion.
for (const [method, params] of [
  ["Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", buttons: 0, clickCount: 0 }]
]) {
  const resetResponse = await send(method, params);
  if (resetResponse.error) throw new Error(`Failed to reset input phase: ${resetResponse.error.message}`);
}

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const waitFor = async (read, timeout = 1_000) => {
      const deadline = performance.now() + timeout;
      let value = read();
      while (!value && performance.now() < deadline) {
        await sleep(16);
        value = read();
      }
      return value;
    };
    const nextPaint = () => Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      sleep(80)
    ]);
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
    surface?.querySelector("iframe")?.contentDocument?.dispatchEvent(
      new (surface.querySelector("iframe").contentWindow.KeyboardEvent)("keydown", { key: "Escape", bubbles: true })
    );
    await nextPaint();
    entry?.click();
    const frame = await waitFor(() => {
      const current = surface?.querySelector("iframe");
      return surface?.dataset.active === "true" && current?.contentDocument ? current : null;
    });
    const doc = frame?.contentDocument;
    const phaseReset = Boolean(await waitFor(() => {
      const feedbackClear = !doc || doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0;
      const guideClear = !doc || doc.getElementById("drag-guide")?.classList.contains("show") !== true;
      return !window.__conversationDashboardDragSession
        && !window.__conversationDashboardDraggedThread
        && !document.documentElement.dataset.conversationDashboardDragging
        && feedbackClear && guideClear;
    }, 800));

    const target = await waitFor(() => doc?.querySelector('[data-drop-kind="work"]'));
    const baseRow = await waitFor(() => [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(row =>
      row.dataset.appActionSidebarThreadKind === "local"
      || /(^|\\s)(Work|Codex)($|\\s)/i.test(row.textContent || "")
    ));
    if (!frame || !doc || !target || !baseRow) return { ok: false, reason: "work source or target unavailable", phaseReset };

    const originalBoard = localStorage.getItem("conversation-dashboard-board-v1");
    const verificationId = "44444444-4444-4444-8444-444444444454";
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
    row.dataset.appActionSidebarThreadTitle = "Pointer valid import";
    row.dataset.appActionSidebarThreadSelected = "false";
    baseRow.parentElement.appendChild(row);
    const sourceRow = () => [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(candidate =>
      candidate.dataset.appActionSidebarThreadId === "local:" + verificationId
    );
    const confirmedRow = await waitFor(() => {
      const current = sourceRow();
      if (!current?.isConnected) return null;
      const rect = current.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && current.dataset.appActionSidebarThreadKind === "local"
        && current.dataset.appActionSidebarThreadTitle === "Pointer valid import"
        ? current
        : null;
    }, 800);

    let result;
    try {
      const dragRow = sourceRow();
      const sourceConfirmed = Boolean(confirmedRow && dragRow === confirmedRow);
      const rowRect = dragRow?.getBoundingClientRect() || { left: 0, top: 0 };
      const startX = rowRect.left + 8;
      const startY = rowRect.top + 8;
      const pointerSequence = (Number(window.__conversationDashboardTestPointerSequence) || (Date.now() % 1_000_000)) + 1;
      window.__conversationDashboardTestPointerSequence = pointerSequence;
      const pointerId = 1_000_000 + (pointerSequence % 1_000_000);
      dragRow?.dispatchEvent(pointer(window, "pointerdown", pointerId, startX, startY, 1));
      document.dispatchEvent(pointer(window, "pointermove", pointerId, startX + 9, startY, 1));
      const startedSession = await waitFor(() => {
        const session = window.__conversationDashboardDragSession;
        const payload = window.__conversationDashboardDraggedThread;
        const threads = payload?.bulk && Array.isArray(payload.threads) ? payload.threads : payload ? [payload] : [];
        return session?.source === "host-pointer" && session.id
          && threads.some(thread => thread?.url === verificationUrl)
          ? session
          : null;
      }, 800);

      const activeAfterOpen = surface?.dataset.active === "true";
      const startedAsHostPointer = startedSession?.source === "host-pointer";
      const sessionId = startedSession?.id || "";
      const sessionMatchesSource = Boolean(startedSession);
      const rowNeverDraggable = dragRow?.getAttribute("draggable") !== "true"
        && !dragRow?.dataset.conversationDashboardDraggable;
      const targetRect = target.getBoundingClientRect();
      const targetX = targetRect.left + Math.min(28, targetRect.width / 2);
      const targetY = targetRect.top + Math.min(28, targetRect.height / 2);

      target.dispatchEvent(pointer(frame.contentWindow, "pointermove", pointerId, targetX, targetY, 1));
      const validHighlighted = Boolean(await waitFor(() => target.classList.contains("is-drop-active"), 800));
      target.dispatchEvent(pointer(frame.contentWindow, "pointerup", pointerId, targetX, targetY, 0));
      await waitFor(() => {
        const imported = frame.contentWindow.eval("board.items.filter(item => item.url === " + JSON.stringify(verificationUrl) + ")");
        return imported.length === 1
          && !window.__conversationDashboardDragSession
          && !window.__conversationDashboardDraggedThread
          && !document.documentElement.dataset.conversationDashboardDragging
          && doc.getElementById("drag-guide")?.classList.contains("show") !== true
          && doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0;
      }, 1_500);

      const imported = frame.contentWindow.eval("board.items.filter(item => item.url === " + JSON.stringify(verificationUrl) + ")");
      const importedOnce = imported.length === 1
        && imported[0].kind === "work"
        && imported[0].title === "Pointer valid import";
      const stateCleared = !window.__conversationDashboardDragSession
        && !window.__conversationDashboardDraggedThread
        && !document.documentElement.dataset.conversationDashboardDragging
        && doc.getElementById("drag-guide")?.classList.contains("show") !== true
        && doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0;
      const allRowsNeverDraggable = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].every(candidate =>
        candidate.getAttribute("draggable") !== "true"
        && !candidate.dataset.conversationDashboardDraggable
      );
      const catcherCount = document.querySelectorAll("#conversation-dashboard-drop-catcher").length;
      const sourceAfterDrop = sourceRow();
      const sourceRowClearedAfterDrop = dragRow?.dataset.aboardDragging !== "true"
        && sourceAfterDrop?.dataset.aboardDragging !== "true";

      result = {
        ok: phaseReset && sourceConfirmed && activeAfterOpen && startedAsHostPointer
          && Boolean(sessionId) && sessionMatchesSource && rowNeverDraggable
          && validHighlighted && importedOnce && stateCleared
          && sourceRowClearedAfterDrop
          && allRowsNeverDraggable && catcherCount === 0,
        version: window.__conversationDashboardVersion,
        phaseReset,
        sourceConfirmed,
        pointerId,
        activeAfterOpen,
        startedAsHostPointer,
        sessionId,
        sessionMatchesSource,
        rowNeverDraggable,
        validHighlighted,
        importedCount: imported.length,
        importedKind: imported[0]?.kind || "",
        importedTitle: imported[0]?.title || "",
        stateCleared,
        sourceRowClearedAfterDrop,
        allRowsNeverDraggable,
        catcherCount
      };
    } finally {
      frame.contentWindow.eval("clearTimeout(saveTimer)");
      if (originalBoard == null) localStorage.removeItem("conversation-dashboard-board-v1");
      else localStorage.setItem("conversation-dashboard-board-v1", originalBoard);
      frame.contentWindow.eval("board = normalizeBoard(JSON.parse(window.parent.localStorage.getItem(storageKey))); activeTab = board.defaultTab || 'professional'; query = ''; floatingMenu = null; internalDrag = null; render()");
      [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")]
        .filter(candidate => candidate.dataset.appActionSidebarThreadId === "local:" + verificationId)
        .forEach(candidate => candidate.remove());
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
