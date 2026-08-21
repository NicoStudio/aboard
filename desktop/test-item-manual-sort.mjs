#!/usr/bin/env node

const storageKey = "conversation-dashboard-board-v1";
const fixture = {
  version: 2,
  defaultTab: "professional",
  chatSortBy: { professional: "updated", personal: "updated" },
  projects: [
    { id: "manual-sort-project", name: "Manual Sort Project", accent: "#315CF5", order: 1, sortBy: "updated" },
    { id: "classification-project", name: "Classification Project", accent: "#5977d9", order: 2, sortBy: "updated" }
  ],
  items: [
    { id: "chat-pinned", title: "Pinned Chat", kind: "chat", topic: "professional", pinned: true, marker: "p2", manualOrder: 99, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", url: "https://chatgpt.com/c/chat-pinned" },
    { id: "chat-new", title: "New Chat", kind: "chat", topic: "professional", pinned: false, marker: "p2", manualOrder: 1, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", url: "https://chatgpt.com/c/chat-new" },
    { id: "chat-old", title: "Old Chat", kind: "chat", topic: "professional", pinned: false, marker: "p2", manualOrder: 2, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2023-01-01T00:00:00.000Z", url: "https://chatgpt.com/c/chat-old" },
    { id: "chat-personal", title: "Personal Chat", kind: "chat", topic: "personal", pinned: false, marker: "p2", manualOrder: 1, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2023-01-01T00:00:00.000Z", url: "https://chatgpt.com/c/chat-personal" },
    { id: "work-pinned", title: "Pinned Work", kind: "work", projectId: "manual-sort-project", pinned: true, marker: "p2", manualOrder: 99, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z", url: "codex://threads/work-pinned" },
    { id: "work-new", title: "New Work", kind: "work", projectId: "manual-sort-project", pinned: false, marker: "p2", manualOrder: 1, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", url: "codex://threads/work-new" },
    { id: "work-old", title: "Old Work", kind: "work", projectId: "manual-sort-project", pinned: false, marker: "p2", manualOrder: 2, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2023-01-01T00:00:00.000Z", url: "codex://threads/work-old" },
    { id: "work-classification", title: "Classification Work", kind: "work", projectId: "classification-project", pinned: false, marker: "p2", manualOrder: 1, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2023-01-01T00:00:00.000Z", url: "codex://threads/work-classification" }
  ]
};

const pages = await fetch("http://127.0.0.1:9237/json/list").then(response => response.json());
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
  if (callback) {
    pending.delete(message.id);
    callback(message);
  }
});
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    document.getElementById("conversation-dashboard-sidebar-entry")?.click();
    await new Promise(resolve => setTimeout(resolve, 120));
    const frame = document.querySelector("#conversation-dashboard-surface iframe");
    if (!frame?.contentWindow || !frame?.contentDocument) throw new Error("Aboard iframe not found");
    const child = frame.contentWindow;
    const doc = frame.contentDocument;
    const key = ${JSON.stringify(storageKey)};
    const fixture = ${JSON.stringify(fixture)};
    const original = localStorage.getItem(key);
    const hadOriginal = original !== null;
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const result = {};

    const setFixture = () => {
      localStorage.setItem(key, JSON.stringify(fixture));
      child.eval("clearTimeout(saveTimer); saveTimer = null");
      child.eval("board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'professional'; query = ''; floatingMenu = null; internalDrag = null; render()");
    };

    const dispatchDrag = (element, type, transfer, clientY = 0) => element.dispatchEvent(new child.DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientY
    }));

    const feedbackState = (scope, row = null) => {
      const indicator = doc.getElementById("internal-insertion-indicator");
      const indicatorRect = indicator?.getBoundingClientRect();
      return {
        scopeActive: Boolean(scope?.classList.contains("is-drop-active")),
        scopeInvalid: Boolean(scope?.classList.contains("is-drop-invalid")),
        targetBefore: Boolean(row?.classList.contains("is-insert-before")),
        targetAfter: Boolean(row?.classList.contains("is-insert-after")),
        insertionCount: doc.querySelectorAll(".is-insert-before, .is-insert-after").length,
        indicatorVisible: Boolean(indicator?.classList.contains("show")),
        indicatorPlacement: indicator?.dataset.placement || "",
        indicatorTarget: indicator?.dataset.targetItem || "",
        indicatorWidth: indicatorRect?.width || 0
      };
    };

    const dragAfter = async (sourceId, targetId) => {
      const source = doc.querySelector('[data-drag-item="' + sourceId + '"]');
      const target = doc.querySelector('[data-drag-item="' + targetId + '"]');
      if (!source || !target) throw new Error("Missing drag fixture rows: " + sourceId + " -> " + targetId);
      const transfer = new child.DataTransfer();
      const rect = target.getBoundingClientRect();
      const afterY = rect.bottom - 1;
      dispatchDrag(source, "dragstart", transfer, source.getBoundingClientRect().top + 1);
      dispatchDrag(target, "dragenter", transfer, afterY);
      dispatchDrag(target, "dragover", transfer, afterY);
      const feedback = feedbackState(target.closest("[data-drop-kind]"), target);
      dispatchDrag(target, "drop", transfer, afterY);
      dispatchDrag(source, "dragend", transfer, afterY);
      await wait(340);
      return feedback;
    };

    const hoverClassificationScope = (sourceId, targetSelector, targetRowId) => {
      const source = doc.querySelector('[data-drag-item="' + sourceId + '"]');
      const target = doc.querySelector(targetSelector);
      const targetRow = targetRowId ? target.querySelector('[data-drag-item="' + targetRowId + '"]') : null;
      if (!source || !target || (targetRowId && !targetRow)) throw new Error("Missing classification fixture: " + sourceId + " -> " + targetSelector);
      const transfer = new child.DataTransfer();
      const hoverTarget = targetRow || target;
      const targetRect = hoverTarget.getBoundingClientRect();
      const clientY = targetRow ? targetRect.bottom - 1 : targetRect.top + Math.min(12, targetRect.height / 2);
      dispatchDrag(source, "dragstart", transfer, source.getBoundingClientRect().top + 1);
      dispatchDrag(hoverTarget, "dragenter", transfer, clientY);
      dispatchDrag(hoverTarget, "dragover", transfer, clientY);
      const feedback = feedbackState(target.closest("[data-drop-kind]"), targetRow);
      dispatchDrag(source, "dragend", transfer, clientY);
      child.eval("internalDrag = null; clearInternalDragStyles(); setDragGuide(false)");
      return feedback;
    };

    const hoverScopeBlank = (sourceId, scopeSelector, targetRowId) => {
      const source = doc.querySelector('[data-drag-item="' + sourceId + '"]');
      const scope = doc.querySelector(scopeSelector);
      const container = scope?.matches(".chat-list") ? scope : scope?.querySelector(".project-items");
      const targetRow = container?.querySelector('[data-drag-item="' + targetRowId + '"]');
      if (!source || !scope || !container || !targetRow) throw new Error("Missing blank-area fixture: " + sourceId + " -> " + scopeSelector);
      const transfer = new child.DataTransfer();
      const clientY = targetRow.getBoundingClientRect().bottom - 1;
      dispatchDrag(source, "dragstart", transfer, source.getBoundingClientRect().top + 1);
      dispatchDrag(container, "dragenter", transfer, clientY);
      dispatchDrag(container, "dragover", transfer, clientY);
      const feedback = feedbackState(scope, targetRow);
      dispatchDrag(source, "dragend", transfer, clientY);
      child.eval("internalDrag = null; clearInternalDragStyles(); setDragGuide(false)");
      return feedback;
    };

    try {
      setFixture();

      doc.querySelector('[data-chat-sort-menu="professional"]')?.click();
      result.chatMenu = [...doc.querySelectorAll("[data-set-sort]")].map(element => element.textContent.trim());
      child.eval("floatingMenu = null; render()");
      doc.querySelector('[data-sort-menu="manual-sort-project"]')?.click();
      result.workMenu = [...doc.querySelectorAll("[data-set-sort]")].map(element => element.textContent.trim());
      child.eval("floatingMenu = null; render()");

      result.chatFeedback = await dragAfter("chat-new", "chat-old");
      result.chat = child.eval("({ sortBy: board.chatSortBy.professional, order: sortItems(board.items.filter(item => item.kind === 'chat' && item.topic === 'professional'), 'manual').map(item => item.id) })");

      result.workFeedback = await dragAfter("work-new", "work-old");
      result.work = child.eval("({ sortBy: board.projects.find(project => project.id === 'manual-sort-project')?.sortBy, order: sortItems(board.items.filter(item => item.kind === 'work' && item.projectId === 'manual-sort-project'), 'manual').map(item => item.id) })");

      result.chatClassificationFeedback = hoverClassificationScope("chat-new", '[data-tab="personal"]');
      result.workClassificationFeedback = hoverClassificationScope("work-new", '[data-project-id="classification-project"]', "work-classification");
      result.chatBlankFeedback = hoverScopeBlank("chat-new", ".chat-list", "chat-old");
      result.workBlankFeedback = hoverScopeBlank("work-new", '[data-project-id="manual-sort-project"]', "work-old");

      const stored = JSON.parse(localStorage.getItem(key));
      result.persisted = {
        chatSortBy: stored.chatSortBy?.professional,
        workSortBy: stored.projects?.find(project => project.id === "manual-sort-project")?.sortBy,
        chatOrder: stored.items?.filter(item => item.kind === "chat" && item.topic === "professional").sort((a, b) => Number(a.manualOrder) - Number(b.manualOrder)).map(item => item.id),
        workOrder: stored.items?.filter(item => item.kind === "work" && item.projectId === "manual-sort-project").sort((a, b) => Number(a.manualOrder) - Number(b.manualOrder)).map(item => item.id)
      };

      result.pinnedFirst = child.eval("Object.fromEntries(['manual', 'updated', 'created-desc', 'created-asc', 'importance'].map(sortBy => [sortBy, sortItems(board.items.filter(item => item.kind === 'chat' && item.topic === 'professional'), sortBy)[0]?.id]))");

      result.created = child.eval("({ descending: sortItems(board.items.filter(item => ['chat-new', 'chat-old'].includes(item.id)), 'created-desc').map(item => item.id), ascending: sortItems(board.items.filter(item => ['chat-new', 'chat-old'].includes(item.id)), 'created-asc').map(item => item.id) })");

      result.migration = child.eval("(() => { const migrated = normalizeBoard({ version: 1, defaultTab: 'professional', chatSortBy: { professional: 'created', personal: 'updated' }, projects: [{ id: 'legacy', name: 'Legacy', sortBy: 'created' }], items: [] }); return { chat: migrated.chatSortBy.professional, work: migrated.projects[0].sortBy }; })()");

      const expectedMenu = ["手动排序", "最近更新", "创建时间倒序", "创建时间正序", "重要性"];
      const pinnedModes = Object.values(result.pinnedFirst || {});
      const insertionOnly = feedback => !feedback?.scopeActive
        && !feedback?.scopeInvalid
        && !feedback?.targetBefore
        && feedback?.targetAfter
        && feedback?.insertionCount === 1
        && feedback?.indicatorVisible
        && feedback?.indicatorPlacement === "after"
        && feedback?.indicatorWidth > 20;
      const classificationTab = feedback => !feedback?.scopeActive
        && !feedback?.scopeInvalid
        && feedback?.insertionCount === 0
        && feedback?.indicatorVisible
        && feedback?.indicatorPlacement === "tab"
        && feedback?.indicatorWidth > 20;
      const classificationInsertion = feedback => !feedback?.scopeActive
        && !feedback?.scopeInvalid
        && !feedback?.targetBefore
        && feedback?.targetAfter
        && feedback?.insertionCount === 1
        && feedback?.indicatorVisible
        && feedback?.indicatorPlacement === "after"
        && feedback?.indicatorWidth > 20;
      result.ok = JSON.stringify(result.chatMenu) === JSON.stringify(expectedMenu)
        && JSON.stringify(result.workMenu) === JSON.stringify(expectedMenu)
        && insertionOnly(result.chatFeedback)
        && insertionOnly(result.workFeedback)
        && classificationTab(result.chatClassificationFeedback)
        && classificationInsertion(result.workClassificationFeedback)
        && insertionOnly(result.chatBlankFeedback)
        && insertionOnly(result.workBlankFeedback)
        && result.chat?.sortBy === "manual"
        && JSON.stringify(result.chat?.order) === JSON.stringify(["chat-pinned", "chat-old", "chat-new"])
        && result.work?.sortBy === "manual"
        && JSON.stringify(result.work?.order) === JSON.stringify(["work-pinned", "work-old", "work-new"])
        && result.persisted?.chatSortBy === "manual"
        && result.persisted?.workSortBy === "manual"
        && JSON.stringify(result.persisted?.chatOrder) === JSON.stringify(["chat-pinned", "chat-old", "chat-new"])
        && JSON.stringify(result.persisted?.workOrder) === JSON.stringify(["work-pinned", "work-old", "work-new"])
        && pinnedModes.length === 5
        && pinnedModes.every(id => id === "chat-pinned")
        && JSON.stringify(result.created?.descending) === JSON.stringify(["chat-new", "chat-old"])
        && JSON.stringify(result.created?.ascending) === JSON.stringify(["chat-old", "chat-new"])
        && result.migration?.chat === "created-asc"
        && result.migration?.work === "created-asc";
    } finally {
      child.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null; document.getElementById('toast')?.classList.remove('show')");
      if (hadOriginal) localStorage.setItem(key, original);
      else localStorage.removeItem(key);
      child.eval("(() => { clearTimeout(saveTimer); saveTimer = null; let restored = fallbackBoard; try { const raw = " + JSON.stringify(original) + "; if (raw) restored = JSON.parse(raw); } catch (_) {} board = normalizeBoard(restored); activeTab = board.defaultTab || 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render(); })()");
      await wait(340);
      result.boardRestored = localStorage.getItem(key) === original;
      result.ok = Boolean(result.ok && result.boardRestored);
    }
    return result;
  })()`,
  awaitPromise: true,
  returnByValue: true
});

socket.close();
const value = response.result?.result?.value;
if (!value?.ok) {
  console.error(JSON.stringify(response, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(value, null, 2));
}
