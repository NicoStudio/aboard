#!/usr/bin/env node

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Aboard window not found");

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
  if (!callback) return;
  pending.delete(message.id);
  callback(message);
});
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

// Give this synthetic-pointer test a hard boundary from the real CDP gesture
// used by the preceding regression. Chromium may otherwise deliver its final
// transition after the fixture starts and consume the first synthetic drag.
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: 8,
  y: 8,
  button: "left",
  buttons: 0
});
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await new Promise(resolve => setTimeout(resolve, 180));

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const pointer = (type, pointerId, x, y, buttons) => new PointerEvent(type, {
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
    const previewSnapshot = () => {
      const nodes = [...document.querySelectorAll("#conversation-dashboard-drag-preview")];
      const preview = nodes[0] || null;
      const style = preview ? getComputedStyle(preview) : null;
      const rect = preview?.getBoundingClientRect();
      return {
        count: nodes.length,
        surfaceKind: preview?.dataset.surfaceKind || "",
        title: (preview?.textContent || "").replace(/\\s+/g, " ").trim(),
        pointerEvents: style?.pointerEvents || "",
        transform: style?.transform || "",
        visible: Boolean(rect?.width && rect?.height)
          && style?.display !== "none"
          && style?.visibility !== "hidden"
          && style?.opacity !== "0",
        rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        visualSignature: preview && style ? [
          preview.className,
          style.position,
          style.display,
          style.padding,
          style.borderRadius,
          style.backgroundColor,
          style.boxShadow,
          style.fontFamily,
          style.fontSize,
          style.fontWeight,
          style.pointerEvents
        ].join("|") : ""
      };
    };
    const followsPointer = (first, second, firstPoint, secondPoint) => {
      if (!first.rect || !second.rect || first.transform === second.transform) return false;
      const pointerDeltaX = secondPoint.x - firstPoint.x;
      const pointerDeltaY = secondPoint.y - firstPoint.y;
      const previewDeltaX = second.rect.left - first.rect.left;
      const previewDeltaY = second.rect.top - first.rect.top;
      return Math.hypot(previewDeltaX, previewDeltaY) > 20
        && Math.abs(previewDeltaX - pointerDeltaX) <= 3
        && Math.abs(previewDeltaY - pointerDeltaY) <= 3;
    };

    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (surface.dataset.active !== "true") entry.click();
    await sleep(100);
    const frame = surface.querySelector("iframe");
    const doc = frame?.contentDocument;
    if (!frame || !doc) return { ok: false, reason: "Aboard frame unavailable" };

    const fixtureRoot = document.createElement("section");
    fixtureRoot.id = "aboard-drag-preview-test-fixtures";
    fixtureRoot.style.cssText = "position:fixed;left:12px;top:90px;width:260px;z-index:2147483000;pointer-events:auto";
    const rowStyle = "box-sizing:border-box;display:flex;align-items:center;width:248px;height:36px;padding:6px 10px";

    const nativeChatWrapper = document.createElement("div");
    nativeChatWrapper.dataset.sidebarChatgptConversationKey = "chatgpt:conversation:preview-native-chat";
    const nativeChatRow = document.createElement("div");
    nativeChatRow.className = "sidebar-item";
    nativeChatRow.setAttribute("role", "button");
    nativeChatRow.style.cssText = rowStyle;
    const nativeChatTitle = document.createElement("span");
    nativeChatTitle.dataset.threadTitle = "";
    nativeChatTitle.textContent = "Native Chat preview fixture";
    nativeChatRow.appendChild(nativeChatTitle);
    nativeChatWrapper.appendChild(nativeChatRow);

    const projectRoot = document.createElement("div");
    projectRoot.dataset.sidebarProjectKind = "cloud";
    const projectSortable = document.createElement("div");
    projectSortable.setAttribute("aria-roledescription", "sortable");
    const projectChatRow = document.createElement("div");
    projectChatRow.className = "sidebar-item";
    projectChatRow.setAttribute("role", "button");
    projectChatRow.style.cssText = rowStyle;
    const projectLabel = document.createElement("span");
    const projectChatTitle = document.createElement("span");
    projectChatTitle.dataset.threadTitle = "";
    projectChatTitle.textContent = "Project Chat preview fixture";
    const projectChatKind = document.createElement("span");
    projectChatKind.textContent = "Chat";
    projectLabel.append(projectChatTitle, projectChatKind);
    projectChatRow.appendChild(projectLabel);
    projectChatRow["__reactProps$aboardPreviewFixture"] = {
      item: {
        conversation: {
          id: "preview-project-chat",
          title: projectChatTitle.textContent,
          create_time: "2026-08-14T00:00:00.000Z",
          update_time: "2026-08-14T00:00:00.000Z"
        }
      }
    };
    projectSortable.appendChild(projectChatRow);
    projectRoot.appendChild(projectSortable);

    // This intentionally has no sortable ancestor. Work preview suppression
    // must be driven by payload.surfaceKind, not incidental host markup.
    const workRow = document.createElement("div");
    workRow.dataset.appActionSidebarThreadId = "local:44444444-4444-4444-8444-444444444451";
    workRow.dataset.appActionSidebarThreadKind = "local";
    workRow.dataset.appActionSidebarThreadTitle = "Work preview fixture";
    workRow.dataset.appActionSidebarThreadSelected = "false";
    workRow.setAttribute("data-app-action-sidebar-thread-row", "");
    workRow.style.cssText = rowStyle;
    workRow.textContent = "Work preview fixture";

    fixtureRoot.append(nativeChatWrapper, projectRoot, workRow);
    document.body.appendChild(fixtureRoot);
    await sleep(60);

    const storageKey = "conversation-dashboard-board-v1";
    const originalBoard = localStorage.getItem(storageKey);
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    const originalFetch = window.fetch;
    const originalHttpTestBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const handoffEndpoint = "http://127.0.0.1:47844/api/handoff";
    const bridgeCalls = [];
    let nextPointerId = 8_000 + Math.floor(performance.now()) % 1_000_000;
    const allocatePointerId = () => ++nextPointerId;
    const patchedFetch = async (url, options = {}) => {
      if (String(url || "") !== handoffEndpoint) return Reflect.apply(originalFetch, window, [url, options]);
      bridgeCalls.push(String(options.body || ""));
      return { ok: true, status: 202, json: async () => ({ ok: true }), text: async () => "" };
    };
    const startGesture = async (row, pointerId) => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (surface.dataset.active !== "true") entry.click();
      await sleep(50);
      const rect = row.getBoundingClientRect();
      const start = { x: rect.left + 24, y: rect.top + rect.height / 2 };
      const firstPoint = { x: start.x + 18, y: start.y + 10 };
      row.dispatchEvent(pointer("pointerdown", pointerId, start.x, start.y, 1));
      document.dispatchEvent(pointer("pointermove", pointerId, firstPoint.x, firstPoint.y, 1));
      await sleep(60);
      return { start, firstPoint };
    };
    const cleanState = row => !window.__conversationDashboardDragSession
      && !window.__conversationDashboardDraggedThread
      && !document.documentElement.dataset.conversationDashboardDragging
      && row.dataset.aboardDragging !== "true"
      && document.querySelectorAll("#conversation-dashboard-drag-preview").length === 0
      && doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0
      && doc.getElementById("drag-guide")?.classList.contains("show") !== true;

    const results = {};
    try {
      Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", {
        configurable: true,
        enumerable: originalHttpTestBridgeDescriptor?.enumerable ?? true,
        writable: true,
        value: true
      });
      Object.defineProperty(window, "fetch", {
        configurable: true,
        enumerable: originalFetchDescriptor?.enumerable ?? true,
        writable: true,
        value: patchedFetch
      });
      const nativePointerId = allocatePointerId();
      const nativeGesture = await startGesture(nativeChatRow, nativePointerId);
      const nativeFirst = previewSnapshot();
      const nativeSecondPoint = { x: nativeGesture.firstPoint.x + 74, y: nativeGesture.firstPoint.y + 38 };
      document.dispatchEvent(pointer("pointermove", nativePointerId, nativeSecondPoint.x, nativeSecondPoint.y, 1));
      await sleep(60);
      const nativeSecond = previewSnapshot();
      results.nativeChatPointerUp = {
        startedAsChat: window.__conversationDashboardDragSession?.payload?.surfaceKind === "chat",
        uniquePreview: nativeFirst.count === 1 && nativeSecond.count === 1,
        visible: nativeFirst.visible && nativeSecond.visible,
        titlePreserved: nativeFirst.title.includes(nativeChatTitle.textContent),
        surfaceKind: nativeFirst.surfaceKind,
        pointerEventsNone: nativeFirst.pointerEvents === "none" && nativeSecond.pointerEvents === "none",
        followsPointer: followsPointer(nativeFirst, nativeSecond, nativeGesture.firstPoint, nativeSecondPoint),
        visualSignature: nativeFirst.visualSignature
      };
      document.dispatchEvent(pointer("pointerup", nativePointerId, nativeSecondPoint.x, nativeSecondPoint.y, 0));
      await sleep(100);
      results.nativeChatPointerUp.cleaned = cleanState(nativeChatRow);

      const projectPointerId = allocatePointerId();
      await startGesture(projectChatRow, projectPointerId);
      const projectPreview = previewSnapshot();
      results.projectChatPointerCancel = {
        hasSortableAncestor: Boolean(projectChatRow.closest('[aria-roledescription="sortable"]')),
        startedAsChat: window.__conversationDashboardDragSession?.payload?.surfaceKind === "chat",
        uniquePreview: projectPreview.count === 1 && projectPreview.visible,
        titlePreserved: projectPreview.title.includes(projectChatTitle.textContent),
        surfaceKind: projectPreview.surfaceKind,
        pointerEventsNone: projectPreview.pointerEvents === "none",
        sameVisualContract: projectPreview.visualSignature === results.nativeChatPointerUp.visualSignature
      };
      document.dispatchEvent(pointer("pointercancel", projectPointerId, 120, 180, 0));
      await sleep(100);
      results.projectChatPointerCancel.cleaned = cleanState(projectChatRow);

      const escapePointerId = allocatePointerId();
      await startGesture(projectChatRow, escapePointerId);
      const escapePreview = previewSnapshot();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(100);
      results.projectChatEscape = {
        previewWasUnique: escapePreview.count === 1 && escapePreview.surfaceKind === "chat",
        cleaned: cleanState(projectChatRow)
      };

      const workPointerId = allocatePointerId();
      await startGesture(workRow, workPointerId);
      const workPreview = previewSnapshot();
      results.work = {
        hasNoSortableAncestor: !workRow.closest('[aria-roledescription="sortable"]'),
        startedAsWork: window.__conversationDashboardDragSession?.payload?.surfaceKind === "work",
        ownedPreviewSuppressed: workPreview.count === 0
      };
      document.dispatchEvent(pointer("pointercancel", workPointerId, 120, 220, 0));
      await sleep(100);
      results.work.cleaned = cleanState(workRow);

      for (const [key, row] of [["nativeChatClick", nativeChatRow], ["projectChatClick", projectChatRow]]) {
        if (surface.dataset.active !== "true") entry.click();
        await sleep(50);
        let delivered = 0;
        row.addEventListener("click", () => { delivered += 1; }, { once: true });
        const before = bridgeCalls.length;
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
        row.dispatchEvent(click);
        await sleep(80);
        results[key] = {
          nativeRowBlocked: delivered === 0,
          prevented: click.defaultPrevented,
          bridgeOnce: bridgeCalls.length === before + 1,
          dashboardVisible: surface.dataset.active === "true",
          previewAbsent: document.querySelectorAll("#conversation-dashboard-drag-preview").length === 0
        };
      }

      results.boardUnchangedBeforeRestore = localStorage.getItem(storageKey) === originalBoard;
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (originalHttpTestBridgeDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpTestBridgeDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      if (originalBoard == null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalBoard);
      frame.contentWindow.eval("(() => { let restored = fallbackBoard; try { const raw = window.parent.localStorage.getItem(storageKey); if (raw) restored = JSON.parse(raw); } catch (_) {} board = normalizeBoard(restored); activeTab = board.defaultTab || 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render(); clearTimeout(saveTimer); saveTimer = null; })()");
      if (originalFetchDescriptor) Object.defineProperty(window, "fetch", originalFetchDescriptor);
      else delete window.fetch;
      fixtureRoot.remove();
      if (surface.dataset.active !== "true") entry.click();
      await sleep(100);
    }

    results.boardRestored = localStorage.getItem(storageKey) === originalBoard;
    const required = [
      results.nativeChatPointerUp?.startedAsChat,
      results.nativeChatPointerUp?.uniquePreview,
      results.nativeChatPointerUp?.visible,
      results.nativeChatPointerUp?.titlePreserved,
      results.nativeChatPointerUp?.surfaceKind === "chat",
      results.nativeChatPointerUp?.pointerEventsNone,
      results.nativeChatPointerUp?.followsPointer,
      results.nativeChatPointerUp?.cleaned,
      results.projectChatPointerCancel?.hasSortableAncestor,
      results.projectChatPointerCancel?.startedAsChat,
      results.projectChatPointerCancel?.uniquePreview,
      results.projectChatPointerCancel?.titlePreserved,
      results.projectChatPointerCancel?.surfaceKind === "chat",
      results.projectChatPointerCancel?.pointerEventsNone,
      results.projectChatPointerCancel?.sameVisualContract,
      results.projectChatPointerCancel?.cleaned,
      results.projectChatEscape?.previewWasUnique,
      results.projectChatEscape?.cleaned,
      results.work?.hasNoSortableAncestor,
      results.work?.startedAsWork,
      results.work?.ownedPreviewSuppressed,
      results.work?.cleaned,
      results.nativeChatClick?.nativeRowBlocked,
      results.nativeChatClick?.prevented,
      results.nativeChatClick?.bridgeOnce,
      results.nativeChatClick?.dashboardVisible,
      results.nativeChatClick?.previewAbsent,
      results.projectChatClick?.nativeRowBlocked,
      results.projectChatClick?.prevented,
      results.projectChatClick?.bridgeOnce,
      results.projectChatClick?.dashboardVisible,
      results.projectChatClick?.previewAbsent,
      results.boardUnchangedBeforeRestore,
      results.boardRestored
    ];
    return {
      ok: required.every(Boolean),
      version: window.__conversationDashboardVersion,
      ...results
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

socket.close();
const result = response.result?.result?.value;
if (!result) console.error(JSON.stringify(response, null, 2));
else console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
