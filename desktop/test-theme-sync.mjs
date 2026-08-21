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
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description
      || response.result.exceptionDetails.text
      || "Aboard theme test evaluation failed");
  }
  return response.result?.result?.value;
};

const result = {};
const failures = [];
let setupComplete = false;

try {
  await send("Page.enable");
  result.setup = await evaluate(`(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const entry = document.getElementById("conversation-dashboard-sidebar-entry");
    const surface = document.getElementById("conversation-dashboard-surface");
    if (!entry || !surface) return { ok: false, reason: "Aboard host UI unavailable" };
    if (surface.dataset.active !== "true") {
      entry.click();
      await sleep(120);
    }
    const frame = surface.querySelector("iframe");
    const child = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const app = doc?.getElementById("app");
    const boardNode = doc?.querySelector(".board");
    if (!frame || !child || !doc || !app || !boardNode) {
      return { ok: false, reason: "Aboard frame unavailable" };
    }

    const storageKey = "conversation-dashboard-board-v1";
    const fixture = doc.createElement("div");
    fixture.id = "aboard-theme-sync-test-fixture";
    fixture.style.cssText = "position:fixed;left:-10000px;top:0;width:320px;visibility:hidden;pointer-events:none";
    fixture.innerHTML = [
      '<div class="project-item is-item-pinned"><span class="project-item-title">Pinned fixture</span></div>',
      '<article class="project-card drop-target is-drop-invalid" data-drop-label="Invalid fixture"></article>'
    ].join("");
    doc.body.appendChild(fixture);

    const state = {
      originalClassAttribute: document.documentElement.getAttribute("class"),
      originalBoard: localStorage.getItem(storageKey),
      boardNode,
      fixture,
      appMutationCount: 0
    };
    state.appObserver = new child.MutationObserver(records => {
      state.appMutationCount += records.filter(record => record.type === "childList").length;
    });
    state.appObserver.observe(app, { childList: true });
    window.__aboardThemeSyncTest = state;
    return {
      ok: true,
      injectionVersion: window.__conversationDashboardVersion,
      active: surface.dataset.active,
      initialHostClass: state.originalClassAttribute,
      boardPresent: state.originalBoard !== null
    };
  })()`);
  if (!result.setup?.ok) throw new Error(result.setup?.reason || "Aboard theme test setup failed");
  setupComplete = true;

  const snapshotExpression = expectedTheme => `(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const expected = ${JSON.stringify(expectedTheme)};
    const root = document.documentElement;
    root.classList.toggle("electron-dark", expected === "dark");
    root.classList.toggle("electron-light", expected === "light");

    const ready = () => {
      const surface = document.getElementById("conversation-dashboard-surface");
      const frame = surface?.querySelector("iframe");
      return root.dataset.conversationDashboardTheme === expected
        && surface?.dataset.aboardTheme === expected
        && frame?.dataset.aboardTheme === expected
        && frame?.contentDocument?.documentElement?.dataset.theme === expected;
    };
    const deadline = performance.now() + 1_000;
    while (!ready() && performance.now() < deadline) await sleep(16);
    // The desktop window can be occluded while this test runs, which lets
    // Chromium throttle requestAnimationFrame indefinitely. A bounded timer
    // still gives the MutationObserver/message bridge time to settle.
    await sleep(40);

    const state = window.__aboardThemeSyncTest;
    const surface = document.getElementById("conversation-dashboard-surface");
    const frame = surface?.querySelector("iframe");
    const child = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const childRoot = doc?.documentElement;
    const boardNode = doc?.querySelector(".board");
    const pinned = state?.fixture?.querySelector(".is-item-pinned");
    const invalid = state?.fixture?.querySelector(".is-drop-invalid");
    const canvas = doc.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const colorChannels = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const childStyle = child.getComputedStyle(childRoot);
    const panelStyle = child.getComputedStyle(boardNode);
    const pinnedStyle = child.getComputedStyle(pinned);
    const invalidStyle = child.getComputedStyle(invalid, "::after");
    const brandMark = doc.querySelector(".brand-mark");
    const brandBefore = child.getComputedStyle(brandMark, "::before");
    const brandAfter = child.getComputedStyle(brandMark, "::after");
    const sidebarIconFills = [...document.querySelectorAll("#conversation-dashboard-sidebar-entry svg rect")]
      .map(node => node.getAttribute("fill")?.toLowerCase() || "");
    return {
      expected,
      propagated: ready(),
      systemDark: matchMedia("(prefers-color-scheme: dark)").matches,
      hostClass: root.className,
      hostTheme: root.dataset.conversationDashboardTheme || "",
      surfaceTheme: surface?.dataset.aboardTheme || "",
      frameTheme: frame?.dataset.aboardTheme || "",
      frameColorScheme: frame?.style.colorScheme || "",
      childTheme: childRoot?.dataset.theme || "",
      childColorScheme: childStyle.colorScheme,
      paper: childStyle.getPropertyValue("--paper").trim().toLowerCase(),
      panel: childStyle.getPropertyValue("--panel").trim().toLowerCase(),
      accent: childStyle.getPropertyValue("--accent").trim().toLowerCase(),
      accentStrong: childStyle.getPropertyValue("--accent-strong").trim().toLowerCase(),
      accentSoft: childStyle.getPropertyValue("--accent-soft").trim().toLowerCase(),
      brandDeep: childStyle.getPropertyValue("--brand-deep").trim().toLowerCase(),
      brandJade: childStyle.getPropertyValue("--brand-jade").trim().toLowerCase(),
      brandMist: childStyle.getPropertyValue("--brand-mist").trim().toLowerCase(),
      brandBeforeHeight: Number.parseFloat(brandBefore.height),
      brandAfterHeight: Number.parseFloat(brandAfter.height),
      brandBeforeTransform: brandBefore.transform,
      brandAfterTransform: brandAfter.transform,
      brandBridgeAbsent: !doc.querySelector(".brand-bridge"),
      sidebarIconFills,
      surfaceColor: getComputedStyle(surface).backgroundColor,
      frameBackgroundColor: getComputedStyle(frame).backgroundColor,
      panelColor: panelStyle.backgroundColor,
      panelChannels: colorChannels(panelStyle.backgroundColor),
      pinnedColor: pinnedStyle.backgroundColor,
      pinnedChannels: colorChannels(pinnedStyle.backgroundColor),
      invalidColor: invalidStyle.backgroundColor,
      invalidChannels: colorChannels(invalidStyle.backgroundColor),
      boardNodeStable: boardNode === state.boardNode,
      appMutationCount: state.appMutationCount,
      boardStorageUnchanged: localStorage.getItem("conversation-dashboard-board-v1") === state.originalBoard
    };
  })()`;

  await send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "dark" }]
  });
  result.explicitLightOverSystemDark = await evaluate(snapshotExpression("light"));

  await send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  result.explicitDarkOverSystemLight = await evaluate(snapshotExpression("dark"));

  result.bothHostClassesDarkWins = await evaluate(`(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const root = document.documentElement;
    root.classList.add("electron-light", "electron-dark");
    const surface = document.getElementById("conversation-dashboard-surface");
    const frame = surface?.querySelector("iframe");
    const ready = () => root.dataset.conversationDashboardTheme === "dark"
      && surface?.dataset.aboardTheme === "dark"
      && frame?.contentDocument?.documentElement?.dataset.theme === "dark";
    const deadline = performance.now() + 1_000;
    while (!ready() && performance.now() < deadline) await sleep(16);
    await sleep(40);
    return {
      propagated: ready(),
      hostClass: root.className,
      hostTheme: root.dataset.conversationDashboardTheme || "",
      surfaceTheme: surface?.dataset.aboardTheme || "",
      childTheme: frame?.contentDocument?.documentElement?.dataset.theme || "",
      surfaceColor: getComputedStyle(surface).backgroundColor,
      frameBackgroundColor: getComputedStyle(frame).backgroundColor,
      paper: frame?.contentWindow?.getComputedStyle(frame.contentDocument.documentElement).getPropertyValue("--paper").trim().toLowerCase(),
      boardStorageUnchanged: localStorage.getItem("conversation-dashboard-board-v1") === window.__aboardThemeSyncTest?.originalBoard
    };
  })()`);

  const light = result.explicitLightOverSystemDark;
  const dark = result.explicitDarkOverSystemLight;
  const both = result.bothHostClassesDarkWins;
  if (!light.propagated
    || light.systemDark !== true
    || !light.hostClass.includes("electron-light")
    || [light.hostTheme, light.surfaceTheme, light.frameTheme, light.frameColorScheme, light.childTheme, light.childColorScheme].some(value => value !== "light")
    || light.paper !== "#f4f6fa") {
    failures.push("explicit host light theme did not override emulated system dark");
  }
  if (!dark.propagated
    || dark.systemDark !== false
    || !dark.hostClass.includes("electron-dark")
    || [dark.hostTheme, dark.surfaceTheme, dark.frameTheme, dark.frameColorScheme, dark.childTheme, dark.childColorScheme].some(value => value !== "dark")
    || dark.paper !== "#12151b"
    || !dark.panel.includes("28, 32, 41")) {
    failures.push("explicit host dark theme did not override emulated system light");
  }
  if (light.accent !== "#146a59"
    || light.accentStrong !== "#0b4f43"
    || light.accentSoft !== "#e1f1ea"
    || dark.accent !== "#69bfa2"
    || dark.accentStrong !== "#91d4bc"
    || dark.accentSoft !== "#173a32") {
    failures.push("Aboard green interaction palette did not map correctly across light and dark themes");
  }
  if ([light.brandDeep, light.brandJade, light.brandMist].join(",") !== "#0b4f43,#69bfa2,#e1f1ea"
    || !light.brandBridgeAbsent
    || !(light.brandBeforeHeight > light.brandAfterHeight)
    || light.brandBeforeTransform === "none"
    || light.brandAfterTransform === "none"
    || light.sidebarIconFills.join(",") !== "#0b4f43,#e1f1ea,#69bfa2") {
    failures.push("Aboard two-block brand mark is missing or inconsistent between the board and sidebar");
  }
  if (!both.propagated
    || !both.hostClass.includes("electron-light")
    || !both.hostClass.includes("electron-dark")
    || [both.hostTheme, both.surfaceTheme, both.childTheme].some(value => value !== "dark")
    || both.paper !== "#12151b"
    || !both.surfaceColor.includes("18, 21, 27")
    || !both.frameBackgroundColor.includes("18, 21, 27")
    || !both.boardStorageUnchanged) {
    failures.push("transient dual host theme classes did not resolve consistently to dark");
  }
  const darkStatusIsSubdued = colors => Array.isArray(colors)
    && colors.length === 4
    && Math.max(...colors.slice(0, 3)) < 160;
  if (!darkStatusIsSubdued(dark.panelChannels)
    || !darkStatusIsSubdued(dark.pinnedChannels)
    || !darkStatusIsSubdued(dark.invalidChannels)) {
    failures.push("dark panel, pinned, or invalid state still flashes a near-white surface");
  }
  if (!light.boardNodeStable || !dark.boardNodeStable || light.appMutationCount !== 0 || dark.appMutationCount !== 0) {
    failures.push("theme switching rerendered the Aboard application tree");
  }
  if (!light.boardStorageUnchanged || !dark.boardStorageUnchanged) {
    failures.push("theme switching changed the stored board");
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  try {
    await send("Emulation.setEmulatedMedia", { media: "", features: [] });
  } catch (error) {
    failures.push(`failed to restore emulated media: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (setupComplete) {
    try {
      result.restore = await evaluate(`(async () => {
        const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
        const state = window.__aboardThemeSyncTest;
        if (!state) return { classRestored: false, boardRestored: false, fixtureRemoved: false };
        state.appObserver?.disconnect();
        state.fixture?.remove();
        if (state.originalClassAttribute === null) document.documentElement.removeAttribute("class");
        else document.documentElement.setAttribute("class", state.originalClassAttribute);
        if (state.originalBoard === null) localStorage.removeItem("conversation-dashboard-board-v1");
        else localStorage.setItem("conversation-dashboard-board-v1", state.originalBoard);
        await sleep(80);
        const restored = {
          classRestored: document.documentElement.getAttribute("class") === state.originalClassAttribute,
          boardRestored: localStorage.getItem("conversation-dashboard-board-v1") === state.originalBoard,
          fixtureRemoved: !document.getElementById("conversation-dashboard-surface")?.querySelector("iframe")?.contentDocument?.getElementById("aboard-theme-sync-test-fixture")
        };
        delete window.__aboardThemeSyncTest;
        return restored;
      })()`);
      if (!result.restore.classRestored || !result.restore.boardRestored || !result.restore.fixtureRemoved) {
        failures.push("theme test did not fully restore host class, board storage, and fixtures");
      }
    } catch (error) {
      failures.push(`failed to restore Aboard state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  socket.close();
  socket.unref?.();
}

result.ok = failures.length === 0;
result.failures = failures;
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
