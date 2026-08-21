#!/usr/bin/env node

// Pure regression for the Aboard-created conversation lifecycle. The test
// evaluates only the relevant production functions with synthetic rows and an
// in-memory board; it never opens a native conversation or touches user data.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const injectionSource = await readFile(path.join(moduleDir, "inject.js"), "utf8");
const dashboardSource = await readFile(path.join(moduleDir, "..", "web", "dashboard.html"), "utf8");

function sourceBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${label} start marker was not found`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${label} end marker was not found`);
  return source.slice(startIndex, endIndex).trim();
}

function productionFunction(source, name, nextName) {
  return sourceBetween(
    source,
    `function ${name}`,
    `\n\n    function ${nextName}`,
    name
  );
}

function runBootContract() {
  const bootSource = sourceBetween(
    injectionSource,
    "const boot = () => {",
    "\n\n  const startAfterDocumentRoot",
    "renderer boot"
  );

  const run = (pending, keepNativeView = false) => {
    const events = [];
    const context = vm.createContext({
      ensureInstalled: () => true,
      pendingDestination: () => pending,
      shouldKeepNativeView: () => keepNativeView,
      startCreationTracking: () => events.push("tracking"),
      hideDashboard: () => events.push("hidden"),
      showReturnControl: () => events.push("return-control"),
      showDashboard: () => events.push("shown"),
      requestAnimationFrame: () => events.push("retry")
    });
    vm.runInContext(`${bootSource}\nboot();`, context, { filename: "inject.js#boot" });
    return events;
  };

  const resumedCreation = run({
    destination: { kind: "work", projectId: "project-beta" },
    beforeIds: [],
    startedAt: Date.now()
  });
  assert.equal(
    resumedCreation.filter(event => event === "tracking").length,
    1,
    "a renderer created by native new-conversation navigation must resume capture"
  );
  assert.equal(
    resumedCreation.includes("shown"),
    false,
    "a pending native conversation must remain in the native Chat/Work page instead of reopening Aboard"
  );

  const ordinaryLaunch = run(null);
  assert.deepEqual(
    ordinaryLaunch,
    ["shown"],
    "an ordinary Aboard launch without a pending creation must still show the board"
  );

  assert.deepEqual(
    run(null, true),
    ["return-control"],
    "after board acknowledgement, a renderer refresh must remain on the native conversation until the user returns"
  );
}

