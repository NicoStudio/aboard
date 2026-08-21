#!/usr/bin/env node

// Installed black-box regression for Aboard's in-window conversation routing.
// Every ID and native row is synthetic. Route navigation and bridge ownership
// are intercepted, so this test never opens, resumes, or mutates a real task.

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
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
  await sleep(150);
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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} timed out`));
  }, 35_000);
  pending.set(id, message => {
    clearTimeout(timer);
    resolve(message);
  });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluation = await send("Runtime.evaluate", {
  expression: `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const waitFor = async (read, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await sleep(20);
      }
      return null;
    };
    const storageKey = "conversation-dashboard-board-v1";
    const pendingKey = "conversation-dashboard-pending-creation";
    const preservedRouteKey = "conversation-dashboard-preserved-overlay-route";
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    if (surface.dataset.active !== "true") entry.click();
    if (!await waitFor(() => surface.dataset.active === "true")) return { ok: false, reason: "Aboard did not open" };

    const frame = surface.querySelector("iframe");
    const child = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!child || !doc) return { ok: false, reason: "Aboard frame unavailable" };

    const originalStorage = localStorage.getItem(storageKey);
    const originalPending = localStorage.getItem(pendingKey);
    const originalPreservedRoute = sessionStorage.getItem(preservedRouteKey);
    const originalBoard = child.eval("JSON.stringify(board)");
    const originalUi = child.eval("JSON.stringify({ activeTab, query, modal, floatingMenu, lastOpenSignature, lastOpenAt })");
    const originalPath = location.pathname + location.search + location.hash;
    const originalHistoryState = history.state;
    const bindingName = window.__conversationDashboardBindingName;
    const originalBindingDescriptor = Object.getOwnPropertyDescriptor(window, bindingName);
    const originalHttpDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const originalRouteSinkDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardRouteTestSink");

    const ids = {
      current: "11111111-1111-4111-8111-000000660101",
      idle: "11111111-1111-4111-8111-000000660102",
      idleMounted: "11111111-1111-4111-8111-000000660103",
      selfMounted: "11111111-1111-4111-8111-000000660104",
      selfMissing: "11111111-1111-4111-8111-000000660105",
      other: "11111111-1111-4111-8111-000000660106",
      remote: "11111111-1111-4111-8111-000000660107",
      chat: "22222222-2222-4222-8222-000000660108",
      chatMounted: "22222222-2222-4222-8222-000000660109",
      invalid: "22222222-2222-4222-8222-000000660110",
      raceA: "11111111-1111-4111-8111-000000660111",
      raceB: "11111111-1111-4111-8111-000000660112",
      cancelled: "11111111-1111-4111-8111-000000660113",
      navigationFailure: "11111111-1111-4111-8111-000000660114",
      queryChat: "22222222-2222-4222-8222-000000660115",
      createCancelled: "11111111-1111-4111-8111-000000660116"
    };
    const fixture = {
      version: 2,
      defaultTab: "personal",
      chatSortBy: { professional: "manual", personal: "manual" },
      projects: [{ id: "inside-project", name: "Inside Aboard", accent: "#0B4F43", order: 1, sortBy: "manual" }],
      items: [
        { id: "inside-current", title: "Current Aboard Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "local", url: "codex://threads/" + ids.current },
        { id: "inside-idle", title: "Idle Aboard Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 2, hostId: "local", url: "codex://threads/" + ids.idle },
        { id: "inside-idle-mounted", title: "Mounted Idle Aboard Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 3, hostId: "local", url: "codex://threads/" + ids.idleMounted },
        { id: "inside-self-mounted", title: "Mounted Aboard Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p1", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 4, hostId: "local", url: "codex://threads/" + ids.selfMounted },
        { id: "inside-self-missing", title: "Unhydrated Aboard Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p1", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 5, hostId: "local", url: "codex://threads/" + ids.selfMissing },
        { id: "inside-other", title: "Official-owned Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p0", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 6, hostId: "local", url: "codex://threads/" + ids.other },
        { id: "inside-remote", title: "Remote Idle Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 7, hostId: "remote:qa east/1", url: "codex://threads/" + ids.remote + "?hostId=remote%3Aqa%20east%2F1" },
        { id: "inside-race-a", title: "Delayed Work A", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 8, hostId: "local", url: "codex://threads/" + ids.raceA },
        { id: "inside-race-b", title: "Delayed Work B", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 9, hostId: "local", url: "codex://threads/" + ids.raceB },
        { id: "inside-cancelled", title: "Cancelled Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 10, hostId: "local", url: "codex://threads/" + ids.cancelled },
        { id: "inside-navigation-failure", title: "Navigation Failure Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 11, hostId: "local", url: "codex://threads/" + ids.navigationFailure },
        { id: "inside-create-cancelled", title: "Create Cancels Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 12, hostId: "local", url: "codex://threads/" + ids.createCancelled },
        { id: "inside-chat", title: "Cloud Chat", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "", url: "https://chatgpt.com/c/" + ids.chat },
        { id: "inside-chat-mounted", title: "Mounted Cloud Chat", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 2, hostId: "", url: "https://chatgpt.com/c/" + ids.chatMounted },
        { id: "inside-query-chat", title: "Query Cloud Chat", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 3, hostId: "", url: "https://chatgpt.com/c/" + ids.queryChat + "?model=gpt-5&source=aboard" }
      ]
    };

    const calls = [];
    const internalRoutes = [];
    const hostNavigationMessages = [];
    const availability = new Map([
      [ids.idle, { claimed: false, ownership: "none" }],
      [ids.idleMounted, { claimed: false, ownership: "none" }],
      [ids.selfMounted, { claimed: true, ownership: "self" }],
      [ids.selfMissing, { claimed: true, ownership: "self" }],
      [ids.other, { claimed: true, ownership: "other" }],
      [ids.remote, { claimed: false, ownership: "none" }],
      [ids.raceA, { claimed: false, ownership: "none" }],
      [ids.raceB, { claimed: false, ownership: "none" }],
      [ids.cancelled, { claimed: false, ownership: "none" }],
      [ids.navigationFailure, { claimed: false, ownership: "none" }],
      [ids.createCancelled, { claimed: false, ownership: "none" }]
    ]);
    const deferredAvailabilityIds = new Set([ids.raceA, ids.raceB, ids.cancelled, ids.createCancelled]);
    const deferredAvailability = new Map();
    const resolveDeferredAvailability = id => {
      const request = deferredAvailability.get(id);
      if (!request) return false;
      deferredAvailability.delete(id);
      deferredAvailabilityIds.delete(id);
      const value = { id, ...(availability.get(id) || { claimed: true, ownership: "other" }) };
      window.__conversationDashboardResolveBridge(request.requestId, { ok: true, value });
      return true;
    };
    const navigationSpy = event => {
      if (event.source === window && event.data?.type === "navigate-to-route") {
        hostNavigationMessages.push({ path: String(event.data.path || ""), replace: event.data.replace === true });
      }
    };
    window.addEventListener("message", navigationSpy, true);

    const fixtureRoot = document.createElement("section");
    fixtureRoot.id = "aboard-internal-routing-fixtures";
    fixtureRoot.hidden = true;
    const composerRouteIdentity = document.createElement("div");
    fixtureRoot.appendChild(composerRouteIdentity);
    const mountedClicks = new Map();
    const addMountedWorkRow = (id, title) => {
      const row = document.createElement("div");
      row.setAttribute("data-app-action-sidebar-thread-row", "");
      row.setAttribute("role", "button");
      row.dataset.appActionSidebarThreadId = "local:" + id;
      row.dataset.appActionSidebarThreadHostId = "local";
      row.dataset.appActionSidebarThreadKind = "local";
      row.dataset.appActionSidebarThreadTitle = title;
      row.addEventListener("click", () => {
        mountedClicks.set(id, (mountedClicks.get(id) || 0) + 1);
        queueMicrotask(() => setPath("/local/" + id));
      });
      fixtureRoot.appendChild(row);
    };
    const addMountedChatRow = (id, title) => {
      const wrapper = document.createElement("div");
      wrapper.dataset.sidebarChatgptConversationKey = "chatgpt:conversation:" + id;
      const row = document.createElement("div");
      row.className = "sidebar-item";
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", title);
      row.addEventListener("click", () => {
        mountedClicks.set(id, (mountedClicks.get(id) || 0) + 1);
        queueMicrotask(() => setPath("/work/conversation/" + id));
      });
      wrapper.appendChild(row);
      fixtureRoot.appendChild(wrapper);
    };
    addMountedWorkRow(ids.idleMounted, "Mounted Idle Aboard Work");
    addMountedWorkRow(ids.selfMounted, "Mounted Aboard Work");
    addMountedChatRow(ids.chatMounted, "Mounted Cloud Chat");
    document.body.appendChild(fixtureRoot);

    const callsFor = (method, id = "") => calls.filter(call => call.method === method && (!id || call.payload?.id === id));
    const opener = itemId => doc.querySelector('[data-open="' + itemId + '"]');
    const toastText = () => doc.querySelector("#toast.show")?.textContent || "";
    const setPath = path => {
      history.replaceState({ aboardInternalRoutingTest: true }, "", path);
      const localId = String(path).match(new RegExp("^/local/([^?]+)"))?.[1] || "";
      const chatId = String(path).match(new RegExp("^/work/conversation/([^?]+)"))?.[1] || "";
      if (localId) composerRouteIdentity.dataset.aboveComposerConversationId = decodeURIComponent(localId);
      else if (chatId) composerRouteIdentity.dataset.aboveComposerConversationId = "chatgpt:" + decodeURIComponent(chatId);
      else delete composerRouteIdentity.dataset.aboveComposerConversationId;
    };
    let failedInternalRoute = "";
    const returnToBoard = async () => {
      const startedAt = performance.now();
      entry.click();
      const visible = await waitFor(() => surface.dataset.active === "true");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const reset = await waitFor(() => child.eval("lastOpenSignature === '' && lastOpenAt === 0"));
      return { visible: Boolean(visible), debounceReset: Boolean(reset), elapsed: performance.now() - startedAt };
    };

    const results = {};
    try {
      localStorage.setItem(storageKey, JSON.stringify(fixture));
      localStorage.removeItem(pendingKey);
      child.eval("clearTimeout(saveTimer); saveTimer = null; board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'personal'; query = ''; modal = null; floatingMenu = null; lastOpenSignature = ''; lastOpenAt = 0; render()");

      Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", {
        configurable: true,
        writable: true,
        value: false
      });
      Object.defineProperty(window, "__conversationDashboardRouteTestSink", {
        configurable: true,
        writable: true,
        value: path => {
          const nextPath = String(path || "");
          internalRoutes.push(nextPath);
          if (nextPath !== failedInternalRoute) queueMicrotask(() => setPath(nextPath));
        }
      });
      Object.defineProperty(window, bindingName, {
        configurable: true,
        writable: true,
        value: raw => {
          const request = JSON.parse(String(raw || "{}"));
          calls.push(request);
          if (request.method === "thread-availability" && deferredAvailabilityIds.has(request.payload?.id)) {
            deferredAvailability.set(request.payload.id, request);
            return;
          }
          const value = request.method === "thread-availability"
            ? { id: request.payload?.id, ...(availability.get(request.payload?.id) || { claimed: true, ownership: "other" }) }
            : request.method === "runtime-status" ? [] : true;
          queueMicrotask(() => window.__conversationDashboardResolveBridge(request.requestId, { ok: true, value }));
        }
      });

      // Aboard overlays the current native route. Re-entering the same running
      // Work must only reveal that route: zero navigation and zero lock probe.
      setPath("/local/" + ids.current);
      const preparedCurrentOverlay = await returnToBoard();
      const persistedOverlayToken = sessionStorage.getItem(preservedRouteKey);
      const currentRoutesBefore = internalRoutes.length;
      opener("inside-current")?.click();
      const currentFirstHidden = await waitFor(() => surface.dataset.active === "false");
      const signatureWasSet = child.eval("lastOpenSignature !== '' && lastOpenAt > 0");
      const currentPath = location.pathname + location.search;
      const navigationBeforeReturn = hostNavigationMessages.length;
      const returned = await returnToBoard();
      const pathAfterReturn = location.pathname + location.search;
      const reopenedAt = performance.now();
      opener("inside-current")?.click();
      const currentSecondHidden = await waitFor(() => surface.dataset.active === "false");
      const rapidRoundTrip = performance.now() - reopenedAt;
      results.currentRouteRoundTrip = {
        firstReveal: Boolean(currentFirstHidden),
        explicitOverlayPrepared: preparedCurrentOverlay.visible,
        overlayTokenPersisted: persistedOverlayToken === "work:" + ids.current,
        firstActivationRecorded: signatureWasSet,
        returnVisible: returned.visible,
        debounceResetOnReturn: returned.debounceReset,
        routePreservedByOverlay: currentPath === "/local/" + ids.current && pathAfterReturn === currentPath,
        noNeutralNavigation: hostNavigationMessages.length === navigationBeforeReturn,
        secondRevealUnder900ms: Boolean(currentSecondHidden) && rapidRoundTrip < 900,
        noInternalNavigate: internalRoutes.length === currentRoutesBefore,
        noAvailabilityProbe: callsFor("thread-availability", ids.current).length === 0
      };
      await returnToBoard();

      // A matching pathname left behind by the host is not proof that its
      // native view is reusable. Without the explicit overlay token (or a
      // matching mounted row), remain on the board instead of claiming success.
      setPath("/local/" + ids.idle);
      const bareCurrentRoutesBefore = internalRoutes.length;
      const bareCurrentCallsBefore = callsFor("thread-availability", ids.idle).length;
      opener("inside-idle")?.click();
      const bareCurrentToast = await waitFor(() => /旧路由|入口尚未恢复/.test(toastText()) ? toastText() : "");
      results.bareCurrentRoute = {
        stayedOnBoard: surface.dataset.active === "true",
        clearMessage: Boolean(bareCurrentToast),
        availabilityOnce: callsFor("thread-availability", ids.idle).length === bareCurrentCallsBefore + 1,
        noInternalNavigate: internalRoutes.length === bareCurrentRoutesBefore,
        routeUnchanged: location.pathname === "/local/" + ids.idle
      };
      await returnToBoard();

      // A board activation permits a new visit, while the unchanged 900ms
      // guard still coalesces a real double click on one visible board.
      setPath("/");
      const idleCallsBefore = callsFor("thread-availability", ids.idle).length;
      const idleRoutesBefore = internalRoutes.length;
      opener("inside-idle")?.click();
      opener("inside-idle")?.click();
      const idleRoute = await waitFor(() => internalRoutes[idleRoutesBefore]);
      await sleep(80);
      results.visibleBoardDoubleClick = {
        exactInternalRoute: idleRoute === "/local/" + ids.idle,
        emittedOnce: internalRoutes.length === idleRoutesBefore + 1,
        availabilityOnce: callsFor("thread-availability", ids.idle).length === idleCallsBefore + 1,
        boardHiddenAfterOpen: surface.dataset.active === "false"
      };
      setPath("/local/" + ids.idle);
      await returnToBoard();

      // Two ownership probes may resolve in the opposite order from the user's
      // clicks. Only the newest click may navigate or hide the board.
      setPath("/");
      const raceRoutesBefore = internalRoutes.length;
      opener("inside-race-a")?.click();
      const raceAWaiting = await waitFor(() => deferredAvailability.has(ids.raceA));
      opener("inside-race-b")?.click();
      const raceBWaiting = await waitFor(() => deferredAvailability.has(ids.raceB));
      const raceBResolved = resolveDeferredAvailability(ids.raceB);
      const raceBOpened = await waitFor(() =>
        surface.dataset.active === "false" && location.pathname === "/local/" + ids.raceB
      );
      const raceAResolved = resolveDeferredAvailability(ids.raceA);
      await sleep(100);
      const raceRoutes = internalRoutes.slice(raceRoutesBefore);
      results.outOfOrderOpen = {
        bothRequestsWaited: Boolean(raceAWaiting && raceBWaiting),
        bothRequestsResolved: raceAResolved && raceBResolved,
        newestOpened: Boolean(raceBOpened),
        onlyNewestNavigated: raceRoutes.length === 1 && raceRoutes[0] === "/local/" + ids.raceB,
        staleDidNotOverride: location.pathname === "/local/" + ids.raceB,
        availabilityOnceEach: callsFor("thread-availability", ids.raceA).length === 1
          && callsFor("thread-availability", ids.raceB).length === 1
      };
      await returnToBoard();

      // Clicking the Aboard entry while a probe is pending cancels that probe;
      // its late response must not reopen a conversation behind the user's back.
      setPath("/");
      const cancelRoutesBefore = internalRoutes.length;
      opener("inside-cancelled")?.click();
      const cancelWaiting = await waitFor(() => deferredAvailability.has(ids.cancelled));
      const cancelReturn = await returnToBoard();
      const cancelResolved = resolveDeferredAvailability(ids.cancelled);
      await sleep(100);
      results.returnCancelsOpen = {
        requestWaited: Boolean(cancelWaiting),
        requestResolved: cancelResolved,
        boardStayedVisible: cancelReturn.visible && surface.dataset.active === "true",
        noLateNavigation: internalRoutes.length === cancelRoutesBefore,
        routeUnchanged: location.pathname === "/",
        availabilityOnce: callsFor("thread-availability", ids.cancelled).length === 1
      };

      // Starting a new native conversation is also a newer user intent. Use an
      // inert pending marker so the create path stops before touching host UI,
      // then verify the older ownership response can no longer navigate.
      const createCancelRoutesBefore = internalRoutes.length;
      opener("inside-create-cancelled")?.click();
      const createCancelWaiting = await waitFor(() => deferredAvailability.has(ids.createCancelled));
      const syntheticCreation = {
        creationId: "internal-routing-create-cancel",
        startedAt: Date.now(),
        destination: { kind: "chat", topic: "personal", projectId: null }
      };
      localStorage.setItem(pendingKey, JSON.stringify(syntheticCreation));
      child.eval("window.parent.postMessage({ method: 'conversation-dashboard/create-native', destination: { kind: 'chat', topic: 'personal', projectId: null } }, '*')");
      const createIntentProcessed = await waitFor(() => /已有一条会话/.test(toastText()));
      child.eval("window.parent.postMessage(" + JSON.stringify({
        method: "conversation-dashboard/native-created-ack",
        startedAt: syntheticCreation.startedAt,
        creationId: syntheticCreation.creationId
      }) + ", '*')");
      const createCancelResolved = resolveDeferredAvailability(ids.createCancelled);
      await sleep(100);
      results.createCancelsOpen = {
        requestWaited: Boolean(createCancelWaiting),
        createIntentProcessed: Boolean(createIntentProcessed),
        requestResolved: createCancelResolved,
        pendingMarkerCleared: !localStorage.getItem(pendingKey),
        boardStayedVisible: surface.dataset.active === "true",
        noLateNavigation: internalRoutes.length === createCancelRoutesBefore,
        routeUnchanged: location.pathname === "/",
        availabilityOnce: callsFor("thread-availability", ids.createCancelled).length === 1
      };

      // A route message is not success by itself. If the host pathname never
      // reaches the target, Aboard must restore the board and explain the failure.
      setPath("/");
      const failedPath = "/local/" + ids.navigationFailure;
      failedInternalRoute = failedPath;
      const failureRoutesBefore = internalRoutes.length;
      opener("inside-navigation-failure")?.click();
      const navigationFailureToast = await waitFor(() =>
        /没有完成跳转|无法仅凭旧路由/.test(toastText()) ? toastText() : ""
      );
      results.navigationFailure = {
        attemptedExactRoute: internalRoutes[failureRoutesBefore] === failedPath,
        attemptedOnce: internalRoutes.length === failureRoutesBefore + 1,
        boardRestored: surface.dataset.active === "true",
        pathNotForged: location.pathname === "/",
        clearMessage: Boolean(navigationFailureToast)
      };
      failedInternalRoute = "";

      // An idle Work already mounted in the host sidebar should reuse that row
      // after the ownership check, preserving the host's existing store.
      setPath("/");
      const idleMountedRoutesBefore = internalRoutes.length;
      const idleMountedCallsBefore = callsFor("thread-availability", ids.idleMounted).length;
      opener("inside-idle-mounted")?.click();
      const idleMountedReused = await waitFor(() => mountedClicks.get(ids.idleMounted) === 1 && surface.dataset.active === "false");
      results.idleMounted = {
        reusedMountedRow: Boolean(idleMountedReused),
        availabilityOnce: callsFor("thread-availability", ids.idleMounted).length === idleMountedCallsBefore + 1,
        noInternalRoute: internalRoutes.length === idleMountedRoutesBefore,
        noHandoff: callsFor("handoff", ids.idleMounted).length === 0
      };
      await returnToBoard();

      // A self-owned background task must reuse its mounted native sidebar row
      // instead of dispatching another resume route.
      setPath("/");
      const selfRoutesBefore = internalRoutes.length;
      const selfCallsBefore = callsFor("thread-availability", ids.selfMounted).length;
      opener("inside-self-mounted")?.click();
      const mountedReused = await waitFor(() => mountedClicks.get(ids.selfMounted) === 1 && surface.dataset.active === "false");
      results.selfOwnedMounted = {
        reusedMountedRow: Boolean(mountedReused),
        availabilityOnce: callsFor("thread-availability", ids.selfMounted).length === selfCallsBefore + 1,
        noBlindResumeRoute: internalRoutes.length === selfRoutesBefore,
        noHandoff: callsFor("handoff", ids.selfMounted).length === 0
      };
      await returnToBoard();

      // If ownership is self but the native row is temporarily unmounted, stay
      // on the board instead of guessing a second resume.
      const missingRoutesBefore = internalRoutes.length;
      const missingCallsBefore = callsFor("thread-availability", ids.selfMissing).length;
      opener("inside-self-missing")?.click();
      const selfMissingToast = await waitFor(() => /正在 Aboard 中运行|入口尚未恢复/.test(toastText()) ? toastText() : "");
      results.selfOwnedUnhydrated = {
        stayedOnBoard: surface.dataset.active === "true",
        clearMessage: Boolean(selfMissingToast),
        availabilityOnce: callsFor("thread-availability", ids.selfMissing).length === missingCallsBefore + 1,
        noBlindResumeRoute: internalRoutes.length === missingRoutesBefore,
        noHandoff: callsFor("handoff", ids.selfMissing).length === 0
      };

      // Another Codex/ChatGPT process is the only blocked local case. It must never
      // trigger an automatic app handoff or a competing internal writer.
      const otherRoutesBefore = internalRoutes.length;
      const otherCallsBefore = callsFor("thread-availability", ids.other).length;
      opener("inside-other")?.click();
      const otherToast = await waitFor(() => new RegExp("另一个 Codex/ChatGPT 进程|完整退出占用它的客户端").test(toastText()) ? toastText() : "");
      results.officialOwned = {
        stayedOnBoard: surface.dataset.active === "true",
        clearMessage: Boolean(otherToast),
        availabilityOnce: callsFor("thread-availability", ids.other).length === otherCallsBefore + 1,
        noInternalRoute: internalRoutes.length === otherRoutesBefore,
        noHandoff: callsFor("handoff", ids.other).length === 0
      };

      // Cloud Chat never participates in the local Work writer lock and opens
      // through the native route in this same Aboard window.
      const chatAvailabilityBefore = callsFor("thread-availability").length;
      const chatRoutesBefore = internalRoutes.length;
      opener("inside-chat")?.click();
      const chatRoute = await waitFor(() => internalRoutes[chatRoutesBefore]);
      results.cloudChat = {
        exactInternalRoute: chatRoute === "/work/conversation/" + ids.chat,
        skippedWriterProbe: callsFor("thread-availability").length === chatAvailabilityBefore,
        boardHidden: surface.dataset.active === "false",
        noHandoff: callsFor("handoff", ids.chat).length === 0
      };
      setPath("/work/conversation/" + ids.chat);
      await returnToBoard();

      // Tracking/query parameters on an otherwise valid Chat URL are a public
      // URL concern. Internal routing intentionally keeps only the conversation ID.
      setPath("/");
      const queryChatAvailabilityBefore = callsFor("thread-availability").length;
      const queryChatRoutesBefore = internalRoutes.length;
      opener("inside-query-chat")?.click();
      const queryChatRoute = await waitFor(() => internalRoutes[queryChatRoutesBefore]);
      results.queryChat = {
        exactInternalRoute: queryChatRoute === "/work/conversation/" + ids.queryChat,
        queryIgnoredInternally: location.pathname === "/work/conversation/" + ids.queryChat && !location.search,
        skippedWriterProbe: callsFor("thread-availability").length === queryChatAvailabilityBefore,
        boardHidden: surface.dataset.active === "false"
      };
      await returnToBoard();

      // A mounted cloud Chat also reuses the native sidebar row immediately;
      // Chat never needs the Work ownership bridge.
      setPath("/");
      const chatMountedAvailabilityBefore = callsFor("thread-availability").length;
      const chatMountedRoutesBefore = internalRoutes.length;
      opener("inside-chat-mounted")?.click();
      const chatMountedReused = await waitFor(() => mountedClicks.get(ids.chatMounted) === 1 && surface.dataset.active === "false");
      results.chatMounted = {
        reusedMountedRow: Boolean(chatMountedReused),
        skippedWriterProbe: callsFor("thread-availability").length === chatMountedAvailabilityBefore,
        noInternalRoute: internalRoutes.length === chatMountedRoutesBefore,
        noHandoff: callsFor("handoff", ids.chatMounted).length === 0
      };
      await returnToBoard();

      // Strict routing preserves the encoded host exactly for an idle remote
      // Work and still rejects fragments before any navigation.
      setPath("/");
      const remoteRoutesBefore = internalRoutes.length;
      opener("inside-remote")?.click();
      const remoteRoute = await waitFor(() => internalRoutes[remoteRoutesBefore]);
      results.remoteWork = {
        exactEncodedRoute: remoteRoute === "/local/" + ids.remote + "?hostId=remote%3Aqa%20east%2F1",
        availabilityOnce: callsFor("thread-availability", ids.remote).length === 1,
        noHandoff: callsFor("handoff", ids.remote).length === 0
      };
      setPath("/local/" + ids.remote + "?hostId=remote%3Aqa%20east%2F1");
      await returnToBoard();

      const invalidRoutesBefore = internalRoutes.length;
      const invalidCallsBefore = callsFor("thread-availability").length;
      child.eval("window.parent.postMessage(" + JSON.stringify({
        method: "conversation-dashboard/open-native",
        payload: {
          id: ids.invalid,
          url: "https://chatgpt.com/c/" + ids.invalid + "#forbidden-fragment",
          kind: "chat",
          hostId: "",
          title: "Invalid fragment Chat"
        }
      }) + ", '*')");
      const invalidToast = await waitFor(() => /链接格式无效|重新绑定/.test(toastText()) ? toastText() : "");
      results.strictInvalidRoute = {
        stayedOnBoard: surface.dataset.active === "true",
        clearMessage: Boolean(invalidToast),
        noRoute: internalRoutes.length === invalidRoutesBefore,
        noAvailabilityProbe: callsFor("thread-availability").length === invalidCallsBefore,
        noHandoff: callsFor("handoff", ids.invalid).length === 0
      };

      results.globalContract = {
        noHandoffAtAll: callsFor("handoff").length === 0,
        noFloatingReturn: !document.getElementById("conversation-dashboard-return"),
        explicitReturnsNeverNeutralized: hostNavigationMessages.length === 0,
        fixtureStorageUnchanged: localStorage.getItem(storageKey) === JSON.stringify(fixture)
      };
    } catch (error) {
      results.error = String(error?.stack || error);
    } finally {
      window.removeEventListener("message", navigationSpy, true);
      if (originalBindingDescriptor) Object.defineProperty(window, bindingName, originalBindingDescriptor);
      else delete window[bindingName];
      if (originalRouteSinkDescriptor) Object.defineProperty(window, "__conversationDashboardRouteTestSink", originalRouteSinkDescriptor);
      else delete window.__conversationDashboardRouteTestSink;
      if (originalHttpDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      fixtureRoot.remove();
      try { history.replaceState(originalHistoryState, "", originalPath); } catch {}
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
      if (originalPending === null) localStorage.removeItem(pendingKey);
      else localStorage.setItem(pendingKey, originalPending);
      const restoredUi = JSON.parse(originalUi);
      child.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null; board = JSON.parse(" + JSON.stringify(originalBoard) + "); activeTab = " + JSON.stringify(restoredUi.activeTab) + "; query = " + JSON.stringify(restoredUi.query) + "; modal = " + JSON.stringify(restoredUi.modal) + "; floatingMenu = " + JSON.stringify(restoredUi.floatingMenu) + "; lastOpenSignature = " + JSON.stringify(restoredUi.lastOpenSignature) + "; lastOpenAt = " + Number(restoredUi.lastOpenAt || 0) + "; internalDrag = null; render()");
      if (surface.dataset.active !== "true") entry.click();
      await waitFor(() => surface.dataset.active === "true");
      await sleep(320);
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
      if (originalPending === null) localStorage.removeItem(pendingKey);
      else localStorage.setItem(pendingKey, originalPending);
      if (originalPreservedRoute === null) sessionStorage.removeItem(preservedRouteKey);
      else sessionStorage.setItem(preservedRouteKey, originalPreservedRoute);
    }

    results.restoration = {
      localStorageExact: localStorage.getItem(storageKey) === originalStorage,
      pendingCreationExact: localStorage.getItem(pendingKey) === originalPending,
      preservedRouteExact: sessionStorage.getItem(preservedRouteKey) === originalPreservedRoute,
      boardExact: child.eval("JSON.stringify(board)") === originalBoard,
      pathExact: location.pathname + location.search + location.hash === originalPath,
      fixturesRemoved: !document.getElementById("aboard-internal-routing-fixtures"),
      aboardVisible: surface.dataset.active === "true"
    };
    const sections = [
      results.currentRouteRoundTrip,
      results.bareCurrentRoute,
      results.visibleBoardDoubleClick,
      results.outOfOrderOpen,
      results.returnCancelsOpen,
      results.createCancelsOpen,
      results.navigationFailure,
      results.idleMounted,
      results.selfOwnedMounted,
      results.selfOwnedUnhydrated,
      results.officialOwned,
      results.cloudChat,
      results.queryChat,
      results.chatMounted,
      results.remoteWork,
      results.strictInvalidRoute,
      results.globalContract,
      results.restoration
    ];
    return {
      ok: sections.flatMap(section => Object.values(section || {})).every(Boolean) && !results.error,
      ...results
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

try { socket.close(); } catch {}
const exception = evaluation?.result?.exceptionDetails;
const result = exception
  ? { ok: false, error: exception.exception?.description || exception.text || "Internal routing evaluation failed" }
  : evaluation?.result?.result?.value;
console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
