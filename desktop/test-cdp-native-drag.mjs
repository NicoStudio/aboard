#!/usr/bin/env node

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const CDP_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 5_000;
let stage = "discover Aboard";

const timeoutError = (label, milliseconds) => new Error(`[${label}] timed out after ${milliseconds} ms`);
const withTimeout = (promise, label, milliseconds) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(timeoutError(label, milliseconds)), milliseconds);
  Promise.resolve(promise).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); }
  );
});
const wait = (milliseconds, label = stage) => withTimeout(
  new Promise(resolve => setTimeout(resolve, milliseconds)),
  `${label}: wait ${milliseconds} ms`,
  milliseconds + 1_000
);

const pagesResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
  signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS)
});
if (!pagesResponse.ok) throw new Error(`[${stage}] debugging endpoint returned ${pagesResponse.status}`);
const pages = await pagesResponse.json();
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error(`[${stage}] Aboard window not found`);

stage = "connect to Aboard renderer";
const socket = new WebSocket(page.webSocketDebuggerUrl);
await withTimeout(new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
}), stage, CONNECT_TIMEOUT_MS);

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(`[${request.stage}] ${message.error.message || "CDP request failed"}`));
  else request.resolve(message);
});
const rejectPending = reason => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`[${request.stage}] ${reason}`));
  }
  pending.clear();
};
socket.addEventListener("close", () => rejectPending("Aboard renderer disconnected"));
socket.addEventListener("error", () => rejectPending("Aboard renderer socket failed"));
const send = (method, params = {}, label = stage, timeoutMs = CDP_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(timeoutError(`${label}: CDP ${method}`, timeoutMs));
  }, timeoutMs);
  pending.set(id, {
    stage: `${label}: CDP ${method}`,
    resolve,
    reject,
    timer
  });
  try {
    socket.send(JSON.stringify({ id, method, params }));
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    reject(new Error(`[${label}: CDP ${method}] ${error.message}`));
  }
});
const sendFresh = async (method, params, label, timeoutMs = CDP_TIMEOUT_MS) => {
  const retrySocket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await withTimeout(new Promise((resolve, reject) => {
      retrySocket.addEventListener("open", resolve, { once: true });
      retrySocket.addEventListener("error", reject, { once: true });
    }), `${label}: reconnect`, CONNECT_TIMEOUT_MS);
    return await withTimeout(new Promise((resolve, reject) => {
      const retryId = 1;
      const onMessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== retryId) return;
        retrySocket.removeEventListener("message", onMessage);
        if (message.error) reject(new Error(`[${label}] ${message.error.message || "CDP request failed"}`));
        else resolve(message);
      };
      retrySocket.addEventListener("message", onMessage);
      retrySocket.send(JSON.stringify({ id: retryId, method, params }));
    }), `${label}: retry CDP ${method}`, timeoutMs);
  } finally {
    retrySocket.close();
  }
};
const sendMouseEvent = async (params, label) => {
  try {
    return await send("Input.dispatchMouseEvent", params, label);
  } catch (error) {
    // Re-dispatching an absolute move at the same coordinates is idempotent,
    // including while the left button is held. Never retry mousePressed.
    const retryIsSafe = params.type === "mouseReleased" || params.type === "mouseMoved";
    if (!retryIsSafe || !/timed out/.test(String(error?.message || error))) throw error;
    return sendFresh("Input.dispatchMouseEvent", params, `${label}: fresh-session retry`);
  }
};
const evaluate = async (expression, label = stage, retryOnFresh = false) => {
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true
  };
  let response;
  try {
    response = await send("Runtime.evaluate", params, label);
  } catch (error) {
    if (!retryOnFresh || !/timed out/.test(String(error?.message || error))) throw error;
    response = await sendFresh("Runtime.evaluate", params, `${label}: fresh-session retry`);
  }
  if (response.result?.exceptionDetails) {
    throw new Error(`[${label}] ${response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text}`);
  }
  return response.result?.result?.value;
};

