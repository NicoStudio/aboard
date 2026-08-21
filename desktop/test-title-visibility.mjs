#!/usr/bin/env node

const storageKey = "conversation-dashboard-board-v1";
const chatTitle = "ABOARD_CHAT_SECRET_20260814";
const workTitle = "ABOARD_WORK_SECRET_20260814";
const renamedChatTitle = "ABOARD_CHAT_RENAMED_SECRET_20260814";
const renamedWorkTitle = "ABOARD_WORK_RENAMED_SECRET_20260814";
const fixture = {
  version: 2,
  defaultTab: "professional",
  chatSortBy: { professional: "updated", personal: "updated" },
  projects: [
    { id: "title-visibility-project", name: "Title Visibility Project", accent: "#315CF5", order: 1, sortBy: "updated" }
  ],
  items: [
    {
      id: "title-visibility-chat",
      title: chatTitle,
      kind: "chat",
      topic: "professional",
      projectId: null,
      pinned: false,
      titleHidden: false,
      marker: "p2",
      runtimeStatus: "idle",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      manualOrder: 1,
      url: "https://chatgpt.com/c/title-visibility-chat-thread"
    },
    {
      id: "title-visibility-work",
      title: workTitle,
      kind: "work",
      topic: null,
      projectId: "title-visibility-project",
      pinned: false,
      titleHidden: false,
      marker: "p2",
      runtimeStatus: "idle",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      manualOrder: 1,
      url: "codex://threads/title-visibility-work-thread"
    }
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

await send("Page.bringToFront");
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
    const secrets = ${JSON.stringify([chatTitle, workTitle, renamedChatTitle, renamedWorkTitle])};
    const originalStorage = localStorage.getItem(key);
    const hadOriginalStorage = originalStorage !== null;
    const originalBoard = child.eval("JSON.stringify(board)");
    const originalUi = child.eval("JSON.stringify({ activeTab, query, modal, floatingMenu })");
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    // Background Electron frames can suspend requestAnimationFrame entirely.
    // A bounded timer still gives the production focus-restoration RAF time to
    // run after Page.bringToFront without making the regression test hang.
    const settleRender = () => wait(80);
    const result = {};

    const renderFixture = () => {
      localStorage.setItem(key, JSON.stringify(fixture));
      child.eval("clearTimeout(saveTimer); saveTimer = null");
      child.eval("board = normalizeBoard(" + JSON.stringify(fixture) + "); activeTab = 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render()");
    };

    const actionOrder = row => [...row.querySelectorAll(".row-actions > button, .project-actions > button")].map(button => {
      if (button.hasAttribute("data-title-visibility")) return "visibility";
      if (button.hasAttribute("data-pin")) return "pin";
      if (button.hasAttribute("data-priority-menu")) return "priority";
      if (button.hasAttribute("data-edit")) return "settings";
      return "unknown";
    });

    const visibilityState = id => {
      const row = doc.querySelector('[data-drag-item="' + id + '"]');
      const button = row?.querySelector('[data-title-visibility="' + id + '"]');
      const title = row?.querySelector(".row-title, .project-item-title");
      const opener = row?.querySelector("[data-open]");
      return {
        text: title?.textContent?.trim() || "",
        titleHiddenClass: Boolean(title?.classList.contains("is-title-hidden")),
        checked: button?.getAttribute("aria-checked") || "",
        label: button?.getAttribute("aria-label") || "",
        role: button?.getAttribute("role") || "",
        focused: doc.activeElement === button,
        openerLabel: opener?.getAttribute("aria-label") || ""
      };
    };

    const toggleVisibility = async id => {
      const button = doc.querySelector('[data-title-visibility="' + id + '"]');
      if (!button) throw new Error("Missing title visibility button: " + id);
      button.click();
      await settleRender();
      return visibilityState(id);
    };

    const inspectHiddenEditor = async id => {
      const button = doc.querySelector('[data-edit="' + id + '"]');
      if (!button) throw new Error("Missing settings button: " + id);
      const expectedTitle = child.eval("board.items.find(item => item.id === " + JSON.stringify(id) + ")?.title || ''");
      button.click();
      await settleRender();
      const input = doc.getElementById("item-title");
      const state = {
        value: input?.value || "",
        readOnly: Boolean(input?.readOnly),
        required: Boolean(input?.required),
        placeholder: input?.getAttribute("placeholder") || "",
        hint: doc.getElementById("item-title-hidden-hint")?.textContent?.trim() || "",
        dom: domLeakState()
      };
      doc.getElementById("item-form")?.requestSubmit();
      await settleRender();
      const savedItem = child.eval("board.items.find(item => item.id === " + JSON.stringify(id) + ")");
      state.savedTitleRetained = savedItem?.title === expectedTitle;
      state.savedHiddenRetained = savedItem?.titleHidden === true;
      return state;
    };

    const domLeakState = () => {
      const app = doc.getElementById("app");
      const appHtml = app?.outerHTML || "";
      const documentHtml = doc.documentElement?.innerHTML || "";
      const leakingAttributes = [...(app?.querySelectorAll("*") || [])].flatMap(element =>
        element.getAttributeNames().map(name => ({ name, value: element.getAttribute(name) || "" }))
      ).filter(attribute => secrets.some(secret => attribute.value.includes(secret)));
      return {
        initialBoardRemoved: !doc.getElementById("initial-board"),
        appLeaks: secrets.filter(secret => appHtml.includes(secret)),
        documentLeaks: secrets.filter(secret => documentHtml.includes(secret)),
        attributeLeaks: leakingAttributes
      };
    };

    try {
      child.eval("clearTimeout(saveTimer); saveTimer = null");
      renderFixture();

      const chatRow = doc.querySelector('[data-drag-item="title-visibility-chat"]');
      const workRow = doc.querySelector('[data-drag-item="title-visibility-work"]');
      if (!chatRow || !workRow) throw new Error("Title visibility fixture rows not rendered");
      result.actionOrder = {
        chat: actionOrder(chatRow),
        work: actionOrder(workRow)
      };
      result.initial = {
        chat: visibilityState("title-visibility-chat"),
        work: visibilityState("title-visibility-work"),
        initialBoardRemoved: !doc.getElementById("initial-board")
      };

      result.hidden = {
        chat: await toggleVisibility("title-visibility-chat"),
        work: await toggleVisibility("title-visibility-work")
      };
      await wait(360);
      result.hidden.persisted = JSON.parse(localStorage.getItem(key)).items
        .filter(item => item.id.startsWith("title-visibility-"))
        .map(item => ({ id: item.id, titleHidden: item.titleHidden }));
      result.hidden.dom = domLeakState();
      result.hidden.editors = {
        chat: await inspectHiddenEditor("title-visibility-chat"),
        work: await inspectHiddenEditor("title-visibility-work")
      };

      child.eval("syncNativeMetadata(" + JSON.stringify([
        { id: "title-visibility-chat-thread", title: ${JSON.stringify(renamedChatTitle)} },
        { id: "title-visibility-work-thread", title: ${JSON.stringify(renamedWorkTitle)} }
      ]) + ")");
      await settleRender();
      await wait(360);
      result.metadata = {
        board: child.eval("board.items.filter(item => item.id.startsWith('title-visibility-')).map(item => ({ id: item.id, title: item.title, titleHidden: item.titleHidden }))"),
        chat: visibilityState("title-visibility-chat"),
        work: visibilityState("title-visibility-work"),
        dom: domLeakState()
      };

      const countBeforeDuplicateImports = child.eval("board.items.length");
      const duplicateChatTarget = doc.querySelector('[data-drop-kind="chat"][data-drop-topic="professional"]');
      child.openImportEditor(duplicateChatTarget, {
        title: ${JSON.stringify(renamedChatTitle)},
        url: "https://www.chatgpt.com/c/TITLE%2DVISIBILITY%2DCHAT%2DTHREAD/?source=manual"
      });
      await settleRender();
      const duplicateEditorInput = doc.getElementById("item-title");
      const duplicateEditor = {
        itemId: child.eval("modal?.itemId || ''"),
        value: duplicateEditorInput?.value || "",
        readOnly: Boolean(duplicateEditorInput?.readOnly),
        dom: domLeakState()
      };
      doc.getElementById("item-form")?.requestSubmit();
      await settleRender();
      child.eval("storeCreatedThread(" + JSON.stringify({
        title: ${JSON.stringify(renamedWorkTitle)},
        url: "codex://threads/TITLE%2DVISIBILITY%2DWORK%2DTHREAD/?hostId=duplicate-import"
      }) + ", { kind: 'work', projectId: 'title-visibility-project' })");
      await settleRender();
      result.duplicates = {
        countBefore: countBeforeDuplicateImports,
        countAfter: child.eval("board.items.length"),
        editor: duplicateEditor,
        normalized: child.eval("JSON.stringify([normalizedThreadId('https://chat.openai.com/c/TITLE%2DVISIBILITY%2DCHAT%2DTHREAD/?x=1'), normalizedThreadId('codex://threads/title-visibility-chat-thread?hostId=abc')])"),
        items: child.eval("board.items.filter(item => item.id.startsWith('title-visibility-')).map(item => ({ id: item.id, title: item.title, titleHidden: item.titleHidden, url: item.url }))"),
        dom: domLeakState()
      };

      result.shown = {
        chat: await toggleVisibility("title-visibility-chat"),
        work: await toggleVisibility("title-visibility-work")
      };
      await wait(360);
      result.shown.persisted = JSON.parse(localStorage.getItem(key)).items
        .filter(item => item.id.startsWith("title-visibility-"))
        .map(item => ({ id: item.id, title: item.title, titleHidden: item.titleHidden }));

      const expectedOrder = JSON.stringify(["visibility", "pin", "priority", "settings"]);
      const hiddenPersisted = result.hidden.persisted || [];
      const hiddenEditors = Object.values(result.hidden.editors || {});
      const metadataBoard = result.metadata.board || [];
      const duplicateItems = result.duplicates.items || [];
      const shownPersisted = result.shown.persisted || [];
      const switchVisible = state => state?.checked === "true"
        && state?.role === "switch"
        && state?.label === "隐藏此会话名称";
      const switchHidden = (state, requireFocus = true) => state?.checked === "false"
        && state?.role === "switch"
        && state?.label === "显示此会话名称"
        && state?.text === "名称已隐藏"
        && state?.titleHiddenClass
        && (!requireFocus || state?.focused)
        && !secrets.some(secret => state?.openerLabel?.includes(secret));
      result.behaviorOk = JSON.stringify(result.actionOrder.chat) === expectedOrder
        && JSON.stringify(result.actionOrder.work) === expectedOrder
        && result.initial.initialBoardRemoved
        && switchVisible(result.initial.chat)
        && switchVisible(result.initial.work)
        && switchHidden(result.hidden.chat)
        && switchHidden(result.hidden.work)
        && hiddenPersisted.length === 2
        && hiddenPersisted.every(item => item.titleHidden === true)
        && result.hidden.dom.initialBoardRemoved
        && result.hidden.dom.appLeaks.length === 0
        && result.hidden.dom.documentLeaks.length === 0
        && result.hidden.dom.attributeLeaks.length === 0
        && hiddenEditors.length === 2
        && hiddenEditors.every(editor => editor.value === ""
          && editor.readOnly
          && !editor.required
          && editor.placeholder === "名称已隐藏"
          && editor.hint.includes("眼睛图标")
          && editor.savedTitleRetained
          && editor.savedHiddenRetained
          && editor.dom.initialBoardRemoved
          && editor.dom.appLeaks.length === 0
          && editor.dom.documentLeaks.length === 0
          && editor.dom.attributeLeaks.length === 0)
        && metadataBoard.length === 2
        && metadataBoard.every(item => item.titleHidden === true)
        && metadataBoard.some(item => item.id === "title-visibility-chat" && item.title === ${JSON.stringify(renamedChatTitle)})
        && metadataBoard.some(item => item.id === "title-visibility-work" && item.title === ${JSON.stringify(renamedWorkTitle)})
        && switchHidden(result.metadata.chat, false)
        && switchHidden(result.metadata.work, false)
        && result.metadata.dom.initialBoardRemoved
        && result.metadata.dom.appLeaks.length === 0
        && result.metadata.dom.documentLeaks.length === 0
        && result.metadata.dom.attributeLeaks.length === 0
        && result.duplicates.countBefore === 2
        && result.duplicates.countAfter === 2
        && result.duplicates.editor.itemId === "title-visibility-chat"
        && result.duplicates.editor.value === ""
        && result.duplicates.editor.readOnly
        && result.duplicates.editor.dom.appLeaks.length === 0
        && result.duplicates.editor.dom.documentLeaks.length === 0
        && result.duplicates.editor.dom.attributeLeaks.length === 0
        && result.duplicates.normalized === JSON.stringify(["title-visibility-chat-thread", "title-visibility-chat-thread"])
        && duplicateItems.length === 2
        && duplicateItems.every(item => item.titleHidden === true)
        && duplicateItems.some(item => item.id === "title-visibility-chat" && item.title === ${JSON.stringify(renamedChatTitle)})
        && duplicateItems.some(item => item.id === "title-visibility-work" && item.title === ${JSON.stringify(renamedWorkTitle)})
        && result.duplicates.dom.appLeaks.length === 0
        && result.duplicates.dom.documentLeaks.length === 0
        && result.duplicates.dom.attributeLeaks.length === 0
        && switchVisible(result.shown.chat)
        && switchVisible(result.shown.work)
        && result.shown.chat.focused
        && result.shown.work.focused
        && result.shown.chat.text === ${JSON.stringify(renamedChatTitle)}
        && result.shown.work.text === ${JSON.stringify(renamedWorkTitle)}
        && shownPersisted.length === 2
        && shownPersisted.every(item => item.titleHidden === false)
        && shownPersisted.some(item => item.id === "title-visibility-chat" && item.title === ${JSON.stringify(renamedChatTitle)})
        && shownPersisted.some(item => item.id === "title-visibility-work" && item.title === ${JSON.stringify(renamedWorkTitle)});
    } finally {
      child.eval("clearTimeout(saveTimer); saveTimer = null; clearTimeout(toastTimer); toastTimer = null");
      if (hadOriginalStorage) localStorage.setItem(key, originalStorage);
      else localStorage.removeItem(key);
      child.eval("board = JSON.parse(" + JSON.stringify(originalBoard) + "); const restoredUi = JSON.parse(" + JSON.stringify(originalUi) + "); activeTab = restoredUi.activeTab; query = restoredUi.query; modal = restoredUi.modal; floatingMenu = restoredUi.floatingMenu; internalDrag = null; render()");
      result.restoration = {
        localStorageExact: hadOriginalStorage ? localStorage.getItem(key) === originalStorage : localStorage.getItem(key) === null,
        boardExact: child.eval("JSON.stringify(board)") === originalBoard
      };
    }

    result.ok = result.behaviorOk
      && result.restoration.localStorageExact
      && result.restoration.boardExact;
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
