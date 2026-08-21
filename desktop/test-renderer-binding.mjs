#!/usr/bin/env node

const nodeDeadline = Date.now() + 10_000;
let page;
while (Date.now() < nodeDeadline) {
  try {
    const pages = await fetch("http://127.0.0.1:9237/json/list", {
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

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Binding probe timed out")), 6_000);
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message.result?.result?.value);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(async () => {
        const storageBefore = localStorage.getItem("conversation-dashboard-board-v1");
        const bindingName = window.__conversationDashboardBindingName;
        const binding = window[bindingName];
        if (!bindingName || typeof binding !== "function") {
          return { ok: false, reason: "renderer binding unavailable" };
        }
        const originalResolver = window.__conversationDashboardResolveBridge;
        const requestId = "binding-probe-" + Date.now().toString(36);
        let response;
        try {
          response = await new Promise(resolve => {
            const timeout = setTimeout(() => resolve({ ok: false, error: "renderer result timeout" }), 3_000);
            window.__conversationDashboardResolveBridge = (id, value) => {
              if (id !== requestId) {
                originalResolver?.(id, value);
                return;
              }
              clearTimeout(timeout);
              resolve(value || {});
            };
            binding(JSON.stringify({
              requestId,
              method: "handoff",
              payload: { id: "binding-probe-invalid", url: "file:///not-a-conversation" }
            }));
          });
        } finally {
          window.__conversationDashboardResolveBridge = originalResolver;
        }
        const storageAfter = localStorage.getItem("conversation-dashboard-board-v1");
        return {
          ok: response?.ok === false && /unsupported conversation link/i.test(String(response?.error || "")),
          rejectedUnsafeUrl: response?.ok === false,
          exactBindingName: /^__aboardNativeBridge_[0-9a-f]{24}$/.test(bindingName),
          boardUnchanged: storageBefore === storageAfter,
          dashboardActive: document.getElementById("conversation-dashboard-surface")?.dataset.active === "true"
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    }
  }));
});
socket.close();
const ok = Boolean(result?.ok && result?.rejectedUnsafeUrl && result?.exactBindingName
  && result?.boardUnchanged && result?.dashboardActive);
console.log(JSON.stringify({ ...result, ok }));
process.exit(ok ? 0 : 1);
