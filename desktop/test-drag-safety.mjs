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

// The installed suite exercises trusted drags immediately before this
// synthetic safety probe. Establish a browser-level input boundary so a late
// release from the preceding phase cannot cancel the fresh pointer candidate.
for (const [method, params] of [
  ["Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", buttons: 0, clickCount: 0 }]
]) {
  const reset = await send(method, params);
  if (reset.error) throw new Error(`Failed to reset drag-safety input phase: ${reset.error.message}`);
}

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const waitFor = async getter => {
      for (let index = 0; index < 40; index += 1) {
        const value = getter();
        if (value) return value;
        await sleep(50);
      }
      return null;
    };
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

    const surface = await waitFor(() => document.getElementById("conversation-dashboard-surface"));
    let entry = await waitFor(() => document.getElementById("conversation-dashboard-sidebar-entry"));
    let row = await waitFor(() => [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(candidate =>
      candidate.dataset.appActionSidebarThreadId && candidate.dataset.appActionSidebarThreadTitle
    ));
    if (!surface || !entry || !row) return { ok: false, reason: "required UI unavailable" };

    entry.click();
    await sleep(80);

    const neverAboardDraggableBefore = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].every(candidate =>
      candidate.getAttribute("draggable") !== "true"
      && !candidate.dataset.conversationDashboardDraggable
    );

    const handoffEndpoint = "http://127.0.0.1:47844/api/handoff";
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    const originalFetch = window.fetch;
    const originalHttpTestBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const handoffRequests = [];
    // A fresh synthetic id is required for every invocation. Reusing a fixed
    // id makes an immediate rerun hit the product's intentional 900 ms
    // duplicate-open guard and falsely report that the bridge was skipped.
    const fixtureNonce = Date.now().toString(16).padStart(12, "0").slice(-12);
    const clickFixtureId = "44444444-4444-4444-8444-" + fixtureNonce;
    const clickFixture = row.cloneNode(true);
    clickFixture.hidden = true;
    clickFixture.removeAttribute("id");
    clickFixture.dataset.appActionSidebarThreadId = "local:" + clickFixtureId;
    clickFixture.dataset.appActionSidebarThreadHostId = "local";
    clickFixture.dataset.appActionSidebarThreadKind = "local";
    clickFixture.dataset.appActionSidebarThreadTitle = "Safety click candidate";
    clickFixture.dataset.appActionSidebarThreadSelected = "false";
    const inlineButton = document.createElement("button");
    inlineButton.type = "button";
    inlineButton.textContent = "Safety inline action";
    clickFixture.appendChild(inlineButton);
    document.body.appendChild(clickFixture);

    let nativeRowClickCount = 0;
    let inlineClickCount = 0;
    clickFixture.addEventListener("click", () => { nativeRowClickCount += 1; });
    inlineButton.addEventListener("click", () => { inlineClickCount += 1; });
    let inlineClickPrevented = null;
    let nativeClickOnePrevented = null;
    let nativeClickTwoPrevented = null;
    let handoffBridgeOnce = false;
    let ordinaryClickKeptAboard = false;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      enumerable: originalFetchDescriptor?.enumerable ?? true,
      writable: true,
      value: async (url, options = {}) => {
        if (String(url || "") !== handoffEndpoint) {
          return Reflect.apply(originalFetch, window, [url, options]);
        }
        let body = null;
        try { body = JSON.parse(String(options.body || "null")); } catch (_) {}
        handoffRequests.push({
          url: String(url || ""),
          method: String(options.method || "GET").toUpperCase(),
          body
        });
        return { ok: true, status: 202 };
      }
    });
    try {
      Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", {
        configurable: true,
        enumerable: originalHttpTestBridgeDescriptor?.enumerable ?? true,
        writable: true,
        value: true
      });
      const inlineEvent = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window });
      inlineButton.dispatchEvent(inlineEvent);
      inlineClickPrevented = inlineEvent.defaultPrevented;

      const nativeClickOne = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window });
      const nativeClickTwo = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window });
      clickFixture.dispatchEvent(nativeClickOne);
      clickFixture.dispatchEvent(nativeClickTwo);
      nativeClickOnePrevented = nativeClickOne.defaultPrevented;
      nativeClickTwoPrevented = nativeClickTwo.defaultPrevented;
      await sleep(120);
      const request = handoffRequests[0];
      handoffBridgeOnce = handoffRequests.length === 1
        && request?.url === handoffEndpoint
        && request?.method === "POST"
        && request?.body?.id === clickFixtureId;
      ordinaryClickKeptAboard = surface.dataset.active === "true";
    } finally {
      if (originalHttpTestBridgeDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpTestBridgeDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      if (originalFetchDescriptor) Object.defineProperty(window, "fetch", originalFetchDescriptor);
      else delete window.fetch;
      clickFixture.remove();
    }

    // The host can replace sidebar DOM during a rerender. A delegated entry
    // handler must keep working even though cloneNode does not copy listeners.
    const originalEntry = entry;
    const remountedEntry = originalEntry.cloneNode(true);
    originalEntry.replaceWith(remountedEntry);
    entry = remountedEntry;
    await sleep(40);
    entry.click();
    await sleep(80);
    const remountedEntryOpened = surface.dataset.active === "true";
    entry.replaceWith(originalEntry);
    entry = originalEntry;
    await sleep(40);
    const remountedEntryRestored = document.getElementById("conversation-dashboard-sidebar-entry") === originalEntry
      && !remountedEntry.isConnected
      && document.querySelectorAll("#conversation-dashboard-sidebar-entry").length === 1;

    // Clear a gesture state left by a previous interrupted/manual verification
    // before proving the fresh threshold transition below.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    entry.click();
    await sleep(80);
    const activeBeforePointer = surface.dataset.active === "true";
    const baseRow = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(candidate =>
      candidate.dataset.appActionSidebarThreadKind === "local"
      || /(^|\\s)(Work|Codex)($|\\s)/i.test(candidate.textContent || "")
    );
    const frame = surface.querySelector("iframe");
    const doc = frame?.contentDocument;
    if (!baseRow || !doc) return { ok: false, reason: "dashboard did not reopen" };

    row = baseRow.cloneNode(true);
    row.removeAttribute("draggable");
    row.removeAttribute("aria-selected");
    row.removeAttribute("aria-checked");
    row.removeAttribute("data-state");
    delete row.dataset.conversationDashboardDraggable;
    delete row.dataset.aboardDragging;
    row.hidden = true;
    row.dataset.appActionSidebarThreadId = "local:44444444-4444-4444-9444-" + fixtureNonce;
    row.dataset.appActionSidebarThreadKind = "local";
    row.dataset.appActionSidebarThreadTitle = "Safety pointer candidate";
    row.dataset.appActionSidebarThreadSelected = "false";
    // Keep the synthetic source outside the host's React-owned sidebar tree.
    // A native sidebar rerender can legitimately replace that tree between
    // append and pointerdown, disconnecting the clone before its delegated
    // event reaches document and producing a false pointer-session failure.
    document.body.appendChild(row);
    await sleep(60);

    const rect = row.getBoundingClientRect();
    const startX = rect.left + Math.min(12, Math.max(2, rect.width / 3));
    const startY = rect.top + Math.min(12, Math.max(2, rect.height / 2));

    const dragPointerId = 4502;
    let pointerDownSeen = 0;
    let pointerMoveSeen = 0;
    const observePointerDown = event => {
      if (event.pointerId === dragPointerId) pointerDownSeen += 1;
    };
    const observePointerMove = event => {
      if (event.pointerId === dragPointerId) pointerMoveSeen += 1;
    };
    row.addEventListener("pointerdown", observePointerDown);
    document.addEventListener("pointermove", observePointerMove);
    const downEvent = pointer(window, "pointerdown", dragPointerId, startX, startY, 1);
    const smallMoveEvent = pointer(window, "pointermove", dragPointerId, startX + 7, startY, 1);
    row.dispatchEvent(downEvent);
    document.dispatchEvent(smallMoveEvent);
    await sleep(30);
    const belowThresholdStarted = Boolean(window.__conversationDashboardDragSession);
    const largeMoveEvent = pointer(window, "pointermove", dragPointerId, startX + 10, startY, 1);
    document.dispatchEvent(largeMoveEvent);
    await sleep(50);
    const pointerSessionStarted = window.__conversationDashboardDragSession?.source === "host-pointer";
    const sourceMarked = row.dataset.aboardDragging === "true"
      && document.documentElement.dataset.conversationDashboardDragging === "true";
    await sleep(20);
    const guideShownAfterStart = doc.getElementById("drag-guide")?.classList.contains("show") === true;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(60);
    const stateCleared = !window.__conversationDashboardDraggedThread
      && !window.__conversationDashboardDragSession
      && !document.documentElement.dataset.conversationDashboardDragging
      && doc.getElementById("drag-guide")?.classList.contains("show") !== true;

    const probe = doc.createElement("button");
    probe.id = "drag-safety-click-probe";
    let frameClickCount = 0;
    let frameClickPrevented = null;
    probe.addEventListener("click", event => {
      frameClickCount += 1;
      frameClickPrevented = event.defaultPrevented;
    });
    doc.body.appendChild(probe);
    probe.dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
    probe.remove();

    const neverAboardDraggableAfter = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].every(candidate =>
      candidate.getAttribute("draggable") !== "true"
      && !candidate.dataset.conversationDashboardDraggable
    );
    const sourceRowClearedAfterCancel = row.dataset.aboardDragging !== "true";
    const catcherCount = document.querySelectorAll("#conversation-dashboard-drop-catcher").length;
    document.removeEventListener("pointermove", observePointerMove);
    row.remove();

    return {
      ok: neverAboardDraggableBefore && neverAboardDraggableAfter
        && ordinaryClickKeptAboard && handoffBridgeOnce
        && nativeClickOnePrevented && nativeClickTwoPrevented
        && inlineClickCount === 1 && inlineClickPrevented === false
        && nativeRowClickCount === 1
        && remountedEntryOpened && remountedEntryRestored
        && activeBeforePointer
        && pointerDownSeen === 1 && pointerMoveSeen === 2
        && !belowThresholdStarted && pointerSessionStarted && sourceMarked
        && stateCleared && sourceRowClearedAfterCancel
        && frameClickCount === 1 && frameClickPrevented === false
        && catcherCount === 0,
      version: window.__conversationDashboardVersion,
      neverAboardDraggableBefore,
      neverAboardDraggableAfter,
      ordinaryClickKeptAboard,
      handoffBridgeOnce,
      handoffRequestCount: handoffRequests.length,
      nativeClicksPrevented: nativeClickOnePrevented && nativeClickTwoPrevented,
      nativeRowNotActivated: nativeRowClickCount === 1,
      inlineButtonDelivered: inlineClickCount === 1,
      inlineButtonDefaultPrevented: inlineClickPrevented,
      remountedEntryOpened,
      remountedEntryRestored,
      activeBeforePointer,
      belowThresholdStarted,
      pointerDownSeen,
      pointerMoveSeen,
      pointerEventsObserved: pointerDownSeen === 1 && pointerMoveSeen === 2,
      pointerSessionStarted,
      sourceMarked,
      guideShown: guideShownAfterStart,
      stateCleared,
      sourceRowClearedAfterCancel,
      frameClickCount,
      frameClickDefaultPrevented: frameClickPrevented,
      catcherCount
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});
socket.close();
const result = response.result?.result?.value;
console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
