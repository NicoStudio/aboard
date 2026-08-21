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

const evaluation = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const waitFor = async (read, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await sleep(20);
      }
      return null;
    };

    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    let frame = surface?.querySelector("iframe");
    let child = frame?.contentWindow;
    let childDocument = frame?.contentDocument;
    if (!entry || !surface || !child || !childDocument) {
      return { ok: false, reason: "Aboard host UI unavailable" };
    }

    const storageKey = "conversation-dashboard-board-v1";
    const originalStorage = localStorage.getItem(storageKey);
    const hadOriginalStorage = originalStorage !== null;
    const originalBoard = child.eval("JSON.stringify(board)");
    const originalUi = child.eval("JSON.stringify({ activeTab, query, modal, floatingMenu })");
    const originalPath = location.pathname + location.search + location.hash;
    const originalHistoryState = history.state;
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
    const originalFetch = window.fetch;
    const originalHttpTestBridgeDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const originalOpen = window.open;
    const originalPostMessageDescriptor = Object.getOwnPropertyDescriptor(window, "postMessage");
    const originalPostMessage = window.postMessage;

    const bridgeRequests = [];
    const routeMessages = [];
    const externalOpens = [];
    const fixtureRoot = document.createElement("section");
    fixtureRoot.id = "aboard-handoff-routing-fixtures";
    fixtureRoot.hidden = true;

    const boardThreadId = "11111111-1111-4111-8111-000000200101";
    const nativeWorkId = "11111111-1111-4111-8111-000000200102";
    const nativeChatId = "22222222-2222-4222-8222-000000200103";
    const neutralThreadId = "11111111-1111-4111-8111-000000200104";

    const boardVisibleRow = document.createElement("div");
    boardVisibleRow.setAttribute("data-app-action-sidebar-thread-row", "");
    boardVisibleRow.dataset.appActionSidebarThreadId = "local:" + boardThreadId;
    boardVisibleRow.dataset.appActionSidebarThreadHostId = "local";
    boardVisibleRow.dataset.appActionSidebarThreadKind = "local";
    boardVisibleRow.dataset.appActionSidebarThreadTitle = "Aboard board handoff fixture";
    fixtureRoot.appendChild(boardVisibleRow);

    const nativeWorkRow = document.createElement("div");
    nativeWorkRow.setAttribute("data-app-action-sidebar-thread-row", "");
    nativeWorkRow.dataset.appActionSidebarThreadId = "local:" + nativeWorkId;
    nativeWorkRow.dataset.appActionSidebarThreadHostId = "local";
    nativeWorkRow.dataset.appActionSidebarThreadKind = "local";
    nativeWorkRow.dataset.appActionSidebarThreadTitle = "Aboard native Work handoff fixture";
    nativeWorkRow.setAttribute("role", "button");
    const nativeWorkInlineButton = document.createElement("button");
    nativeWorkInlineButton.type = "button";
    nativeWorkInlineButton.textContent = "Work inline action";
    nativeWorkRow.appendChild(nativeWorkInlineButton);
    fixtureRoot.appendChild(nativeWorkRow);

    const nativeChatWrapper = document.createElement("div");
    nativeChatWrapper.dataset.sidebarChatgptConversationKey = "chatgpt:conversation:" + nativeChatId;
    const nativeChatRow = document.createElement("div");
    nativeChatRow.className = "sidebar-item";
    nativeChatRow.dataset.appActionSidebarThreadTitle = "Aboard native Chat handoff fixture";
    nativeChatRow.setAttribute("role", "button");
    const nativeChatInlineButton = document.createElement("button");
    nativeChatInlineButton.type = "button";
    nativeChatInlineButton.textContent = "Chat inline action";
    nativeChatRow.appendChild(nativeChatInlineButton);
    nativeChatWrapper.appendChild(nativeChatRow);
    fixtureRoot.appendChild(nativeChatWrapper);

    const aside = document.querySelector("aside");
    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.hidden = true;
    hideButton.textContent = "Aboard handoff test hide button";
    (aside || fixtureRoot).appendChild(hideButton);
    document.body.appendChild(fixtureRoot);

    let boardVisibleRowClicks = 0;
    let nativeWorkRowClicks = 0;
    let nativeChatRowClicks = 0;
    let nativeWorkInlineClicks = 0;
    let nativeChatInlineClicks = 0;
    boardVisibleRow.addEventListener("click", () => { boardVisibleRowClicks += 1; });
    nativeWorkRow.addEventListener("click", () => { nativeWorkRowClicks += 1; });
    nativeChatRow.addEventListener("click", () => { nativeChatRowClicks += 1; });
    nativeWorkInlineButton.addEventListener("click", () => { nativeWorkInlineClicks += 1; });
    nativeChatInlineButton.addEventListener("click", () => { nativeChatInlineClicks += 1; });

    const handoffEndpoint = "http://127.0.0.1:47844/api/handoff";
    const patchedFetch = async (url, options = {}) => {
      if (String(url || "") !== handoffEndpoint) {
        return Reflect.apply(originalFetch, window, [url, options]);
      }
      const headers = new Headers(options.headers || {});
      let body = null;
      try { body = JSON.parse(String(options.body || "null")); }
      catch (_) { body = String(options.body || ""); }
      bridgeRequests.push({
        url: String(url || ""),
        method: String(options.method || "GET").toUpperCase(),
        token: headers.get("X-Aboard-Token") || "",
        contentType: headers.get("Content-Type") || "",
        body
      });
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true })
      };
    };
    const patchedPostMessage = function patchedPostMessage(message, ...rest) {
      if (message?.type === "navigate-to-route") {
        routeMessages.push({
          path: String(message.path || ""),
          replace: message.replace === true,
          activeAtCall: surface.dataset.active || ""
        });
        return undefined;
      }
      return Reflect.apply(originalPostMessage, window, [message, ...rest]);
    };

    const requestsFor = id => bridgeRequests.filter(request => request.body?.id === id);
    const dispatchRowClick = row => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
      row.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented };
    };
    const validRequest = (request, expected) => request?.url === handoffEndpoint
      && request?.method === "POST"
      && request?.token.length >= 16
      && !request.token.includes("__")
      && request?.contentType.toLowerCase().includes("application/json")
      && request?.body?.id === expected.id
      && request?.body?.url === expected.url
      && request?.body?.kind === expected.kind
      && String(request?.body?.hostId || "") === String(expected.hostId || "")
      && request?.body?.title === expected.title;

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
      Object.defineProperty(window, "postMessage", {
        configurable: true,
        enumerable: originalPostMessageDescriptor?.enumerable ?? true,
        writable: true,
        value: patchedPostMessage
      });
      window.open = (url, target, features) => {
        externalOpens.push({ url: String(url || ""), target: String(target || ""), features: String(features || "") });
        return null;
      };

      // Returning through the sidebar Aboard entry must preserve the native
      // route underneath the overlay. This lets a running conversation keep
      // its mounted writer and makes an immediate board-to-conversation round
      // trip possible without a second resume.
      if (surface.dataset.active !== "true") entry.click();
      await waitFor(() => surface.dataset.active === "true");
      routeMessages.length = 0;
      hideButton.click();
      await waitFor(() => surface.dataset.active === "false");
      history.pushState({ aboardHandoffTest: true }, "", "/local/" + neutralThreadId);
      entry.click();
      await waitFor(() => surface.dataset.active === "true");
      await sleep(80);
      results.neutralRoute = {
        emittedNone: routeMessages.length === 0,
        pathPreserved: location.pathname === "/local/" + neutralThreadId,
        visibleWithoutNavigation: surface.dataset.active === "true",
        noBridgeRequest: bridgeRequests.length === 0
      };
      history.replaceState(originalHistoryState, "", originalPath);
      routeMessages.length = 0;
      // The route spy wraps Window.postMessage. Keeping that wrapper installed
      // changes the source identity of messages posted by the iframe, so the
      // production source guard correctly ignores them. Restore the native
      // method before exercising board-to-host handoff.
      if (originalPostMessageDescriptor) Object.defineProperty(window, "postMessage", originalPostMessageDescriptor);
      else delete window.postMessage;

      // Host route changes can remount the workspace and its injected iframe.
      // Always exercise the current Aboard document rather than a detached
      // pre-navigation frame, which would post from a source production
      // intentionally ignores.
      const liveFrame = await waitFor(() => {
        const candidate = surface.querySelector("iframe");
        const candidateWindow = candidate?.contentWindow;
        const candidateDocument = candidate?.contentDocument;
        if (!candidateWindow || candidateDocument?.readyState !== "complete") return null;
        try {
          if (!candidateWindow.eval("typeof openItem === 'function' && typeof render === 'function'")) return null;
        } catch (_) { return null; }
        return { frame: candidate, child: candidateWindow, document: candidateDocument };
      }, 3_000);
      if (!liveFrame) throw new Error("Aboard frame was remounted without a ready document");
      frame = liveFrame.frame;
      child = liveFrame.child;
      childDocument = liveFrame.document;

      const fixtureBoard = {
        version: 2,
        defaultTab: "professional",
        chatSortBy: { professional: "updated", personal: "updated" },
        projects: [
          { id: "handoff-project", name: "Handoff Project", accent: "#315CF5", order: 1, sortBy: "updated" }
        ],
        items: [
          {
            id: "handoff-board-item",
            title: "Aboard board handoff fixture",
            kind: "work",
            topic: null,
            projectId: "handoff-project",
            pinned: false,
            titleHidden: false,
            marker: "p2",
            runtimeStatus: "idle",
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
            manualOrder: 1,
            hostId: "local",
            url: "codex://threads/" + boardThreadId
          }
        ]
      };
      localStorage.setItem(storageKey, JSON.stringify(fixtureBoard));
      child.eval("clearTimeout(saveTimer); saveTimer = null; board = normalizeBoard(" + JSON.stringify(fixtureBoard) + "); activeTab = 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render()");

      const boardOpener = childDocument.querySelector('[data-open="handoff-board-item"]');
      if (!boardOpener) throw new Error("Board handoff fixture was not rendered");
      // Aboard board entries use the same direct handoff as native sidebar
      // rows. Rapid duplicate activation must still be coalesced.
      boardOpener.click();
      boardOpener.click();
      await waitFor(() => requestsFor(boardThreadId).length >= 1);
      await sleep(80);
      const boardRequests = requestsFor(boardThreadId);
      results.boardItem = {
        bridgeOnce: boardRequests.length === 1,
        validContract: validRequest(boardRequests[0], {
          id: boardThreadId,
          url: "codex://threads/" + boardThreadId,
          kind: "work",
          hostId: "local",
          title: "Aboard board handoff fixture"
        }),
        noIntermediateDetail: !childDocument.querySelector("[data-conversation-detail]"),
        boardRemainsInteractive: childDocument.querySelector("[data-board-view]")?.inert !== true,
        mountedNativeRowNotClicked: boardVisibleRowClicks === 0,
        noHostTaskRoute: routeMessages.length === 0,
        noExternalOpen: externalOpens.length === 0,
        dashboardRemainsVisible: surface.dataset.active === "true"
      };

      // Inline row controls (pin/archive/menu etc.) keep their native behavior
      // and must not be interpreted as requests to open the conversation.
      nativeWorkInlineButton.click();
      nativeChatInlineButton.click();
      await sleep(30);
      results.inlineActions = {
        workClicked: nativeWorkInlineClicks === 1,
        chatClicked: nativeChatInlineClicks === 1,
        noWorkHandoff: requestsFor(nativeWorkId).length === 0,
        noChatHandoff: requestsFor(nativeChatId).length === 0,
        notPreventedByCapture: nativeWorkRowClicks === 1 && nativeChatRowClicks === 1,
        dashboardRemainsVisible: surface.dataset.active === "true"
      };

      const workClickOne = dispatchRowClick(nativeWorkRow);
      const workClickTwo = dispatchRowClick(nativeWorkRow);
      await waitFor(() => requestsFor(nativeWorkId).length >= 1);
      await sleep(80);
      const nativeWorkRequests = requestsFor(nativeWorkId);
      results.nativeWork = {
        bridgeOnce: nativeWorkRequests.length === 1,
        validContract: validRequest(nativeWorkRequests[0], {
          id: nativeWorkId,
          url: "codex://threads/" + nativeWorkId,
          kind: "work",
          hostId: "local",
          title: "Aboard native Work handoff fixture"
        }),
        clicksIntercepted: workClickOne.defaultPrevented && workClickTwo.defaultPrevented,
        nativeRowNotActivated: nativeWorkRowClicks === 1,
        noHostTaskRoute: routeMessages.length === 0,
        dashboardRemainsVisible: surface.dataset.active === "true"
      };

      const chatClickOne = dispatchRowClick(nativeChatRow);
      const chatClickTwo = dispatchRowClick(nativeChatRow);
      await waitFor(() => requestsFor(nativeChatId).length >= 1);
      await sleep(80);
      const nativeChatRequests = requestsFor(nativeChatId);
      results.nativeChat = {
        bridgeOnce: nativeChatRequests.length === 1,
        validContract: validRequest(nativeChatRequests[0], {
          id: nativeChatId,
          url: "https://chatgpt.com/c/" + nativeChatId,
          kind: "chat",
          hostId: "",
          title: "Aboard native Chat handoff fixture"
        }),
        clicksIntercepted: chatClickOne.defaultPrevented && chatClickTwo.defaultPrevented,
        nativeRowNotActivated: nativeChatRowClicks === 1,
        noHostTaskRoute: routeMessages.length === 0,
        dashboardRemainsVisible: surface.dataset.active === "true"
      };

      results.allRequests = {
        count: bridgeRequests.length,
        onePerConversation: bridgeRequests.length === 3
          && requestsFor(boardThreadId).length === 1
          && requestsFor(nativeWorkId).length === 1
          && requestsFor(nativeChatId).length === 1,
        noHostTaskRoute: routeMessages.length === 0,
        noExternalOpen: externalOpens.length === 0
      };
      results.boardUnchangedBeforeRestore = child.eval("JSON.stringify(board)") === JSON.stringify(fixtureBoard);
    } catch (error) {
      results.error = String(error?.stack || error);
    } finally {
      try { history.replaceState(originalHistoryState, "", originalPath); } catch (_) {}
      if (originalHttpTestBridgeDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpTestBridgeDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      if (originalFetchDescriptor) Object.defineProperty(window, "fetch", originalFetchDescriptor);
      else delete window.fetch;
      if (originalPostMessageDescriptor) Object.defineProperty(window, "postMessage", originalPostMessageDescriptor);
      else delete window.postMessage;
      window.open = originalOpen;
      hideButton.remove();
      fixtureRoot.remove();

      child.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null");
      if (hadOriginalStorage) localStorage.setItem(storageKey, originalStorage);
      else localStorage.removeItem(storageKey);
      child.eval("board = JSON.parse(" + JSON.stringify(originalBoard) + "); const restoredUi = JSON.parse(" + JSON.stringify(originalUi) + "); activeTab = restoredUi.activeTab; query = restoredUi.query; modal = restoredUi.modal; floatingMenu = restoredUi.floatingMenu; internalDrag = null; render()");
      if (surface.dataset.active !== "true") entry.click();
      await waitFor(() => surface.dataset.active === "true");
    }

    results.restoration = {
      fetchRestored: window.fetch === originalFetch,
      postMessageRestored: window.postMessage === originalPostMessage,
      openRestored: window.open === originalOpen,
      fixturesRemoved: !document.getElementById(fixtureRoot.id) && !document.body.contains(hideButton),
      pathRestored: location.pathname + location.search + location.hash === originalPath,
      localStorageExact: hadOriginalStorage ? localStorage.getItem(storageKey) === originalStorage : localStorage.getItem(storageKey) === null,
      boardExact: child.eval("JSON.stringify(board)") === originalBoard,
      aboardVisible: surface.dataset.active === "true"
    };

    const required = [
      window.__conversationDashboardVersion >= 52,
      ...Object.values(results.neutralRoute || {}),
      ...Object.values(results.boardItem || {}),
      ...Object.values(results.inlineActions || {}),
      ...Object.values(results.nativeWork || {}),
      ...Object.values(results.nativeChat || {}),
      results.allRequests?.onePerConversation,
      results.allRequests?.noHostTaskRoute,
      results.allRequests?.noExternalOpen,
      results.boardUnchangedBeforeRestore,
      ...Object.values(results.restoration || {}),
      !results.error
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
socket.unref?.();
if (evaluation.result?.exceptionDetails) {
  console.error(JSON.stringify(evaluation.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  const result = evaluation.result?.result?.value;
  console.log(JSON.stringify(result, null, 2));
  if (!result?.ok) process.exitCode = 1;
}