function runProvisionalIdentityContract() {
  const identitySource = [
    sourceBetween(
      injectionSource,
      "function conversationFromProps(props)",
      "\n\n  function projectConversationData",
      "conversation props"
    ),
    sourceBetween(
      injectionSource,
      "function normalizedNativeId(rawId)",
      "\n\n  function nativeRowTitle",
      "native row identity"
    ),
    sourceBetween(
      injectionSource,
      "function threadPayload(row, cache = conversationCache())",
      "\n\n  function selectedThreadRows",
      "native thread payload"
    )
  ].join("\n\n");
  const createdId = "11111111-1111-4111-8111-000000700001";
  const storage = new Map();
  const location = { pathname: "/", search: "" };
  const titleNode = { textContent: "Synthetic created Work" };
  const row = {
    dataset: { appActionSidebarThreadId: "local:client-new-thread:synthetic-work" },
    matches: selector => selector === "[data-app-action-sidebar-thread-row]",
    querySelector: selector => selector === "[data-thread-title]" ? titleNode : null
  };
  let fiber = { memoizedProps: {} };
  row.__reactFiber$test = fiber;
  for (let depth = 0; depth < 5; depth += 1) {
    fiber.return = { memoizedProps: {} };
    fiber = fiber.return;
  }
  fiber.return = {
    memoizedProps: { entry: { conversationId: createdId, title: "Synthetic created Work" } },
    return: null
  };
  const context = vm.createContext({
    WORK_THREAD_SELECTOR: "[data-app-action-sidebar-thread-row]",
    NATIVE_ID_ALIASES_KEY: "conversation-dashboard-native-id-aliases",
    location,
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    visibleText(element) { return String(element?.textContent || "").trim(); },
    chatConversationWrapper() { return null; },
    projectConversationData() { return null; },
    nativeRowActive(candidate) { return candidate.active === true; },
    nativeSurfaceKind() { return "work"; },
    nativeRowTitle(candidate) { return String(candidate?.dataset?.appActionSidebarThreadTitle || "").trim(); },
    nativeRuntimeStatus() { return "active"; },
    conversationCache() { return new Map(); },
    CODEX_THREAD_METADATA: {}
  });
  vm.runInContext(`${identitySource}\nglobalThis.api = { normalizedRowId, threadPayload };`, context, {
    filename: "inject.js#nativeRowIdentity"
  });

  assert.equal(context.api.normalizedRowId(row), createdId, "React row metadata must replace a provisional Work id with its stable UUID");
  assert.equal(
    JSON.parse(storage.get("conversation-dashboard-native-id-aliases"))["client-new-thread:synthetic-work"],
    createdId,
    "the provisional-to-stable mapping must survive a renderer row refresh"
  );

  const routeFallbackRow = {
    active: true,
    dataset: {
      appActionSidebarThreadId: "local:client-new-thread:route-fallback",
      appActionSidebarThreadKind: "local",
      appActionSidebarThreadHostId: "local",
      appActionSidebarThreadTitle: "Synthetic route fallback"
    },
    matches: selector => selector === "[data-app-action-sidebar-thread-row]",
    querySelector: () => null
  };
  routeFallbackRow.active = false;
  assert.equal(context.api.threadPayload(routeFallbackRow), null, "a titled provisional row must never become an openable codex URL");
  routeFallbackRow.active = true;
  location.pathname = `/local/${createdId}`;
  assert.equal(context.api.normalizedRowId(routeFallbackRow), createdId, "the active route may resolve a provisional id when React metadata is briefly unavailable");
  assert.equal(context.api.threadPayload(routeFallbackRow)?.url, `codex://threads/${createdId}`, "only the resolved UUID may become the stored Work URL");
}

function runKnownBaselineContract() {
  const baselineSource = sourceBetween(
    injectionSource,
    "function currentKnownThreadIds()",
    "\n\n  function threadIdFromUrl",
    "known thread baseline"
  );
  const context = vm.createContext({
    currentThreadIds: () => new Set(["visible-thread"]),
    conversationCache: () => new Map([["cached-cloud-thread", {}]]),
    CODEX_THREAD_METADATA: { "indexed-work-thread": {} },
    currentRouteConversationId: () => "active-route-thread"
  });
  vm.runInContext(`${baselineSource}\nglobalThis.api = { currentKnownThreadIds };`, context, {
    filename: "inject.js#currentKnownThreadIds"
  });
  assert.deepEqual(
    [...context.api.currentKnownThreadIds()].sort(),
    ["active-route-thread", "cached-cloud-thread", "indexed-work-thread", "visible-thread"].sort(),
    "the creation baseline must include hidden cached/indexed conversations, not only currently mounted rows"
  );
  assert.match(injectionSource, /const beforeIds = \[\.\.\.currentKnownThreadIds\(\)\]/,
    "native create must persist the complete known baseline before opening the composer");
}

function runPendingExpiryContract() {
  const pendingSource = sourceBetween(
    injectionSource,
    "function pendingDestination()",
    "\n\n  function completePendingCreation",
    "pending creation expiry"
  );
  const pendingKey = "conversation-dashboard-pending-creation";
  const maxAge = 30 * 60 * 1000;
  const storage = new Map();
  let now = 1_800_000_000_000;
  const context = vm.createContext({
    Date: { now: () => now },
    JSON,
    pendingCreation: null,
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    }
  });
  vm.runInContext(
    `${pendingSource}\nglobalThis.api = { pendingDestination, current: () => pendingCreation };`,
    context,
    { filename: "inject.js#pendingDestination" }
  );

  const fresh = {
    destination: { kind: "chat", topic: "professional" },
    beforeIds: [],
    startedAt: now - 1_000
  };
  storage.set(pendingKey, JSON.stringify(fresh));
  assert.equal(context.api.pendingDestination().startedAt, fresh.startedAt,
    "a fresh persisted creation must resume after a renderer refresh");

  now = fresh.startedAt + maxAge + 1;
  assert.equal(context.api.pendingDestination(), null,
    "an abandoned creation must expire even when it is already held in memory");
  assert.equal(context.api.current(), null,
    "expiry must clear the in-memory destination so a later conversation cannot be misplaced");
  assert.equal(storage.has(pendingKey), false,
    "expiry must clear the persisted destination at the same time");

  const stale = { ...fresh, startedAt: now - maxAge - 1 };
  storage.set(pendingKey, JSON.stringify(stale));
  assert.equal(context.api.pendingDestination(), null,
    "a stale destination must not be rehydrated from localStorage");
  assert.equal(storage.has(pendingKey), false,
    "a stale persisted destination must be removed immediately");
}

