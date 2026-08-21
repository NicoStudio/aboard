#!/usr/bin/env node

const pages = await fetch("http://127.0.0.1:9237/json/list").then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Dashboard window not found");
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
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const pointer = (view, type, pointerId, x, y, buttons) => new view.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
      clientX: x,
      clientY: y
    });
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    entry?.click();
    await sleep(80);

    const frame = surface?.querySelector("iframe");
    const doc = frame?.contentDocument;
    const workTarget = doc?.querySelector('[data-drop-kind="work"]');
    const chatTarget = doc?.querySelector('[data-drop-kind="chat"]');
    const baseRow = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(row =>
      row.dataset.appActionSidebarThreadKind === "local"
      || /(^|\\s)(Work|Codex)($|\\s)/i.test(row.textContent || "")
    );
    if (!frame || !doc || !workTarget || !chatTarget || !baseRow) {
      return { ok: false, reason: "work source and both targets are required" };
    }

    const dynamicRow = baseRow.cloneNode(true);
    dynamicRow.removeAttribute("draggable");
    dynamicRow.removeAttribute("aria-selected");
    dynamicRow.removeAttribute("aria-checked");
    dynamicRow.removeAttribute("data-state");
    delete dynamicRow.dataset.conversationDashboardDraggable;
    delete dynamicRow.dataset.conversationDashboardDragListener;
    delete dynamicRow.dataset.aboardDragging;
    dynamicRow.dataset.appActionSidebarThreadId = "local:44444444-4444-4444-8444-444444444453";
    dynamicRow.dataset.appActionSidebarThreadKind = "local";
    dynamicRow.dataset.appActionSidebarThreadTitle = "Dynamic pointer candidate";
    dynamicRow.dataset.appActionSidebarThreadSelected = "false";
    baseRow.parentElement.appendChild(dynamicRow);
    await sleep(100);

    const dynamicNeverDraggable = dynamicRow.getAttribute("draggable") !== "true"
      && !dynamicRow.dataset.conversationDashboardDraggable;
    const rowRect = dynamicRow.getBoundingClientRect();
    const startX = rowRect.left + 8;
    const startY = rowRect.top + 8;
    const pointerId = 4201;
    dynamicRow.dispatchEvent(pointer(window, "pointerdown", pointerId, startX, startY, 1));
    document.dispatchEvent(pointer(window, "pointermove", pointerId, startX + 9, startY, 1));
    await sleep(40);

    const session = window.__conversationDashboardDragSession;
    const activeAfterOpen = surface?.dataset.active === "true";
    const dynamicCandidateStarted = session?.source === "host-pointer"
      && session?.payload?.id === dynamicRow.dataset.appActionSidebarThreadId.split(":").slice(1).join(":");

    const chatRect = chatTarget.getBoundingClientRect();
    const parentProbe = document.createElement("div");
    parentProbe.dataset.dropKind = "chat";
    Object.assign(parentProbe.style, {
      position: "fixed",
      left: "260px",
      top: "120px",
      width: "80px",
      height: "80px",
      zIndex: "2147483646",
      pointerEvents: "auto"
    });
    document.body.appendChild(parentProbe);
    const parentRect = parentProbe.getBoundingClientRect();
    document.dispatchEvent(pointer(window, "pointermove", pointerId, parentRect.left + 20, parentRect.top + 20, 1));
    await sleep(40);
    const parentMoveProcessed = window.__conversationDashboardDragSession?.source === "host-pointer";
    parentProbe.remove();

    chatTarget.dispatchEvent(pointer(
      frame.contentWindow,
      "pointermove",
      pointerId,
      chatRect.left + Math.min(24, chatRect.width / 2),
      chatRect.top + Math.min(24, chatRect.height / 2),
      1
    ));
    await sleep(40);
    const childMoveHighlightedInvalid = chatTarget.classList.contains("is-drop-invalid");

    const workRect = workTarget.getBoundingClientRect();
    workTarget.dispatchEvent(pointer(
      frame.contentWindow,
      "pointermove",
      pointerId,
      workRect.left + Math.min(24, workRect.width / 2),
      workRect.top + Math.min(24, workRect.height / 2),
      1
    ));
    await sleep(40);
    const childMoveHighlightedValid = workTarget.classList.contains("is-drop-active")
      && !chatTarget.classList.contains("is-drop-invalid");

    doc.dispatchEvent(pointer(
      frame.contentWindow,
      "pointercancel",
      pointerId,
      workRect.left + Math.min(24, workRect.width / 2),
      workRect.top + Math.min(24, workRect.height / 2),
      0
    ));
    await sleep(60);

    const cleanupComplete = !window.__conversationDashboardDragSession
      && !window.__conversationDashboardDraggedThread
      && !document.documentElement.dataset.conversationDashboardDragging
      && doc.querySelectorAll(".is-drop-active, .is-drop-invalid").length === 0
      && doc.getElementById("drag-guide")?.classList.contains("show") !== true;
    const allRowsNeverDraggable = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].every(row =>
      row.getAttribute("draggable") !== "true"
      && !row.dataset.conversationDashboardDraggable
    );
    const hoverRuleInstalled = [...document.getElementById("conversation-dashboard-host-style")?.sheet?.cssRules || []]
      .some(rule => String(rule.selectorText || "").includes("data-app-action-sidebar-thread-row")
        && String(rule.selectorText || "").includes(":hover"));
    const sourceRowClearedAfterCancel = dynamicRow.dataset.aboardDragging !== "true";
    const catcherCount = document.querySelectorAll("#conversation-dashboard-drop-catcher").length;
    dynamicRow.remove();

    return {
      ok: activeAfterOpen && dynamicNeverDraggable && dynamicCandidateStarted
        && parentMoveProcessed && childMoveHighlightedInvalid && childMoveHighlightedValid
        && cleanupComplete && sourceRowClearedAfterCancel
        && allRowsNeverDraggable && hoverRuleInstalled
        && catcherCount === 0,
      version: window.__conversationDashboardVersion,
      dynamicNeverDraggable,
      activeAfterOpen,
      dynamicCandidateStarted,
      pointerSource: session?.source || "",
      parentMoveProcessed,
      childMoveHighlightedInvalid,
      childMoveHighlightedValid,
      cleanupComplete,
      sourceRowClearedAfterCancel,
      allRowsNeverDraggable,
      hoverRuleInstalled,
      catcherCount
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
});
socket.close();
const result = response.result?.result?.value;
console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
