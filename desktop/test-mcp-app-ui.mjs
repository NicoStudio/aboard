#!/usr/bin/env node

// Black-box regression for the standalone MCP App UI. The harness supplies a
// fake window.openai.callTool, so this test can exercise every direct-open
// outcome without asking Launch Services to open a real conversation.

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
    const waitFor = async (read, timeoutMs = 2_000) => {
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
    const liveFrame = surface.querySelector("iframe");
    const liveWindow = liveFrame?.contentWindow;
    if (!liveWindow) return { ok: false, reason: "Aboard frame unavailable" };

    const originalStorage = localStorage.getItem(storageKey);
    const hadOriginalStorage = originalStorage !== null;
    const originalLiveBoard = liveWindow.eval("JSON.stringify(board)");
    const originalLiveUi = liveWindow.eval("JSON.stringify({ activeTab, query, modal, floatingMenu })");
    const originalHarnessDescriptor = Object.getOwnPropertyDescriptor(window, "__aboardMcpUiHarness");
    const originalDraggedThreadDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardDraggedThread");
    const originalDragSessionDescriptor = Object.getOwnPropertyDescriptor(window, "__conversationDashboardDragSession");
    const fixtureIds = {
      success: "22222222-2222-4222-8222-000000000101",
      isError: "22222222-2222-4222-8222-000000000102",
      okFalse: "22222222-2222-4222-8222-000000000103",
      structuredFalse: "22222222-2222-4222-8222-000000000104",
      rejected: "22222222-2222-4222-8222-000000000105",
      syncThrow: "22222222-2222-4222-8222-000000000106"
    };
    const fixture = {
      version: 2,
      defaultTab: "personal",
      chatSortBy: { professional: "manual", personal: "manual" },
      projects: [],
      items: Object.entries(fixtureIds).map(([outcome, id], index) => ({
        id: "mcp-ui-" + outcome,
        title: "MCP UI " + outcome,
        kind: "chat",
        topic: "personal",
        projectId: null,
        pinned: false,
        titleHidden: false,
        marker: "p2",
        runtimeStatus: "idle",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        manualOrder: index + 1,
        hostId: "",
        url: "https://chatgpt.com/c/" + id
      }))
    };
    const calls = [];
    const fallbackOpens = [];
    const displayRequests = [];
    const uncaughtErrors = [];
    const openCalls = () => calls.filter(call => call.name === "open_conversation");
    const saveCalls = () => calls.filter(call => call.name === "save_dashboard");
    const fakeOpenai = {
      toolOutput: { board: fixture },
      requestDisplayMode: request => { displayRequests.push(JSON.parse(JSON.stringify(request || {}))); },
      callTool(name, args) {
        calls.push({ name: String(name || ""), args: JSON.parse(JSON.stringify(args || {})) });
        if (name === "save_dashboard") return Promise.resolve({ structuredContent: { ok: true } });
        if (name !== "open_conversation") return Promise.resolve({ structuredContent: { ok: false } });
        if (args?.id === fixtureIds.success) return Promise.resolve({ structuredContent: { ok: true } });
        if (args?.id === fixtureIds.isError) return Promise.resolve({ isError: true, content: [{ type: "text", text: "fixture failure" }] });
        if (args?.id === fixtureIds.okFalse) return Promise.resolve({ ok: false });
        if (args?.id === fixtureIds.structuredFalse) return Promise.resolve({ structuredContent: { ok: false } });
        if (args?.id === fixtureIds.rejected) return Promise.reject(new Error("fixture rejected"));
        if (args?.id === fixtureIds.syncThrow) throw new Error("fixture synchronous throw");
        return Promise.resolve({ structuredContent: { ok: false } });
      }
    };
    Object.defineProperty(window, "__aboardMcpUiHarness", {
      configurable: true,
      value: { openai: fakeOpenai }
    });
    // The production dashboard deliberately falls back to these host globals
    // for native sidebar drags. Earlier installed drag tests may leave a stale
    // payload there; a plain text/uri-list fixture must not inherit it and be
    // misclassified as a native import.
    Object.defineProperty(window, "__conversationDashboardDraggedThread", {
      configurable: true,
      writable: true,
      value: null
    });
    Object.defineProperty(window, "__conversationDashboardDragSession", {
      configurable: true,
      writable: true,
      value: null
    });

    let testFrame = null;
    let ui = null;
    let doc = null;
    const results = {};
    try {
      // The installed Aboard frame is itself srcdoc, so there is no fetchable
      // URL. Its retained main script is the authoritative installed source.
      const source = liveFrame.contentDocument?.documentElement?.outerHTML || "";
      const bodyStart = source.indexOf("<body");
      const bodyTagEnd = bodyStart >= 0 ? source.indexOf(">", bodyStart) : -1;
      if (bodyTagEnd < 0 || !source.includes("function openItem")) throw new Error("Dashboard source marker was not found");
      const harnessScript = '<script>window.openai = parent.__aboardMcpUiHarness.openai;</scr' + 'ipt>';
      const standaloneSource = source.slice(0, bodyTagEnd + 1) + harnessScript + source.slice(bodyTagEnd + 1);
      testFrame = document.createElement("iframe");
      testFrame.id = "aboard-mcp-ui-regression-frame";
      testFrame.hidden = true;
      testFrame.srcdoc = standaloneSource;
      document.body.appendChild(testFrame);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP App UI fixture timed out")), 4_000);
        testFrame.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      ui = testFrame.contentWindow;
      doc = testFrame.contentDocument;
      await waitFor(() => {
        try { return ui.eval("typeof openItem === 'function' && document.querySelectorAll('[data-open]').length >= 6"); }
        catch (_) { return false; }
      }, 3_000);
      if (!ui || !doc || !ui.eval("typeof openItem === 'function'")) throw new Error("Standalone MCP App UI did not initialize");
      ui.open = (...args) => { fallbackOpens.push(args.map(value => String(value || ""))); return null; };
      ui.addEventListener("error", event => {
        uncaughtErrors.push(String(event.error?.message || event.message || "unknown"));
        event.preventDefault();
      });

      const clearToast = () => ui.eval("clearTimeout(toastTimer); toastTimer = null; const toast = document.getElementById('toast'); toast.classList.remove('show'); toast.textContent = ''");
      const toastState = () => {
        const toast = doc.getElementById("toast");
        return { visible: toast?.classList.contains("show") === true, text: toast?.textContent || "" };
      };
      const recoverFromForbiddenDetail = () => {
        if (!doc.querySelector("[data-conversation-detail]")) return;
        try { ui.eval("closeConversationDetail({ restoreFocus: false })"); } catch (_) {}
      };
      const exactPayload = (call, outcome) => call?.name === "open_conversation"
        && call?.args?.id === fixtureIds[outcome]
        && call?.args?.url === "https://chatgpt.com/c/" + fixtureIds[outcome]
        && call?.args?.kind === "chat"
        && call?.args?.hostId === ""
        && call?.args?.title === "MCP UI " + outcome;
      const activate = async (outcome, shouldFail) => {
        clearToast();
        const before = openCalls().length;
        const opener = doc.querySelector('[data-open="mcp-ui-' + outcome + '"]');
        opener?.click();
        await waitFor(() => openCalls().length > before);
        await sleep(80);
        const matching = openCalls().slice(before);
        const toast = toastState();
        const result = {
          openerFound: Boolean(opener),
          callToolExactlyOnce: matching.length === 1,
          exactPayload: exactPayload(matching[0], outcome),
          noIntermediateDetail: !doc.querySelector("[data-conversation-detail]"),
          successStaysQuiet: shouldFail || (!toast.visible && !toast.text),
          failureShowsToast: !shouldFail || (toast.visible && /无法|重试/.test(toast.text))
        };
        recoverFromForbiddenDetail();
        return result;
      };

      results.mode = {
        standaloneMcpMode: ui.eval("embeddedMode") === false,
        fixtureLoadedFromToolOutput: ui.eval("JSON.stringify(board)") === JSON.stringify(fixture),
        noRealFallbackCapability: typeof ui.openai?.openExternal === "undefined"
      };
      results.success = await activate("success", false);
      results.resolvedIsError = await activate("isError", true);
      results.resolvedOkFalse = await activate("okFalse", true);
      results.resolvedStructuredOkFalse = await activate("structuredFalse", true);
      results.promiseReject = await activate("rejected", true);
      results.synchronousThrow = await activate("syncThrow", true);

      recoverFromForbiddenDetail();
      clearToast();
      const fixtureBoardBeforeUnsupported = ui.eval("JSON.stringify(board)");
      const callsBeforeForm = calls.length;
      ui.eval("modal = { type: 'item', topic: 'personal' }; render()");
      const form = await waitFor(() => doc.getElementById("item-form"));
      const titleInput = form?.querySelector("#item-title");
      const urlInput = form?.querySelector("#item-url");
      if (titleInput) titleInput.value = "Unsupported form fixture";
      if (urlInput) urlInput.value = "https://example.com/c/22222222-2222-4222-8222-000000000201";
      form?.requestSubmit();
      await sleep(80);
      const formToast = toastState();
      results.unsupportedForm = {
        formFound: Boolean(form),
        rejectedInPlace: ui.eval("modal?.type === 'item'") && Boolean(doc.getElementById("item-form")),
        explicitValidityError: Boolean(urlInput?.validationMessage),
        explicitToast: formToast.visible && /无效|不支持|未保存/.test(formToast.text),
        boardUnchanged: ui.eval("JSON.stringify(board)") === fixtureBoardBeforeUnsupported,
        noToolCall: calls.length === callsBeforeForm
      };
      doc.querySelector("[data-close-modal]")?.click();
      await sleep(20);

      clearToast();
      const callsBeforeDrop = calls.length;
      const boardBeforeDrop = ui.eval("JSON.stringify(board)");
      const target = doc.querySelector('.chat-list[data-drop-kind="chat"]');
      const transfer = new ui.DataTransfer();
      transfer.setData("text/uri-list", "https://chatgpt.com.evil.test/c/22222222-2222-4222-8222-000000000202");
      let dropEvent;
      try { dropEvent = new ui.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }); }
      catch (_) {
        dropEvent = new ui.Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(dropEvent, "dataTransfer", { value: transfer });
      }
      target?.dispatchEvent(dropEvent);
      await sleep(80);
      const dropToast = toastState();
      results.unsupportedDrop = {
        targetFound: Boolean(target),
        dropHandled: dropEvent?.defaultPrevented === true,
        explicitToast: dropToast.visible && /仅支持|不支持|无效/.test(dropToast.text),
        editorNotOpened: ui.eval("modal === null") && !doc.getElementById("item-form"),
        boardUnchanged: ui.eval("JSON.stringify(board)") === boardBeforeDrop,
        noToolCall: calls.length === callsBeforeDrop
      };

      results.isolation = {
        openConversationCalls: openCalls().length === 6,
        noSaveCalls: saveCalls().length === 0,
        noFallbackWindowOpen: fallbackOpens.length === 0,
        noUncaughtErrors: uncaughtErrors.length === 0,
        isolatedFixtureBoardUnchanged: ui.eval("JSON.stringify(board)") === JSON.stringify(fixture)
      };
    } catch (error) {
      results.error = String(error?.stack || error);
    } finally {
      try { ui?.eval("clearTimeout(saveTimer); clearTimeout(toastTimer)"); } catch (_) {}
      testFrame?.remove();
      if (originalHarnessDescriptor) Object.defineProperty(window, "__aboardMcpUiHarness", originalHarnessDescriptor);
      else delete window.__aboardMcpUiHarness;
      if (originalDraggedThreadDescriptor) Object.defineProperty(window, "__conversationDashboardDraggedThread", originalDraggedThreadDescriptor);
      else delete window.__conversationDashboardDraggedThread;
      if (originalDragSessionDescriptor) Object.defineProperty(window, "__conversationDashboardDragSession", originalDragSessionDescriptor);
      else delete window.__conversationDashboardDragSession;
      // Metadata/save work from the surrounding installed-test sequence can
      // settle while this isolated iframe is running. Restore both persisted
      // and in-memory forms from their independent exact snapshots so the
      // regression is byte-for-byte neutral to the user's real board.
      try { liveWindow.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null"); } catch (_) {}
      if (hadOriginalStorage) localStorage.setItem(storageKey, originalStorage);
      else localStorage.removeItem(storageKey);
      try {
        const restoredUi = JSON.parse(originalLiveUi);
        liveWindow.eval("board = JSON.parse(" + JSON.stringify(originalLiveBoard) + "); activeTab = " + JSON.stringify(restoredUi.activeTab) + "; query = " + JSON.stringify(restoredUi.query) + "; modal = " + JSON.stringify(restoredUi.modal) + "; floatingMenu = " + JSON.stringify(restoredUi.floatingMenu) + "; internalDrag = null; render()");
      } catch (_) {}
    }

    results.restoration = {
      fixtureRemoved: !document.getElementById("aboard-mcp-ui-regression-frame"),
      harnessRestored: originalHarnessDescriptor
        ? Object.getOwnPropertyDescriptor(window, "__aboardMcpUiHarness")?.value === originalHarnessDescriptor.value
        : !("__aboardMcpUiHarness" in window),
      dragThreadGlobalRestored: originalDraggedThreadDescriptor
        ? Object.getOwnPropertyDescriptor(window, "__conversationDashboardDraggedThread")?.value === originalDraggedThreadDescriptor.value
        : !("__conversationDashboardDraggedThread" in window),
      dragSessionGlobalRestored: originalDragSessionDescriptor
        ? Object.getOwnPropertyDescriptor(window, "__conversationDashboardDragSession")?.value === originalDragSessionDescriptor.value
        : !("__conversationDashboardDragSession" in window),
      localStorageExactString: hadOriginalStorage ? localStorage.getItem(storageKey) === originalStorage : localStorage.getItem(storageKey) === null,
      boardExactString: liveWindow.eval("JSON.stringify(board)") === originalLiveBoard,
      aboardVisible: surface.dataset.active === "true"
    };
    const sections = [
      results.mode, results.success, results.resolvedIsError,
      results.resolvedOkFalse, results.resolvedStructuredOkFalse,
      results.promiseReject, results.synchronousThrow,
      results.unsupportedForm, results.unsupportedDrop,
      results.isolation, results.restoration
    ];
    const required = sections.flatMap(section => Object.values(section || {}));
    return { ok: required.every(Boolean) && !results.error, displayRequests: displayRequests.length, ...results };
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
