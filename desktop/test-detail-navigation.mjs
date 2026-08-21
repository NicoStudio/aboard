#!/usr/bin/env node

// Black-box regression for Aboard board-item activation. Chat and Work rows
// must hand off directly to their original conversation; an intermediate
// Aboard detail route is never part of this contract.

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const deadline = Date.now() + 10_000;
let page;
while (Date.now() < deadline) {
  try {
    const pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(800)
    }).then(response => response.json());
    page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
    if (page) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 150));
}
if (!page) throw new Error("Aboard renderer was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 2_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
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

const evaluation = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const waitFor = async (read, timeoutMs = 1_200) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await sleep(20);
      }
      return null;
    };
    const storageKey = "conversation-dashboard-board-v1";
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    if (surface.dataset.active !== "true") entry.click();
    await waitFor(() => surface.dataset.active === "true");

    const frame = surface.querySelector("iframe");
    const child = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!child || !doc) return { ok: false, reason: "Aboard frame unavailable" };

    const originalStorage = localStorage.getItem(storageKey);
    const hadOriginalStorage = originalStorage !== null;
    const originalBoard = child.eval("JSON.stringify(board)");
    const originalUi = child.eval("JSON.stringify({ activeTab, query, modal, floatingMenu })");
    const originalChildState = child.history.state;
    const originalChildUrl = child.location.href;
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    const originalFetch = window.fetch;
    const originalHttpTestBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const hostMessages = [];
    const detailRequests = [];
    let detailMounts = 0;
    const observer = new child.MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("[data-conversation-detail]") || node.querySelector?.("[data-conversation-detail]")) detailMounts += 1;
        }
      }
    });
    const interceptHostBridge = event => {
      if (event.source !== child) return;
      if (event.data?.method === "conversation-dashboard/open-native") {
        hostMessages.push(JSON.parse(JSON.stringify(event.data)));
      } else if (event.data?.method === "conversation-dashboard/request-detail") {
        detailRequests.push(JSON.parse(JSON.stringify(event.data)));
      } else {
        return;
      }
      // Never let this regression switch a real native/cloud conversation.
      event.stopImmediatePropagation();
    };
    window.addEventListener("message", interceptHostBridge, true);
    // The production listener was registered before this capture probe, so a
    // later stopImmediatePropagation cannot reliably keep a fixture activation
    // out of the native router. Force the documented test-only HTTP path and
    // intercept it here; no synthetic conversation can reach the host route.
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
      value: async (url, options = {}) => {
        if (String(url || "") === "http://127.0.0.1:47844/api/handoff") {
          return { ok: true, status: 202, json: async () => ({ ok: true }) };
        }
        return Reflect.apply(originalFetch, window, [url, options]);
      }
    });

    const ids = {
      workClick: "11111111-1111-4111-8111-000000500101",
      workEnter: "11111111-1111-4111-8111-000000500102",
      workSpace: "11111111-1111-4111-8111-000000500103",
      chatClick: "22222222-2222-4222-8222-000000500104",
      chatEnter: "11111111-1111-4111-8111-000000500105",
      chatSpace: "22222222-2222-4222-8222-000000500106",
      repeat: "11111111-1111-4111-8111-000000500107",
      failure: "22222222-2222-4222-8222-000000500108",
      repeatChat: "22222222-2222-4222-8222-000000500109"
    };
    const hiddenChatTitle = "ABOARD_DIRECT_OPEN_HIDDEN_CHAT_SECRET_20260817";
    const hiddenWorkTitle = "ABOARD_DIRECT_OPEN_HIDDEN_WORK_SECRET_20260817";
    const fixture = {
      version: 2,
      defaultTab: "personal",
      chatSortBy: { professional: "manual", personal: "manual" },
      projects: [
        { id: "direct-project", name: "Direct Open", accent: "#315CF5", order: 1, sortBy: "manual" }
      ],
      items: [
        { id: "work-click", title: "Work mouse", kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 1, hostId: "local", url: "codex://threads/" + ids.workClick },
        { id: "work-enter", title: "Work Enter", kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 2, hostId: "work-host", url: "codex://threads/" + ids.workEnter + "?hostId=work-host" },
        { id: "work-space", title: hiddenWorkTitle, kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: true, marker: "p1", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 3, hostId: "local", url: "codex://threads/" + ids.workSpace },
        { id: "repeat-work", title: "Repeat protection", kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 4, hostId: "local", url: "codex://threads/" + ids.repeat },
        { id: "chat-click", title: hiddenChatTitle, kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: true, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 1, hostId: "", url: "https://chatgpt.com/c/" + ids.chatClick },
        { id: "chat-enter", title: "Local Chat Enter", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 2, hostId: "local-chat-host", url: "codex://threads/" + ids.chatEnter + "?hostId=local-chat-host" },
        { id: "chat-space", title: "Chat Space", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 3, hostId: "", url: "https://chatgpt.com/c/" + ids.chatSpace },
        { id: "failure-chat", title: "Failure toast", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 4, hostId: "", url: "https://chatgpt.com/c/" + ids.failure },
        { id: "repeat-chat", title: "Repeat Chat protection", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 5, hostId: "", url: "https://chatgpt.com/c/" + ids.repeatChat },
        { id: "no-url-visible", title: "Unbound visible conversation", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 6, hostId: "", url: "" },
        { id: "no-url-hidden", title: "ABOARD_DIRECT_OPEN_UNBOUND_HIDDEN_SECRET", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: true, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z", manualOrder: 7, hostId: "", url: "" }
      ]
    };
    const fixtureStorage = JSON.stringify(fixture);
    const results = {};
    const opener = itemId => doc.querySelector('[data-open="' + itemId + '"]');
    const row = itemId => doc.querySelector('[data-drag-item="' + itemId + '"]');
    const messagesFor = nativeId => hostMessages.filter(message => message.payload?.id === nativeId);
    const noDetail = () => !doc.querySelector("[data-conversation-detail]");
    const boardInteractive = () => {
      const boardView = doc.querySelector("[data-board-view]");
      return Boolean(boardView && boardView.inert !== true && boardView.getAttribute("aria-hidden") !== "true");
    };
    const dispatchKey = (target, key) => {
      const event = new child.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const dispatchDrag = (target, type, dataTransfer) => {
      let event;
      try { event = new child.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }); }
      catch (_) {
        event = new child.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      }
      target.dispatchEvent(event);
      return event;
    };
    const expectedPayload = (message, expected) => message?.method === "conversation-dashboard/open-native"
      && message?.payload?.id === expected.id
      && message?.payload?.url === expected.url
      && message?.payload?.kind === expected.kind
      && String(message?.payload?.hostId || "") === String(expected.hostId || "")
      && message?.payload?.title === expected.title;
    const recoverFromForbiddenDetail = () => {
      if (!noDetail()) {
        try { child.eval("closeConversationDetail({ restoreFocus: false })"); } catch (_) {}
      }
    };
    const activateOnce = async ({ itemId, nativeId, mode, expected }) => {
      recoverFromForbiddenDetail();
      const target = opener(itemId);
      const before = messagesFor(nativeId).length;
      let prevented = true;
      target?.focus();
      if (mode === "click") target?.click();
      else prevented = dispatchKey(target, mode === "enter" ? "Enter" : " ");
      await waitFor(() => messagesFor(nativeId).length > before);
      await sleep(80);
      const matching = messagesFor(nativeId).slice(before);
      const result = {
        openerFound: Boolean(target),
        keyboardPrevented: mode === "click" || prevented,
        emittedExactlyOnce: matching.length === 1,
        exactPayload: expectedPayload(matching[0], expected),
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };
      recoverFromForbiddenDetail();
      return result;
    };

    try {
      localStorage.setItem(storageKey, fixtureStorage);
      child.eval("clearTimeout(saveTimer); saveTimer = null; document.querySelector('[data-conversation-detail]')?.remove(); board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'personal'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render()");
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      const normalizedFixtureBoard = child.eval("JSON.stringify(board)");

      results.workClick = await activateOnce({
        itemId: "work-click", nativeId: ids.workClick, mode: "click",
        expected: { id: ids.workClick, url: "codex://threads/" + ids.workClick, kind: "work", hostId: "local", title: "Work mouse" }
      });
      results.chatClick = await activateOnce({
        itemId: "chat-click", nativeId: ids.chatClick, mode: "click",
        expected: { id: ids.chatClick, url: "https://chatgpt.com/c/" + ids.chatClick, kind: "chat", hostId: "", title: "" }
      });
      results.hiddenChat = {
        concealedInRow: opener("chat-click")?.textContent?.includes(hiddenChatTitle) === false,
        secretAbsentFromHandoff: !JSON.stringify(messagesFor(ids.chatClick)).includes(hiddenChatTitle),
        directUrlStillExact: messagesFor(ids.chatClick)[0]?.payload?.url === "https://chatgpt.com/c/" + ids.chatClick
      };
      results.workEnter = await activateOnce({
        itemId: "work-enter", nativeId: ids.workEnter, mode: "enter",
        expected: { id: ids.workEnter, url: "codex://threads/" + ids.workEnter + "?hostId=work-host", kind: "work", hostId: "work-host", title: "Work Enter" }
      });
      results.chatEnter = await activateOnce({
        itemId: "chat-enter", nativeId: ids.chatEnter, mode: "enter",
        expected: { id: ids.chatEnter, url: "codex://threads/" + ids.chatEnter + "?hostId=local-chat-host", kind: "chat", hostId: "local-chat-host", title: "Local Chat Enter" }
      });
      results.localRoutingUsesUrl = {
        chatKindStillUsesCodexUrl: messagesFor(ids.chatEnter)[0]?.payload?.kind === "chat"
          && messagesFor(ids.chatEnter)[0]?.payload?.url?.startsWith("codex://threads/"),
        hostPreserved: messagesFor(ids.chatEnter)[0]?.payload?.hostId === "local-chat-host"
      };
      results.workSpace = await activateOnce({
        itemId: "work-space", nativeId: ids.workSpace, mode: "space",
        expected: { id: ids.workSpace, url: "codex://threads/" + ids.workSpace, kind: "work", hostId: "local", title: "" }
      });
      results.chatSpace = await activateOnce({
        itemId: "chat-space", nativeId: ids.chatSpace, mode: "space",
        expected: { id: ids.chatSpace, url: "https://chatgpt.com/c/" + ids.chatSpace, kind: "chat", hostId: "", title: "Chat Space" }
      });
      results.hiddenWork = {
        concealedInRow: opener("work-space")?.textContent?.includes(hiddenWorkTitle) === false,
        secretAbsentFromHandoff: !JSON.stringify(messagesFor(ids.workSpace)).includes(hiddenWorkTitle),
        directUrlStillExact: messagesFor(ids.workSpace)[0]?.payload?.url === "codex://threads/" + ids.workSpace
      };

      recoverFromForbiddenDetail();
      const repeatBefore = messagesFor(ids.repeat).length;
      const repeatOpener = opener("repeat-work");
      repeatOpener?.click();
      repeatOpener?.click();
      await waitFor(() => messagesFor(ids.repeat).length > repeatBefore);
      await sleep(160);
      results.repeatProtection = {
        openerFound: Boolean(repeatOpener),
        rapidDoubleActivationEmitsOnce: messagesFor(ids.repeat).length - repeatBefore === 1,
        exactPayload: expectedPayload(messagesFor(ids.repeat)[repeatBefore], {
          id: ids.repeat, url: "codex://threads/" + ids.repeat, kind: "work", hostId: "local", title: "Repeat protection"
        }),
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };
      recoverFromForbiddenDetail();

      const repeatChatBefore = messagesFor(ids.repeatChat).length;
      const repeatChatOpener = opener("repeat-chat");
      repeatChatOpener?.click();
      repeatChatOpener?.click();
      await waitFor(() => messagesFor(ids.repeatChat).length > repeatChatBefore);
      await sleep(160);
      results.repeatChatProtection = {
        openerFound: Boolean(repeatChatOpener),
        rapidDoubleActivationEmitsOnce: messagesFor(ids.repeatChat).length - repeatChatBefore === 1,
        exactPayload: expectedPayload(messagesFor(ids.repeatChat)[repeatChatBefore], {
          id: ids.repeatChat, url: "https://chatgpt.com/c/" + ids.repeatChat, kind: "chat", hostId: "", title: "Repeat Chat protection"
        }),
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };
      recoverFromForbiddenDetail();

      const failureBefore = messagesFor(ids.failure).length;
      opener("failure-chat")?.click();
      await waitFor(() => messagesFor(ids.failure).length > failureBefore);
      child.postMessage({ method: "conversation-dashboard/native-create-error", message: "无法打开目标会话，请重试" }, "*");
      const toast = await waitFor(() => {
        const candidate = doc.querySelector("#toast.show");
        return /无法打开|重试/.test(candidate?.textContent || "") ? candidate : null;
      });
      results.failureToast = {
        emittedExactlyOnce: messagesFor(ids.failure).length - failureBefore === 1,
        errorVisible: Boolean(toast),
        actionableMessage: /无法打开|重试/.test(toast?.textContent || ""),
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };
      recoverFromForbiddenDetail();

      const beforeUnbound = hostMessages.length;
      opener("no-url-visible")?.click();
      const unboundVisibleToast = await waitFor(() => /链接|绑定|设置/.test(doc.querySelector("#toast.show")?.textContent || ""));
      const visibleEditor = doc.querySelector("[data-modal-backdrop]");
      results.unboundVisible = {
        noHandoff: hostMessages.length === beforeUnbound,
        opensSettings: Boolean(visibleEditor) && child.eval("modal?.itemId") === "no-url-visible",
        actionableToast: Boolean(unboundVisibleToast),
        noIntermediateDetail: noDetail()
      };
      doc.querySelector("[data-close-modal]")?.click();
      await sleep(20);
      const hiddenUnboundSecret = "ABOARD_DIRECT_OPEN_UNBOUND_HIDDEN_SECRET";
      opener("no-url-hidden")?.click();
      const unboundHiddenToast = await waitFor(() => /链接|绑定|设置/.test(doc.querySelector("#toast.show")?.textContent || ""));
      results.unboundHidden = {
        noHandoff: hostMessages.length === beforeUnbound,
        toastVisible: Boolean(unboundHiddenToast),
        settingsNotOpened: !doc.querySelector("[data-modal-backdrop]") && child.eval("modal === null"),
        secretAbsentFromDom: !doc.documentElement.innerHTML.includes(hiddenUnboundSecret),
        secretAbsentFromBridge: !JSON.stringify(hostMessages).includes(hiddenUnboundSecret),
        noIntermediateDetail: noDetail()
      };
      recoverFromForbiddenDetail();

      const beforeInline = hostMessages.length;
      const eye = doc.querySelector('[data-drag-item="chat-enter"] [data-title-visibility]');
      eye?.click();
      doc.querySelector('[data-drag-item="chat-enter"] [data-title-visibility]')?.click();
      const pin = doc.querySelector('[data-drag-item="work-click"] [data-pin]');
      pin?.click();
      doc.querySelector('[data-drag-item="work-click"] [data-pin]')?.click();
      doc.querySelector('[data-drag-item="chat-enter"] [data-priority-menu]')?.click();
      await sleep(40);
      const chatMenuOpened = Boolean(doc.querySelector(".floating-menu[role='menu']"));
      child.eval("floatingMenu = null; render()");
      doc.querySelector('[data-drag-item="work-click"] [data-edit]')?.click();
      await sleep(40);
      const workEditorOpened = Boolean(doc.querySelector("[data-modal-backdrop]"));
      doc.querySelector("[data-close-modal]")?.click();
      await sleep(20);
      results.inlineActions = {
        eyeFound: Boolean(eye),
        pinFound: Boolean(pin),
        chatMenuOpened,
        workEditorOpened,
        noHandoff: hostMessages.length === beforeInline,
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };

      const beforeDrag = hostMessages.length;
      const dragResults = [];
      for (const itemId of ["chat-space", "work-enter"]) {
        const dragRow = row(itemId);
        const transfer = new child.DataTransfer();
        dispatchDrag(dragRow, "dragstart", transfer);
        const started = child.eval("internalDrag?.itemId") === itemId && dragRow?.classList.contains("is-dragging");
        dispatchDrag(dragRow, "dragend", transfer);
        const ended = child.eval("internalDrag === null") && !dragRow?.classList.contains("is-dragging");
        dragResults.push(Boolean(dragRow) && started && ended);
      }
      results.drag = {
        chatAndWorkStayDragOnly: dragResults.length === 2 && dragResults.every(Boolean),
        noHandoff: hostMessages.length === beforeDrag,
        noIntermediateDetail: noDetail(),
        boardRemainsInteractive: boardInteractive()
      };

      results.globalContract = {
        noDetailEverMounted: detailMounts === 0,
        noTranscriptRequest: detailRequests.length === 0,
        exactActivationCount: hostMessages.length === 9,
        fixtureBoardUnchanged: child.eval("JSON.stringify(board)") === normalizedFixtureBoard,
        fixtureStorageUnchanged: localStorage.getItem(storageKey) === fixtureStorage
      };
    } catch (error) {
      results.error = String(error?.stack || error);
    } finally {
      observer.disconnect();
      // Let every iframe activation message reach the capture guard before it
      // is removed. Otherwise a queued final activation can escape into the
      // production listener during teardown and hide the board after all
      // behavioral assertions have already passed.
      await sleep(120);
      window.removeEventListener("message", interceptHostBridge, true);
      if (originalHttpTestBridgeDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpTestBridgeDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      if (originalFetchDescriptor) Object.defineProperty(window, "fetch", originalFetchDescriptor);
      else delete window.fetch;
      try { child.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null; document.querySelector('[data-conversation-detail]')?.remove()"); } catch (_) {}
      if (hadOriginalStorage) localStorage.setItem(storageKey, originalStorage);
      else localStorage.removeItem(storageKey);
      const restoredUi = JSON.parse(originalUi);
      child.eval("board = JSON.parse(" + JSON.stringify(originalBoard) + "); activeTab = " + JSON.stringify(restoredUi.activeTab) + "; query = " + JSON.stringify(restoredUi.query) + "; modal = " + JSON.stringify(restoredUi.modal) + "; floatingMenu = " + JSON.stringify(restoredUi.floatingMenu) + "; internalDrag = null; render()");
      try { child.history.replaceState(originalChildState, "", originalChildUrl); } catch (_) {}
      if (surface.dataset.active !== "true") {
        entry.click();
        await waitFor(() => surface.dataset.active === "true");
      }
    }

    results.restoration = {
      localStorageExactString: hadOriginalStorage ? localStorage.getItem(storageKey) === originalStorage : localStorage.getItem(storageKey) === null,
      boardExactString: child.eval("JSON.stringify(board)") === originalBoard,
      aboardVisible: surface.dataset.active === "true",
      sameFrame: surface.querySelector("iframe") === frame
    };
    const sections = [
      results.workClick, results.chatClick, results.hiddenChat,
      results.workEnter, results.chatEnter, results.localRoutingUsesUrl, results.workSpace, results.chatSpace,
      results.hiddenWork, results.repeatProtection, results.repeatChatProtection, results.failureToast,
      results.unboundVisible, results.unboundHidden,
      results.inlineActions, results.drag, results.globalContract, results.restoration
    ];
    const required = sections.flatMap(section => Object.values(section || {}));
    return { ok: required.every(Boolean) && !results.error, ...results };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

socket.close();
socket.unref?.();
if (evaluation.result?.exceptionDetails) {
  console.error(JSON.stringify(evaluation.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  const result = evaluation.result?.result?.value;
  console.log(JSON.stringify(result, null, 2));
  if (!result?.ok) process.exitCode = 1;
}