function runCreationFreshnessContract() {
  const freshnessSource = sourceBetween(
    injectionSource,
    "function timestampMilliseconds(value)",
    "\n\n  async function captureCreatedConversation",
    "created route freshness"
  );
  const now = 1_800_000_000_000;
  const context = vm.createContext({
    Date: { now: () => now, parse: Date.parse },
    Number,
    String
  });
  vm.runInContext(
    `${freshnessSource}\nglobalThis.api = { timestampMilliseconds, uuidV7Timestamp, createdRouteFreshness };`,
    context,
    { filename: "inject.js#createdRouteFreshness" }
  );

  assert.equal(context.api.timestampMilliseconds(now / 1000), now, "epoch seconds must normalize to milliseconds");
  assert.equal(context.api.timestampMilliseconds(now), now, "epoch milliseconds must remain milliseconds");
  assert.equal(context.api.timestampMilliseconds(new Date(now).toISOString()), now, "ISO timestamps must normalize to milliseconds");
  assert.equal(context.api.timestampMilliseconds("not-a-date"), 0, "invalid timestamps must remain unknown");
  const v7Compact = `${now.toString(16).padStart(12, "0")}70008000000000000001`;
  const v7Id = `${v7Compact.slice(0, 8)}-${v7Compact.slice(8, 12)}-${v7Compact.slice(12, 16)}-${v7Compact.slice(16, 20)}-${v7Compact.slice(20)}`;
  assert.equal(context.api.uuidV7Timestamp(v7Id), now, "a UUIDv7 route must carry its creation time");
  const pending = { startedAt: now - 1_000, destination: { kind: "work" } };
  assert.equal(context.api.createdRouteFreshness(pending, v7Id, {}), "fresh", "a current UUIDv7 Work route must be accepted");
  assert.equal(
    context.api.createdRouteFreshness({ ...pending, startedAt: now + 120_000 }, v7Id, {}),
    "stale",
    "a route older than the pending transaction must be rejected"
  );
  assert.equal(
    context.api.createdRouteFreshness(
      { startedAt: now, destination: { kind: "chat" } },
      "synthetic-cloud-id",
      { createdAt: now - 30_000 }
    ),
    "stale",
    "a recently created but pre-existing cloud conversation omitted from the baseline must not be captured"
  );
  assert.equal(
    context.api.createdRouteFreshness({ startedAt: now, destination: { kind: "chat" } }, "synthetic-cloud-id", { createdAt: now + 120_000 }),
    "stale",
    "a future server timestamp must fail closed"
  );
  assert.equal(
    context.api.createdRouteFreshness({ startedAt: now, destination: { kind: "chat" } }, "synthetic-cloud-id", {}),
    "unknown",
    "missing cloud metadata must wait instead of being guessed"
  );
}