const mouse = async (type, point, buttons, label = stage) => {
  await sendMouseEvent({
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons,
    clickCount: 1,
    pointerType: "mouse"
  }, `${label}: ${type} (${Math.round(point.x)}, ${Math.round(point.y)})`);
  await wait(24, `${label}: settle ${type}`);
};

const moveAlong = async (from, to, steps = 18, label = stage) => {
  for (let index = 1; index <= steps; index += 1) {
    await mouse("mouseMoved", {
      x: from.x + ((to.x - from.x) * index / steps),
      y: from.y + ((to.y - from.y) * index / steps)
    }, 1, `${label}: move ${index}/${steps}`);
  }
};

const startDrag = async (source, destination, label = stage) => {
  await sendMouseEvent({
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse"
  }, `${label}: prewarm source`);
  await wait(80, `${label}: prewarm settle`);
  await mouse("mouseMoved", source, 0, `${label}: source hover`);
  const hitSourceId = await evaluate(`(() => {
    const point = ${JSON.stringify(source)};
    const row = document.elementFromPoint(point.x, point.y)?.closest?.("[data-app-action-sidebar-thread-row]");
    const raw = row?.dataset?.appActionSidebarThreadId || "";
    return raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
  })()`, `${label}: confirm source hit`, true);
  if (hitSourceId !== setup?.sourceId) {
    throw new Error(`[${label}] trusted source point no longer targets the selected Work row`);
  }
  await mouse("mousePressed", source, 1, `${label}: source press`);
  await mouse("mouseMoved", { x: source.x + 4, y: source.y }, 1, `${label}: threshold 4px`);
  await mouse("mouseMoved", { x: source.x + 10, y: source.y }, 1, `${label}: threshold 10px`);
  await mouse("mouseMoved", { x: source.x + 18, y: source.y + 4 }, 1, `${label}: threshold 18px`);
  let armed = false;
  for (let attempt = 1; attempt <= 5 && !armed; attempt += 1) {
    armed = await evaluate("window.__conversationDashboardDragSession?.source === 'host-pointer'", `${label}: confirm drag start ${attempt}/5`, true);
    if (!armed) await wait(40, `${label}: wait for drag start ${attempt}/5`);
  }
  if (!armed) throw new Error(`[${label}] trusted source press did not start a host-pointer drag session`);
  await moveAlong({ x: source.x + 18, y: source.y + 4 }, destination, 8, `${label}: destination`);
};

const finishDrag = async (destination, label = stage) => {
  await mouse("mouseReleased", destination, 0, `${label}: release`);
  await wait(520, `${label}: drop settle`);
};

