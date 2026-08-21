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
const send = (method, params = {}, timeoutMs = 6_000) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Timed out waiting for CDP ${method}`));
  }, timeoutMs);
  pending.set(id, message => {
    clearTimeout(timer);
    resolve(message);
  });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const mouse = async (type, point, buttons) => {
  await send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons,
    clickCount: 1,
    pointerType: "mouse"
  });
  await wait(24);
};

const hostModeState = () => evaluate(`(() => {
  const switcher = document.querySelector('button[aria-label^="Switch mode"], button[aria-label^="\u5207\u6362\u6a21\u5f0f"]');
  const label = switcher?.getAttribute("aria-label") || "";
  const projectChatRows = [...document.querySelectorAll('[data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row])')]
    .filter(row => {
      const title = (row.querySelector("[data-thread-title]")?.textContent || "").replace(/\\s+/g, " ").trim();
      const labels = [...row.querySelectorAll("span")]
        .map(element => (element.textContent || "").replace(/\\s+/g, " ").trim());
      const suffix = (row.textContent || "").replace(/\\s+/g, " ").trim().replace(title, "").trim();
      return labels.includes("Chat") || /(^|\\s)Chat($|\\s)/i.test(suffix);
    });
  const recentsChatRows = document.querySelectorAll('[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"] .sidebar-item').length;
  return {
    mode: /ChatGPT/i.test(label) ? "ChatGPT" : /Codex/i.test(label) ? "Codex" : "",
    recentsChatRows,
    projectChatRows: projectChatRows.length,
    chatRows: recentsChatRows + projectChatRows.length
  };
})()`);

const elementCenter = expression => evaluate(`(() => {
  const element = ${expression};
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`);

const trustedClick = async point => {
  if (!point) return false;
  await mouse("mouseMoved", point, 0);
  await mouse("mousePressed", point, 1);
  await mouse("mouseReleased", point, 0);
  return true;
};

const ensureHostMode = async (desiredMode, { requireChatRows = false } = {}) => {
  let state = await hostModeState();
  if (state.mode !== desiredMode) {
    const switcherPoint = await elementCenter(`document.querySelector('button[aria-label^="Switch mode"], button[aria-label^="\u5207\u6362\u6a21\u5f0f"]')`);
    if (!await trustedClick(switcherPoint)) return false;
    let menuPoint = null;
    for (let attempt = 0; attempt < 80 && !menuPoint; attempt += 1) {
      menuPoint = await elementCenter(`[...document.querySelectorAll('[role="menuitem"]')].find(item => {
        const text = (item.textContent || "").replace(/\\s+/g, " ").trim();
        return text.startsWith(${JSON.stringify(desiredMode)});
      })`);
      if (!menuPoint) await wait(50);
    }
    if (!await trustedClick(menuPoint)) return false;
  }

  for (let attempt = 0; attempt < 200; attempt += 1) {
    state = await hostModeState();
    if (state.mode === desiredMode && (!requireChatRows || state.chatRows > 0)) return true;
    await wait(50);
  }
  return false;
};

const moveAlong = async (from, to, steps = 18) => {
  for (let index = 1; index <= steps; index += 1) {
    await mouse("mouseMoved", {
      x: from.x + ((to.x - from.x) * index / steps),
      y: from.y + ((to.y - from.y) * index / steps)
    }, 1);
  }
};

const startDrag = async (source, destination, label) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse"
  });
  await wait(80);
  await mouse("mouseMoved", source, 0);
  await mouse("mousePressed", source, 1);
  await mouse("mouseMoved", { x: source.x + 4, y: source.y }, 1);
  await mouse("mouseMoved", { x: source.x + 10, y: source.y }, 1);
  let armed = false;
  for (let attempt = 0; attempt < 5 && !armed; attempt += 1) {
    armed = await evaluate("window.__conversationDashboardDragSession?.source === 'host-pointer'");
    if (!armed) await wait(40);
  }
  if (!armed) {
    const diagnostic = await evaluate(`(() => {
      const hit = document.elementFromPoint(${JSON.stringify(source.x)}, ${JSON.stringify(source.y)});
      const row = hit?.closest?.(':is([data-app-action-sidebar-thread-row], [data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"] .sidebar-item, [data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row]))');
      const rect = row?.getBoundingClientRect();
      return {
        hit: hit?.tagName || "",
        hitClass: String(hit?.className || ""),
        rowPresent: Boolean(row),
        rowRect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        dashboardActive: document.getElementById("conversation-dashboard-surface")?.dataset.active || "",
        rootActive: document.documentElement.dataset.conversationDashboardActive || "",
        events: window.__aboardChatCdpEvents || []
      };
    })()`);
    throw new Error(`${label}: trusted source press did not start a host-pointer Chat drag session; ${JSON.stringify(diagnostic)}`);
  }
  await moveAlong({ x: source.x + 10, y: source.y }, destination);
};

const finishDrag = async destination => {
  await mouse("mouseReleased", destination, 0);
  await wait(520);
};

const originalHostMode = (await hostModeState()).mode;
if (!await ensureHostMode("ChatGPT", { requireChatRows: true })) {
  socket.close();
  throw new Error("Could not switch Aboard to ChatGPT mode or load a real Chat source");
}

const setup = await evaluate(`(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.getElementById("conversation-dashboard-sidebar-entry")?.click();
  await sleep(120);

  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  if (!frame || !doc) return { ok: false, reason: "Aboard iframe unavailable" };
  const board = frame.contentWindow.eval("board");
  const importedIds = new Set(board.items.map(item => String(item.url || "").match(/(?:threads\\/|chatgpt\\.com\\/c\\/)([^?/#]+)/i)?.[1]).filter(Boolean));
  const chatRows = [...document.querySelectorAll('[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"] .sidebar-item')];
  const projectChatRows = [...document.querySelectorAll('[data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row])')]
    .filter(candidate => {
      const title = (candidate.querySelector("[data-thread-title]")?.textContent || "").replace(/\\s+/g, " ").trim();
      const labels = [...candidate.querySelectorAll("span")]
        .map(element => (element.textContent || "").replace(/\\s+/g, " ").trim());
      const suffix = (candidate.textContent || "").replace(/\\s+/g, " ").trim().replace(title, "").trim();
      return labels.includes("Chat") || /(^|\\s)Chat($|\\s)/i.test(suffix);
    });
  let sourceOrigin = "recents";
  let row = chatRows.find(candidate => {
    const wrapper = candidate.closest('[data-sidebar-chatgpt-conversation-key]');
    const id = String(wrapper?.dataset.sidebarChatgptConversationKey || "").replace(/^chatgpt:conversation:/, "");
    const rect = candidate.getBoundingClientRect();
    return id && !importedIds.has(id) && rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 40;
  }) || chatRows.find(candidate => {
    const wrapper = candidate.closest('[data-sidebar-chatgpt-conversation-key]');
    const id = String(wrapper?.dataset.sidebarChatgptConversationKey || "").replace(/^chatgpt:conversation:/, "");
    return id && !importedIds.has(id);
  }) || chatRows[0];
  if (!row) {
    sourceOrigin = "project";
    row = projectChatRows.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 40;
    }) || projectChatRows[0];
  }
  if (row) {
    row.scrollIntoView({ block: "center" });
    await sleep(180);
  }
  const chatTarget = doc.querySelector('.chat-list[data-drop-kind="chat"]')
    || doc.querySelector('[data-drop-kind="chat"]');
  const workTarget = [...doc.querySelectorAll('[data-drop-kind="work"]')].find(target => {
    const rect = target.getBoundingClientRect();
    return rect.width > 100 && rect.height > 80;
  });
  if (!row || !chatTarget || !workTarget) return { ok: false, reason: "real Chat source or drop targets unavailable" };

  const wrapper = row.closest('[data-sidebar-chatgpt-conversation-key]');
  const provisionalSourceId = String(wrapper?.dataset.sidebarChatgptConversationKey || "").replace(/^chatgpt:conversation:/, "");
  const sourceTitle = (row.querySelector("[data-thread-title]")?.textContent || "").replace(/\\s+/g, " ").trim();
  window.__aboardChatCdpEvents = [];
  window.__aboardChatHostController?.abort();
  window.__aboardChatChildController?.abort();
  window.__aboardChatHostController = new AbortController();
  window.__aboardChatChildController = new frame.contentWindow.AbortController();
  const record = realm => event => window.__aboardChatCdpEvents.push({
    realm,
    type: event.type,
    trusted: event.isTrusted,
    pointerId: event.pointerId
  });
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    document.addEventListener(type, record("host"), {
      capture: true,
      passive: true,
      signal: window.__aboardChatHostController.signal
    });
    doc.addEventListener(type, record("child"), {
      capture: true,
      passive: true,
      signal: window.__aboardChatChildController.signal
    });
  }

  return {
    ok: Boolean(sourceTitle),
    reason: sourceTitle ? "" : "Chat title unavailable",
    originalBoard: localStorage.getItem("conversation-dashboard-board-v1"),
    sourceOrigin,
    provisionalSourceId,
    sourceTitle,
    topic: frame.contentWindow.eval("activeTab"),
    workProjectId: workTarget.dataset.projectId
  };
})()`);

if (!setup?.ok) {
  if (originalHostMode) await ensureHostMode(originalHostMode);
  socket.close();
  throw new Error(setup?.reason || "Could not prepare trusted Chat drag test");
}

const resetTrace = () => evaluate("window.__aboardChatCdpEvents = []; true");
const dragGeometry = targetKind => evaluate(`(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const sourceOrigin = ${JSON.stringify(setup.sourceOrigin)};
  const sourceId = ${JSON.stringify(setup.provisionalSourceId)};
  const sourceTitle = ${JSON.stringify(setup.sourceTitle)};
  const workProjectId = ${JSON.stringify(setup.workProjectId || "")};
  const projectChatRows = () => [...document.querySelectorAll('[data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row])')]
    .filter(candidate => {
      const title = (candidate.querySelector("[data-thread-title]")?.textContent || "").replace(/\\s+/g, " ").trim();
      const labels = [...candidate.querySelectorAll("span")]
        .map(element => (element.textContent || "").replace(/\\s+/g, " ").trim());
      const suffix = (candidate.textContent || "").replace(/\\s+/g, " ").trim().replace(title, "").trim();
      return labels.includes("Chat") || /(^|\\s)Chat($|\\s)/i.test(suffix);
    });
  const findSource = () => {
    if (sourceOrigin === "recents") {
      const wrapper = [...document.querySelectorAll('[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"]')]
        .find(candidate => String(candidate.dataset.sidebarChatgptConversationKey || "").replace(/^chatgpt:conversation:/, "") === sourceId);
      const row = wrapper?.querySelector(".sidebar-item");
      if (row) return row;
    }
    return projectChatRows().find(candidate => {
      const title = (candidate.querySelector("[data-thread-title]")?.textContent || "").replace(/\\s+/g, " ").trim();
      return title === sourceTitle;
    }) || null;
  };
  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  if (!frame || !doc) return { ok: false, reason: "Aboard iframe unavailable" };

  let previousSignature = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = findSource();
    if (!row) {
      await sleep(50);
      continue;
    }
    row.scrollIntoView({ block: "center" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const liveRow = findSource();
    const rowRect = liveRow?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const target = ${JSON.stringify(targetKind)} === "chat"
      ? (doc.querySelector('.chat-list[data-drop-kind="chat"]') || doc.querySelector('[data-drop-kind="chat"]'))
      : ([...doc.querySelectorAll('[data-drop-kind="work"]')].find(candidate => !workProjectId || candidate.dataset.projectId === workProjectId)
        || [...doc.querySelectorAll('[data-drop-kind="work"]')].find(candidate => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 100 && rect.height > 80;
        }));
    const targetRect = target?.getBoundingClientRect();
    if (!liveRow || !rowRect || !target || !targetRect
      || rowRect.width <= 40 || rowRect.height <= 0
      || targetRect.width <= 100 || targetRect.height <= 40) {
      previousSignature = "";
      await sleep(50);
      continue;
    }

    const source = {
      x: rowRect.left + Math.min(80, rowRect.width / 3),
      y: rowRect.top + rowRect.height / 2
    };
    const targetLocal = {
      x: targetRect.left + Math.min(Math.max(24, targetRect.width / 2), targetRect.width - 12),
      y: targetRect.top + Math.min(Math.max(24, targetRect.height / 2), targetRect.height - 12)
    };
    const targetPoint = { x: frameRect.left + targetLocal.x, y: frameRect.top + targetLocal.y };
    const sourceHit = document.elementFromPoint(source.x, source.y);
    const sourceHitRow = sourceHit?.closest?.(':is([data-app-action-sidebar-thread-row], [data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"] .sidebar-item, [data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row]))');
    const targetHit = doc.elementFromPoint(targetLocal.x, targetLocal.y)?.closest?.("[data-drop-kind]");
    const signature = [rowRect.left, rowRect.top, rowRect.width, rowRect.height, frameRect.left, frameRect.top, targetRect.left, targetRect.top, targetRect.width, targetRect.height]
      .map(value => Math.round(value * 2) / 2)
      .join(":");
    if ((sourceHitRow === liveRow || liveRow.contains(sourceHit)) && targetHit === target && signature === previousSignature) {
      return {
        ok: true,
        source,
        target: targetPoint,
        targetKind: target.dataset.dropKind || ""
      };
    }
    previousSignature = signature;
    await sleep(32);
  }
  const row = findSource();
  return {
    ok: false,
    reason: "Chat source or target geometry did not stabilize",
    sourcePresent: Boolean(row),
    hostMode: document.querySelector('button[aria-label^="Switch mode"], button[aria-label^="\\u5207\\u6362\\u6a21\\u5f0f"]')?.getAttribute("aria-label") || ""
  };
})()`);
const phaseState = () => evaluate(`(() => {
  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  const board = frame?.contentWindow?.eval("board");
  const previewNodes = [...document.querySelectorAll("#conversation-dashboard-drag-preview")];
  const preview = previewNodes[0] || null;
  const previewStyle = preview ? getComputedStyle(preview) : null;
  const previewRect = preview?.getBoundingClientRect();
  return {
    events: window.__aboardChatCdpEvents || [],
    session: window.__conversationDashboardDragSession ? {
      source: window.__conversationDashboardDragSession.source,
      targetKey: window.__conversationDashboardDragSession.targetKey,
      payload: window.__conversationDashboardDragSession.payload
    } : null,
    draggedThread: window.__conversationDashboardDraggedThread || null,
    dragging: document.documentElement.dataset.conversationDashboardDragging || "",
    sourceMarked: Boolean(document.querySelector('[data-aboard-dragging="true"]')),
    ownedPreview: {
      count: previewNodes.length,
      surfaceKind: preview?.dataset.surfaceKind || "",
      title: (preview?.textContent || "").replace(/\\s+/g, " ").trim(),
      pointerEvents: previewStyle?.pointerEvents || "",
      transform: previewStyle?.transform || "",
      visible: Boolean(previewRect?.width && previewRect?.height)
        && previewStyle?.display !== "none"
        && previewStyle?.visibility !== "hidden"
        && previewStyle?.opacity !== "0"
    },
    guideShown: doc?.getElementById("drag-guide")?.classList.contains("show") === true,
    targets: [...(doc?.querySelectorAll(".is-drop-active, .is-drop-invalid") || [])].map(element => ({
      active: element.classList.contains("is-drop-active"),
      invalid: element.classList.contains("is-drop-invalid"),
      kind: element.dataset.dropKind || "",
      projectId: element.dataset.projectId || ""
    })),
    board: JSON.stringify(board),
    items: board?.items || [],
    toast: doc?.getElementById("toast")?.textContent || ""
  };
})()`);
const trustedPath = events => events.some(event => event.realm === "host" && event.type === "pointerdown" && event.trusted)
  && events.some(event => event.realm === "child" && event.type === "pointermove" && event.trusted)
  && events.some(event => event.realm === "child" && event.type === "pointerup" && event.trusted);
const singleHostTerminal = events => {
  const pointerId = events.find(event => event.realm === "host" && event.type === "pointerdown" && event.trusted)?.pointerId;
  return pointerId != null
    && events.filter(event => event.realm === "host"
      && event.type === "pointercancel"
      && !event.trusted
      && event.pointerId === pointerId).length === 1;
};
const cleaned = state => !state.session && !state.draggedThread && !state.dragging
  && !state.sourceMarked && state.ownedPreview.count === 0
  && !state.guideShown && state.targets.length === 0;
const blankPoint = () => evaluate(`(() => {
  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  if (!frame || !doc) return null;
  const frameRect = frame.getBoundingClientRect();
  for (let y = Math.max(420, Math.floor(doc.defaultView.innerHeight * 0.55)); y < doc.defaultView.innerHeight - 24; y += 40) {
    for (let x = 32; x < doc.defaultView.innerWidth - 32; x += 60) {
      const hit = doc.elementFromPoint(x, y);
      if (hit && !hit.closest("[data-drop-kind], button, a, input, textarea, select")) {
        return { x: frameRect.left + x, y: frameRect.top + y };
      }
    }
  }
  return { x: frameRect.right - 28, y: frameRect.bottom - 28 };
})()`);
const resetGesture = async (label, targetKind) => {
  const safe = await blankPoint();
  if (!safe) throw new Error(`${label}: could not resolve a safe pointer reset point`);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: safe.x,
    y: safe.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse"
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: safe.x,
    y: safe.y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse"
  });
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await wait(160);
  const resetState = await phaseState();
  if (!cleaned(resetState)) throw new Error(`${label}: previous drag state was not cleaned before the phase`);

  const geometry = await dragGeometry(targetKind);
  if (!geometry?.ok) throw new Error(`${label}: ${geometry?.reason || "drag geometry unavailable"}`);
  for (let index = 1; index <= 4; index += 1) {
    await mouse("mouseMoved", {
      x: safe.x + ((geometry.source.x - safe.x) * index / 4),
      y: safe.y + ((geometry.source.y - safe.y) * index / 4)
    }, 0);
  }
  await wait(120);
  await resetTrace();
  return geometry;
};
const chatThreadFromPayload = (payload, expectedTitle = "") => {
  const threads = (Array.isArray(payload?.threads) ? payload.threads : [payload]).filter(Boolean);
  return threads.find(thread => thread.surfaceKind === "chat" && thread.title === expectedTitle)
    || threads.find(thread => thread.surfaceKind === "chat")
    || null;
};

let result;
try {
  const validGeometry = await resetGesture("valid Chat drop", "chat");
  await startDrag(validGeometry.source, validGeometry.target, "valid Chat drop");
  const validHover = await phaseState();
  const sourceThread = chatThreadFromPayload(validHover.session?.payload, setup.sourceTitle);
  await finishDrag(validGeometry.target);
  const validDrop = await phaseState();
  const validItems = validDrop.items.filter(item => item.url === sourceThread?.url);
  const valid = {
    startedAsChat: validHover.session?.source === "host-pointer"
      && sourceThread?.surfaceKind === "chat",
    identityResolvedFromSession: Boolean(sourceThread?.id && sourceThread?.url),
    sourceTitlePreserved: sourceThread?.title === setup.sourceTitle,
    previewVisible: validHover.ownedPreview.count === 1 && validHover.ownedPreview.visible,
    previewIsChat: validHover.ownedPreview.surfaceKind === "chat",
    previewTitlePreserved: validHover.ownedPreview.title.includes(setup.sourceTitle),
    previewDoesNotIntercept: validHover.ownedPreview.pointerEvents === "none",
    targetedChat: validHover.session?.targetKey?.startsWith("chat:"),
    highlighted: validHover.targets.some(target => target.active && target.kind === "chat"),
    importedOnce: validItems.length === 1,
    importedToActiveTab: validItems[0]?.kind === "chat" && validItems[0]?.topic === setup.topic,
    titlePreserved: validItems[0]?.title === setup.sourceTitle,
    trustedPath: trustedPath(validDrop.events),
    singleHostTerminal: singleHostTerminal(validDrop.events),
    cleaned: cleaned(validDrop)
  };

  const invalidGeometry = await resetGesture("invalid Chat-to-Work drop", "work");
  const beforeInvalid = (await phaseState()).board;
  await startDrag(invalidGeometry.source, invalidGeometry.target, "invalid Chat-to-Work drop");
  const invalidHover = await phaseState();
  const invalidSourceThread = chatThreadFromPayload(invalidHover.session?.payload, setup.sourceTitle);
  await finishDrag(invalidGeometry.target);
  const invalidDrop = await phaseState();
  const invalid = {
    startedAsChat: invalidSourceThread?.surfaceKind === "chat",
    identityResolvedFromSession: Boolean(invalidSourceThread?.id && invalidSourceThread?.url),
    previewStillUnique: invalidHover.ownedPreview.count === 1 && invalidHover.ownedPreview.visible,
    previewStillChat: invalidHover.ownedPreview.surfaceKind === "chat",
    previewStillNonBlocking: invalidHover.ownedPreview.pointerEvents === "none",
    highlighted: invalidHover.targets.some(target => target.invalid && target.kind === "work" && target.projectId === setup.workProjectId),
    boardUnchanged: invalidDrop.board === beforeInvalid,
    rejected: /不能移入|类型不匹配/.test(invalidDrop.toast),
    trustedPath: trustedPath(invalidDrop.events),
    singleHostTerminal: singleHostTerminal(invalidDrop.events),
    cleaned: cleaned(invalidDrop)
  };

  result = {
    ok: Object.values(valid).every(Boolean) && Object.values(invalid).every(Boolean),
    version: await evaluate("window.__conversationDashboardVersion"),
    valid,
    invalid
  };
} finally {
  try {
    const safe = await blankPoint();
    if (safe) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: safe.x,
        y: safe.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse"
      });
    }
  } catch {}
  await evaluate(`(() => {
    window.__aboardChatHostController?.abort();
    window.__aboardChatChildController?.abort();
    delete window.__aboardChatHostController;
    delete window.__aboardChatChildController;
    delete window.__aboardChatCdpEvents;
    const frame = document.querySelector("#conversation-dashboard-surface iframe");
    if (!frame?.contentWindow) return false;
    frame.contentWindow.eval("clearTimeout(saveTimer); saveTimer = null");
    const original = ${JSON.stringify(setup.originalBoard)};
    if (original == null) localStorage.removeItem("conversation-dashboard-board-v1");
    else localStorage.setItem("conversation-dashboard-board-v1", original);
    frame.contentWindow.eval("(() => { let restored = fallbackBoard; try { const raw = window.parent.localStorage.getItem(storageKey); if (raw) restored = JSON.parse(raw); } catch (_) {} board = normalizeBoard(restored); activeTab = board.defaultTab || 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; render(); clearTimeout(saveTimer); saveTimer = null; })()");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await wait(80);
  const restored = await evaluate(`localStorage.getItem("conversation-dashboard-board-v1") === ${JSON.stringify(setup.originalBoard)}`);
  if (result) {
    result.boardRestored = restored;
    result.ok = result.ok && restored;
  }
  const hostModeRestored = !originalHostMode || await ensureHostMode(originalHostMode);
  if (result) {
    result.hostModeRestored = hostModeRestored;
    result.ok = result.ok && hostModeRestored;
  }
  socket.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result?.ok) process.exitCode = 1;