async function runReturnCancellationContract() {
  const returnSource = sourceBetween(
    injectionSource,
    "let returnToDashboardInFlight = false;",
    "\n\n  function showDashboard",
    "return-to-board creation cancellation"
  );
  const events = [];
  let pending = {
    destination: { kind: "work", projectId: "project-alpha" },
    startedAt: 1_800_000_000_000,
    creationId: "synthetic-empty-composer",
    threadId: null
  };
  const context = vm.createContext({
    pendingDestination() { return pending; },
    async captureCreatedConversation() { events.push("capture"); },
    samePendingCreation(left, right) { return left?.creationId === right?.creationId; },
    currentRouteConversationId() { return ""; },
    clearPendingCreation(value) {
      assert.equal(value.creationId, pending.creationId);
      pending = null;
      events.push("cancel");
      return true;
    },
    persistPendingCreation() { throw new Error("a blank composer must not remain pending"); },
    startCreationTracking() { throw new Error("a blank composer must not resume tracking"); },
    showDashboard() { events.push("board"); }
  });
  vm.runInContext(`${returnSource}\nglobalThis.api = { returnToDashboard };`, context, {
    filename: "inject.js#returnToDashboard"
  });
  await context.api.returnToDashboard();
  assert.deepEqual(events, ["capture", "cancel", "board"], "returning from an unsent blank composer must cancel before showing Aboard");
  assert.equal(pending, null, "the cancelled blank composer must not block the next create action");
  assert.match(injectionSource, /returnControl[\s\S]{0,180}returnToDashboard\(\)/,
    "the delegated left return control must use the cancellation-aware return path");
  assert.match(injectionSource, /if \(!active\) \{[\s\S]{0,260}nativeRow[\s\S]{0,160}clearPendingCreation\(unfinishedCreation\)/,
    "opening a native sidebar conversation after abandoning the composer must cancel the unanchored transaction");
  assert.match(injectionSource, /async function openNativeConversation[\s\S]{0,260}clearPendingCreation\(unfinishedCreation\)/,
    "opening an existing board item must cancel an unanchored create transaction before navigation");
}

async function runConcurrentCreationGuardContract() {
  const createSource = sourceBetween(
    injectionSource,
    "async function createNativeConversation(rawDestination)",
    "\n\n  function startCreationTracking",
    "native creation concurrency guard"
  );
  let releaseRows;
  const rowsReady = new Promise(resolve => { releaseRows = resolve; });
  const errors = [];
  const context = vm.createContext({
    nativeCreationStarting: false,
    pendingDestination() { return null; },
    reportCreateError(message) { errors.push(message); },
    ensureThreadRowsVisible() { return rowsReady; },
    currentKnownThreadIds() { return new Set(); },
    rememberNativeView() {},
    hideDashboard() {},
    showReturnControl() {},
    async ensureChatGPTMode() { return false; },
    showDashboard() {}
  });
  vm.runInContext(
    `${createSource}\nglobalThis.api = { createNativeConversation, starting: () => nativeCreationStarting };`,
    context,
    { filename: "inject.js#createNativeConversation" }
  );

  const first = context.api.createNativeConversation({ kind: "work", projectId: "project-alpha" });
  await Promise.resolve();
  await context.api.createNativeConversation({ kind: "work", projectId: "project-beta" });
  assert.equal(errors[0], "已有一条会话正在创建，请先完成后再新建",
    "a fast second create request must not overwrite the first destination");
  assert.equal(context.api.starting(), true,
    "the first launch must retain exclusive ownership while native preparation is pending");
  releaseRows([]);
  await first;
  assert.equal(context.api.starting(), false,
    "the creation launch guard must always release after a terminal result");
}

async function runWaitingAndCaptureContract() {
  const completionSource = sourceBetween(
    injectionSource,
    "function pendingCreationToken(value)",
    "\n\n  async function captureCreatedConversation",
    "created conversation pending lifecycle"
  );
  const captureSource = sourceBetween(
    injectionSource,
    "async function captureCreatedConversation()",
    "\n\n  function showDashboard",
    "created conversation capture"
  );
  const destination = { kind: "work", projectId: "project-beta" };
  const startedAt = Date.now();
  const createdId = "11111111-1111-4111-8111-000000700101";
  const pendingKey = "conversation-dashboard-pending-creation";
  const posted = [];
  const storage = new Map();
  const aliases = new Map();
  let routeId = "";
  const oldRow = { id: "existing-thread", title: "Existing conversation" };
  const createdRow = {
    id: "client-new-thread:synthetic-work",
    title: "",
    payload: {
      id: createdId,
      title: "",
      url: `codex://threads/${createdId}`,
      hostId: "local",
      surfaceKind: "work",
      runtimeStatus: "active",
      createdAt: new Date(startedAt + 1_000).toISOString()
    }
  };
  let rows = [oldRow, createdRow];
  let ensureRows = async () => rows;
  const context = vm.createContext({
    URL,
    SURFACE_ID: "conversation-dashboard-surface",
    captureCreationInFlight: false,
    pendingCreation: {
      destination,
      beforeIds: [oldRow.id],
      startedAt,
      creationId: "synthetic-create-generation",
      threadId: null
    },
    pendingCreationPollTimer: 17,
    ensureThreadRowsVisible() { return ensureRows(); },
    allThreadRows() { return rows; },
    currentRouteConversationId() { return routeId; },
    currentRouteSurfaceKind() { return context.location.pathname.startsWith("/local/") ? "work" : ""; },
    rawRowId(row) { return row?.id || ""; },
    normalizedRowId(row) { return aliases.get(row?.id) || row?.resolvedId || row?.id || ""; },
    nativeRowActive(row) { return row === createdRow; },
    rememberNativeIdAlias(provisionalId, stableId) { aliases.set(provisionalId, stableId); },
    nativeRowTitle(row) { return row?.title || ""; },
    conversationCache() { return new Map(); },
    threadPayload(row) { return row?.payload || null; },
    document: {
      querySelector() {
        return { contentWindow: { postMessage(message) { posted.push(message); } } };
      }
    },
    location: {
      pathname: "/",
      href: "https://aboard.invalid/"
    },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    clearInterval() {}
  });
  storage.set(pendingKey, JSON.stringify(context.pendingCreation));
  vm.runInContext(`${completionSource}\n${captureSource}\nglobalThis.api = { captureCreatedConversation, completePendingCreation, clearPendingCreation };`, context, {
    filename: "inject.js#captureCreatedConversation"
  });

  await context.api.captureCreatedConversation();
  assert.equal(posted.length, 0, "thinking before a stable conversation route exists must not finish capture");
  assert.ok(context.pendingCreation, "the pending destination must survive while GPT is still thinking");
  assert.ok(storage.has(pendingKey), "the persisted pending destination must survive a renderer change");

  const staleId = "11111111-1111-4111-8111-000000700099";
  routeId = staleId;
  context.location.pathname = `/local/${staleId}`;
  createdRow.resolvedId = staleId;
  createdRow.title = "Synthetic unloaded old Work";
  Object.assign(createdRow.payload, {
    id: staleId,
    title: createdRow.title,
    url: `codex://threads/${staleId}`,
    createdAt: new Date(startedAt - 24 * 60 * 60 * 1000).toISOString()
  });
  await context.api.captureCreatedConversation();
  assert.equal(context.pendingCreation, null,
    "an old same-kind route omitted from the DOM baseline must cancel instead of being captured as newly created");
  assert.equal(storage.has(pendingKey), false,
    "rejecting an unloaded old conversation must release the create guard immediately");

  context.pendingCreation = {
    destination,
    beforeIds: [oldRow.id],
    startedAt,
    creationId: "synthetic-create-generation",
    threadId: null
  };
  storage.set(pendingKey, JSON.stringify(context.pendingCreation));
  routeId = "";
  context.location.pathname = "/";
  createdRow.resolvedId = "";
  createdRow.title = "";
  Object.assign(createdRow.payload, {
    id: createdId,
    title: "",
    url: `codex://threads/${createdId}`,
    createdAt: new Date(startedAt + 1_000).toISOString()
  });

  routeId = createdId;
  context.location.pathname = `/local/${createdId}`;
  context.location.href = `https://aboard.invalid/local/${createdId}`;
  createdRow.resolvedId = createdId;
  await context.api.captureCreatedConversation();
  assert.equal(posted.length, 0, "a stable route without a real title must keep waiting instead of storing a placeholder");
  assert.equal(context.pendingCreation.threadId, createdId,
    "the stable native id must be persisted as soon as the new conversation route appears");
  assert.equal(JSON.parse(storage.get(pendingKey)).threadId, createdId,
    "the stable native id must survive leaving or reloading the new conversation page");

  const unrelatedId = "11111111-1111-4111-8111-000000700199";
  routeId = unrelatedId;
  context.location.pathname = `/local/${unrelatedId}`;
  context.location.href = `https://aboard.invalid/local/${unrelatedId}`;
  await context.api.captureCreatedConversation();
  assert.equal(context.pendingCreation.threadId, createdId,
    "a later same-kind route must never replace the first anchored conversation id");
  assert.equal(aliases.get(createdRow.id), createdId,
    "a later route must never remap the provisional source row to another conversation");

  routeId = "";
  context.location.pathname = "/";
  context.location.href = "https://aboard.invalid/";
  createdRow.title = "Synthetic created Work";
  createdRow.payload.title = createdRow.title;
  await context.api.captureCreatedConversation();
  const stablePayload = createdRow.payload;
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{
    method: "conversation-dashboard/native-created",
    payload: stablePayload,
    destination,
    startedAt,
    creationId: "synthetic-create-generation"
  }], "the active provisional row must be captured with the stable native route and original destination");
  assert.equal(aliases.get(createdRow.id), createdId, "the provisional client-new-thread id must be aliased to the stable route id");
  assert.equal(JSON.stringify(posted).includes("client-new-thread:"), false, "a provisional id must never be stored as an openable Aboard link");
  assert.ok(context.pendingCreation, "capture must wait for the board acknowledgement before clearing pending state");
  assert.equal(context.api.completePendingCreation(startedAt, "stale-generation"), false,
    "an acknowledgement from an older generation must not clear the current creation");
  assert.ok(context.pendingCreation, "a stale acknowledgement must leave the current creation pending");
  assert.equal(context.api.completePendingCreation(startedAt, "synthetic-create-generation"), true, "the matching board acknowledgement must complete capture");
  assert.equal(context.pendingCreation, null, "capture must clear the in-memory pending state");
  assert.equal(storage.has(pendingKey), false, "capture must clear the persisted pending state");
  assert.equal(context.pendingCreationPollTimer, null, "capture must stop polling after success");

  rows = [oldRow, createdRow];
  await context.api.captureCreatedConversation();
  assert.equal(posted.length, 1, "a completed creation must not be imported twice");

  const racePending = {
    destination,
    beforeIds: [oldRow.id],
    startedAt: startedAt + 10,
    creationId: "synthetic-cancel-race",
    threadId: null
  };
  context.pendingCreation = racePending;
  storage.set(pendingKey, JSON.stringify(racePending));
  let releaseRows;
  ensureRows = () => new Promise(resolve => { releaseRows = resolve; });
  const racingCapture = context.api.captureCreatedConversation();
  await Promise.resolve();
  assert.equal(context.api.clearPendingCreation(racePending), true,
    "returning while a capture awaits rows must invalidate that exact generation");
  releaseRows(rows);
  await racingCapture;
  assert.equal(context.pendingCreation, null,
    "a cancelled in-flight capture must never resurrect pending state after its await");
  assert.equal(storage.has(pendingKey), false,
    "a cancelled in-flight capture must never rewrite persistent pending state");
  assert.equal(posted.length, 1,
    "a cancelled in-flight capture must not emit a late native-created message");
}