let setup;
let result;
let failure;
try {
stage = "setup fixture";
setup = await evaluate(`(async () => {
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.getElementById("conversation-dashboard-sidebar-entry")?.click();
  await sleep(100);
  const sidebarScroller = [...document.querySelectorAll("aside *")].find(element =>
    element.scrollHeight > element.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(element).overflowY)
  );
  if (sidebarScroller) {
    sidebarScroller.scrollTop = 0;
    await sleep(100);
  }
  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  if (!frame || !doc) return { ok: false, reason: "Aboard iframe unavailable" };

  const board = frame.contentWindow.eval("board");
  const importedIds = new Set(board.items.map(item => String(item.url || "").match(/threads\\/([^?/#]+)/i)?.[1]).filter(Boolean));
  const candidates = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].filter(row => {
    const rect = row.getBoundingClientRect();
    const exactLabels = [...row.querySelectorAll("*")].map(element => (element.textContent || "").trim());
    const rawId = row.dataset.appActionSidebarThreadId || "";
    const id = rawId.includes(":") ? rawId.split(":").slice(1).join(":") : rawId;
    return rect.top >= 0 && rect.bottom <= window.innerHeight
      && rect.width > 40 && rect.height > 8
      && (row.dataset.appActionSidebarThreadKind === "local" || exactLabels.includes("Work"))
      && id && row.dataset.appActionSidebarThreadTitle
      && !importedIds.has(id);
  });
  const row = candidates[0] || [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].find(candidate => {
    const rect = candidate.getBoundingClientRect();
    const exactLabels = [...candidate.querySelectorAll("*")].map(element => (element.textContent || "").trim());
    return rect.top >= 0 && rect.bottom <= window.innerHeight
      && (candidate.dataset.appActionSidebarThreadKind === "local" || exactLabels.includes("Work"));
  });
  const workTarget = [...doc.querySelectorAll('[data-drop-kind="work"]')].find(target => {
    const rect = target.getBoundingClientRect();
    return rect.width > 100 && rect.height > 80;
  });
  const chatTarget = doc.querySelector('.chat-list[data-drop-kind="chat"]')
    || doc.querySelector('[data-drop-kind="chat"]');
  if (!row || !workTarget || !chatTarget) return { ok: false, reason: "real source or drop targets unavailable" };

  const frameRect = frame.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const pointInParent = target => {
    const rect = target.getBoundingClientRect();
    return {
      x: frameRect.left + rect.left + Math.min(Math.max(24, rect.width / 2), rect.width - 12),
      y: frameRect.top + rect.top + Math.min(Math.max(24, rect.height / 2), rect.height - 12)
    };
  };
  let blank = null;
  for (let y = Math.max(420, Math.floor(doc.defaultView.innerHeight * 0.55)); y < doc.defaultView.innerHeight - 24 && !blank; y += 40) {
    for (let x = 32; x < doc.defaultView.innerWidth - 32; x += 60) {
      const hit = doc.elementFromPoint(x, y);
      if (hit && !hit.closest("[data-drop-kind], button, a, input, textarea, select")) {
        blank = { x: frameRect.left + x, y: frameRect.top + y };
        break;
      }
    }
  }
  if (!blank) blank = { x: frameRect.right - 28, y: frameRect.bottom - 28 };

  window.__aboardCdpEvents = [];
  window.__aboardCdpHostController?.abort();
  window.__aboardCdpChildController?.abort();
  window.__aboardCdpHostController = new AbortController();
  window.__aboardCdpChildController = new frame.contentWindow.AbortController();
  const record = realm => event => {
    window.__aboardCdpEvents.push({
      realm,
      type: event.type,
      trusted: event.isTrusted,
      pointerId: event.pointerId,
      buttons: event.buttons,
      x: event.clientX,
      y: event.clientY
    });
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    document.addEventListener(type, record("host"), {
      capture: true,
      passive: true,
      signal: window.__aboardCdpHostController.signal
    });
    doc.addEventListener(type, record("child"), {
      capture: true,
      passive: true,
      signal: window.__aboardCdpChildController.signal
    });
  }

  const rawId = row.dataset.appActionSidebarThreadId || "";
  const sourceId = rawId.includes(":") ? rawId.split(":").slice(1).join(":") : rawId;
  return {
    ok: true,
    originalBoard: window.localStorage.getItem("conversation-dashboard-board-v1"),
    source: { x: rowRect.left + Math.min(80, rowRect.width / 3), y: rowRect.top + rowRect.height / 2 },
    sourceId,
    sourceUrl: "codex://threads/" + sourceId,
    work: pointInParent(workTarget),
    workProjectId: workTarget.dataset.projectId,
    chat: pointInParent(chatTarget),
    blank
  };
})()`, stage);

if (!setup?.ok) throw new Error(`[${stage}] ${setup?.reason || "Could not prepare trusted native drag test"}`);

const resetTrace = label => evaluate("window.__aboardCdpEvents = []; true", `${label}: reset trace`);
const phaseState = label => evaluate(`(() => {
  const frame = document.querySelector("#conversation-dashboard-surface iframe");
  const doc = frame?.contentDocument;
  const board = frame?.contentWindow?.eval("board");
  return {
    events: window.__aboardCdpEvents || [],
    session: window.__conversationDashboardDragSession ? {
      id: window.__conversationDashboardDragSession.id,
      source: window.__conversationDashboardDragSession.source,
      targetKey: window.__conversationDashboardDragSession.targetKey,
      dropPoint: window.__conversationDashboardDragSession.dropPoint
    } : null,
    draggedThread: window.__conversationDashboardDraggedThread || null,
    dragging: document.documentElement.dataset.conversationDashboardDragging || "",
    sourceMarked: Boolean(document.querySelector('[data-aboard-dragging="true"]')),
    ownedPreviewCount: document.querySelectorAll("#conversation-dashboard-drag-preview").length,
    guideShown: doc?.getElementById("drag-guide")?.classList.contains("show") === true,
    activeTargets: [...(doc?.querySelectorAll(".is-drop-active, .is-drop-invalid") || [])].map(element => ({
      active: element.classList.contains("is-drop-active"),
      invalid: element.classList.contains("is-drop-invalid"),
      kind: element.dataset.dropKind || "",
      projectId: element.dataset.projectId || "",
      topic: element.dataset.dropTopic || ""
    })),
    board: JSON.stringify(board),
    items: board?.items || [],
    toast: doc?.getElementById("toast")?.textContent || ""
  };
  })()`, `${label}: inspect state`, true);

const sourcePoint = async label => {
  const found = await evaluate(`(async () => {
    const wanted = ${JSON.stringify(setup.sourceId)};
    const normalize = row => {
      const raw = row?.dataset?.appActionSidebarThreadId || "";
      return raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
    };
    const rows = [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")]
      .filter(row => normalize(row) === wanted);
    const row = rows.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 40 && rect.height > 8;
    });
    if (!row) return { ok: false, reason: "source row disappeared" };
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = row.getBoundingClientRect();
    const point = {
      x: rect.left + Math.min(80, rect.width / 3),
      y: rect.top + rect.height / 2
    };
    const hitRow = document.elementFromPoint(point.x, point.y)?.closest?.("[data-app-action-sidebar-thread-row]");
    return {
      ok: rect.top >= 0 && rect.bottom <= window.innerHeight && hitRow === row,
      reason: hitRow === row ? "source outside viewport" : "source is obscured",
      point,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      hitId: normalize(hitRow)
    };
  })()`, `${label}: refresh source row`, true);
  if (!found?.ok) {
    throw new Error(`[${label}: refresh source row] ${found?.reason || "source unavailable"}`);
  }
  return found.point;
};

const targetPoint = async (label, kind, projectId = "") => {
  const found = await evaluate(`(async () => {
    const frame = document.querySelector("#conversation-dashboard-surface iframe");
    const doc = frame?.contentDocument;
    if (!frame || !doc) return { ok: false, reason: "Aboard iframe unavailable" };
    const kind = ${JSON.stringify(kind)};
    const projectId = ${JSON.stringify(projectId)};
    const targets = [...doc.querySelectorAll('[data-drop-kind="' + kind + '"]')];
    // Chat tabs are also classification targets, but this regression is meant
    // to exercise the full list drop area. Selecting the first generic Chat
    // target made the test depend on the tab's compact height after a render.
    const target = kind === "chat"
      ? doc.querySelector('.chat-list[data-drop-kind="chat"]') || targets.find(candidate => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 100 && rect.height > 80;
        })
      : targets.find(candidate => !projectId || candidate.dataset.projectId === projectId);
    if (!target) return { ok: false, reason: "drop target disappeared" };
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const frameRect = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (!(rect.width > 100 && rect.height > 40)) {
      return { ok: false, reason: "target has invalid dimensions" };
    }
    const left = Math.max(1, rect.left + 8);
    const right = Math.min(doc.defaultView.innerWidth - 1, rect.right - 8);
    const top = Math.max(1, rect.top + 8);
    const bottom = Math.min(doc.defaultView.innerHeight - 1, rect.bottom - 8);
    if (right <= left || bottom <= top) {
      return { ok: false, reason: "target is outside the visible iframe" };
    }

    // The previous phase can leave a toast over the card centre. Search the
    // target's visible area for a point that Chromium itself resolves back to
    // this exact drop container instead of trusting a stale geometric centre.
    const candidates = [
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + Math.min(28, (right - left) / 3), y: top + Math.min(28, (bottom - top) / 3) },
      { x: right - Math.min(28, (right - left) / 3), y: top + Math.min(28, (bottom - top) / 3) }
    ];
    const xStep = Math.max(16, Math.min(32, (right - left) / 10));
    const yStep = Math.max(16, Math.min(32, (bottom - top) / 8));
    for (let y = top; y <= bottom; y += yStep) {
      for (let x = left; x <= right; x += xStep) candidates.push({ x, y });
    }
    const seen = new Set();
    const obscurers = new Set();
    for (const point of candidates) {
      const key = Math.round(point.x) + ":" + Math.round(point.y);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = doc.elementFromPoint(point.x, point.y);
      const hitTarget = hit?.closest?.("[data-drop-kind]");
      if (hitTarget === target) {
        return {
          ok: true,
          point: { x: frameRect.left + point.x, y: frameRect.top + point.y }
        };
      }
      obscurers.add(hitTarget?.dataset?.dropKind || hit?.id || hit?.className || hit?.tagName || "none");
    }
    return {
      ok: false,
      reason: "target is obscured across its visible area",
      obscurers: [...obscurers].slice(0, 6)
    };
  })()`, `${label}: refresh ${kind} target`, true);
  if (!found?.ok) {
    const obscurers = found?.obscurers?.length ? `; hits=${found.obscurers.join(",")}` : "";
    throw new Error(`[${label}: refresh ${kind} target] ${found?.reason || "target unavailable"}${obscurers}`);
  }
  return found.point;
};

const blankPoint = async label => {
  const found = await evaluate(`(() => {
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
    return null;
  })()`, `${label}: refresh blank target`, true);
  if (!found) throw new Error(`[${label}: refresh blank target] blank point unavailable`);
  return found;
};

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
  && !state.sourceMarked && state.ownedPreviewCount === 0
  && !state.guideShown && state.activeTargets.length === 0;

const resetGesture = async label => {
  stage = `${label}: reset gesture`;
  // Electron can leave Input.dispatchMouseEvent unanswered in the native
  // titlebar corner. Use a verified renderer point with no drop target instead.
  const safe = await blankPoint(`${label}: reset gesture`);
  await sendMouseEvent({
    type: "mouseReleased",
    x: safe.x,
    y: safe.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse"
  }, `${label}: reset pointer buttons`);
  await sendMouseEvent({
    type: "mouseMoved",
    x: safe.x,
    y: safe.y,
    button: "none",
    buttons: 0,
    clickCount: 0,
    pointerType: "mouse"
  }, `${label}: reset pointer position`);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true", `${label}: cancel stale gesture`);
  await wait(160, `${label}: reset settle`);
  const state = await phaseState(`${label}: after reset`);
  if (!cleaned(state)) throw new Error(`[${label}: reset gesture] Native drag gesture did not reset before phase`);

  // A completed cross-frame drag can leave Chromium's synthetic pointer at the
  // previous child coordinate. Re-resolve the real row after every board render,
  // then approach it with buttons up before beginning the next gesture.
  const source = await sourcePoint(label);
  for (let index = 1; index <= 4; index += 1) {
    await mouse("mouseMoved", {
      x: safe.x + ((source.x - safe.x) * index / 4),
      y: safe.y + ((source.y - safe.y) * index / 4)
    }, 0, `${label}: prewarm ${index}/4`);
  }
  await wait(120, `${label}: source prewarm settle`);
  await resetTrace(label);
  return source;
};

  stage = "valid work drop";
  const validSource = await resetGesture("valid work drop");
  const validTarget = await targetPoint("valid work drop", "work", setup.workProjectId);
  await startDrag(validSource, validTarget, "valid work drop");
  const validHover = await phaseState("valid work hover");
  await finishDrag(validTarget, "valid work drop");
  const validDrop = await phaseState("valid work result");
  const validItems = validDrop.items.filter(item => item.url === setup.sourceUrl);
  const valid = {
    hoverStarted: validHover.session?.source === "host-pointer",
    hoverTargeted: validHover.session?.targetKey === `work:${setup.workProjectId}`,
    ownedPreviewSuppressed: validHover.ownedPreviewCount === 0,
    highlighted: validHover.activeTargets.some(target => target.active && target.kind === "work" && target.projectId === setup.workProjectId),
    importedOnce: validItems.length === 1,
    importedToProject: validItems[0]?.kind === "work" && validItems[0]?.projectId === setup.workProjectId,
    trustedPath: trustedPath(validDrop.events),
    singleHostTerminal: singleHostTerminal(validDrop.events),
    cleaned: cleaned(validDrop)
  };

  result = {
    ok: Object.values(valid).every(Boolean),
    version: await evaluate("window.__conversationDashboardVersion", "read installed version", true),
    valid
  };
} catch (error) {
  failure = error;
  result = result || {
    ok: false,
    failedStage: stage,
    error: error instanceof Error ? error.message : String(error)
  };
} finally {
  stage = "restore original board";
  const cleanupErrors = [];
  let restored = !setup || !Object.hasOwn(setup, "originalBoard");
  if (setup && Object.hasOwn(setup, "originalBoard")) {
    // Restore persistent storage and the in-memory model before rendering. If
    // rendering ever stalls, the exact original board is already safe and no
    // delayed save can write the fixture back over it.
    try {
      await evaluate(`(() => {
        window.__aboardCdpHostController?.abort();
        window.__aboardCdpChildController?.abort();
        delete window.__aboardCdpHostController;
        delete window.__aboardCdpChildController;
        delete window.__aboardCdpEvents;
        const frame = document.querySelector("#conversation-dashboard-surface iframe");
        if (frame?.contentWindow) frame.contentWindow.eval("clearTimeout(saveTimer); saveTimer = null; internalDrag = null");
        const original = ${JSON.stringify(setup.originalBoard)};
        if (original == null) window.localStorage.removeItem("conversation-dashboard-board-v1");
        else window.localStorage.setItem("conversation-dashboard-board-v1", original);
        if (frame?.contentWindow) frame.contentWindow.eval("(() => { let restored = fallbackBoard; try { const raw = window.parent.localStorage.getItem(storageKey); if (raw) restored = JSON.parse(raw); } catch (_) {} board = normalizeBoard(restored); activeTab = board.defaultTab || 'professional'; query = ''; modal = null; floatingMenu = null; internalDrag = null; clearTimeout(saveTimer); saveTimer = null; })()");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return true;
      })()`, `${stage}: restore storage and model`);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await evaluate(`(() => {
        const frame = document.querySelector("#conversation-dashboard-surface iframe");
        if (!frame?.contentWindow) return false;
        frame.contentWindow.eval("render(); clearTimeout(saveTimer); saveTimer = null");
        return true;
      })()`, `${stage}: render restored model`);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    await wait(80, `${stage}: settle restored model`).catch(error => cleanupErrors.push(error.message));
    try {
      restored = await evaluate(
        `window.localStorage.getItem("conversation-dashboard-board-v1") === ${JSON.stringify(setup.originalBoard)}`,
        `${stage}: verify exact storage`
      );
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
      restored = false;
    }
  }

  result = result || { ok: false, error: failure?.message || "Native drag test did not produce a result" };
  result.boardRestored = restored;
  result.ok = Boolean(result.ok && restored && cleanupErrors.length === 0);
  if (cleanupErrors.length) result.cleanupErrors = cleanupErrors;

  try {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
      socket.close();
      await withTimeout(closed, "close Aboard renderer socket", 1_000);
    }
  } catch (error) {
    rejectPending("test cleanup closed the socket");
    result.socketCloseError = error instanceof Error ? error.message : String(error);
    result.ok = false;
  }
}

console.log(JSON.stringify(result, null, 2));
process.exitCode = result?.ok ? 0 : 1;
// Node's built-in WebSocket has no terminate() method. This bounded fallback
// prevents an abnormal close handshake from keeping an installed-suite process
// alive after board restoration and result output.
setTimeout(() => process.exit(process.exitCode || 0), 1_200).unref();
