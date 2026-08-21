#!/usr/bin/env node

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
  if (callback) { pending.delete(message.id); callback(message); }
});
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

const response = await send("Runtime.evaluate", {
  expression: `(async () => {
    document.getElementById("conversation-dashboard-sidebar-entry")?.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const frame = document.querySelector("#conversation-dashboard-surface iframe");
    const child = frame.contentWindow;
    const doc = frame.contentDocument;
    const original = localStorage.getItem("conversation-dashboard-board-v1");
    const fixture = {
      version: 2,
      defaultTab: "professional",
      chatSortBy: { professional: "updated", personal: "updated" },
      projects: [
        { id: "feature-project-a", name: "Demo Project", accent: "#0B4F43", order: 1, sortBy: "manual", layoutLane: 0, layoutOrder: 1 },
        { id: "feature-project-b", name: "Sample Project", accent: "#315CF5", order: 2, sortBy: "manual", layoutLane: 1, layoutOrder: 1 }
      ],
      items: [
        { id: "feature-work-a", title: "示例中文工作", kind: "work", topic: null, projectId: "feature-project-a", pinned: false, titleHidden: false, marker: "p1", runtimeStatus: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", manualOrder: 1, url: "codex://threads/11111111-1111-4111-8111-111111111111" },
        { id: "feature-work-b", title: "示例中文计划", kind: "work", topic: null, projectId: "feature-project-b", pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", manualOrder: 1, url: "codex://threads/22222222-2222-4222-8222-222222222222" },
        { id: "feature-chat", title: "示例中文聊天", kind: "chat", topic: "professional", projectId: null, pinned: false, titleHidden: false, marker: "p2", runtimeStatus: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", manualOrder: 1, url: "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333" }
      ]
    };
    child.eval("board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'professional'; query = ''; render()");
    const dispatchDrag = (element, type, transfer) => element.dispatchEvent(new child.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const result = {};
    try {
      result.name = doc.querySelector(".brand h1")?.textContent;
      result.headings = [...doc.querySelectorAll(".section-title")].map(element => element.textContent.trim());
      result.removedCopy = !doc.body.innerText.includes("7个项目对话") && !doc.body.innerText.includes("7 个项目对话");
      result.tabLabels = [...doc.querySelectorAll(".tab")].map(element => element.textContent.replace(/\\s+/g, " ").trim());
      result.projectCounts = [...doc.querySelectorAll(".project-sub")].map(element => element.textContent.trim());
      result.toolbarOrder = [...doc.querySelector(".project-tools").children].map(element => element.hasAttribute("data-create-project-work") ? "add" : element.hasAttribute("data-sort-menu") ? "sort" : element.hasAttribute("data-edit-project") ? "settings" : "unknown");

      doc.querySelector("[data-action='add-project']").click();
      const projectName = doc.querySelector("#project-name");
      result.projectName = { placeholder: projectName.placeholder, maxLength: projectName.maxLength };
      doc.querySelector("[data-close-modal]").click();

      doc.querySelector("[data-priority-menu]").click();
      result.priorities = [...doc.querySelectorAll("[data-set-priority]")].map(element => element.innerText.replace(/\\s+/g, " ").trim());
      doc.body.click();

      const search = doc.querySelector("#search");
      search.dispatchEvent(new child.CompositionEvent("compositionstart", { bubbles: true }));
      search.value = "示例中文";
      search.dispatchEvent(new child.InputEvent("input", { bubbles: true, data: "示例中文", isComposing: true }));
      search.dispatchEvent(new child.CompositionEvent("compositionend", { bubbles: true, data: "示例中文" }));
      result.chineseSearch = {
        value: doc.querySelector("#search")?.value,
        titles: [...doc.querySelectorAll(".row-title, .project-item-title")].map(element => element.textContent.trim())
      };

      child.eval("query = ''; render()");
      const workItems = [...doc.querySelectorAll(".project-item[data-drag-item]")];
      const workSource = workItems[0];
      const workSourceCard = workSource?.closest("[data-drag-project]");
      const workTargetCard = [...doc.querySelectorAll("[data-drag-project]")].find(card => card !== workSourceCard);
      if (workSource && workTargetCard) {
        const workId = workSource.dataset.dragItem;
        const transfer = new child.DataTransfer();
        dispatchDrag(workSource.querySelector("[data-open]"), "dragstart", transfer);
        dispatchDrag(workTargetCard, "dragenter", transfer);
        dispatchDrag(workTargetCard, "dragover", transfer);
        dispatchDrag(workTargetCard, "drop", transfer);
        result.workMove = child.eval("board.items.find(item => item.id === " + JSON.stringify(workId) + ")?.projectId") === workTargetCard.dataset.projectId;
      }

      child.eval("query = ''; render()");
      child.eval("query = ''; const candidate = board.items.find(item => item.kind === 'chat'); activeTab = candidate?.topic || 'professional'; render()");
      const chatRow = doc.querySelector(".chat-list [data-drag-item]");
      const chatId = chatRow?.dataset.dragItem;
      if (chatRow && chatId) {
        const currentTopic = child.eval("board.items.find(item => item.id === " + JSON.stringify(chatId) + ")?.topic");
        const transfer = new child.DataTransfer();
        dispatchDrag(chatRow.querySelector("[data-open]"), "dragstart", transfer);
        const targetTab = doc.querySelector(currentTopic === "personal" ? "[data-tab='professional']" : "[data-tab='personal']");
        dispatchDrag(targetTab, "dragenter", transfer);
        dispatchDrag(targetTab, "dragover", transfer);
        dispatchDrag(targetTab, "drop", transfer);
        result.chatMove = child.eval("board.items.find(item => item.id === " + JSON.stringify(chatId) + ")?.topic");
      }

      child.eval("activeTab = board.defaultTab || 'professional'; render()");
      const cards = [...doc.querySelectorAll("[data-drag-project]")]
        .sort((a, b) => Number(a.dataset.projectLayoutIndex) - Number(b.dataset.projectLayoutIndex));
      if (cards.length > 1) {
        const sourceProjectId = cards[0].dataset.dragProject;
        const targetLane = Number(cards[1].dataset.projectLayoutLane);
        const targetRect = cards[1].getBoundingClientRect();
        const transfer = new child.DataTransfer();
        dispatchDrag(cards[0].querySelector(".project-heading"), "dragstart", transfer);
        const projectEvent = type => cards[1].dispatchEvent(new child.DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: targetRect.left + targetRect.width / 2,
          clientY: targetRect.top + 2
        }));
        projectEvent("dragenter");
        projectEvent("dragover");
        projectEvent("drop");
        const movedProject = child.eval("board.projects.find(project => project.id === " + JSON.stringify(sourceProjectId) + ")");
        result.projectReordered = movedProject?.layoutLane === targetLane;
      }
    } finally {
      child.eval("clearTimeout(saveTimer)");
      if (original === null) localStorage.removeItem("conversation-dashboard-board-v1");
      else localStorage.setItem("conversation-dashboard-board-v1", original);
      child.eval("board = normalizeBoard(window.parent.localStorage.getItem(storageKey) ? JSON.parse(window.parent.localStorage.getItem(storageKey)) : fallbackBoard); activeTab = board.defaultTab || 'professional'; query = ''; floatingMenu = null; internalDrag = null; render()");
    }
    result.ok = result.name === "Aboard"
      && JSON.stringify(result.headings) === JSON.stringify(["Chats", "Work"])
      && result.removedCopy
      && result.projectName?.maxLength === 30
      && JSON.stringify(result.toolbarOrder) === JSON.stringify(["add", "sort", "settings"])
      && result.priorities?.length === 3
      && result.chineseSearch?.value === "示例中文"
      && result.chineseSearch.titles.every(title => title.includes("示例中文"))
      && result.workMove
      && ["professional", "personal"].includes(result.chatMove)
      && result.projectReordered;
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
