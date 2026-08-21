#!/usr/bin/env node

// Regression coverage for the two project-conversation row shapes observed in
// the desktop sidebar:
//   1. a hydrated synthetic Work row such as `Demo Work Thread`, with
//      data-app-action-sidebar-thread-* attributes;
//   2. a synthetic server Chat project row such as `示例项目会话`, whose `.sidebar-item`
//      has no native action attributes but whose React owner carries the
//      conversation identity.
//
// The test prefers those real rows. If a title is not present, it clones a
// visible row into the equivalent shape so dynamic/late-mounted rows remain
// covered without depending on one user's sidebar contents.

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
    const exactProjectRow = title => [...document.querySelectorAll("aside [data-thread-title]")]
      .find(element => (element.textContent || "").replace(/\\s+/g, " ").trim() === title)
      ?.closest('.sidebar-item[role="button"]') || null;
    const reactConversation = row => {
      const fiberKey = Object.keys(row || {}).find(key => key.startsWith("__reactFiber"));
      let fiber = fiberKey ? row[fiberKey] : null;
      for (let depth = 0; fiber && depth < 32; depth += 1, fiber = fiber.return) {
        const conversation = fiber.memoizedProps?.conversation || fiber.memoizedProps?.item?.conversation;
        const id = conversation?.id || fiber.memoizedProps?.conversationId;
        if (id) return { id: String(id), title: String(conversation?.title || fiber.memoizedProps?.title || "") };
      }
      return null;
    };
    const setTitle = (row, title, suffix) => {
      const titleNode = row.querySelector("[data-thread-title]");
      if (titleNode) titleNode.textContent = title;
      const suffixNode = [...row.querySelectorAll("span")]
        .find(element => ["Chat", "Work", "Codex"].includes((element.textContent || "").trim()));
      if (suffixNode) suffixNode.textContent = suffix;
    };
    const removeNativeMetadata = row => {
      for (const name of [...row.getAttributeNames()]) {
        if (name.startsWith("data-app-action-sidebar-thread-")) row.removeAttribute(name);
      }
      row.removeAttribute("aria-label");
      row.removeAttribute("aria-current");
    };
    const appendDynamicRow = (base, title, suffix, hydrate, parent = base.parentElement) => {
      const row = base.cloneNode(true);
      for (const key of Object.keys(base)) {
        if (key.startsWith("__reactFiber") || key.startsWith("__reactProps")) row[key] = base[key];
      }
      row.removeAttribute("draggable");
      delete row.dataset.aboardDragging;
      setTitle(row, title, suffix);
      if (hydrate) {
        row.dataset.appActionSidebarThreadActive = "false";
        row.dataset.appActionSidebarThreadHostId = "local";
        row.dataset.appActionSidebarThreadId = "local:" + hydrate.id;
        row.dataset.appActionSidebarThreadKind = "local";
        row.dataset.appActionSidebarThreadRow = "";
        row.dataset.appActionSidebarThreadSelected = "false";
        row.dataset.appActionSidebarThreadTitle = title;
        row.setAttribute("aria-label", title);
      } else {
        removeNativeMetadata(row);
        const fixtureConversation = {
          id: "project-chat-fixture-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          title,
          create_time: "2026-08-14T00:00:00.000Z",
          update_time: "2026-08-14T00:00:00.000Z"
        };
        const reactKey = Object.keys(row).find(key => key.startsWith("__reactProps"));
        if (reactKey) row[reactKey] = { item: { conversation: fixtureConversation } };
        else row["__reactProps$aboardFixture"] = { item: { conversation: fixtureConversation } };
      }
      parent.appendChild(row);
      return row;
    };
    const findTargets = doc => ({
      chat: doc.querySelector('.chat-list[data-drop-kind="chat"]')
        || doc.querySelector('[data-drop-kind="chat"]'),
      work: [...doc.querySelectorAll('[data-drop-kind="work"]')].find(target => {
        const rect = target.getBoundingClientRect();
        return rect.width > 100 && rect.height > 80;
      })
    });
    const childPoint = target => {
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + Math.min(Math.max(24, rect.width / 2), rect.width - 12),
        y: rect.top + Math.min(Math.max(24, rect.height / 2), rect.height - 12)
      };
    };
    const ownedPreview = () => {
      const nodes = [...document.querySelectorAll("#conversation-dashboard-drag-preview")];
      const preview = nodes[0] || null;
      const style = preview ? getComputedStyle(preview) : null;
      return {
        count: nodes.length,
        surfaceKind: preview?.dataset.surfaceKind || "",
        title: (preview?.textContent || "").replace(/\\s+/g, " ").trim(),
        pointerEvents: style?.pointerEvents || ""
      };
    };
    const cleanState = (row, doc) => !window.__conversationDashboardDragSession
      && !window.__conversationDashboardDraggedThread
      && !document.documentElement.dataset.conversationDashboardDragging
      && row.dataset.aboardDragging !== "true"
      && ownedPreview().count === 0
      && doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0;
    const resetGesture = async (row, doc) => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      doc.dispatchEvent(new frame.contentWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const deadline = Date.now() + 800;
      while (!cleanState(row, doc) && Date.now() < deadline) await sleep(20);
      await sleep(80);
      return cleanState(row, doc);
    };
    const startHostGesture = async (row, pointerId) => {
      const rect = row.getBoundingClientRect();
      const startX = rect.left + Math.min(72, Math.max(24, rect.width / 3));
      const startY = rect.top + rect.height / 2;
      row.dispatchEvent(pointer(window, "pointerdown", pointerId, startX, startY, 1));
      document.dispatchEvent(pointer(window, "pointermove", pointerId, startX + 16, startY, 1));
      const deadline = Date.now() + 800;
      while (window.__conversationDashboardDragSession?.source !== "host-pointer" && Date.now() < deadline) {
        await sleep(20);
      }
      return { rect, session: window.__conversationDashboardDragSession };
    };

    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (surface.dataset.active !== "true") entry.click();
    await sleep(100);
    const frame = surface.querySelector("iframe");
    const doc = frame?.contentDocument;
    const targets = doc ? findTargets(doc) : {};
    if (!frame || !doc || !targets.chat || !targets.work) {
      return { ok: false, reason: "Aboard frame or drop targets unavailable" };
    }

    const hydratedWorkRow = () => exactProjectRow("Demo Work Thread")
      || [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")]
        .find(row => row.dataset.appActionSidebarThreadKind === "local");
    const unhydratedProjectChatRow = () => exactProjectRow("示例项目会话")
      || exactProjectRow("Aboard Project Chat fixture")
      || [...document.querySelectorAll('aside [role="list"][aria-label^="Chats in "] .sidebar-item[role="button"]')]
        .find(row => !row.matches("[data-app-action-sidebar-thread-row]"));
    let workRow = hydratedWorkRow();
    const hydratedBase = workRow;
    let chatRow = unhydratedProjectChatRow();
    if (!hydratedBase) return { ok: false, reason: "Hydrated project Work fixture unavailable" };

    const appended = [];
    const fixtureRoots = [];
    const fixtureProject = document.createElement("div");
    fixtureProject.dataset.sidebarProjectKind = "local";
    fixtureProject.style.cssText = "position:fixed;left:8px;top:220px;width:320px;z-index:1";
    const fixtureHeader = document.createElement("div");
    fixtureHeader.className = "sidebar-item";
    fixtureHeader.setAttribute("role", "button");
    fixtureHeader.textContent = "Aboard fixture project";
    const fixtureList = document.createElement("div");
    fixtureList.setAttribute("role", "list");
    fixtureList.setAttribute("aria-label", "Chats in Aboard fixture project");
    const fixtureItem = document.createElement("div");
    fixtureItem.setAttribute("role", "listitem");
    const fixtureOverflow = document.createElement("div");
    fixtureOverflow.className = "overflow-hidden";
    fixtureItem.appendChild(fixtureOverflow);
    fixtureList.appendChild(fixtureItem);
    fixtureProject.append(fixtureHeader, fixtureList);
    document.querySelector("aside")?.appendChild(fixtureProject);
    fixtureRoots.push(fixtureProject);
    const fixtureChatRow = appendDynamicRow(hydratedBase, "Aboard Project Chat fixture", "Chat", null, fixtureOverflow);
    let fixtureBadge = [...fixtureChatRow.querySelectorAll("span")]
      .find(element => ["Chat", "Work", "Codex"].includes((element.textContent || "").trim()));
    if (!fixtureBadge) {
      const titleNode = fixtureChatRow.querySelector("[data-thread-title]");
      fixtureBadge = document.createElement("span");
      fixtureBadge.textContent = "Chat";
      titleNode?.parentElement?.appendChild(fixtureBadge);
    }
    appended.push(fixtureChatRow);

    if (!workRow) {
      workRow = appendDynamicRow(hydratedBase, "Demo Work Thread", "Work", { id: "row-variant-work-" + Date.now() });
      appended.push(workRow);
    }
    if (!chatRow) {
      chatRow = fixtureChatRow;
    }
    const projectChatFixture = chatRow;
    await sleep(100);

    const storageKey = "conversation-dashboard-board-v1";
    const originalBoard = localStorage.getItem(storageKey);
    const baseline = frame.contentWindow.eval("structuredClone(board)");
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    const originalFetch = window.fetch;
    const originalHttpTestBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const bridgeCalls = [];
    const handoffEndpoint = "http://127.0.0.1:47844/api/handoff";
    const patchedFetch = async (url, options = {}) => {
      if (String(url || "") !== handoffEndpoint) return Reflect.apply(originalFetch, window, [url, options]);
      let body = null;
      try { body = JSON.parse(String(options.body || "null")); } catch (_) {}
      bridgeCalls.push({ url: String(url || ""), body });
      return { ok: true, status: 202, json: async () => ({ ok: true }), text: async () => "" };
    };
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
      // Aboard is a board-only companion. Clicking either native row while it
      // is active must hand off exactly once without allowing this cloned host
      // renderer to resume the same conversation.
      for (const [key, getRow] of [["hydratedWork", hydratedWorkRow], ["unhydratedChat", unhydratedProjectChatRow]]) {
        if (surface.dataset.active !== "true") entry.click();
        await sleep(60);
        const row = getRow();
        if (!row) throw new Error(key + " row disappeared before handoff");
        let seen = 0;
        row.addEventListener("click", () => { seen += 1; }, { once: true });
        const before = bridgeCalls.length;
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
        row.dispatchEvent(click);
        await sleep(80);
        results[key + "Click"] = {
          nativeRowBlocked: seen === 0,
          prevented: click.defaultPrevented,
          bridgeOnce: bridgeCalls.length === before + 1,
          dashboardVisible: surface.dataset.active === "true"
        };
      }

      // Hydrated Work has a stable id before selection and should drag directly
      // to Work without starting native HTML5 drag mode.
      entry.click();
      await sleep(60);
      workRow = hydratedWorkRow();
      if (!workRow) throw new Error("Hydrated Work row unavailable after click checks");
      const workId = 6401;
      await resetGesture(workRow, doc);
      const { session: workSession } = await startHostGesture(workRow, workId);
      const workPreview = ownedPreview();
      const workPoint = childPoint(targets.work);
      targets.work.dispatchEvent(pointer(frame.contentWindow, "pointermove", workId, workPoint.x, workPoint.y, 1));
      await sleep(40);
      results.hydratedWorkDrag = {
        started: workSession?.source === "host-pointer",
        surfaceKind: workSession?.payload?.surfaceKind,
        ownedPreviewSuppressed: workPreview.count === 0,
        validHighlight: targets.work.classList.contains("is-drop-active")
          && !targets.work.classList.contains("is-drop-invalid"),
        html5DragDisabled: workRow.getAttribute("draggable") !== "true"
      };
      targets.work.dispatchEvent(pointer(frame.contentWindow, "pointercancel", workId, workPoint.x, workPoint.y, 0));
      await sleep(60);
      results.hydratedWorkDrag.cleaned = cleanState(workRow, doc);

      // The unhydrated Chat variant is the original regression: it must be a
      // candidate even though the DOM attributes are absent. Production may
      // obtain identity from React ownership or by selecting/hydrating the row.
      chatRow = projectChatFixture.isConnected ? projectChatFixture : unhydratedProjectChatRow();
      if (!chatRow) throw new Error("Unhydrated project Chat row unavailable after click checks");
      const chatId = 6402;
      await resetGesture(chatRow, doc);
      const { session: chatSession } = await startHostGesture(chatRow, chatId);
      const chatPreview = ownedPreview();
      const chatPoint = childPoint(targets.chat);
      targets.chat.dispatchEvent(pointer(frame.contentWindow, "pointermove", chatId, chatPoint.x, chatPoint.y, 1));
      await sleep(50);
      results.unhydratedChatDrag = {
        fixtureHasNoNativeMetadata: !chatRow.matches("[data-app-action-sidebar-thread-row]"),
        fixtureHasReactIdentity: Boolean(reactConversation(chatRow)?.id) || appended.includes(chatRow),
        started: chatSession?.source === "host-pointer",
        hasStableId: Boolean(chatSession?.payload?.id),
        surfaceKind: chatSession?.payload?.surfaceKind,
        uniqueOwnedPreview: chatPreview.count === 1,
        previewSurfaceKind: chatPreview.surfaceKind,
        previewTitlePreserved: chatPreview.title.includes((chatRow.querySelector("[data-thread-title]")?.textContent || "").trim()),
        previewDoesNotIntercept: chatPreview.pointerEvents === "none",
        validHighlight: targets.chat.classList.contains("is-drop-active")
          && !targets.chat.classList.contains("is-drop-invalid"),
        html5DragDisabled: chatRow.getAttribute("draggable") !== "true"
      };
      targets.chat.dispatchEvent(pointer(frame.contentWindow, "pointercancel", chatId, chatPoint.x, chatPoint.y, 0));
      await sleep(60);
      results.unhydratedChatDrag.cleaned = cleanState(chatRow, doc);

      // The same project Chat must remain type-safe: moving it over a Work
      // card is rejected and must not alter the board.
      const boardBeforeInvalid = JSON.stringify(frame.contentWindow.eval("board"));
      await resetGesture(chatRow, doc);
      await startHostGesture(chatRow, chatId + 1);
      const invalidChatPreview = ownedPreview();
      targets.work.dispatchEvent(pointer(frame.contentWindow, "pointermove", chatId + 1, workPoint.x, workPoint.y, 1));
      await sleep(50);
      results.unhydratedChatToWork = {
        started: window.__conversationDashboardDragSession?.source === "host-pointer",
        uniqueOwnedPreview: invalidChatPreview.count === 1
          && invalidChatPreview.surfaceKind === "chat"
          && invalidChatPreview.pointerEvents === "none",
        invalidHighlight: targets.work.classList.contains("is-drop-invalid")
          && !targets.work.classList.contains("is-drop-active")
      };
      targets.work.dispatchEvent(pointer(frame.contentWindow, "pointerup", chatId + 1, workPoint.x, workPoint.y, 0));
      await sleep(120);
      results.unhydratedChatToWork.boardUnchanged = JSON.stringify(frame.contentWindow.eval("board")) === boardBeforeInvalid;
      results.unhydratedChatToWork.cleaned = cleanState(chatRow, doc);

      // Row-level delegation must not steal the native overflow/settings
      // control. This preserves menus and prevents an accidental drag when a
      // user presses an inline action.
      const inlineButton = chatRow.querySelector("button");
      if (inlineButton) {
        const buttonRect = inlineButton.getBoundingClientRect();
        inlineButton.dispatchEvent(pointer(window, "pointerdown", chatId + 2, buttonRect.left + 2, buttonRect.top + 2, 1));
        document.dispatchEvent(pointer(window, "pointermove", chatId + 2, buttonRect.left + 14, buttonRect.top + 2, 1));
        await sleep(50);
      }
      results.inlineButton = {
        available: Boolean(inlineButton),
        didNotStart: !window.__conversationDashboardDragSession
      };

      // A project header is navigational/container UI, not a conversation.
      // It must not match the delegated row selector even though it lives in
      // the same project subtree.
      const projectContainer = chatRow.closest("[data-sidebar-project-kind]");
      const projectHeader = [...(projectContainer?.querySelectorAll?.('.sidebar-item[role="button"]') || [])]
        .find(candidate => !candidate.closest('[role="list"][aria-label^="Chats in "]')
          && !candidate.closest('[role="list"][aria-label^="Scheduled tasks in "]'));
      if (projectHeader) {
        const headerRect = projectHeader.getBoundingClientRect();
        projectHeader.dispatchEvent(pointer(window, "pointerdown", chatId + 3, headerRect.left + 72, headerRect.top + headerRect.height / 2, 1));
        document.dispatchEvent(pointer(window, "pointermove", chatId + 3, headerRect.left + 84, headerRect.top + headerRect.height / 2, 1));
        await sleep(50);
      }
      results.projectHeader = {
        available: Boolean(projectHeader),
        doesNotMatchConversationRow: !projectHeader?.matches('[data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row])'),
        didNotStart: !window.__conversationDashboardDragSession
      };

      // A late-mounted unhydrated row must receive the same delegated behavior;
      // no reinstallation or per-row event binding should be required.
      const dynamicBase = unhydratedProjectChatRow();
      if (!dynamicBase) throw new Error("Dynamic project Chat base unavailable");
      const dynamic = appendDynamicRow(dynamicBase, "Late project Chat", "Chat", null);
      appended.push(dynamic);
      await sleep(80);
      if (surface.dataset.active !== "true") entry.click();
      await sleep(50);
      const dynamicBefore = bridgeCalls.length;
      const dynamicEvent = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      dynamic.dispatchEvent(dynamicEvent);
      await sleep(60);
      results.dynamicClick = {
        prevented: dynamicEvent.defaultPrevented,
        bridgeOnce: bridgeCalls.length === dynamicBefore + 1,
        dashboardVisible: surface.dataset.active === "true",
        noNativeMetadata: !dynamic.matches("[data-app-action-sidebar-thread-row]")
      };
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (originalHttpTestBridgeDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpTestBridgeDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      frame.contentWindow.eval("clearTimeout(saveTimer); saveTimer = null");
      if (originalBoard == null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalBoard);
      frame.contentWindow.eval("board = normalizeBoard(" + JSON.stringify(baseline) + "); activeTab = board.defaultTab || 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render(); clearTimeout(saveTimer); saveTimer = null");
      if (originalFetchDescriptor) Object.defineProperty(window, "fetch", originalFetchDescriptor);
      else delete window.fetch;
      appended.forEach(row => row.remove());
      fixtureRoots.forEach(root => root.remove());
      if (surface.dataset.active !== "true") entry.click();
      await sleep(80);
    }

    const required = [
      results.hydratedWorkClick?.nativeRowBlocked,
      results.hydratedWorkClick?.prevented,
      results.hydratedWorkClick?.bridgeOnce,
      results.hydratedWorkClick?.dashboardVisible,
      results.unhydratedChatClick?.nativeRowBlocked,
      results.unhydratedChatClick?.prevented,
      results.unhydratedChatClick?.bridgeOnce,
      results.unhydratedChatClick?.dashboardVisible,
      results.hydratedWorkDrag?.started,
      results.hydratedWorkDrag?.surfaceKind === "work",
      results.hydratedWorkDrag?.ownedPreviewSuppressed,
      results.hydratedWorkDrag?.validHighlight,
      results.hydratedWorkDrag?.html5DragDisabled,
      results.hydratedWorkDrag?.cleaned,
      results.unhydratedChatDrag?.fixtureHasNoNativeMetadata,
      results.unhydratedChatDrag?.fixtureHasReactIdentity,
      results.unhydratedChatDrag?.started,
      results.unhydratedChatDrag?.hasStableId,
      results.unhydratedChatDrag?.surfaceKind === "chat",
      results.unhydratedChatDrag?.uniqueOwnedPreview,
      results.unhydratedChatDrag?.previewSurfaceKind === "chat",
      results.unhydratedChatDrag?.previewTitlePreserved,
      results.unhydratedChatDrag?.previewDoesNotIntercept,
      results.unhydratedChatDrag?.validHighlight,
      results.unhydratedChatDrag?.html5DragDisabled,
      results.unhydratedChatDrag?.cleaned,
      results.unhydratedChatToWork?.started,
      results.unhydratedChatToWork?.uniqueOwnedPreview,
      results.unhydratedChatToWork?.invalidHighlight,
      results.unhydratedChatToWork?.boardUnchanged,
      results.unhydratedChatToWork?.cleaned,
      results.inlineButton?.available,
      results.inlineButton?.didNotStart,
      results.projectHeader?.available,
      results.projectHeader?.doesNotMatchConversationRow,
      results.projectHeader?.didNotStart,
      results.dynamicClick?.prevented,
      results.dynamicClick?.bridgeOnce,
      results.dynamicClick?.dashboardVisible,
      results.dynamicClick?.noNativeMetadata
    ];
    return {
      ok: required.every(Boolean),
      version: window.__conversationDashboardVersion,
      usedRealRows: {
        hydratedWork: !appended.includes(workRow),
        unhydratedChat: !appended.includes(chatRow)
      },
      ...results,
      boardRestored: localStorage.getItem(storageKey) === originalBoard
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

socket.close();
const result = response.result?.result?.value;
if (!result) console.error(JSON.stringify(response, null, 2));
else console.log(JSON.stringify(result, null, 2));
if (!result?.ok || !result?.boardRestored) process.exitCode = 1;
