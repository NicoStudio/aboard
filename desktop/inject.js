(() => {
  "use strict";

  const ACTIVE_HANDOFF_BINDING = __ABOARD_HANDOFF_BINDING__;
  window.__conversationDashboardBindingName = ACTIVE_HANDOFF_BINDING;
  const INJECTION_VERSION = 64;
  if (window.__conversationDashboardInstalled) {
    if (window.__conversationDashboardVersion === INJECTION_VERSION) return;
    window.__conversationDashboardCleanup?.();
    // A version refresh must rebuild the entry and iframe because their event
    // listeners belong to the aborted controller from the previous injection.
    document.getElementById("conversation-dashboard-sidebar-entry")?.remove();
    document.getElementById("conversation-dashboard-surface")?.remove();
    clearInterval(window.__conversationDashboardMetadataPollTimer);
    document.getElementById("conversation-dashboard-host-style")?.remove();
    document.getElementById("conversation-dashboard-drop-catcher")?.remove();
    document.getElementById("conversation-dashboard-drag-preview")?.remove();
    document.getElementById("conversation-dashboard-return")?.remove();
    document.querySelectorAll("[data-conversation-dashboard-draggable]").forEach(row => {
      const original = row.dataset.conversationDashboardOriginalDraggable;
      if (original && original !== "__missing__") row.setAttribute("draggable", original);
      else row.removeAttribute("draggable");
      delete row.dataset.conversationDashboardDraggable;
      delete row.dataset.conversationDashboardOriginalDraggable;
      delete row.dataset.aboardDragging;
    });
    const root = document.documentElement;
    if (root) {
      delete root.dataset.conversationDashboardActive;
      delete root.dataset.conversationDashboardDragging;
    }
    const hiddenMain = document.querySelector("main[data-conversation-dashboard-hidden]");
    if (hiddenMain) {
      hiddenMain.style.visibility = "";
      hiddenMain.removeAttribute("aria-hidden");
      delete hiddenMain.dataset.conversationDashboardHidden;
    }
  }
  window.__conversationDashboardInstalled = true;
  window.__conversationDashboardVersion = INJECTION_VERSION;

  const DASHBOARD_HTML = __CONVERSATION_DASHBOARD_HTML__;
  const CODEX_THREAD_METADATA = __CODEX_THREAD_METADATA__;
  const HANDOFF_ENDPOINT = __ABOARD_HANDOFF_ENDPOINT__;
  const HANDOFF_TOKEN = __ABOARD_HANDOFF_TOKEN__;
  const ENTRY_ID = "conversation-dashboard-sidebar-entry";
  const SURFACE_ID = "conversation-dashboard-surface";
  const STYLE_ID = "conversation-dashboard-host-style";
  const DRAG_PREVIEW_ID = "conversation-dashboard-drag-preview";
  const RETURN_ID = "conversation-dashboard-return";
  const NATIVE_VIEW_STATE_KEY = "conversation-dashboard-native-view";
  const NATIVE_ID_ALIASES_KEY = "conversation-dashboard-native-id-aliases";
  const PLUGINS_LABELS = new Set(["Plugins", "插件"]);
  const WORK_THREAD_SELECTOR = "[data-app-action-sidebar-thread-row]";
  const CHAT_THREAD_WRAPPER_SELECTOR = '[data-sidebar-chatgpt-conversation-key^="chatgpt:conversation:"]';
  const CHAT_THREAD_SELECTOR = `${CHAT_THREAD_WRAPPER_SELECTOR} .sidebar-item`;
  const PROJECT_THREAD_SELECTOR = '[data-sidebar-project-kind] .sidebar-item[role="button"]:has([data-thread-title]):not([data-app-action-sidebar-thread-row])';
  const NATIVE_THREAD_SELECTOR = `:is(${WORK_THREAD_SELECTOR}, ${CHAT_THREAD_SELECTOR}, ${PROJECT_THREAD_SELECTOR})`;
  let active = false;
  let previousMain = null;
  let observer = null;
  let themeObserver = null;
  let domStartupFrame = null;
  let domStartupStarted = false;
  let dragSession = null;
  let dragSessionSequence = 0;
  let dragHardTimer = null;
  let dragPreviewFrame = null;
  let dragPreviewPoint = null;
  let pendingCreation = null;
  let pendingCreationPollTimer = null;
  let nativeCreationStarting = false;
  let captureCreationInFlight = false;
  let lastMetadataSignature = "";
  let metadataPollTimer = null;
  let metadataDebounceTimer = null;
  let runtimeStatusRequestInFlight = false;
  let nativeRefreshFrame = null;
  let recentHydrationPromise = null;
  let recentHydrationButton = null;
  let recentHydrationCacheSize = -1;
  let recentHydrationAttempts = 0;
  let pointerCandidate = null;
  let childPointerController = null;
  let lastHandoffSignature = "";
  let lastHandoffAt = 0;
  let lastOpenErrorMessage = "";
  let lastCompletedDragAt = 0;
  const hostBridgeWaiters = new Map();
  const resolveHostBridge = (requestId, result = {}) => {
    const waiter = hostBridgeWaiters.get(String(requestId || ""));
    if (!waiter) return;
    hostBridgeWaiters.delete(String(requestId || ""));
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  };
  window.__conversationDashboardResolveBridge = resolveHostBridge;

  function callHostBridgeResult(method, payload, timeoutMs = 4_000) {
    if (window.__conversationDashboardUseHttpTestBridge === true) return null;
    const binding = window[window.__conversationDashboardBindingName];
    if (typeof binding !== "function") return null;
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        hostBridgeWaiters.delete(requestId);
        resolve({ ok: false, error: "Aboard bridge timed out" });
      }, timeoutMs);
      hostBridgeWaiters.set(requestId, { resolve, timer });
      try {
        binding(JSON.stringify({ requestId, method, payload }));
      } catch (_) {
        clearTimeout(timer);
        hostBridgeWaiters.delete(requestId);
        resolve({ ok: false, error: "Aboard bridge is unavailable" });
      }
    });
  }

  function callHostBridge(method, payload, timeoutMs = 4_000) {
    const result = callHostBridgeResult(method, payload, timeoutMs);
    return result?.then(value => Boolean(value?.ok));
  }

  let lastCompletedDragRow = null;
  const listenerController = new AbortController();
  const listenerOptions = { signal: listenerController.signal };

  const icon = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x=".5" y=".5" width="15" height="15" rx="3.4" fill="#0B4F43"/>
      <g transform="rotate(8 5.15 12.6)"><rect x="3.4" y="3.4" width="3.5" height="9.2" rx="1.1" fill="#E1F1EA"/></g>
      <g transform="rotate(-8 10.85 12.6)"><rect x="9.1" y="5.8" width="3.5" height="6.8" rx="1.1" fill="#69BFA2"/></g>
    </svg>`;

  function visibleText(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findPluginsButton() {
    return [...document.querySelectorAll("button")].find(button => PLUGINS_LABELS.has(visibleText(button))) || null;
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: color-mix(in srgb, #69BFA2 18%, var(--color-background-surface, transparent));
      }
      #${SURFACE_ID} {
        position: absolute;
        inset: 0;
        z-index: 2147482000;
        display: none;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--color-background-surface, #f5f6f8);
      }
      #${SURFACE_ID}[data-active="true"] { display: block; }
      #${SURFACE_ID} iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--color-background-surface, #f5f6f8);
      }
      #${RETURN_ID} {
        position: fixed;
        z-index: 2147481999;
        display: none;
        align-items: center;
        gap: 7px;
        box-sizing: border-box;
        min-width: 0;
        height: 36px;
        padding: 0 12px 0 10px;
        border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
        border-radius: 12px;
        background: color-mix(in srgb, var(--color-background-panel, #fff) 94%, transparent);
        color: var(--color-text-foreground, #20242d);
        box-shadow: 0 8px 24px rgba(20, 27, 45, .14);
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
        cursor: pointer;
        white-space: nowrap;
      }
      #${RETURN_ID}[data-visible="true"] { display: inline-flex; }
      #${RETURN_ID}:hover { background: var(--color-background-panel, #fff); }
      #${RETURN_ID}:focus-visible {
        outline: 2px solid #69BFA2;
        outline-offset: 2px;
      }
      #${RETURN_ID} .aboard-return-arrow {
        display: inline-flex;
        width: 16px;
        height: 16px;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        font-weight: 500;
        transform: translateY(-.5px);
      }
      ${NATIVE_THREAD_SELECTOR}:hover {
        background: var(--color-background-surface, rgba(0,0,0,.055)) !important;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent);
      }
      html[data-conversation-dashboard-active="true"] ${NATIVE_THREAD_SELECTOR}:hover {
        cursor: grab;
      }
      html[data-conversation-dashboard-dragging="true"] ${NATIVE_THREAD_SELECTOR}[data-aboard-dragging="true"] {
        cursor: grabbing;
        opacity: .48;
      }
      #${DRAG_PREVIEW_ID} {
        position: fixed;
        inset: 0 auto auto 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        gap: 8px;
        box-sizing: border-box;
        min-width: 0;
        padding: 4px 8px;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        border-radius: 10px;
        background: var(--color-background-panel, var(--color-background-surface, #fff));
        color: var(--color-text-foreground, #20242d);
        box-shadow: 0 8px 22px rgba(20, 27, 45, .18);
        opacity: .72;
        pointer-events: none !important;
        user-select: none;
        will-change: transform;
        contain: layout paint style;
        font: 500 13px/1.25 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      }
      #${DRAG_PREVIEW_ID} .aboard-drag-preview-icon {
        display: flex;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        align-items: center;
        justify-content: center;
        color: var(--color-text-foreground-muted, #697386);
      }
      #${DRAG_PREVIEW_ID} .aboard-drag-preview-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${SURFACE_ID}[data-aboard-theme="dark"],
      #${SURFACE_ID}[data-aboard-theme="dark"] iframe { background: #12151b; }
      html[data-conversation-dashboard-theme="dark"] #${DRAG_PREVIEW_ID} {
        border-color: rgba(255, 255, 255, .12);
        background: var(--color-background-panel, var(--color-background-surface, #242832));
        color: var(--color-text-foreground, #f2f4f8);
        box-shadow: 0 10px 26px rgba(0, 0, 0, .32);
      }
      html[data-conversation-dashboard-theme="dark"] #${RETURN_ID} {
        border-color: rgba(255, 255, 255, .14);
        background: color-mix(in srgb, var(--color-background-panel, #242832) 94%, transparent);
        color: var(--color-text-foreground, #f2f4f8);
        box-shadow: 0 10px 28px rgba(0, 0, 0, .32);
      }
      #${SURFACE_ID}[data-aboard-theme="light"],
      #${SURFACE_ID}[data-aboard-theme="light"] iframe { background: #f5f6f8; }
      @media (prefers-color-scheme: dark) {
        html:not(.electron-light):not(.electron-dark) #${SURFACE_ID} iframe { background: #12151b; }
        html:not(.electron-light):not(.electron-dark) #${DRAG_PREVIEW_ID} {
          border-color: rgba(255, 255, 255, .12);
          background: var(--color-background-panel, var(--color-background-surface, #242832));
          color: var(--color-text-foreground, #f2f4f8);
          box-shadow: 0 10px 26px rgba(0, 0, 0, .32);
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createEntry(pluginsButton) {
    const entry = document.createElement("button");
    entry.id = ENTRY_ID;
    entry.type = "button";
    entry.className = pluginsButton.className;
    entry.setAttribute("aria-label", "Aboard");
    entry.innerHTML = `
      <div class="flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground">
        <span class="flex w-4 shrink-0 items-center justify-center">${icon}</span>
        <span class="truncate">Aboard</span>
      </div>`;
    entry.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      returnToDashboard();
    });
    pluginsButton.insertAdjacentElement("afterend", entry);
    return entry;
  }

  function findWorkspaceMain(entry) {
    const leftPanel = entry.closest("aside");
    const shell = leftPanel?.parentElement;
    if (!shell) return null;
    return [...shell.children].find(child => child !== leftPanel && child.matches?.("main")) || shell.querySelector(":scope > main");
  }

  function syncSurfaceBounds(surface, main) {
    if (!surface || !main) return;
    const host = surface.parentElement;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    surface.style.inset = "auto";
    surface.style.left = `${Math.max(0, mainRect.left - hostRect.left)}px`;
    surface.style.top = `${Math.max(0, mainRect.top - hostRect.top)}px`;
    surface.style.width = `${mainRect.width}px`;
    surface.style.height = `${mainRect.height}px`;
    syncReturnControlPosition(main);
  }

  function syncReturnControlPosition(main = previousMain) {
    const control = document.getElementById(RETURN_ID);
    if (!control || !main) return;
    const rect = main.getBoundingClientRect();
    control.style.left = `${Math.max(12, Math.round(rect.left + 12))}px`;
    control.style.top = `${Math.max(12, Math.round(rect.top + 12))}px`;
  }

  function ensureReturnControl() {
    let control = document.getElementById(RETURN_ID);
    if (control) return control;
    control = document.createElement("button");
    control.id = RETURN_ID;
    control.type = "button";
    control.dataset.visible = "false";
    control.setAttribute("aria-label", "返回 Aboard");
    control.innerHTML = `<span class="aboard-return-arrow" aria-hidden="true">‹</span><span>返回 Aboard</span>`;
    control.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      returnToDashboard();
    });
    document.body.appendChild(control);
    syncReturnControlPosition();
    return control;
  }

  function showReturnControl() {
    const control = ensureReturnControl();
    control.dataset.visible = "true";
    control.removeAttribute("aria-hidden");
    syncReturnControlPosition();
  }

  function hideReturnControl() {
    const control = document.getElementById(RETURN_ID);
    if (!control) return;
    control.dataset.visible = "false";
    control.setAttribute("aria-hidden", "true");
  }

  function ensureSurface(entry) {
    let surface = document.getElementById(SURFACE_ID);
    if (surface) {
      const existingFrame = surface.querySelector("iframe");
      if (existingFrame?.dataset?.conversationDashboard !== "true") {
        surface.replaceChildren(createDashboardFrame());
      }
      const main = previousMain?.isConnected ? previousMain : findWorkspaceMain(entry);
      if (main) {
        previousMain = main;
        syncSurfaceBounds(surface, main);
      }
      return surface;
    }
    const main = findWorkspaceMain(entry);
    if (!main?.parentElement) return null;
    previousMain = main;
    const host = main.parentElement;
    const hostStyle = getComputedStyle(host);
    if (hostStyle.position === "static") host.style.position = "relative";
    surface = document.createElement("section");
    surface.id = SURFACE_ID;
    surface.setAttribute("aria-label", "Aboard");
    surface.appendChild(createDashboardFrame());
    host.appendChild(surface);
    syncSurfaceBounds(surface, main);
    return surface;
  }

  function createDashboardFrame() {
    const frame = document.createElement("iframe");
    frame.title = "Aboard";
    frame.dataset.conversationDashboard = "true";
    frame.dataset.aboardTheme = hostTheme();
    frame.style.colorScheme = frame.dataset.aboardTheme;
    frame.allow = "clipboard-read; clipboard-write";
    frame.srcdoc = DASHBOARD_HTML;
    frame.addEventListener("load", syncHostTheme, listenerOptions);
    return frame;
  }

  function hostTheme() {
    if (document.documentElement.classList.contains("electron-dark")) return "dark";
    if (document.documentElement.classList.contains("electron-light")) return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }

  function syncHostTheme() {
    const theme = hostTheme();
    document.documentElement.dataset.conversationDashboardTheme = theme;
    const surface = document.getElementById(SURFACE_ID);
    if (surface) surface.dataset.aboardTheme = theme;
    const frame = surface?.querySelector("iframe");
    if (!frame) return;
    frame.dataset.aboardTheme = theme;
    frame.style.colorScheme = theme;
    frame.contentWindow?.postMessage({ method: "conversation-dashboard/theme", theme }, "*");
  }

  function nativeSurfaceKind(row, title) {
    const titleNode = row?.querySelector?.("[data-thread-title]") || null;
    const labelScope = titleNode?.parentElement || row;
    const exactLabels = [...(labelScope?.querySelectorAll?.("span") || [])]
      .filter(element => element !== titleNode && !titleNode?.contains?.(element))
      .map(element => visibleText(element))
      .filter(label => label === "Chat" || label === "Work" || label === "Codex");
    if (exactLabels.includes("Chat")) return "chat";
    if (exactLabels.includes("Work") || exactLabels.includes("Codex")) return "work";
    const suffix = visibleText(row).replace(String(title || ""), "").trim();
    if (/(^|\s)Chat($|\s)/i.test(suffix)) return "chat";
    if (/(^|\s)(Work|Codex)($|\s)/i.test(suffix)) return "work";
    return "";
  }

  function chatConversationWrapper(row) {
    return row?.closest?.(CHAT_THREAD_WRAPPER_SELECTOR) || null;
  }

  function reactProps(element) {
    if (!element) return null;
    const key = Object.keys(element).find(candidate => candidate.startsWith("__reactProps"));
    return key ? element[key] : null;
  }

  function conversationFromProps(props) {
    const candidates = [
      props?.conversation,
      props?.item?.conversation,
      props?.children?.props?.item?.conversation,
      props?.children?.props?.children?.props?.item?.conversation
    ];
    return candidates.find(candidate => candidate?.id) || null;
  }

  function projectConversationData(row) {
    if (!row?.matches?.(PROJECT_THREAD_SELECTOR)) return null;
    const visibleTitle = visibleText(row.querySelector("[data-thread-title]"));

    for (let element = row, depth = 0; element && depth < 4; element = element.parentElement, depth += 1) {
      const conversation = conversationFromProps(reactProps(element));
      if (conversation?.id && (!conversation.title || conversation.title === visibleTitle)) return conversation;
    }

    const fiberKey = Object.keys(row).find(candidate => candidate.startsWith("__reactFiber"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 24; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const conversation = conversationFromProps(props);
      if (conversation?.id && (!conversation.title || conversation.title === visibleTitle)) return conversation;
      const id = String(props?.conversationId || "").trim();
      const route = String(props?.route || "").trim();
      const title = String(props?.title || "").trim();
      if (id && route.endsWith(`/${id}`) && (!title || title === visibleTitle)) {
        return {
          id,
          title,
          create_time: props?.create_time || "",
          update_time: props?.update_time || ""
        };
      }
    }
    return null;
  }

  function normalizedNativeId(rawId) {
    const value = String(rawId || "").trim();
    if (value.startsWith("chatgpt:conversation:")) return value.slice("chatgpt:conversation:".length);
    return value.includes(":") ? value.split(":").slice(1).join(":") : value;
  }

  function stableLocalThreadId(value) {
    const id = String(value || "").trim();
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : "";
  }

  function resolvedWorkConversationId(row) {
    if (!row?.matches?.(WORK_THREAD_SELECTOR)) return "";
    const visibleTitle = String(row?.dataset?.appActionSidebarThreadTitle || "").trim()
      || visibleText(row?.querySelector?.("[data-thread-title]"));
    const fiberKey = Object.keys(row).find(candidate => candidate.startsWith("__reactFiber"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 16; fiber = fiber.return, depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const conversation = conversationFromProps(props);
      const candidates = [
        { id: props?.conversationId, title: props?.title },
        { id: props?.entry?.conversationId, title: props?.entry?.title },
        { id: conversation?.id, title: conversation?.title }
      ];
      for (const candidate of candidates) {
        const id = stableLocalThreadId(candidate.id);
        const title = String(candidate.title || "").trim();
        if (id && (!title || !visibleTitle || title === visibleTitle)) return id;
      }
    }
    return "";
  }

  function rawRowId(row) {
    const wrapperKey = chatConversationWrapper(row)?.dataset?.sidebarChatgptConversationKey || "";
    const projectConversationId = projectConversationData(row)?.id || "";
    return normalizedNativeId(row?.dataset?.appActionSidebarThreadId || wrapperKey || projectConversationId);
  }

  function currentRouteConversationId() {
    try {
      const pathname = decodeURIComponent(location.pathname).replace(/\/$/, "");
      return pathname.match(/^\/local\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i)?.[1]
        || pathname.match(/^\/work\/conversation\/([A-Za-z0-9_-]{12,})$/)?.[1]
        || "";
    } catch {
      return "";
    }
  }

  function currentRouteSurfaceKind() {
    try {
      const pathname = decodeURIComponent(location.pathname).replace(/\/$/, "");
      if (/^\/local\//i.test(pathname)) return "work";
      if (/^\/work\/conversation\//i.test(pathname)) return "chat";
    } catch {}
    return "";
  }

  function nativeIdAliases() {
    try {
      const value = JSON.parse(sessionStorage.getItem(NATIVE_ID_ALIASES_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function rememberNativeIdAlias(provisionalId, stableId) {
    if (!String(provisionalId).startsWith("client-new-thread:") || !stableLocalThreadId(stableId) || stableId === provisionalId) return;
    const aliases = nativeIdAliases();
    aliases[provisionalId] = stableId;
    const entries = Object.entries(aliases).slice(-64);
    try { sessionStorage.setItem(NATIVE_ID_ALIASES_KEY, JSON.stringify(Object.fromEntries(entries))); } catch {}
  }

  function normalizedRowId(row) {
    const id = rawRowId(row);
    if (!id.startsWith("client-new-thread:")) return id;
    const resolvedId = resolvedWorkConversationId(row);
    if (resolvedId) {
      rememberNativeIdAlias(id, resolvedId);
      return resolvedId;
    }
    if (nativeRowActive(row)) {
      const stableId = stableLocalThreadId(currentRouteConversationId());
      if (stableId) {
        rememberNativeIdAlias(id, stableId);
        return stableId;
      }
    }
    return String(nativeIdAliases()[id] || id);
  }

  function nativeRowTitle(row, cache = null) {
    const directTitle = String(row?.dataset?.appActionSidebarThreadTitle || "").trim();
    if (directTitle) return directTitle;
    const visibleTitle = visibleText(row?.querySelector?.("[data-thread-title]"));
    if (visibleTitle) return visibleTitle;
    const cachedTitle = String(cache?.get?.(normalizedRowId(row))?.title || "").trim();
    if (cachedTitle) return cachedTitle;
    const ariaTitle = String(row?.getAttribute?.("aria-label") || "").trim();
    if (ariaTitle) return ariaTitle;
    return visibleText(row).replace(/\s*(Chat|Work|Codex)\s*$/i, "").trim();
  }

  function nativeRowActive(row) {
    const wrapper = chatConversationWrapper(row);
    return row?.dataset?.appActionSidebarThreadActive === "true"
      || row?.getAttribute?.("aria-current") === "page"
      || row?.getAttribute?.("aria-current") === "true"
      || wrapper?.getAttribute?.("aria-current") === "page"
      || wrapper?.getAttribute?.("aria-current") === "true";
  }

  function nativeRuntimeStatus(row) {
    const rowSignals = [row, ...(row?.querySelectorAll?.("[aria-label], [title], [data-status], [data-state], [data-testid]") || [])]
      .flatMap(element => [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.getAttribute?.("data-status"),
        element.getAttribute?.("data-state"),
        element.getAttribute?.("data-testid")
      ])
      .filter(Boolean)
      .join(" ");
    if (/waiting[-_ ]?on[-_ ]?approval|等待批准/i.test(rowSignals)) return "waitingOnApproval";
    if (/waiting[-_ ]?on[-_ ]?user[-_ ]?input|等待输入/i.test(rowSignals)) return "waitingOnUserInput";
    if (/(^|\s)(running|working|thinking|generating|active)($|\s)|进行中|生成中|思考中/i.test(rowSignals)) return "active";

    if (!nativeRowActive(row)) return "idle";
    const main = previousMain || document.querySelector("main, [role='main']");
    if (!main) return "idle";
    const controls = [...main.querySelectorAll("button[aria-label], button[title], [role='button'][aria-label]")]
      .flatMap(element => [element.getAttribute("aria-label"), element.getAttribute("title")])
      .filter(Boolean)
      .join(" ");
    if (/waiting[-_ ]?on[-_ ]?approval|approve action|review approval|等待批准|批准后继续/i.test(controls)) return "waitingOnApproval";
    if (/waiting[-_ ]?on[-_ ]?user[-_ ]?input|provide input|等待输入|需要输入/i.test(controls)) return "waitingOnUserInput";
    if (/stop generating|stop response|cancel response|interrupt task|停止生成|停止回复|中止任务/i.test(controls)) return "active";
    return "idle";
  }

  function threadPayload(row, cache = conversationCache()) {
    const chatWrapper = chatConversationWrapper(row);
    const projectConversation = projectConversationData(row);
    const projectSurfaceKind = projectConversation
      ? nativeSurfaceKind(row, visibleText(row.querySelector("[data-thread-title]")))
      : "";
    const chatSource = Boolean(chatWrapper || projectSurfaceKind === "chat");
    const id = normalizedRowId(row);
    const hostId = row?.dataset?.appActionSidebarThreadHostId || (projectSurfaceKind === "work" ? "local" : "");
    const nativeKind = chatSource ? "cloud" : row?.dataset?.appActionSidebarThreadKind || (projectSurfaceKind === "work" ? "local" : "");
    const title = nativeRowTitle(row, cache);
    if (!id) return null;
    const validId = chatSource ? /^[A-Za-z0-9_-]{12,}$/.test(id) : Boolean(stableLocalThreadId(id));
    if (!validId) return null;
    const url = chatSource
      ? `https://chatgpt.com/c/${id}`
      : nativeKind === "cloud" && hostId
        ? `codex://threads/${id}?hostId=${encodeURIComponent(hostId)}`
        : `codex://threads/${id}`;
    const cached = cache.get(id) || {};
    const codex = CODEX_THREAD_METADATA[id] || {};
    return {
      id,
      hostId,
      nativeKind,
      surfaceKind: nativeSurfaceKind(row, title) || (chatSource ? "chat" : nativeKind === "local" ? "work" : nativeKind === "cloud" ? "chat" : ""),
      title,
      url,
      runtimeStatus: nativeRuntimeStatus(row),
      createdAt: cached.create_time || projectConversation?.create_time || projectConversation?.created_at || codex.createdAt || "",
      updatedAt: cached.update_time || projectConversation?.update_time || projectConversation?.updated_at || codex.updatedAt || ""
    };
  }

  function selectedThreadRows(draggedRow) {
    const selected = allThreadRows().filter(row => {
      const containers = [row, row.closest('[aria-selected], [aria-checked], [data-state="selected"]')].filter(Boolean);
      return row.dataset.appActionSidebarThreadSelected === "true"
        || containers.some(element => element.getAttribute("aria-selected") === "true"
          || element.getAttribute("aria-checked") === "true"
          || element.getAttribute("data-state") === "selected");
    });
    return selected.length > 1 && selected.includes(draggedRow) ? selected : [draggedRow];
  }

  function nativeDragPayload(row) {
    const cache = conversationCache();
    const threads = selectedThreadRows(row)
      .map(candidate => threadPayload(candidate, cache))
      .filter(Boolean)
      .map(thread => ({ ...thread, title: thread.title || "未命名会话" }));
    if (!threads.length) return null;
    return threads.length === 1 ? threads[0] : { bulk: true, threads };
  }

  function payloadThreads(payload) {
    return payload?.bulk && Array.isArray(payload.threads) ? payload.threads : payload ? [payload] : [];
  }

  function payloadSurfaceKind(payload) {
    const kinds = new Set(payloadThreads(payload).map(thread => thread?.surfaceKind).filter(Boolean));
    return kinds.size === 1 ? [...kinds][0] : "mixed";
  }

  function dashboardFrame() {
    return document.querySelector(`#${SURFACE_ID} iframe`);
  }

  function postDragMessage(method, point = null, state = dragSession) {
    dashboardFrame()?.contentWindow?.postMessage({
      method,
      point,
      payload: state?.payload || null,
      sessionId: state?.id || ""
    }, "*");
  }

  function removeNativeDragPreview() {
    if (dragPreviewFrame) cancelAnimationFrame(dragPreviewFrame);
    dragPreviewFrame = null;
    dragPreviewPoint = null;
    document.getElementById(DRAG_PREVIEW_ID)?.remove();
  }

  function renderNativeDragPreview(point = dragPreviewPoint) {
    const preview = document.getElementById(DRAG_PREVIEW_ID);
    const anchor = pointerCandidate?.previewAnchor;
    if (!preview || !anchor || !point) return;
    const x = anchor.left + point.x - anchor.pointerX;
    const y = anchor.top + point.y - anchor.pointerY;
    preview.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function updateNativeDragPreview(point, immediate = false) {
    if (!point || !document.getElementById(DRAG_PREVIEW_ID)) return;
    dragPreviewPoint = point;
    if (immediate) {
      if (dragPreviewFrame) cancelAnimationFrame(dragPreviewFrame);
      dragPreviewFrame = null;
      renderNativeDragPreview(point);
      return;
    }
    if (dragPreviewFrame) return;
    dragPreviewFrame = requestAnimationFrame(() => {
      dragPreviewFrame = null;
      renderNativeDragPreview();
    });
  }

  function createNativeDragPreview(candidate, sessionId) {
    removeNativeDragPreview();
    if (!candidate?.row || payloadSurfaceKind(candidate.payload) !== "chat") return;
    const threads = payloadThreads(candidate.payload);
    const rect = candidate.row.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;

    const preview = document.createElement("div");
    preview.id = DRAG_PREVIEW_ID;
    preview.dataset.surfaceKind = "chat";
    preview.dataset.sessionId = sessionId;
    preview.dataset.bulk = String(threads.length > 1);
    preview.setAttribute("aria-hidden", "true");
    preview.inert = true;
    preview.style.width = `${Math.round(rect.width)}px`;
    preview.style.height = `${Math.max(30, Math.round(rect.height))}px`;

    const previewIcon = document.createElement("span");
    previewIcon.className = "aboard-drag-preview-icon";
    previewIcon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 3.25h10v7.1H7.1L4 12.75v-2.4H3v-7.1Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>`;
    const previewTitle = document.createElement("span");
    previewTitle.className = "aboard-drag-preview-title";
    previewTitle.textContent = threads.length > 1
      ? `${threads[0]?.title || "Chat"} 等 ${threads.length} 条`
      : (threads[0]?.title || "Chat");
    preview.append(previewIcon, previewTitle);
    document.body.appendChild(preview);

    candidate.previewAnchor = {
      left: rect.left,
      top: rect.top,
      pointerX: candidate.startX,
      pointerY: candidate.startY
    };
    updateNativeDragPreview({ x: candidate.lastX, y: candidate.lastY }, true);
  }

  function clearNativeDragVisuals() {
    removeNativeDragPreview();
    if (pointerCandidate?.row) delete pointerCandidate.row.dataset.aboardDragging;
    document.querySelectorAll(`${NATIVE_THREAD_SELECTOR}[data-aboard-dragging]`).forEach(row => delete row.dataset.aboardDragging);
    const root = document.documentElement;
    if (root) delete root.dataset.conversationDashboardDragging;
  }

  function resetNativeDrag(reason = "cancelled") {
    clearTimeout(dragHardTimer);
    dragHardTimer = null;
    const sourceRow = pointerCandidate?.row || dragSession?.sourceRow;
    if (sourceRow) delete sourceRow.dataset.aboardDragging;
    clearNativeDragVisuals();
    if (dragSession && reason !== "replaced") postDragMessage("conversation-dashboard/native-dragleave", null, dragSession);
    pointerCandidate = null;
    dragSession = null;
    window.__conversationDashboardDraggedThread = null;
    window.__conversationDashboardDragSession = null;
  }

  function cancelCurrentGesture(reason = "cancelled") {
    const candidate = pointerCandidate;
    if (candidate?.active && !candidate.terminalForwarded) {
      const lastEvent = { clientX: candidate.lastX, clientY: candidate.lastY };
      // Clear first so our capture listener cannot recursively finish the same
      // gesture when the host receives the synthetic terminal event.
      pointerCandidate = null;
      forwardHostPointerEnd("pointercancel", lastEvent, null, candidate);
    }
    if (candidate?.row) delete candidate.row.dataset.aboardDragging;
    resetNativeDrag(reason);
  }

  function beginPassiveDrag(candidate) {
    clearTimeout(dragHardTimer);
    dragHardTimer = null;
    clearNativeDragVisuals();
    if (dragSession) postDragMessage("conversation-dashboard/native-dragleave", null, dragSession);
    pointerCandidate = candidate;
    const id = `drag-${Date.now()}-${++dragSessionSequence}`;
    dragSession = { id, payload: candidate.payload, source: "host-pointer", sourceRow: candidate.row, committed: false, startedAt: Date.now(), targetKey: "", targetElement: null, dropPoint: null };
    window.__conversationDashboardDraggedThread = candidate.payload;
    window.__conversationDashboardDragSession = dragSession;
    candidate.row.dataset.aboardDragging = "true";
    document.documentElement.dataset.conversationDashboardDragging = "true";
    createNativeDragPreview(candidate, id);
    postDragMessage("conversation-dashboard/native-dragstart");
    dragHardTimer = setTimeout(() => {
      if (dragSession?.id === id) cancelCurrentGesture("hard-timeout");
    }, 60_000);
    return dragSession;
  }

  function pointerMatchesCandidate(event) {
    if (!pointerCandidate) return false;
    const inputType = String(event?.type || "").startsWith("mouse") ? "mouse"
      : String(event?.type || "").startsWith("pointer") ? "pointer"
      : "";
    // Chromium emits compatibility mouse events after Pointer Events. They
    // must never take over an existing pointer session; the mouse fallback is
    // reserved for accessibility gestures that produce no Pointer Events.
    if (inputType && pointerCandidate.inputType !== inputType) return false;
    const candidateId = pointerCandidate.pointerId;
    const eventId = event?.pointerId;
    return candidateId == null || eventId == null || candidateId === eventId;
  }

  function eventPoint(event) {
    const rawX = event?.clientX;
    const rawY = event?.clientY;
    const x = typeof rawX === "number" && Number.isFinite(rawX) ? rawX : pointerCandidate?.lastX;
    const y = typeof rawY === "number" && Number.isFinite(rawY) ? rawY : pointerCandidate?.lastY;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function framePointFromParent(point, frame = dashboardFrame()) {
    if (!frame || !point) return null;
    const rect = frame.getBoundingClientRect();
    if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return null;
    return { x: point.x - rect.left, y: point.y - rect.top };
  }

  function hostPoint(event, childCoordinates = false) {
    const point = eventPoint(event);
    if (!point || !childCoordinates) return point;
    const rect = dashboardFrame()?.getBoundingClientRect();
    return rect ? { x: rect.left + point.x, y: rect.top + point.y } : null;
  }

  function dropTargetAt(point, frame = dashboardFrame()) {
    if (!frame || !point) return null;
    return frame.contentDocument?.elementFromPoint(point.x, point.y)?.closest?.("[data-drop-kind]") || null;
  }

  function updatePassiveDrag(point) {
    const state = dragSession;
    if (!state || state.committed) return false;
    const target = dropTargetAt(point);
    const targetKey = target ? `${target.dataset.dropKind || ""}:${target.dataset.projectId || target.dataset.dropTopic || ""}` : "";
    state.dropPoint = target ? point : null;
    if (state.targetKey === targetKey && state.targetElement === target) return Boolean(target);
    state.targetKey = targetKey;
    state.targetElement = target;
    if (target) postDragMessage("conversation-dashboard/native-dragmove", point, state);
    else postDragMessage("conversation-dashboard/native-dragleave", null, state);
    return Boolean(target);
  }

  function activatePointerCandidate(event, childCoordinates = false) {
    if (!pointerMatchesCandidate(event) || pointerCandidate.active) return Boolean(pointerCandidate?.active);
    const point = hostPoint(event, childCoordinates);
    if (!point) return false;
    const distance = Math.hypot(point.x - pointerCandidate.startX, point.y - pointerCandidate.startY);
    if (distance < 8) return false;
    const payload = nativeDragPayload(pointerCandidate.row);
    if (!payload) {
      pointerCandidate = null;
      return false;
    }
    const candidate = { ...pointerCandidate, payload, active: true };
    beginPassiveDrag(candidate);
    return true;
  }

  function movePassivePointer(event, childCoordinates = false) {
    if (event.__aboardForwarded) return;
    if (!active || !pointerMatchesCandidate(event)) return;
    const eventCoordinates = eventPoint(event);
    activatePointerCandidate(event, childCoordinates);
    if (!pointerCandidate?.active || !dragSession) return;
    const previewPoint = hostPoint(event, childCoordinates);
    if (previewPoint) updateNativeDragPreview(previewPoint);
    if (eventCoordinates && !childCoordinates) {
      pointerCandidate.lastX = eventCoordinates.x;
      pointerCandidate.lastY = eventCoordinates.y;
    }
    const point = childCoordinates ? eventCoordinates : framePointFromParent(eventCoordinates);
    // Always publish the first position that crosses the iframe boundary so the
    // user gets target feedback before releasing the host drag preview.
    updatePassiveDrag(point);
    if (childCoordinates && pointerCandidate?.active) {
      const rect = dashboardFrame()?.getBoundingClientRect();
      if (rect && eventCoordinates) {
        try {
          const usesMouseEvents = String(event.type || "").startsWith("mouse");
          const forwarded = usesMouseEvents
            ? new MouseEvent("mousemove", {
              bubbles: true,
              cancelable: true,
              button: 0,
              buttons: event.buttons,
              clientX: rect.left + eventCoordinates.x,
              clientY: rect.top + eventCoordinates.y
            })
            : new PointerEvent("pointermove", {
              bubbles: true,
              cancelable: true,
              pointerId: pointerCandidate.pointerId,
              pointerType: pointerCandidate.pointerType || "mouse",
              isPrimary: true,
              button: 0,
              buttons: event.buttons,
              clientX: rect.left + eventCoordinates.x,
              clientY: rect.top + eventCoordinates.y
            });
          forwarded.__aboardForwarded = true;
          (pointerCandidate.row?.ownerDocument || document).dispatchEvent(forwarded);
        } catch {}
      }
    }
  }

  function forwardHostPointerEnd(type, event, point, candidate = pointerCandidate) {
    if (!candidate || candidate.terminalForwarded) return;
    candidate.terminalForwarded = true;
    const frame = dashboardFrame();
    const rect = frame?.getBoundingClientRect();
    const clientX = point && rect ? rect.left + point.x : (event.clientX ?? candidate.lastX);
    const clientY = point && rect ? rect.top + point.y : (event.clientY ?? candidate.lastY);
    const ownerDocument = candidate.row?.ownerDocument || document;
    const dispatchTerminal = terminal => {
      terminal.__aboardForwarded = true;
      ownerDocument.dispatchEvent(terminal);
    };
    if (candidate.inputType === "pointer" && candidate.pointerId != null) {
      try {
        dispatchTerminal(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: candidate.pointerId,
          pointerType: candidate.pointerType || "mouse",
          isPrimary: true,
          button: 0,
          buttons: 0,
          clientX,
          clientY
        }));
      } catch {}
    }
    if (candidate.inputType === "mouse") {
      try {
        dispatchTerminal(new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          clientX,
          clientY
        }));
      } catch {}
    }
  }

  function finishPassivePointer(event, childCoordinates = false, cancelled = false) {
    if (event.__aboardForwarded) return;
    if (!pointerMatchesCandidate(event)) return;
    const candidate = pointerCandidate;
    const eventCoordinates = eventPoint(event);
    const point = childCoordinates ? eventCoordinates : framePointFromParent(eventCoordinates);
    if (candidate.active) updatePassiveDrag(point);
    const state = dragSession;
    if (candidate.active && !cancelled) {
      lastCompletedDragAt = Date.now();
      lastCompletedDragRow = candidate.row;
    }
    const dropPoint = !cancelled && state?.dropPoint ? state.dropPoint : null;
    removeNativeDragPreview();
    if (state && candidate.active && dropPoint && !cancelled) {
      state.committed = true;
      postDragMessage("conversation-dashboard/native-drop", dropPoint, state);
    }
    // Pointer events do not bubble out of an iframe. A synthetic cancel releases
    // the host's own drag sensor without asking it to perform a second drop.
    // This event is never cancelled or stopped.
    if (childCoordinates) forwardHostPointerEnd("pointercancel", event, point, candidate);
    pointerCandidate = null;
    if (!state || !candidate.active || !dropPoint || cancelled) {
      resetNativeDrag(cancelled ? "pointer-cancel" : "pointer-release");
      return;
    }
    setTimeout(() => {
      if (dragSession?.id === state.id) resetNativeDrag("drop-timeout");
    }, 800);
  }

  function beginPointerCandidate(event) {
    if (!active || event.button !== 0 || event.isPrimary === false) return;
    const inputType = String(event.type || "").startsWith("mouse") ? "mouse" : "pointer";
    // Ignore the compatibility mousedown that follows a normal pointerdown.
    // A mouse-only accessibility gesture reaches this handler with no existing
    // pointer candidate and becomes the fallback session instead.
    if (inputType === "mouse" && pointerCandidate?.inputType === "pointer") return;
    if (pointerCandidate || dragSession) cancelCurrentGesture("new-pointer");
    const row = event.target.closest?.(NATIVE_THREAD_SELECTOR);
    if (!row) {
      return;
    }
    const nestedButton = event.target.closest?.("button");
    if (nestedButton && nestedButton !== row) return;
    pointerCandidate = {
      row,
      payload: null,
      inputType,
      pointerId: inputType === "pointer" ? (event.pointerId ?? 0) : null,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false
    };
  }

  function bridgeDashboardPointer(frame) {
    if (frame.dataset.conversationDashboardPointerBridge === String(INJECTION_VERSION)) return;
    frame.dataset.conversationDashboardPointerBridge = String(INJECTION_VERSION);
    const connect = () => {
      childPointerController?.abort();
      childPointerController = new AbortController();
      const doc = frame.contentDocument;
      if (!doc) return;
      const options = { capture: true, passive: true, signal: childPointerController.signal };
      doc.addEventListener("pointermove", event => movePassivePointer(event, true), options);
      doc.addEventListener("pointerup", event => finishPassivePointer(event, true), options);
      doc.addEventListener("pointercancel", event => finishPassivePointer(event, true, true), options);
      doc.addEventListener("mousemove", event => movePassivePointer(event, true), options);
      doc.addEventListener("mouseup", event => finishPassivePointer(event, true), options);
      doc.addEventListener("keydown", event => {
        if (event.key === "Escape" && (pointerCandidate || dragSession)) cancelCurrentGesture("escape");
      }, options);
    };
    frame.addEventListener("load", connect, listenerOptions);
    connect();
  }

  function allThreadRows() { return [...document.querySelectorAll(NATIVE_THREAD_SELECTOR)]; }

  function currentThreadIds() {
    return new Set(allThreadRows().map(normalizedRowId).filter(Boolean));
  }

  function currentKnownThreadIds() {
    const ids = currentThreadIds();
    for (const id of conversationCache().keys()) ids.add(id);
    for (const id of Object.keys(CODEX_THREAD_METADATA)) ids.add(id);
    const routeId = currentRouteConversationId();
    if (routeId) ids.add(routeId);
    return ids;
  }

  function threadIdFromUrl(url) {
    return String(url || "").match(/^codex:\/\/threads\/([^?/#]+)/i)?.[1]
      || String(url || "").match(/^https?:\/\/(?:www\.)?chatgpt\.com\/c\/([^?/#]+)/i)?.[1]
      || "";
  }

  function conversationCache() {
    try {
      const cache = JSON.parse(localStorage.getItem("codex.chatgpt-conversations") || "null");
      const entries = cache?.pages?.flatMap(page => page?.items || []) || [];
      return new Map(entries.filter(entry => entry?.id).map(entry => [entry.id, entry]));
    } catch {
      return new Map();
    }
  }

  function nativeThreadMetadata() {
    const cache = conversationCache();
    const rows = allThreadRows().flatMap(row => {
      const payload = threadPayload(row, cache);
      if (!payload) return [];
      const cached = cache.get(payload.id) || {};
      const codex = CODEX_THREAD_METADATA[payload.id] || {};
      return [{
        ...payload,
        title: nativeRowTitle(row, cache) || cached.title || payload.title,
        createdAt: cached.create_time || codex.createdAt || payload.createdAt || "",
        updatedAt: cached.update_time || codex.updatedAt || payload.updatedAt || ""
      }];
    });
    const seen = new Set(rows.map(entry => entry.id));
    for (const [id, cached] of cache) {
      if (seen.has(id)) continue;
      const cachedKind = String(cached?.conversation_origin || cached?.conversationOrigin || cached?.mode || "").toLowerCase();
      rows.push({
        id,
        hostId: "",
        nativeKind: "cloud",
        surfaceKind: cachedKind === "work" ? "work" : "chat",
        title: cached.title || "",
        url: `https://chatgpt.com/c/${id}`,
        createdAt: cached.create_time || "",
        updatedAt: cached.update_time || "",
        runtimeStatus: "idle"
      });
    }
    return rows;
  }

  function postNativeMetadata() {
    if (active) void hydrateRecentThreads();
    const frame = document.querySelector(`#${SURFACE_ID} iframe`);
    const payload = nativeThreadMetadata();
    const signature = JSON.stringify(payload.map(entry => [entry.id, entry.title, entry.createdAt, entry.updatedAt, entry.runtimeStatus]));
    if (signature === lastMetadataSignature) return;
    lastMetadataSignature = signature;
    frame?.contentWindow?.postMessage({ method: "conversation-dashboard/native-metadata", payload }, "*");
  }

  function sendNativeMetadata() {
    lastMetadataSignature = "";
    postNativeMetadata();
  }

  function scheduleNativeMetadata() {
    clearTimeout(metadataDebounceTimer);
    metadataDebounceTimer = setTimeout(postNativeMetadata, 220);
  }

  function scheduleNativeRefresh() {
    if (nativeRefreshFrame) return;
    nativeRefreshFrame = requestAnimationFrame(() => {
      nativeRefreshFrame = null;
      captureCreatedConversation();
      scheduleNativeMetadata();
      if (!document.getElementById(ENTRY_ID)) {
        ensureInstalled();
        if (active) showDashboard();
      }
    });
  }

  async function renameNativeConversation(payload = {}) {
    const id = String(payload.id || threadIdFromUrl(payload.url)).trim();
    const title = String(payload.title || "").trim();
    if (!id || !title) return false;
    const bridged = callHostBridge("rename", { id, title }, 12_000);
    if (bridged) return bridged;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(HANDOFF_ENDPOINT.replace(/\/api\/handoff$/, "/api/rename"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Aboard-Token": HANDOFF_TOKEN
        },
        body: JSON.stringify({ id, title }),
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) return false;
      return true;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function recentThreadsButton() {
    return [...document.querySelectorAll("aside button")].find(button => {
      const label = visibleText(button);
      return label === "Recents" || label === "最近";
    }) || null;
  }

  function recentThreadRows() {
    return [...document.querySelectorAll(CHAT_THREAD_SELECTOR)];
  }

  function nativeSidebarScrollContainer(recents = recentThreadsButton()) {
    const aside = document.querySelector("aside");
    if (!aside || !recents) return null;
    return [aside, ...aside.querySelectorAll("*")].find(element =>
      element.contains?.(recents)
      && element.clientHeight > 100
      && element.scrollHeight > element.clientHeight + 8
    ) || null;
  }

  function afterAnimationFrames(count = 1) {
    return new Promise(resolve => {
      const next = remaining => {
        if (remaining <= 0) { resolve(); return; }
        requestAnimationFrame(() => next(remaining - 1));
      };
      next(count);
    });
  }

  async function hydrateRecentThreads({ force = false } = {}) {
    if (recentHydrationPromise) return recentHydrationPromise;
    const recents = recentThreadsButton();
    if (!recents) return recentThreadRows();
    const cacheSize = conversationCache().size;
    const currentRows = recentThreadRows().length;
    const newSidebar = recents !== recentHydrationButton;
    const cacheGrew = recentHydrationCacheSize >= 0 && cacheSize > recentHydrationCacheSize;
    const collapsed = recents.getAttribute("aria-expanded") !== "true";
    if (newSidebar || cacheGrew) recentHydrationAttempts = 0;
    const partialRetry = !collapsed && currentRows < 10 && recentHydrationAttempts < 3;
    const shouldExpand = collapsed && (force || newSidebar || cacheGrew);
    if (!cacheGrew && !partialRetry && !shouldExpand) {
      recentHydrationButton = recents;
      recentHydrationCacheSize = Math.max(recentHydrationCacheSize, cacheSize);
      return recentThreadRows();
    }

    recentHydrationPromise = (async () => {
      recentHydrationAttempts += 1;
      if (shouldExpand) {
        recents.click();
        await waitFor(() => recents.getAttribute("aria-expanded") === "true", 800);
      }

      const scroller = nativeSidebarScrollContainer(recents);
      if (!scroller || listenerController.signal.aborted) return recentThreadRows();
      const originalScrollTop = scroller.scrollTop;
      const originalScrollBehavior = scroller.style.scrollBehavior;
      const originalOverflowAnchor = scroller.style.overflowAnchor;
      const beforeCount = recentThreadRows().length;
      const beforeHeight = scroller.scrollHeight;
      let userInteracted = false;
      const markUserInteraction = () => { userInteracted = true; };
      const interactionEvents = ["wheel", "pointerdown", "touchstart", "keydown"];
      interactionEvents.forEach(type => scroller.addEventListener(type, markUserInteraction, { capture: true, once: true }));
      try {
        scroller.style.scrollBehavior = "auto";
        scroller.style.overflowAnchor = "none";
        const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (bottom > 0) {
          scroller.scrollTop = bottom;
          await waitFor(() =>
            recentThreadRows().length > beforeCount || scroller.scrollHeight > beforeHeight,
          300);
          await afterAnimationFrames(2);
          if (!userInteracted) {
            scroller.scrollTop = Math.min(originalScrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
            await afterAnimationFrames(1);
          }
        }
      } finally {
        interactionEvents.forEach(type => scroller.removeEventListener(type, markUserInteraction, { capture: true }));
        scroller.style.scrollBehavior = originalScrollBehavior;
        scroller.style.overflowAnchor = originalOverflowAnchor;
      }
      return recentThreadRows();
    })().finally(() => {
      recentHydrationButton = recents.isConnected === false ? null : recents;
      recentHydrationCacheSize = Math.max(recentHydrationCacheSize, cacheSize);
      recentHydrationPromise = null;
    });
    return recentHydrationPromise;
  }

  async function ensureThreadRowsVisible() {
    await hydrateRecentThreads({ force: true });
    if (allThreadRows().length) return allThreadRows();
    await waitFor(() => allThreadRows().length ? allThreadRows() : null, 3_000);
    return allThreadRows();
  }

  function waitFor(find, timeoutMs = 8_000) {
    const startedAt = Date.now();
    return new Promise(resolve => {
      const check = () => {
        const value = find();
        if (value) { resolve(value); return; }
        if (Date.now() - startedAt >= timeoutMs) { resolve(null); return; }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function topModeButton() {
    return document.querySelector('button[aria-label^="Switch mode"], button[aria-label^="切换模式"]');
  }

  async function ensureChatGPTMode() {
    let switcher = await waitFor(topModeButton);
    if (!switcher) return false;
    if (/ChatGPT/i.test(switcher.getAttribute("aria-label") || "")) return true;
    if (switcher.getAttribute("aria-expanded") !== "true") switcher.click();
    const menuId = switcher.getAttribute("aria-controls");
    const chatGPTItem = await waitFor(() => {
      const menu = (menuId && document.getElementById(menuId)) || document.querySelector('[role="menu"][data-state="open"]');
      const items = [...(menu?.querySelectorAll('[role="menuitem"]') || [])];
      return items.find(item => [...item.querySelectorAll("span")].some(span => visibleText(span) === "ChatGPT")) || items[0] || null;
    });
    if (!chatGPTItem) return false;
    chatGPTItem.click();
    switcher = await waitFor(() => {
      const candidate = topModeButton();
      return /ChatGPT/i.test(candidate?.getAttribute("aria-label") || "") ? candidate : null;
    });
    return Boolean(switcher);
  }

  function composerModeButton(kind) {
    const label = kind === "work" ? "Work" : "Chat";
    const groups = [...document.querySelectorAll('[role="group"], [aria-label="Composer mode"], [aria-label="编辑器模式"]')];
    const group = groups.find(candidate => {
      const labels = [...candidate.querySelectorAll('button[aria-pressed]')].map(visibleText);
      return labels.includes("Chat") && labels.includes("Work");
    });
    return [...(group?.querySelectorAll('button[aria-pressed]') || [])].find(button => visibleText(button) === label) || null;
  }

  function sidebarNewChatButton() {
    return [...document.querySelectorAll("aside button")].find(button => {
      const label = visibleText(button);
      return label === "New chat" || label === "新建对话";
    }) || null;
  }

  function reportCreateError(message) {
    const frame = document.querySelector(`#${SURFACE_ID} iframe`);
    frame?.contentWindow?.postMessage({ method: "conversation-dashboard/native-create-error", message }, "*");
  }

  function requestNeutralHostRoute() {
    window.postMessage({ type: "navigate-to-route", path: "/", replace: true }, "*");
  }

  function rememberNativeView(reason = "native") {
    try {
      sessionStorage.setItem(NATIVE_VIEW_STATE_KEY, JSON.stringify({ reason, startedAt: Date.now() }));
    } catch {}
  }

  function clearNativeViewState() {
    try { sessionStorage.removeItem(NATIVE_VIEW_STATE_KEY); } catch {}
  }

  function shouldKeepNativeView() {
    try {
      const value = JSON.parse(sessionStorage.getItem(NATIVE_VIEW_STATE_KEY) || "null");
      if (value && Date.now() - Number(value.startedAt || 0) < 12 * 60 * 60 * 1000) return true;
      sessionStorage.removeItem(NATIVE_VIEW_STATE_KEY);
    } catch {
      try { sessionStorage.removeItem(NATIVE_VIEW_STATE_KEY); } catch {}
    }
    return false;
  }

  async function handoffNativeConversation(payload = {}) {
    const id = String(payload.id || threadIdFromUrl(payload.url)).trim();
    const kind = payload.kind === "work" || payload.surfaceKind === "work" ? "work" : "chat";
    const url = String(payload.url || (id
      ? (kind === "work" ? `codex://threads/${id}` : `https://chatgpt.com/c/${id}`)
      : "")).trim();
    if (!id || !url) return false;
    const handoffPayload = {
      id,
      url,
      kind,
      hostId: String(payload.hostId || "").trim(),
      title: String(payload.title || "").trim()
    };
    const signature = `${handoffPayload.kind}:${handoffPayload.url}`;
    const now = Date.now();
    if (signature === lastHandoffSignature && now - lastHandoffAt < 900) return true;
    lastHandoffSignature = signature;
    lastHandoffAt = now;
    const bridged = callHostBridge("handoff", handoffPayload, 12_000);
    if (bridged) {
      const opened = await bridged;
      if (!opened && lastHandoffSignature === signature) {
        lastHandoffSignature = "";
        lastHandoffAt = 0;
      }
      return opened;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(HANDOFF_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Aboard-Token": HANDOFF_TOKEN
        },
        body: JSON.stringify(handoffPayload),
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Aboard handoff failed (${response.status})`);
      return true;
    } catch (_) {
      if (lastHandoffSignature === signature) {
        lastHandoffSignature = "";
        lastHandoffAt = 0;
      }
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  function internalConversationRoute(payload = {}) {
    try {
      const url = new URL(String(payload.url || "").trim());
      if (url.username || url.password || url.port || url.hash) return null;
      const decodedPath = decodeURIComponent(url.pathname).replace(/\/$/, "");
      if (url.protocol === "codex:" && url.hostname === "threads") {
        const id = decodedPath.match(/^\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i)?.[1];
        if (!id) return null;
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => key !== "hostId") || url.searchParams.getAll("hostId").length > 1) return null;
        const explicitHostId = url.searchParams.has("hostId") ? String(url.searchParams.get("hostId") || "").trim() : "";
        if (url.searchParams.has("hostId") && !explicitHostId) return null;
        const payloadHostId = String(payload.hostId || "").trim();
        const hostId = explicitHostId || (payloadHostId && payloadHostId !== "local" ? payloadHostId : "");
        return {
          id,
          local: true,
          path: `/local/${encodeURIComponent(id)}${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`
        };
      }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"].includes(host)) return null;
      if ([...url.searchParams.keys()].length) return null;
      const id = decodedPath.match(/^\/c\/([A-Za-z0-9_-]{12,})$/)?.[1];
      return id ? { id, local: false, path: `/work/conversation/${encodeURIComponent(id)}` } : null;
    } catch {
      return null;
    }
  }

  function isCurrentConversationRoute(route) {
    if (!route?.path) return false;
    try {
      const expected = new URL(route.path, location.href);
      const currentPath = decodeURIComponent(location.pathname).replace(/\/$/, "");
      const expectedPath = decodeURIComponent(expected.pathname).replace(/\/$/, "");
      return currentPath === expectedPath && location.search === expected.search;
    } catch {
      return false;
    }
  }

  function reportOpenError(fallback) {
    const message = lastOpenErrorMessage || fallback;
    lastOpenErrorMessage = "";
    reportCreateError(message);
  }

  async function openNativeConversation(payload = {}) {
    lastOpenErrorMessage = "";
    const unfinishedCreation = pendingDestination();
    if (unfinishedCreation && !unfinishedCreation.threadId) clearPendingCreation(unfinishedCreation);
    // Installed regression fixtures opt into the legacy HTTP compatibility
    // surface so they never navigate a user's real native conversation.
    if (window.__conversationDashboardUseHttpTestBridge === true) {
      return handoffNativeConversation(payload);
    }
    const route = internalConversationRoute(payload);
    if (!route) {
      lastOpenErrorMessage = "原会话链接格式无效，请在设置中重新绑定";
      return false;
    }
    if (isCurrentConversationRoute(route)) {
      rememberNativeView("current-conversation");
      hideDashboard();
      showReturnControl();
      return true;
    }
    if (route.local) {
      const request = callHostBridgeResult("thread-availability", { id: route.id }, 6_000);
      if (!request) {
        lastOpenErrorMessage = "Aboard 暂时无法确认会话状态，请重试";
        return false;
      }
      const result = await request;
      if (!result?.ok) {
        lastOpenErrorMessage = "Aboard 暂时无法确认会话状态，请重试";
        return false;
      }
      const availability = result.value;
      const safeIdle = availability?.claimed === false && availability?.ownership === "none";
      const safeSelf = availability?.claimed === true && availability?.ownership === "self";
      if (!safeIdle && !safeSelf) {
        lastOpenErrorMessage = availability?.claimed === true && availability?.ownership === "other"
          ? "该本地会话正在另一个 Codex 窗口中使用；为避免冲突，请先结束或切换该会话后再打开"
          : "Aboard 暂时无法确认会话状态，请重试";
        return false;
      }
    }
    rememberNativeView("open-conversation");
    hideDashboard();
    showReturnControl();
    const testSink = window.__conversationDashboardRouteTestSink;
    if (typeof testSink === "function") testSink(route.path);
    else window.postMessage({ type: "navigate-to-route", path: route.path }, "*");
    return true;
  }

  async function createNativeConversation(rawDestination) {
    if (nativeCreationStarting || pendingDestination()) {
      reportCreateError("已有一条会话正在创建，请先完成后再新建");
      return;
    }
    nativeCreationStarting = true;
    try {
      const destination = {
        ...rawDestination,
        kind: rawDestination?.kind === "work" ? "work" : "chat"
      };
      await ensureThreadRowsVisible();
      const beforeIds = [...currentKnownThreadIds()];
      rememberNativeView("create-conversation");
      hideDashboard();
      showReturnControl();

      if (!await ensureChatGPTMode()) {
        showDashboard();
        reportCreateError("无法切换到 ChatGPT，请重试");
        return;
      }

      const startedAt = Date.now();
      pendingCreation = {
        destination,
        beforeIds,
        startedAt,
        creationId: globalThis.crypto?.randomUUID?.() || `${startedAt}:${Math.random().toString(36).slice(2)}`,
        threadId: null
      };
      try { localStorage.setItem("conversation-dashboard-pending-creation", JSON.stringify(pendingCreation)); } catch {}

      const newChatButton = await waitFor(sidebarNewChatButton);
      if (!newChatButton) {
        pendingCreation = null;
        try { localStorage.removeItem("conversation-dashboard-pending-creation"); } catch {}
        showDashboard();
        reportCreateError("找不到原生新建入口，请重试");
        return;
      }
      newChatButton.click();

      const modeButton = await waitFor(() => composerModeButton(destination.kind));
      if (!modeButton) {
        pendingCreation = null;
        try { localStorage.removeItem("conversation-dashboard-pending-creation"); } catch {}
        showDashboard();
        reportCreateError(`无法打开 ${destination.kind === "work" ? "Work" : "Chat"} 新建页，请重试`);
        return;
      }
      if (modeButton.getAttribute("aria-pressed") !== "true") modeButton.click();
      const selected = await waitFor(() => composerModeButton(destination.kind)?.getAttribute("aria-pressed") === "true");
      if (!selected) {
        pendingCreation = null;
        try { localStorage.removeItem("conversation-dashboard-pending-creation"); } catch {}
        showDashboard();
        reportCreateError(`无法切换到 ${destination.kind === "work" ? "Work" : "Chat"}，请重试`);
        return;
      }
      startCreationTracking();
    } finally {
      nativeCreationStarting = false;
    }
  }

  function startCreationTracking() {
    clearInterval(pendingCreationPollTimer);
    pendingCreationPollTimer = setInterval(() => {
      captureCreatedConversation();
      if (!pendingDestination()) {
        clearInterval(pendingCreationPollTimer);
        pendingCreationPollTimer = null;
      }
    }, 500);
  }

  function pendingCreationToken(value) {
    return String(value?.creationId || value?.startedAt || "");
  }

  function samePendingCreation(left, right) {
    const leftToken = pendingCreationToken(left);
    return Boolean(leftToken && leftToken === pendingCreationToken(right));
  }

  function persistPendingCreation(value) {
    pendingCreation = value;
    try { localStorage.setItem("conversation-dashboard-pending-creation", JSON.stringify(value)); } catch {}
  }

  function clearPendingCreation(expected = null) {
    const current = pendingDestination();
    if (!current || (expected && !samePendingCreation(current, expected))) return false;
    pendingCreation = null;
    try { localStorage.removeItem("conversation-dashboard-pending-creation"); } catch {}
    clearInterval(pendingCreationPollTimer);
    pendingCreationPollTimer = null;
    return true;
  }

  function pendingDestination() {
    const maxAge = 30 * 60 * 1000;
    const returnedUnverifiedMaxAge = 60 * 1000;
    const now = Date.now();
    try {
      const parsed = JSON.parse(localStorage.getItem("conversation-dashboard-pending-creation") || "null");
      const parsedExpired = parsed && (now - Number(parsed.startedAt || 0) >= maxAge
        || (!parsed.threadId && parsed.returnRequestedAt
          && now - Number(parsed.returnRequestedAt || 0) >= returnedUnverifiedMaxAge));
      if (parsed && !parsedExpired && (!pendingCreation || parsed.startedAt >= pendingCreation.startedAt)) {
        pendingCreation = parsed;
      } else if (parsed) {
        localStorage.removeItem("conversation-dashboard-pending-creation");
      }
    } catch {}
    if (pendingCreation && (now - Number(pendingCreation.startedAt || 0) >= maxAge
      || (!pendingCreation.threadId && pendingCreation.returnRequestedAt
        && now - Number(pendingCreation.returnRequestedAt || 0) >= returnedUnverifiedMaxAge))) {
      pendingCreation = null;
      try { localStorage.removeItem("conversation-dashboard-pending-creation"); } catch {}
    }
    return pendingCreation;
  }

  function completePendingCreation(startedAt, creationId = "") {
    const pending = pendingDestination();
    if (!pending || Number(pending.startedAt) !== Number(startedAt)) return false;
    if (creationId && pendingCreationToken(pending) !== String(creationId)) return false;
    return clearPendingCreation(pending);
  }

  function timestampMilliseconds(value) {
    if (value === null || value === undefined || value === "") return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function uuidV7Timestamp(value) {
    const compact = String(value || "").replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/i.test(compact) || compact[12]?.toLowerCase() !== "7") return 0;
    const milliseconds = Number.parseInt(compact.slice(0, 12), 16);
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  }

  function createdRouteFreshness(pending, routeId, payload) {
    const uuidTimestamp = pending.destination?.kind === "work" ? uuidV7Timestamp(routeId) : 0;
    const createdAt = uuidTimestamp || timestampMilliseconds(payload?.createdAt);
    if (!createdAt) return "unknown";
    const startedAt = Number(pending.startedAt || 0);
    if (!startedAt) return "stale";
    const futureClockTolerance = 60 * 1000;
    const secondPrecisionTolerance = uuidTimestamp ? 0 : 1_000;
    if (createdAt > Date.now() + futureClockTolerance) return "stale";
    return createdAt >= startedAt - secondPrecisionTolerance ? "fresh" : "stale";
  }

  async function captureCreatedConversation() {
    if (captureCreationInFlight) return;
    let pending = pendingDestination();
    if (!pending) return;
    const pendingToken = pendingCreationToken(pending);
    captureCreationInFlight = true;
    try {
      await ensureThreadRowsVisible();
      const currentPending = pendingDestination();
      if (!samePendingCreation(currentPending, pending)) return;
      pending = currentPending;
      const existingIds = new Set(pending.beforeIds || []);
      const rows = allThreadRows();
      const routeId = currentRouteConversationId();
      const routeKind = currentRouteSurfaceKind();
      const routeRow = routeId
        ? rows.find(candidate => normalizedRowId(candidate) === routeId && nativeRowActive(candidate)) || null
        : null;
      const routePayload = routeRow ? threadPayload(routeRow) : null;
      const freshness = createdRouteFreshness(pending, routeId, routePayload);
      const canInspectRoute = !pending.threadId
        && routeId
        && routeKind === pending.destination?.kind
        && !existingIds.has(routeId)
        && routeRow
        && routePayload?.id === routeId
        && routePayload?.surfaceKind === routeKind;
      if (canInspectRoute && freshness === "stale") {
        clearPendingCreation(pending);
        return;
      }
      if (canInspectRoute && freshness === "unknown") {
        pending.observedThreadId = routeId;
        pending.observedAt = pending.observedAt || Date.now();
        persistPendingCreation(pending);
      }
      if (canInspectRoute && freshness === "fresh") {
        if (routeKind === "work") {
          const provisionalRows = rows.filter(row => {
            const id = rawRowId(row);
            return id.startsWith("client-new-thread:") && !existingIds.has(id);
          });
          const provisionalRow = provisionalRows.find(nativeRowActive)
            || (provisionalRows.length === 1 ? provisionalRows[0] : null);
          if (provisionalRow) rememberNativeIdAlias(rawRowId(provisionalRow), routeId);
        }
        pending.threadId = routeId;
        delete pending.observedThreadId;
        delete pending.observedAt;
        delete pending.returnRequestedAt;
        persistPendingCreation(pending);
      }
      const candidates = rows.filter(row => !existingIds.has(normalizedRowId(row)));
      const titledCandidates = candidates.filter(candidate => {
        const title = nativeRowTitle(candidate, conversationCache());
        return title && title !== "New chat" && title !== "新建对话";
      });
      const targetId = String(pending.threadId || "");
      const routeCandidate = targetId
        ? titledCandidates.find(candidate => normalizedRowId(candidate) === targetId)
        : null;
      // A provisional composer row may briefly coexist with sidebar rows that
      // become active for unrelated hydration. Only the native route is a
      // sufficiently strong identity to place a newly created conversation.
      const row = routeCandidate || null;
      const payload = threadPayload(row);
      if (!payload || !payload.title || payload.title === "New chat" || payload.title === "新建对话") return;
      if (payload.surfaceKind !== pending.destination?.kind) return;
      const latestPending = pendingDestination();
      if (!samePendingCreation(latestPending, pending) || pendingCreationToken(latestPending) !== pendingToken) return;
      const frame = document.querySelector(`#${SURFACE_ID} iframe`);
      frame?.contentWindow?.postMessage({
        method: "conversation-dashboard/native-created",
        payload,
        destination: pending.destination,
        startedAt: pending.startedAt,
        creationId: pendingCreationToken(pending)
      }, "*");
    } finally {
      captureCreationInFlight = false;
    }
  }

  let returnToDashboardInFlight = false;
  async function returnToDashboard() {
    if (returnToDashboardInFlight) return;
    returnToDashboardInFlight = true;
    try {
      const pending = pendingDestination();
      if (pending && !pending.threadId) {
        await captureCreatedConversation();
        const latest = pendingDestination();
        if (latest && samePendingCreation(latest, pending) && !latest.threadId) {
          const routeId = currentRouteConversationId();
          if (!latest.observedThreadId || latest.observedThreadId !== routeId) {
            clearPendingCreation(latest);
          } else {
            latest.returnRequestedAt = latest.returnRequestedAt || Date.now();
            persistPendingCreation(latest);
            startCreationTracking();
          }
        }
      }
      showDashboard();
    } finally {
      returnToDashboardInFlight = false;
    }
  }

  function showDashboard() {
    let entry = document.getElementById(ENTRY_ID);
    if (!entry) {
      if (!ensureInstalled()) return;
      entry = document.getElementById(ENTRY_ID);
    }
    if (!entry) return;
    const surface = ensureSurface(entry);
    if (!surface) return;
    clearNativeViewState();
    // Aboard is a board-only companion. Release any task restored by the
    // underlying cloned client before revealing the dashboard so it cannot
    // compete with the official Codex app for the same task writer.
    if (!active) {
      const startupNeutralHandled = window.__aboardStartupNeutralHandled === true;
      delete window.__aboardStartupNeutralHandled;
      if (!startupNeutralHandled) requestNeutralHostRoute();
    }
    const firstActivation = !active;
    hideReturnControl();
    active = true;
    syncSurfaceBounds(surface, previousMain);
    surface.dataset.active = "true";
    surface.removeAttribute("aria-hidden");
    entry.setAttribute("aria-current", "page");
    document.documentElement.dataset.conversationDashboardActive = "true";
    surface.querySelectorAll("iframe").forEach(bridgeDashboardPointer);
    syncHostTheme();
    if (previousMain) {
      previousMain.dataset.conversationDashboardHidden = "true";
      previousMain.style.visibility = "hidden";
      previousMain.setAttribute("aria-hidden", "true");
    }
    if (firstActivation) void hydrateRecentThreads({ force: true });
    setTimeout(postNativeMetadata, 80);
    clearInterval(metadataPollTimer);
    metadataPollTimer = setInterval(postNativeMetadata, 1_500);
    window.__conversationDashboardMetadataPollTimer = metadataPollTimer;
  }

  function hideDashboard() {
    cancelCurrentGesture("dashboard-hidden");
    if (!active) return;
    clearInterval(metadataPollTimer);
    metadataPollTimer = null;
    window.__conversationDashboardMetadataPollTimer = null;
    active = false;
    delete document.documentElement.dataset.conversationDashboardActive;
    const surface = document.getElementById(SURFACE_ID);
    const entry = document.getElementById(ENTRY_ID);
    if (surface) {
      surface.dataset.active = "false";
      surface.setAttribute("aria-hidden", "true");
    }
    entry?.removeAttribute("aria-current");
    if (previousMain) {
      previousMain.style.visibility = "";
      previousMain.removeAttribute("aria-hidden");
      delete previousMain.dataset.conversationDashboardHidden;
    }
  }

  function ensureInstalled() {
    installStyle();
    const pluginsButton = findPluginsButton();
    if (!pluginsButton) return false;
    const entry = document.getElementById(ENTRY_ID) || createEntry(pluginsButton);
    if (!active && entry.previousElementSibling !== pluginsButton) pluginsButton.insertAdjacentElement("afterend", entry);
    ensureSurface(entry);
    document.querySelectorAll(`#${SURFACE_ID} iframe`).forEach(bridgeDashboardPointer);
    syncHostTheme();
    return true;
  }

  document.addEventListener("click", event => {
    const returnControl = event.target.closest?.(`#${RETURN_ID}`);
    if (returnControl) {
      event.preventDefault();
      event.stopImmediatePropagation();
      returnToDashboard();
      return;
    }
    const entry = event.target.closest?.(`#${ENTRY_ID}`);
    if (entry) {
      event.preventDefault();
      event.stopPropagation();
      returnToDashboard();
      return;
    }
    const nativeRow = event.target.closest?.(NATIVE_THREAD_SELECTOR);
    if (!active) {
      const unfinishedCreation = pendingDestination();
      if (nativeRow && unfinishedCreation && !unfinishedCreation.threadId) {
        clearPendingCreation(unfinishedCreation);
      }
      return;
    }
    if (nativeRow) {
      const nativeButton = event.target.closest?.("button");
      if (nativeButton && nativeButton !== nativeRow) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (nativeRow === lastCompletedDragRow && Date.now() - lastCompletedDragAt < 450) return;
      const payload = threadPayload(nativeRow);
      cancelCurrentGesture("native-thread-click");
      openNativeConversation(payload || {}).then(opened => {
        if (!opened) reportOpenError("无法在 Aboard 中打开该会话，请重试");
      });
      return;
    }
    const sidebarButton = event.target.closest?.("aside button");
    if (sidebarButton) {
      rememberNativeView("sidebar");
      hideDashboard();
      showReturnControl();
    }
  }, { capture: true, signal: listenerController.signal });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") cancelCurrentGesture("escape");
  }, listenerOptions);
  document.addEventListener("pointerdown", beginPointerCandidate, { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("pointermove", event => movePassivePointer(event, false), { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("pointerup", event => finishPassivePointer(event, false), { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("pointercancel", event => finishPassivePointer(event, false, true), { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("mousedown", beginPointerCandidate, { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("mousemove", event => movePassivePointer(event, false), { capture: true, passive: true, signal: listenerController.signal });
  document.addEventListener("mouseup", event => finishPassivePointer(event, false), { capture: true, passive: true, signal: listenerController.signal });
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!document.hasFocus()) cancelCurrentGesture("blur");
    }, 0);
  }, listenerOptions);
  window.addEventListener("pagehide", () => cancelCurrentGesture("pagehide"), listenerOptions);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") cancelCurrentGesture("hidden");
  }, listenerOptions);
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", syncHostTheme, listenerOptions);
  window.addEventListener("resize", () => {
    syncSurfaceBounds(document.getElementById(SURFACE_ID), previousMain);
  }, { passive: true, signal: listenerController.signal });

  window.addEventListener("message", event => {
    const dashboardFrame = document.querySelector(`#${SURFACE_ID} iframe`)?.contentWindow;
    if (event.source !== dashboardFrame) return;
    if (event.data?.method === "conversation-dashboard/request-theme") syncHostTheme();
    if (event.data?.method === "conversation-dashboard/create-native") createNativeConversation(event.data.destination || {});
    if (event.data?.method === "conversation-dashboard/native-created-ack") {
      completePendingCreation(event.data.startedAt, event.data.creationId);
    }
    if (event.data?.method === "conversation-dashboard/open-native") {
      openNativeConversation(event.data.payload || {}).then(opened => {
        if (!opened) reportOpenError("无法在 Aboard 中打开该会话，请重试");
      });
    }
    if (event.data?.method === "conversation-dashboard/rename-native") {
      renameNativeConversation(event.data.payload || {}).then(renamed => {
        const frame = document.querySelector(`#${SURFACE_ID} iframe`);
        frame?.contentWindow?.postMessage({
          method: renamed ? "conversation-dashboard/native-renamed" : "conversation-dashboard/native-rename-error",
          payload: event.data.payload || {}
        }, "*");
      });
    }
    if (event.data?.method === "conversation-dashboard/request-native-metadata") sendNativeMetadata();
    if (event.data?.method === "conversation-dashboard/request-runtime-status" && !runtimeStatusRequestInFlight) {
      const frame = document.querySelector(`#${SURFACE_ID} iframe`);
      const ids = Array.isArray(event.data?.payload?.ids) ? event.data.payload.ids : [];
      const request = callHostBridgeResult("runtime-status", { ids }, 6_000);
      if (request) {
        runtimeStatusRequestInFlight = true;
        request.then(result => {
          if (!result?.ok || !Array.isArray(result.value)) return;
          frame?.contentWindow?.postMessage({
            method: "conversation-dashboard/native-runtime-status",
            payload: result.value
          }, "*");
        }).finally(() => { runtimeStatusRequestInFlight = false; });
      }
    }
    if (event.data?.method === "conversation-dashboard/native-drag-cancel" && dragSession) {
      cancelCurrentGesture("frame-cancel");
    }
    if (event.data?.method === "conversation-dashboard/native-drop-ack" && dragSession?.id === event.data.sessionId) resetNativeDrag("drop-ack");
  }, listenerOptions);

  window.__conversationDashboardCleanup = () => {
    cancelCurrentGesture("cleanup");
    listenerController.abort();
    observer?.disconnect();
    themeObserver?.disconnect();
    clearInterval(metadataPollTimer);
    clearInterval(pendingCreationPollTimer);
    clearTimeout(metadataDebounceTimer);
    for (const waiter of hostBridgeWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: "Aboard bridge closed" });
    }
    hostBridgeWaiters.clear();
    if (window.__conversationDashboardResolveBridge === resolveHostBridge) {
      delete window.__conversationDashboardResolveBridge;
    }
    if (nativeRefreshFrame) cancelAnimationFrame(nativeRefreshFrame);
    if (domStartupFrame) cancelAnimationFrame(domStartupFrame);
    domStartupFrame = null;
    childPointerController?.abort();
    childPointerController = null;
    document.getElementById(RETURN_ID)?.remove();
    const root = document.documentElement;
    if (root) {
      delete root.dataset.conversationDashboardActive;
      delete root.dataset.conversationDashboardTheme;
    }
  };

  const boot = () => {
    if (ensureInstalled()) {
      const pending = pendingDestination();
      if (pending) startCreationTracking();
      if (pending || shouldKeepNativeView()) {
        showReturnControl();
        return;
      }
      showDashboard();
      return;
    }
    requestAnimationFrame(boot);
  };

  const startAfterDocumentRoot = () => {
    if (domStartupStarted || listenerController.signal.aborted) return;
    const root = document.documentElement;
    if (!root) {
      domStartupFrame = requestAnimationFrame(startAfterDocumentRoot);
      return;
    }
    domStartupFrame = null;
    domStartupStarted = true;
    observer = new MutationObserver(scheduleNativeRefresh);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-app-action-sidebar-thread-title"]
    });
    themeObserver = new MutationObserver(syncHostTheme);
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    boot();
  };
  startAfterDocumentRoot();
})();
