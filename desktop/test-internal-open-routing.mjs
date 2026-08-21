#!/usr/bin/env node

// Installed black-box regression for Aboard's in-window conversation routing.
// It uses synthetic conversation IDs and a mocked CDP binding, so it never
// opens or mutates a real native conversation.

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
        await sleep(25);
      }
      return null;
    };
    const storageKey = "conversation-dashboard-board-v1";
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    if (surface.dataset.active !== "true") entry.click();
    if (!await waitFor(() => surface.dataset.active === "true")) return { ok: false, reason: "Aboard did not open" };

    const originalStorage = localStorage.getItem(storageKey);
    const originalBindingName = window.__conversationDashboardBindingName;
    const originalBindingDescriptor = Object.getOwnPropertyDescriptor(window, originalBindingName);
    const originalHttpDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const originalRouteSinkDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardRouteTestSink");
    const calls = [];
    const routeMessages = [];
    const ids = {
      work: "11111111-1111-4111-8111-000000600101",
      claimed: "11111111-1111-4111-8111-000000600102",
      remote: "11111111-1111-4111-8111-000000600103",
      chat: "22222222-2222-4222-8222-000000600104",
      self: "11111111-1111-4111-8111-000000600105"
    };
    const fixture = {
      version: 2,
      defaultTab: "personal",
      chatSortBy: { professional: "manual", personal: "manual" },
      projects: [{ id: "inside-project", name: "Inside Aboard", accent: "#0B4F43", order: 1, sortBy: "manual" }],
      items: [
        { id: "inside-work", title: "Inside Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "local", url: "codex://threads/" + ids.work },
        { id: "inside-claimed", title: "Claimed Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 2, hostId: "local", url: "codex://threads/" + ids.claimed },
        { id: "inside-self", title: "Aboard-owned Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 3, hostId: "local", url: "codex://threads/" + ids.self },
        { id: "inside-remote", title: "Remote Work", kind: "work", topic: null, projectId: "inside-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 4, hostId: "remote:qa east/1", url: "codex://threads/" + ids.remote + "?hostId=remote%3Aqa%20east%2F1" },
        { id: "inside-chat", title: "Inside Chat", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "", url: "https://chatgpt.com/c/" + ids.chat }
      ]
    };
    const currentFrame = async () => waitFor(() => {
      const frame = document.querySelector("#conversation-dashboard-surface iframe");
      const child = frame?.contentWindow;
      try {
        if (!child || !child.eval("typeof openItem === 'function' && typeof render === 'function'")) return null;
      } catch (_) { return null; }
      return { frame, child, doc: frame.contentDocument };
    });
    const installFixture = async () => {
      const live = await currentFrame();
      if (!live) throw new Error("Aboard frame unavailable");
      localStorage.setItem(storageKey, JSON.stringify(fixture));
      live.child.eval("clearTimeout(saveTimer); saveTimer = null; board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'personal'; query = ''; modal = null; floatingMenu = null; render()");
      return live;
    };
    const clickItem = async itemId => {
      const live = await currentFrame();
      const opener = live?.doc?.querySelector('[data-open="' + itemId + '"]');
      if (!opener) throw new Error("Missing board opener " + itemId);
      opener.click();
    };
    const returnToBoard = async () => {
      const control = await waitFor(() => document.getElementById("conversation-dashboard-return")?.dataset.visible === "true"
        ? document.getElementById("conversation-dashboard-return") : null);
      if (!control) throw new Error("Return to Aboard control was not shown");
      control.click();
      if (!await waitFor(() => document.getElementById("conversation-dashboard-surface")?.dataset.active === "true"
        && (location.pathname === "/" || location.pathname === "/index.html"))) {
        throw new Error("Return to Aboard did not restore the board");
      }
      // The host router handles navigate-to-route asynchronously even though
      // the dashboard overlay becomes visible immediately. Let that neutral
      // route settle before the next synthetic conversation is opened.
      await sleep(350);
      return control;
    };

    const results = {};
    try {
      Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", {
        configurable: true, writable: true, value: false
      });
      Object.defineProperty(window, "__conversationDashboardRouteTestSink", {
        configurable: true,
        writable: true,
        value: path => routeMessages.push({ path: String(path || ""), replace: false })
      });
      Object.defineProperty(window, originalBindingName, {
        configurable: true,
        writable: true,
        value: raw => {
          const request = JSON.parse(String(raw || "{}"));
          calls.push(request);
          const id = String(request?.payload?.id || "");
          queueMicrotask(() => window.__conversationDashboardResolveBridge(request.requestId, {
            ok: true,
            value: {
              id,
              claimed: id === ids.claimed || id === ids.self,
              ownership: id === ids.self ? "self" : id === ids.claimed ? "other" : "none"
            }
          }));
        }
      });

      await installFixture();
      const routesBeforeWork = routeMessages.length;
      await clickItem("inside-work");
      const workOpened = await waitFor(() => surface.dataset.active === "false"
        && document.getElementById("conversation-dashboard-return")?.dataset.visible === "true");
      const workRoute = await waitFor(() => routeMessages.slice(routesBeforeWork).find(message => message.path.startsWith("/local/"))?.path);
      const workReturn = await returnToBoard();
      results.work = {
        openedInside: Boolean(workOpened),
        exactRoute: workRoute === "/local/" + ids.work,
        route: workRoute,
        availabilityCheckedOnce: calls.filter(call => call.method === "thread-availability" && call.payload?.id === ids.work).length === 1,
        returnControlAccessible: workReturn.getAttribute("aria-label") === "返回 Aboard",
        boardRestored: surface.dataset.active === "true"
      };

      await installFixture();
      const routesBeforeRemote = routeMessages.length;
      await clickItem("inside-remote");
      const remoteOpened = await waitFor(() => surface.dataset.active === "false"
        && document.getElementById("conversation-dashboard-return")?.dataset.visible === "true");
      const remoteRoute = await waitFor(() => routeMessages.slice(routesBeforeRemote).find(message => message.path.startsWith("/local/"))?.path);
      await returnToBoard();
      results.remote = {
        openedInside: Boolean(remoteOpened),
        exactRoute: remoteRoute === "/local/" + ids.remote + "?hostId=remote%3Aqa%20east%2F1",
        route: remoteRoute,
        availabilityCheckedOnce: calls.filter(call => call.method === "thread-availability" && call.payload?.id === ids.remote).length === 1
      };

      await installFixture();
      const availabilityCallsBeforeChat = calls.filter(call => call.method === "thread-availability").length;
      const routesBeforeChat = routeMessages.length;
      await clickItem("inside-chat");
      const chatOpened = await waitFor(() => surface.dataset.active === "false"
        && document.getElementById("conversation-dashboard-return")?.dataset.visible === "true");
      const chatRoute = await waitFor(() => routeMessages.slice(routesBeforeChat).find(message => message.path.startsWith("/work/conversation/"))?.path);
      await returnToBoard();
      results.chat = {
        openedInside: Boolean(chatOpened),
        exactRoute: chatRoute === "/work/conversation/" + ids.chat,
        route: chatRoute,
        skippedWriterProbe: calls.filter(call => call.method === "thread-availability").length === availabilityCallsBeforeChat,
        boardRestored: surface.dataset.active === "true"
      };

      await installFixture();
      const routesBeforeSelf = routeMessages.length;
      await clickItem("inside-self");
      const selfOpened = await waitFor(() => surface.dataset.active === "false"
        && document.getElementById("conversation-dashboard-return")?.dataset.visible === "true");
      const selfRoute = await waitFor(() => routeMessages.slice(routesBeforeSelf).find(message => message.path.startsWith("/local/"))?.path);
      await returnToBoard();
      results.selfOwned = {
        openedInside: Boolean(selfOpened),
        exactRoute: selfRoute === "/local/" + ids.self,
        availabilityCheckedOnce: calls.filter(call => call.method === "thread-availability" && call.payload?.id === ids.self).length === 1
      };

      const live = await installFixture();
      const beforeClaimedPath = location.pathname + location.search;
      await clickItem("inside-claimed");
      const conflictToast = await waitFor(() => {
        const toast = live.doc.getElementById("toast");
        return toast?.classList.contains("show") && toast.textContent.includes("另一个 Codex 窗口") ? toast.textContent : "";
      });
      results.claimed = {
        stayedOnBoard: surface.dataset.active === "true",
        routeUnchanged: location.pathname + location.search === beforeClaimedPath,
        clearMessage: Boolean(conflictToast),
        returnHidden: document.getElementById("conversation-dashboard-return")?.dataset.visible !== "true",
        availabilityCheckedOnce: calls.filter(call => call.method === "thread-availability" && call.payload?.id === ids.claimed).length === 1
      };
      results.noExternalHandoff = calls.every(call => call.method !== "handoff" && call.method !== "rename");
    } finally {
      document.getElementById("conversation-dashboard-return")?.click();
      await waitFor(() => (location.pathname === "/" || location.pathname === "/index.html")
        && document.getElementById("conversation-dashboard-surface")?.dataset.active === "true");
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
      const live = await currentFrame();
      if (live) {
        const originalBoardExpression = originalStorage === null
          ? "fallbackBoard"
          : "JSON.parse(" + JSON.stringify(originalStorage) + ")";
        live.child.eval("clearTimeout(saveTimer); saveTimer = null; board = normalizeBoard(" + originalBoardExpression + "); modal = null; floatingMenu = null; render()");
      }
      if (originalBindingDescriptor) Object.defineProperty(window, originalBindingName, originalBindingDescriptor);
      else delete window[originalBindingName];
      if (originalRouteSinkDescriptor) Object.defineProperty(window, "__conversationDashboardRouteTestSink", originalRouteSinkDescriptor);
      else delete window.__conversationDashboardRouteTestSink;
      if (originalHttpDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      await sleep(320);
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
    }
    results.restored = {
      storageExact: localStorage.getItem(storageKey) === originalStorage,
      boardVisible: document.getElementById("conversation-dashboard-surface")?.dataset.active === "true",
      returnHidden: document.getElementById("conversation-dashboard-return")?.dataset.visible !== "true"
    };
    return { ok: Object.values(results).every(value => typeof value === "boolean" ? value : Object.values(value).every(Boolean)), results };
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
