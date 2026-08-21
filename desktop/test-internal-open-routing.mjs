#!/usr/bin/env node

// Installed black-box regression for Aboard's direct-open contract. Every
// board item must be handed to the official client, even when it is already
// running. The synthetic CDP binding prevents any real conversation opening.

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
    const bindingName = window.__conversationDashboardBindingName;
    const originalBindingDescriptor = Object.getOwnPropertyDescriptor(window, bindingName);
    const originalHttpDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardUseHttpTestBridge");
    const originalRouteSinkDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardRouteTestSink");
    const calls = [];
    const routeMessages = [];
    const ids = {
      idle: "11111111-1111-4111-8111-000000650101",
      active: "11111111-1111-4111-8111-000000650102",
      chat: "22222222-2222-4222-8222-000000650103",
      hidden: "22222222-2222-4222-8222-000000650104"
    };
    const fixture = {
      version: 2,
      defaultTab: "personal",
      chatSortBy: { professional: "manual", personal: "manual" },
      projects: [{ id: "direct-project", name: "Direct open", accent: "#0B4F43", order: 1, sortBy: "manual" }],
      items: [
        { id: "idle-work", title: "Idle Work", kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "local", url: "codex://threads/" + ids.idle },
        { id: "active-work", title: "Active Work", kind: "work", topic: null, projectId: "direct-project", pinned: false, titleHidden: false, marker: "p1", runtimeStatus: "active", progress: 58, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 2, hostId: "local", url: "codex://threads/" + ids.active },
        { id: "active-chat", title: "Active Chat", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "active", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 1, hostId: "", url: "https://chatgpt.com/c/" + ids.chat },
        { id: "hidden-chat", title: "Synthetic private title", kind: "chat", topic: "personal", projectId: null, pinned: false, titleHidden: true, marker: "p2", runtimeStatus: "idle", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", manualOrder: 2, hostId: "", url: "https://chatgpt.com/c/" + ids.hidden }
      ]
    };
    const currentFrame = async () => waitFor(() => {
      const frame = document.querySelector("#conversation-dashboard-surface iframe");
      const child = frame?.contentWindow;
      try {
        if (!child || !child.eval("typeof render === 'function'")) return null;
      } catch (_) { return null; }
      return { child, doc: frame.contentDocument };
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
      if (!opener) throw new Error("Missing synthetic board opener");
      opener.click();
    };
    const handoffs = () => calls.filter(call => call.method === "handoff");

    const results = {};
    try {
      Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", {
        configurable: true, writable: true, value: false
      });
      Object.defineProperty(window, "__conversationDashboardRouteTestSink", {
        configurable: true, writable: true, value: path => routeMessages.push(String(path || ""))
      });
      Object.defineProperty(window, bindingName, {
        configurable: true,
        writable: true,
        value: raw => {
          const request = JSON.parse(String(raw || "{}"));
          calls.push(request);
          queueMicrotask(() => window.__conversationDashboardResolveBridge(request.requestId, { ok: true, value: true }));
        }
      });

      await installFixture();
      await clickItem("idle-work");
      await waitFor(() => handoffs().some(call => call.payload?.id === ids.idle));
      await clickItem("active-work");
      await waitFor(() => handoffs().some(call => call.payload?.id === ids.active));
      await clickItem("active-chat");
      await waitFor(() => handoffs().some(call => call.payload?.id === ids.chat));
      await clickItem("hidden-chat");
      await waitFor(() => handoffs().some(call => call.payload?.id === ids.hidden));

      const activeFirstCount = handoffs().filter(call => call.payload?.id === ids.active).length;
      await sleep(950);
      await clickItem("active-work");
      await waitFor(() => handoffs().filter(call => call.payload?.id === ids.active).length === activeFirstCount + 1);

      results.allKindsHandedOff = [ids.idle, ids.active, ids.chat, ids.hidden]
        .every(id => handoffs().some(call => call.payload?.id === id));
      results.activeConversationReopens = handoffs().filter(call => call.payload?.id === ids.active).length === 2;
      results.boardStaysAvailable = surface.dataset.active === "true";
      results.noInternalRoute = routeMessages.length === 0;
      results.noWriterGate = calls.every(call => call.method !== "thread-availability");
      results.noFloatingReturn = !document.getElementById("conversation-dashboard-return");
      results.hiddenTitleProtected = handoffs().find(call => call.payload?.id === ids.hidden)?.payload?.title === "";
    } finally {
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
      const live = await currentFrame();
      if (live) {
        const originalBoardExpression = originalStorage === null
          ? "fallbackBoard"
          : "JSON.parse(" + JSON.stringify(originalStorage) + ")";
        live.child.eval("clearTimeout(saveTimer); saveTimer = null; board = normalizeBoard(" + originalBoardExpression + "); modal = null; floatingMenu = null; render()");
      }
      if (originalBindingDescriptor) Object.defineProperty(window, bindingName, originalBindingDescriptor);
      else delete window[bindingName];
      if (originalRouteSinkDescriptor) Object.defineProperty(window, "__conversationDashboardRouteTestSink", originalRouteSinkDescriptor);
      else delete window.__conversationDashboardRouteTestSink;
      if (originalHttpDescriptor) Object.defineProperty(window, "__conversationDashboardUseHttpTestBridge", originalHttpDescriptor);
      else delete window.__conversationDashboardUseHttpTestBridge;
      await sleep(320);
      if (originalStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, originalStorage);
    }
    results.storageExact = localStorage.getItem(storageKey) === originalStorage;
    return { ok: Object.values(results).every(Boolean), results };
  })()`,
  awaitPromise: true,
  returnByValue: true
});

try { socket.close(); } catch {}
const exception = evaluation?.result?.exceptionDetails;
const result = exception
  ? { ok: false, error: exception.exception?.description || exception.text || "Direct-open evaluation failed" }
  : evaluation?.result?.result?.value;
console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