function runPlacementAndReopenContract() {
  assert.match(
    dashboardSource,
    /conversation-dashboard\/native-created-ack[\s\S]{0,140}creationId:\s*message\.creationId/,
    "the board acknowledgement must return the exact creation generation"
  );
  const requiredFunctions = [
    productionFunction(dashboardSource, "threadIdFromUrl", "normalizedThreadId"),
    productionFunction(dashboardSource, "normalizedThreadId", "matchingThreadItem"),
    productionFunction(dashboardSource, "matchingThreadItem", "relativeTime"),
    productionFunction(dashboardSource, "liveRuntimeEntry", "itemProgress"),
    productionFunction(dashboardSource, "openItem", "isSupportedConversationUrl"),
    productionFunction(dashboardSource, "isSupportedConversationUrl", "sessionUrl"),
    productionFunction(dashboardSource, "sessionUrl", "importPayload"),
    productionFunction(dashboardSource, "storeCreatedThread", "updateConditionalFields")
  ].join("\n\n");

  const workId = "11111111-1111-4111-8111-000000700201";
  const chatId = "22222222-2222-4222-8222-000000700202";
  const messages = [];
  const toasts = [];
  const persisted = new Map();
  let fakeNow = 1_800_000_000_000;
  class TestDate extends Date {
    static now() { fakeNow += 1; return fakeNow; }
  }
  const context = vm.createContext({
    URL,
    Date: TestDate,
    Promise,
    board: {
      version: 2,
      defaultTab: "professional",
      chatSortBy: { professional: "updated", personal: "updated" },
      projects: [
        { id: "project-alpha", name: "Alpha", order: 1, sortBy: "updated" },
        { id: "project-beta", name: "Beta", order: 2, sortBy: "updated" }
      ],
      items: []
    },
    embeddedMode: true,
    storageKey: "conversation-dashboard-board-v1",
    liveRuntime: new Map(),
    lastOpenSignature: "",
    lastOpenAt: 0,
    modal: null,
    window: {
      parent: {
        postMessage(message, origin) { messages.push({ message, origin }); },
        localStorage: {
          setItem(key, value) { persisted.set(key, String(value)); }
        }
      }
    },
    updateBoard(mutator) { mutator(context.board); },
    render() {},
    showToast(message) { toasts.push(message); }
  });
  vm.runInContext(
    `${requiredFunctions}\nglobalThis.api = { storeCreatedThread, openItem };`,
    context,
    { filename: "dashboard.html#createConversationLifecycle" }
  );

  const workUrl = `codex://threads/${workId}?hostId=synthetic-host`;
  const chatUrl = `https://chatgpt.com/c/${chatId}`;
  context.api.storeCreatedThread({
    id: workId,
    title: "Synthetic created Work",
    url: workUrl,
    hostId: "synthetic-host",
    runtimeStatus: "active"
  }, { kind: "work", projectId: "project-beta" });
  context.api.storeCreatedThread({
    id: chatId,
    title: "Synthetic created Chat",
    url: chatUrl,
    runtimeStatus: "active"
  }, { kind: "chat", topic: "personal" });

  const work = context.board.items.find(item => item.url === workUrl);
  const chat = context.board.items.find(item => item.url === chatUrl);
  assert.ok(work, "the created Work item must be stored");
  assert.equal(work.kind, "work");
  assert.equal(work.projectId, "project-beta", "created Work must land in the project that launched it");
  assert.equal(work.topic, null);
  assert.equal(work.hostId, "synthetic-host");
  assert.ok(chat, "the created Chat item must be stored");
  assert.equal(chat.kind, "chat");
  assert.equal(chat.topic, "personal", "created Chat must land in the Chat tab that launched it");
  assert.equal(chat.projectId, null);
  assert.equal(
    JSON.parse(persisted.get("conversation-dashboard-board-v1")).items.length,
    2,
    "the created item must be synchronously durable before the host receives its acknowledgement"
  );

  context.api.openItem(work.id);
  context.api.openItem(chat.id);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    {
      origin: "*",
      message: {
        method: "conversation-dashboard/open-native",
        payload: {
          id: workId,
          url: workUrl,
          title: work.title,
          kind: "work",
          hostId: "synthetic-host",
          runtimeStatus: "active"
        }
      }
    },
    {
      origin: "*",
      message: {
        method: "conversation-dashboard/open-native",
        payload: {
          id: chatId,
          url: chatUrl,
          title: chat.title,
          kind: "chat",
          hostId: "",
          runtimeStatus: "active"
        }
      }
    }
  ], "reopening created Chat and Work items must use their exact original native routes");
  assert.deepEqual(toasts, [], "the successful create-and-reopen flow must not emit an error toast");
}

runBootContract();
runProvisionalIdentityContract();
runKnownBaselineContract();
runPendingExpiryContract();
runCreationFreshnessContract();
await runReturnCancellationContract();
await runConcurrentCreationGuardContract();
await runWaitingAndCaptureContract();
runPlacementAndReopenContract();
console.log("Aboard create-conversation lifecycle verification passed.");
