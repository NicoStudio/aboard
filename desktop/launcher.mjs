#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { appendFile, chmod, mkdir, open as openFile, readFile, stat as statFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const resourcesDir = path.resolve(moduleDir, "..");
const dataDir = path.join(process.env.HOME, "Library", "Application Support", "Conversation Dashboard");
const logsDir = path.join(process.env.HOME, "Library", "Logs", "Conversation Dashboard");
const logPath = path.join(logsDir, "launcher.log");
const cdpPort = 9237;
const dockInspectorPort = 9238;
const dockIconPath = path.resolve(resourcesDir, "..", "Aboard.png");
const handoffHost = "127.0.0.1";
const handoffPort = 47844;
const handoffEndpoint = `http://${handoffHost}:${handoffPort}/api/handoff`;
const officialCodexBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
const officialChatGPTRuntime = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const officialCodexBundleId = "com.openai.codex";
const codexRequestTimeoutMs = 6_000;
const codexStatePath = path.join(process.env.HOME, ".codex", "state_5.sqlite");
const writerLocksDir = path.join(process.env.HOME, ".codex", "thread-writer-locks");
const threadIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const rolloutTailBytes = 4 * 1_024 * 1_024;
const ownedRuntimePid = Number(process.env.ABOARD_RUNTIME_PID || 0);
let ownsHandoffBridge = false;
const execFileAsync = promisify(execFile);
let runtimeSnapshotCache = { key: "", expiresAt: 0, value: [] };

await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(logsDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
await chmod(logsDir, 0o700);
await appendFile(logPath, "", { encoding: "utf8", mode: 0o600 });
await chmod(logPath, 0o600);

async function log(message) {
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8").catch(() => {});
}

function isSupportedConversationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.username || url.password || url.port || url.hash) return false;
    const pathname = decodeURIComponent(url.pathname);
    if (url.protocol === "codex:") {
      const queryEntries = [...url.searchParams.entries()];
      const validQuery = queryEntries.length <= 1
        && queryEntries.every(([key, entry]) => key === "hostId" && entry.trim());
      return url.hostname === "threads"
        && /^\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/?$/i.test(pathname)
        && validQuery;
    }
    return url.protocol === "https:"
      && ["chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"].includes(url.hostname)
      && /^\/c\/[A-Za-z0-9_-]{12,}\/?$/.test(pathname);
  } catch {
    return false;
  }
}

function officialAppEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    "ABOARD_RUNTIME_PID",
    "CODEX_CI",
    "CODEX_ELECTRON_AGENT_RUN_ID",
    "CODEX_ELECTRON_USER_DATA_PATH",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID"
  ]) delete environment[key];
  return environment;
}

function hasDefaultOfficialRuntime(processList, excludedPid = ownedRuntimePid) {
  return String(processList || "").split(/\r?\n/).some(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return false;
    const pid = Number(match[1]);
    const command = match[2];
    return pid !== excludedPid
      && (command === officialChatGPTRuntime || command.startsWith(`${officialChatGPTRuntime} `))
      && !/(?:^|\s)--user-data-dir(?:=|\s)/.test(command);
  });
}

async function defaultOfficialRuntimeIsRunning() {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
      timeout: 2_000,
      maxBuffer: 2_000_000
    });
    return hasDefaultOfficialRuntime(stdout);
  } catch {
    return false;
  }
}

async function openInOfficialApp(url, overrides = {}) {
  const defaultRuntimeRunning = await (overrides.defaultOfficialRuntimeIsRunning || defaultOfficialRuntimeIsRunning)();
  const spawnProcess = overrides.spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    // Both the default client and Aboard's isolated runtime execute the same
    // signed bundle. Reuse the default client when it exists; otherwise force
    // LaunchServices to start a new default-profile instance so the URL cannot
    // be routed back into Aboard's hidden workspace.
    const args = defaultRuntimeRunning
      ? ["-b", officialCodexBundleId, url]
      : ["-n", "-b", officialCodexBundleId, url];
    const child = spawnProcess("/usr/bin/open", args, {
      env: officialAppEnvironment(),
      stdio: "ignore"
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Opening the official ChatGPT/Codex app timed out"));
    }, 6_000);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LaunchServices exited with status ${code}`));
    });
  });
}

async function withOfficialCodexAppServer(operation) {
  const child = spawn(officialCodexBinary, ["app-server", "--listen", "stdio://"], {
    env: officialAppEnvironment(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let nextId = 0;
  let exited = false;
  const pending = new Map();
  const failPending = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.length > 2_000_000) {
      failPending(new Error("Codex app-server response was too large"));
      child.kill("SIGTERM");
      return;
    }
    while (stdout.includes("\n")) {
      const newline = stdout.indexOf("\n");
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "Codex request failed"));
        else waiter.resolve(message.result);
      } catch {}
    }
  });
  child.once("error", failPending);
  child.once("exit", code => {
    exited = true;
    if (pending.size) failPending(new Error(stderr.trim() || `Codex app-server exited with status ${code}`));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited || child.stdin.destroyed) {
      reject(new Error(stderr.trim() || "Codex app-server is unavailable"));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex ${method} timed out`));
    }, codexRequestTimeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
      if (!error) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.reject(error);
    });
  });
  try {
    await request("initialize", {
      clientInfo: { name: "aboard", version: "1.0.4" },
      capabilities: { experimentalApi: true }
    });
    return await operation(request);
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    if (!exited) {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 1_000);
      forceTimer.unref?.();
      child.once("exit", () => clearTimeout(forceTimer));
    }
  }
}

async function renameOfficialThread(threadId, name) {
  await withOfficialCodexAppServer(request => request("thread/name/set", { threadId, name }));
}

function normalizedRuntimeThreadIds(values) {
  if (!Array.isArray(values)) throw new Error("Invalid runtime status request");
  const ids = [...new Set(values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean))];
  if (ids.length > 64 || ids.some(id => !threadIdPattern.test(id))) {
    throw new Error("Invalid runtime status request");
  }
  return ids;
}

function parseRolloutRuntimeTail(text, { writerActive = false, modifiedAtMs = 0, nowMs = Date.now() } = {}) {
  const terminalTypes = new Set(["task_complete", "turn_aborted", "task_aborted", "task_failed"]);
  let lifecycle = "";
  let progress = null;
  const lines = String(text || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0 && (!lifecycle || progress === null); index -= 1) {
    const line = lines[index];
    const mayContainLifecycle = !lifecycle && (
      line.includes('"type":"task_started"')
      || [...terminalTypes].some(type => line.includes(`"type":"${type}"`))
    );
    const mayContainProgress = progress === null && line.includes('"type":"token_count"');
    if (!mayContainLifecycle && !mayContainProgress) continue;
    try {
      const message = JSON.parse(line);
      const payload = message?.type === "event_msg" ? message.payload : null;
      if (!payload) continue;
      if (mayContainLifecycle && (payload.type === "task_started" || terminalTypes.has(payload.type))) {
        lifecycle = payload.type;
      }
      if (mayContainProgress && payload.type === "token_count") {
        const used = Number(payload.info?.last_token_usage?.total_tokens);
        const capacity = Number(payload.info?.model_context_window);
        if (Number.isFinite(used) && Number.isFinite(capacity) && capacity > 0) {
          progress = Math.max(0, Math.min(100, Math.round((used / capacity) * 100)));
        }
      }
    } catch {}
  }
  const recentlyWritten = Number.isFinite(modifiedAtMs) && modifiedAtMs > 0 && nowMs - modifiedAtMs < 120_000;
  const active = writerActive && (lifecycle === "task_started" || (!lifecycle && recentlyWritten));
  return { runtimeStatus: active ? "active" : "idle", progress: active ? progress : null };
}

async function writerLockOwners(ids, overrides = {}) {
  if (!ids.length) return new Map();
  const run = overrides.execFileAsync || execFileAsync;
  const inspect = overrides.statFile || statFile;
  const waitForRetry = overrides.waitForWriterLockRetry
    || (() => new Promise(resolve => setTimeout(resolve, 40)));
  const lockDir = overrides.writerLocksDir || writerLocksDir;
  const lockPaths = ids.map(id => path.join(lockDir, `${id}.lock`));
  const ownersByPath = new Map(lockPaths.map(lockPath => [lockPath, new Set()]));
  const ownerMap = () => new Map(ids.map((id, index) => [
    id,
    ownersByPath.get(lockPaths[index]) || new Set()
  ]));
  const inspectExisting = async candidates => (await Promise.all(candidates.map(async lockPath => {
    try {
      await inspect(lockPath);
      return lockPath;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("Could not safely inspect a conversation writer lock", { cause: error });
    }
  }))).filter(Boolean);
  const classifyProbeFailure = (error, candidates) => {
    if (Number(error?.code) !== 1 || error?.killed || error?.signal) return "unknown";
    const stderrLines = String(error?.stderr || "").trim().split(/\r?\n/).filter(Boolean);
    if (!stderrLines.length) return "no-match";
    return stderrLines.every(line =>
      line.includes("No such file or directory")
      && candidates.some(lockPath => line.includes(lockPath))
    ) ? "vanished" : "unknown";
  };
  const probeOwners = candidates => run("/usr/sbin/lsof", ["-Fpn", "--", ...candidates], {
    timeout: 2_000,
    maxBuffer: 1_000_000
  });

  let existingPaths = await inspectExisting(lockPaths);
  if (!existingPaths.length) {
    return ownerMap();
  }
  let output = "";
  try {
    ({ stdout: output } = await probeOwners(existingPaths));
  } catch (error) {
    const failure = classifyProbeFailure(error, existingPaths);
    if (failure === "no-match") {
      output = String(error?.stdout || "");
    } else if (failure === "vanished") {
      // A lock can be removed after stat but before lsof opens it. Recheck the
      // exact candidates, then give surviving locks one short chance to settle
      // before probing only those paths again.
      existingPaths = await inspectExisting(existingPaths);
      if (!existingPaths.length) return ownerMap();
      await waitForRetry(40);
      existingPaths = await inspectExisting(existingPaths);
      if (!existingPaths.length) return ownerMap();
      try {
        ({ stdout: output } = await probeOwners(existingPaths));
      } catch (retryError) {
        const retryFailure = classifyProbeFailure(retryError, existingPaths);
        if (retryFailure === "no-match") {
          output = String(retryError?.stdout || "");
        } else if (retryFailure === "vanished") {
          const survivors = await inspectExisting(existingPaths);
          if (!survivors.length) return ownerMap();
          throw new Error("Could not safely determine conversation writer ownership", { cause: retryError });
        } else {
          throw new Error("Could not safely determine conversation writer ownership", { cause: retryError });
        }
      }
    } else {
      throw new Error("Could not safely determine conversation writer ownership", { cause: error });
    }
  }
  let currentPid = 0;
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith("p")) {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith("n") || !Number.isInteger(currentPid) || currentPid <= 1) continue;
    ownersByPath.get(line.slice(1))?.add(currentPid);
  }
  return ownerMap();
}

async function heldWriterThreadIds(ids, overrides = {}) {
  const owners = await writerLockOwners(ids, overrides);
  return new Set(ids.filter(id => owners.get(id)?.size));
}

async function processParentMap(overrides = {}) {
  if (overrides.processParents instanceof Map) return overrides.processParents;
  const run = overrides.execFileAsync || execFileAsync;
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid="], {
    timeout: 2_000,
    maxBuffer: 1_000_000
  });
  const parents = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

function processBelongsToRuntime(pid, rootPid, parents) {
  let current = Number(pid);
  const seen = new Set();
  for (let depth = 0; Number.isInteger(current) && current > 1 && depth < 64; depth += 1) {
    if (current === rootPid) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = Number(parents.get(current));
  }
  return false;
}

async function rolloutPathsForThreads(ids, overrides = {}) {
  if (!ids.length) return new Map();
  const run = overrides.execFileAsync || execFileAsync;
  const statePath = overrides.codexStatePath || codexStatePath;
  const quotedIds = ids.map(id => `'${id}'`).join(",");
  const query = `SELECT id, rollout_path FROM threads WHERE id IN (${quotedIds});`;
  const { stdout } = await run("/usr/bin/sqlite3", ["-readonly", "-json", statePath, query], {
    timeout: 2_000,
    maxBuffer: 1_000_000
  });
  let rows = [];
  try { rows = JSON.parse(String(stdout || "[]")); } catch {}
  return new Map(rows.filter(row => ids.includes(String(row?.id || "").toLowerCase()) && row?.rollout_path)
    .map(row => [String(row.id).toLowerCase(), String(row.rollout_path)]));
}

async function readRolloutTail(rolloutPath, overrides = {}) {
  const open = overrides.openFile || openFile;
  const handle = await open(rolloutPath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, rolloutTailBytes);
    const start = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    if (length) await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return { text, modifiedAtMs: stats.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function loadRuntimeSnapshots(values, overrides = {}) {
  const ids = normalizedRuntimeThreadIds(values);
  if (!ids.length) return [];
  const cacheKey = ids.slice().sort().join(",");
  const now = Date.now();
  if (!overrides.disableCache && runtimeSnapshotCache.key === cacheKey && runtimeSnapshotCache.expiresAt > now) {
    return runtimeSnapshotCache.value;
  }
  const held = await heldWriterThreadIds(ids, overrides);
  const activeCandidates = ids.filter(id => held.has(id));
  const rolloutPaths = await rolloutPathsForThreads(activeCandidates, overrides).catch(() => new Map());
  const snapshots = await Promise.all(ids.map(async id => {
    if (!held.has(id)) return { id, runtimeStatus: "idle", progress: null };
    const rolloutPath = rolloutPaths.get(id);
    if (!rolloutPath) return { id, runtimeStatus: "idle", progress: null };
    try {
      const tail = await readRolloutTail(rolloutPath, overrides);
      return { id, ...parseRolloutRuntimeTail(tail.text, { writerActive: true, modifiedAtMs: tail.modifiedAtMs }) };
    } catch {
      return { id, runtimeStatus: "idle", progress: null };
    }
  }));
  if (!overrides.disableCache) runtimeSnapshotCache = { key: cacheKey, expiresAt: now + 2_000, value: snapshots };
  return snapshots;
}

async function threadAvailability(value, overrides = {}) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) {
    throw new Error("Invalid conversation availability request");
  }
  const owners = await writerLockOwners([id], overrides);
  const holderPids = [...(owners.get(id) || [])];
  if (!holderPids.length) return { id, claimed: false, ownership: "none" };
  const runtimePid = Number(overrides.ownedRuntimePid ?? ownedRuntimePid);
  if (!Number.isInteger(runtimePid) || runtimePid <= 1) {
    return { id, claimed: true, ownership: "other" };
  }
  try {
    const parents = await processParentMap(overrides);
    const selfOwned = holderPids.every(pid => processBelongsToRuntime(pid, runtimePid, parents));
    return { id, claimed: true, ownership: selfOwned ? "self" : "other" };
  } catch {
    return { id, claimed: true, ownership: "other" };
  }
}

async function performHostOperation(method, payload) {
  if (method === "runtime-status") {
    return loadRuntimeSnapshots(payload?.ids || []);
  }
  if (method === "thread-availability") {
    return threadAvailability(payload?.id);
  }
  if (method === "rename") {
    const id = String(payload?.id || "").trim();
    const title = String(payload?.title || "").trim();
    if (!/^[A-Za-z0-9-]{12,}$/.test(id) || !title || [...title].length > 200) {
      throw new Error("Invalid conversation rename request");
    }
    await renameOfficialThread(id, title);
    await log("Renamed a conversation through the official Codex app-server");
    return undefined;
  }
  if (method !== "handoff") throw new Error("Unsupported Aboard bridge operation");
  const url = String(payload?.url || "").trim();
  if (!isSupportedConversationUrl(url)) throw new Error("Unsupported conversation link");
  await openInOfficialApp(url);
  await log("Handed a conversation to the official ChatGPT profile");
  return undefined;
}

function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Aboard-Token",
    "Access-Control-Allow-Private-Network": "true",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function startHandoffBridge(token, expectedVersion, bindingName) {
  const server = createServer(async (request, response) => {
    request.setTimeout(13_000, () => request.destroy());
    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, {
        ok: true,
        injectionVersion: expectedVersion,
        bindingName
      });
      return;
    }
    const isHandoff = request.url === "/api/handoff";
    const isRename = request.url === "/api/rename";
    if (request.method !== "POST" || (!isHandoff && !isRename)) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    if (request.headers["x-aboard-token"] !== token) {
      writeJson(response, 403, { error: "Invalid Aboard token" });
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8_192) throw new Error("Handoff request is too large");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await performHostOperation(isRename ? "rename" : "handoff", payload);
      writeJson(response, 202, { ok: true });
    } catch (error) {
      await log(`Handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", error => {
      if (error?.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(handoffPort, handoffHost, () => resolve(server));
  });
}

async function runtimeEndpointIsAlive() {
  try {
    const response = await fetch(`http://localhost:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(600)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function existingBridgeBindingName(expectedVersion) {
  try {
    const response = await fetch(`http://${handoffHost}:${handoffPort}/health`, {
      signal: AbortSignal.timeout(600)
    });
    if (!response.ok) return "";
    const health = await response.json();
    const bindingName = String(health?.bindingName || "");
    return health?.ok === true
      && health?.injectionVersion === expectedVersion
      && /^__aboardNativeBridge_[a-f0-9]{24}$/.test(bindingName)
      ? bindingName
      : "";
  } catch {
    return "";
  }
}

function ownedRuntimeIsAlive() {
  if (!Number.isInteger(ownedRuntimePid) || ownedRuntimePid <= 1) return true;
  try {
    process.kill(ownedRuntimePid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runtimeHasCurrentInjection(expectedVersion, bindingName) {
  try {
    const response = await fetch(`http://localhost:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(800)
    });
    if (!response.ok) return false;
    const pages = await response.json();
    const targets = pages.filter(page => page.type === "page"
      && page.url.startsWith("app://-/index.html")
      && !page.url.includes("avatar-overlay"));
    for (const target of targets) {
      const { socket, send } = await connect(target.webSocketDebuggerUrl, 1_000);
      try {
        const result = await send("Runtime.evaluate", {
          expression: `window.__conversationDashboardVersion === ${Number(expectedVersion)} && window.__conversationDashboardBindingName === ${JSON.stringify(bindingName)}`,
          returnByValue: true
        }, 1_000);
        if (result.result?.result?.value === true) return true;
      } finally {
        socket.close();
      }
    }
  } catch {}
  return false;
}

async function existingBridgeOwnsActiveRenderer(expectedVersion) {
  const bindingName = await existingBridgeBindingName(expectedVersion);
  return Boolean(bindingName)
    && await runtimeEndpointIsAlive()
    && await runtimeHasCurrentInjection(expectedVersion, bindingName);
}

async function acquireHandoffBridge(token, expectedVersion, bindingName, overrides = {}) {
  const startBridge = overrides.startBridge || startHandoffBridge;
  const bridgeOwnsActiveRenderer = overrides.bridgeOwnsActiveRenderer || existingBridgeOwnsActiveRenderer;
  const runtimeIsAlive = overrides.runtimeIsAlive || ownedRuntimeIsAlive;
  const pause = overrides.pause || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const writeLog = overrides.writeLog || log;
  const attempts = overrides.attempts ?? 80;
  const retryDelayMs = overrides.retryDelayMs ?? 250;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const server = await startBridge(token, expectedVersion, bindingName);
    if (server) return server;

    // The bridge winner may belong to either wrapper in a concurrent launch.
    // Once that bridge has injected the live renderer, it is the authoritative
    // owner even when this launch's runtime is the Electron singleton that
    // remains alive. Waiting for our own runtime to exit here lets the primary
    // launcher time out and terminate the healthy singleton.
    if (await bridgeOwnsActiveRenderer(expectedVersion, bindingName)) {
      await writeLog("This launch lost the single-instance race to the active Aboard renderer");
      return null;
    }

    // A secondary Electron invocation normally exits after forwarding its
    // launch to the singleton. If its launcher did not win the bridge race,
    // there is no ownership left for it to establish.
    if (!runtimeIsAlive()) {
      await writeLog("This launch's Aboard runtime exited before the handoff bridge became available");
      return null;
    }
    await pause(retryDelayMs);
  }

  // Close the narrow race where the other launcher completes injection after
  // the final retry started but before we report an ownership failure.
  if (await bridgeOwnsActiveRenderer(expectedVersion, bindingName)) {
    await writeLog("This launch lost the single-instance race to the active Aboard renderer");
    return null;
  }
  const error = new Error("Aboard handoff bridge ownership could not be established");
  error.code = "ABOARD_BRIDGE_OWNERSHIP_UNRESOLVED";
  throw error;
}

function mayTerminateOwnedRuntime(bridgeOwned = ownsHandoffBridge, runtimePid = ownedRuntimePid, parentPid = process.ppid) {
  return bridgeOwned
    && Number.isInteger(runtimePid)
    && runtimePid > 1
    && parentPid === runtimePid;
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedRuntimeIsAlive()) throw new Error("Aboard runtime exited before startup completed");
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function cdpPages(timeoutMs = 20_000) {
  const response = await waitFor(`http://localhost:${cdpPort}/json/list`, timeoutMs);
  return response.json();
}

async function ensureRuntime(overrides = {}) {
  const timeoutMs = overrides.timeoutMs ?? 60_000;
  const loadPages = overrides.loadPages || (() => cdpPages(1_000));
  const runtimeIsAlive = overrides.runtimeIsAlive || ownedRuntimeIsAlive;
  const pause = overrides.pause || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!runtimeIsAlive()) throw new Error("Aboard runtime exited before startup completed");
    try {
      const pages = await loadPages();
      const workspaceReady = Array.isArray(pages) && pages.some(page => (
        page?.type === "page"
        && String(page.url || "").startsWith("app://-/index.html")
        && !String(page.url || "").includes("avatar-overlay")
        && Boolean(page.webSocketDebuggerUrl)
      ));
      if (workspaceReady) return pages;
    } catch (error) {
      lastError = error;
    }
    await pause(120);
  }
  throw lastError || new Error("Timed out waiting for the Aboard workspace renderer");
}

async function connect(url, timeoutMs = 3_000) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to the Aboard renderer"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", error => {
      clearTimeout(timer);
      reject(error);
    }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const failPending = error => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  socket.addEventListener("error", () => failPending(new Error("Aboard renderer connection failed")));
  socket.addEventListener("close", () => failPending(new Error("Aboard renderer connection closed")));
  const send = (method, params = {}, requestTimeoutMs = 4_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for CDP ${method}`));
    }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function dockInspectorTargets(timeoutMs = 12_000, overrides = {}) {
  const loadTargets = overrides.loadTargets || (async () => {
    const response = await fetch(`http://127.0.0.1:${dockInspectorPort}/json/list`, {
      signal: AbortSignal.timeout(700)
    });
    if (!response.ok) throw new Error(`Dock inspector returned status ${response.status}`);
    return response.json();
  });
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!ownedRuntimeIsAlive()) throw new Error("Aboard runtime exited before its Dock icon was ready");
    try {
      const targets = await loadTargets();
      if (Array.isArray(targets) && targets.some(target => target?.webSocketDebuggerUrl)) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw lastError || new Error("Timed out waiting for the Aboard Dock inspector");
}

async function setRuntimeDockIcon(overrides = {}) {
  const targets = overrides.targets || await dockInspectorTargets(overrides.timeoutMs, overrides);
  const target = targets.find(candidate => candidate?.webSocketDebuggerUrl);
  if (!target) throw new Error("The Aboard Dock inspector target is unavailable");
  const openConnection = overrides.connect || connect;
  const { socket, send } = await openConnection(target.webSocketDebuggerUrl, 2_000);
  try {
    const iconPath = overrides.iconPath || dockIconPath;
    const expression = `(() => {
      const electron = process.mainModule.require("electron");
      const inspector = process.mainModule.require("node:inspector");
      setTimeout(() => { try { inspector.close(); } catch {} }, 120);
      const image = electron.nativeImage.createFromPath(${JSON.stringify(iconPath)});
      if (image.isEmpty()) throw new Error("Aboard Dock icon could not be decoded");
      electron.app.dock.setIcon(image);
      const size = image.getSize();
      return { ok: true, width: size.width, height: size.height };
    })()`;
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true
    }, 3_000);
    const value = response.result?.result?.value;
    if (response.result?.exceptionDetails || value?.ok !== true || value.width < 128 || value.height < 128) {
      throw new Error(response.result?.exceptionDetails?.text || "Aboard Dock icon update failed");
    }
    await log(`Applied Aboard Dock icon (${value.width}x${value.height})`);
    return value;
  } finally {
    socket.close();
  }
}

async function requestNeutralRouteOnce(pages) {
  const targets = pages.filter(page => page.type === "page"
    && page.url.startsWith("app://-/index.html")
    && !page.url.includes("avatar-overlay"));
  let confirmed = 0;
  let lastError = null;
  for (const target of targets) {
    try {
      const { socket, send } = await connect(target.webSocketDebuggerUrl);
      try {
        const response = await send("Runtime.evaluate", {
          expression: `(async () => {
            if (window.__aboardStartupNeutralHandled === true) return true;
            delete window.__aboardStartupNeutralHandled;
            const deadline = Date.now() + 15_000;
            let neutralSamples = 0;
            while (document.readyState !== "complete" && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            while (Date.now() < deadline) {
              window.postMessage({ type: "navigate-to-route", path: "/", replace: true }, "*");
              await new Promise(resolve => setTimeout(resolve, 160));
              const composerValue = String(document.querySelector("[data-above-composer-conversation-id]")
                ?.getAttribute("data-above-composer-conversation-id") || "").trim();
              const stableComposer = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(composerValue.replace(/^local:/, ""))
                || /^chatgpt:(?:conversation:)?[A-Za-z0-9_-]{12,}$/.test(composerValue);
              const activePersistedRow = Boolean(document.querySelector(
                '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"],'
                + '[data-app-action-sidebar-thread-row][aria-current="page"],'
                + '[data-sidebar-chatgpt-conversation-key][aria-current="page"],'
                + '[data-sidebar-chatgpt-conversation-key] [aria-current="page"]'
              ));
              const workspaceReady = Boolean(document.querySelector("aside"));
              neutralSamples = workspaceReady && !stableComposer && !activePersistedRow
                ? neutralSamples + 1
                : 0;
              if (neutralSamples >= 3) {
                window.__aboardStartupNeutralHandled = true;
                return true;
              }
            }
            throw new Error("Aboard startup route did not reach the neutral workspace");
          })()`,
          awaitPromise: true,
          returnByValue: true
        }, 16_000);
        if (response.result?.exceptionDetails || response.result?.result?.value !== true) {
          throw new Error(response.result?.exceptionDetails?.exception?.description
            || response.result?.exceptionDetails?.text
            || "Aboard could not confirm the neutral startup workspace");
        }
        confirmed += 1;
      } finally {
        socket.close();
      }
    } catch (error) {
      lastError = error;
      await log(`Could not neutralize an early renderer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!targets.length || confirmed !== targets.length) {
    throw lastError || new Error("Aboard startup renderer was unavailable for safe neutralization");
  }
}

async function injectInto(page, script, bindingName) {
  const { socket, send } = await connect(page.webSocketDebuggerUrl);
  const connection = { socket, send, closed: false };
  const contexts = new Map();
  const inFlightBridgeRequests = new Set();
  let rootFrameId = "";
  socket.addEventListener("close", () => { connection.closed = true; });
  socket.addEventListener("error", () => { connection.closed = true; });
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.method === "Runtime.executionContextCreated") {
      contexts.set(message.params?.context?.id, message.params?.context || {});
      return;
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      contexts.delete(message.params?.executionContextId);
      return;
    }
    if (message.method === "Runtime.executionContextsCleared") {
      contexts.clear();
      return;
    }
    if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId) {
      rootFrameId = message.params?.frame?.id || rootFrameId;
      return;
    }
    if (message.method !== "Runtime.bindingCalled" || message.params?.name !== bindingName) return;
    const contextId = message.params?.executionContextId;
    const context = contexts.get(contextId);
    const auxiliary = context?.auxData || {};
    if (!context || auxiliary.isDefault !== true || auxiliary.frameId !== rootFrameId || context.origin !== "app://-") return;
    void (async () => {
      let requestId = "";
      let ownsRequest = false;
      let result;
      try {
        const raw = String(message.params?.payload || "");
        if (!raw || Buffer.byteLength(raw) > 8_192) throw new Error("Aboard bridge request is too large");
        const request = JSON.parse(raw);
        requestId = String(request?.requestId || "");
        if (!requestId || requestId.length > 160) throw new Error("Invalid Aboard bridge request");
        if (inFlightBridgeRequests.has(requestId)) throw new Error("Duplicate Aboard bridge request");
        if (inFlightBridgeRequests.size >= 8) throw new Error("Too many concurrent Aboard bridge requests");
        inFlightBridgeRequests.add(requestId);
        ownsRequest = true;
        const value = await performHostOperation(String(request?.method || ""), request?.payload || {});
        result = value === undefined ? { ok: true } : { ok: true, value };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await log(`Aboard renderer bridge failed: ${detail}`);
        result = { ok: false, error: detail };
      }
      if (!requestId) return;
      try {
        await send("Runtime.callFunctionOn", {
          executionContextId: contextId,
          functionDeclaration: "function(requestId, result) { globalThis.__conversationDashboardResolveBridge?.(requestId, result); }",
          arguments: [{ value: requestId }, { value: result }],
          returnByValue: true
        }, 2_000);
      } catch {}
      if (ownsRequest) inFlightBridgeRequests.delete(requestId);
    })();
  });
  try {
    await send("Page.enable");
    const frameTree = await send("Page.getFrameTree");
    rootFrameId = frameTree.result?.frameTree?.frame?.id || "";
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: bindingName });
    await send("Page.setBypassCSP", { enabled: true });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    await send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
    return connection;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function inject(handoffToken, bindingName) {
  const [injectTemplate, dashboardTemplate, boardText, codexThreadMetadata] = await Promise.all([
    readFile(path.join(resourcesDir, "desktop", "inject.js"), "utf8"),
    readFile(path.join(resourcesDir, "web", "dashboard.html"), "utf8"),
    readFile(path.join(resourcesDir, "desktop", "default-board.json"), "utf8"),
    loadCodexThreadMetadata()
  ]);
  const board = JSON.parse(boardText);
  const dashboardHtml = dashboardTemplate.replace("__BOARD_JSON__", JSON.stringify(board).replaceAll("<", "\\u003c"));
  const script = injectTemplate
    .replace("__CONVERSATION_DASHBOARD_HTML__", JSON.stringify(dashboardHtml))
    .replace("__CODEX_THREAD_METADATA__", JSON.stringify(codexThreadMetadata))
    .replace("__ABOARD_HANDOFF_ENDPOINT__", JSON.stringify(handoffEndpoint))
    .replace("__ABOARD_HANDOFF_TOKEN__", JSON.stringify(handoffToken))
    .replace("__ABOARD_HANDOFF_BINDING__", JSON.stringify(bindingName));
  const pages = await cdpPages();
  const targets = pages.filter(page => page.type === "page" && page.url.startsWith("app://-/index.html") && !page.url.includes("avatar-overlay"));
  if (!targets.length) throw new Error("The ChatGPT workspace renderer is not ready");
  let injectedCount = 0;
  const injectedTargetIds = [];
  const bridgeConnections = [];
  for (const target of targets) {
    const { socket, send } = await connect(target.webSocketDebuggerUrl);
    let ready;
    try {
      await send("Runtime.enable");
      ready = await send("Runtime.evaluate", {
        expression: `document.readyState !== "loading" && Boolean(document.documentElement && document.body)`,
        returnByValue: true
      });
    } finally {
      socket.close();
    }
    if (ready.result?.result?.value !== true) continue;
    const connection = await injectInto(target, script, bindingName);
    bridgeConnections.push(connection);
    injectedCount += 1;
    if (target.id) injectedTargetIds.push(target.id);
  }
  if (!injectedCount) throw new Error("The ChatGPT workspace renderer is not ready");
  await log(`Injected Aboard into ${injectedCount} renderer(s)`);
  return { injectedTargetIds, bridgeConnections };
}

function createdAtFromUuidV7(id) {
  const compact = String(id || "").replaceAll("-", "");
  if (compact.length < 13 || compact[12] !== "7") return "";
  const milliseconds = Number.parseInt(compact.slice(0, 12), 16);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
}

async function loadCodexThreadMetadata() {
  try {
    const indexPath = path.join(process.env.HOME, ".codex", "session_index.jsonl");
    const lines = (await readFile(indexPath, "utf8")).split(/\r?\n/).filter(Boolean);
    return Object.fromEntries(lines.flatMap(line => {
      try {
        const entry = JSON.parse(line);
        if (!entry?.id) return [];
        return [[entry.id, {
          title: entry.thread_name || "",
          createdAt: createdAtFromUuidV7(entry.id),
          updatedAt: entry.updated_at || ""
        }]];
      } catch {
        return [];
      }
    }));
  } catch {
    return {};
  }
}

async function main() {
  await log("Launcher started");
  const injectSource = await readFile(path.join(resourcesDir, "desktop", "inject.js"), "utf8");
  const versionMatch = injectSource.match(/const INJECTION_VERSION = (\d+);/);
  if (!versionMatch) throw new Error("Could not determine the Aboard injection version");
  const expectedVersion = Number(versionMatch[1]);
  const handoffToken = randomBytes(24).toString("base64url");
  const bindingName = `__aboardNativeBridge_${randomBytes(12).toString("hex")}`;
  const bridge = await acquireHandoffBridge(handoffToken, expectedVersion, bindingName);
  if (!bridge) {
    await log("Aboard handoff bridge is already active; duplicate launcher exiting");
    return;
  }
  ownsHandoffBridge = true;
  const rendererBridgeConnections = [];
  try {
    const startupPages = await ensureRuntime();
    // Release a restored task as soon as the Electron renderer exists. This is
    // deliberately outside the retrying injection loop, so it can never create
    // the repeated navigation/flash cycle it is meant to prevent.
    await requestNeutralRouteOnce(startupPages);
    const deadline = Date.now() + 60_000;
    let lastError = null;
    let injected = false;
    let ownedTargetIds = [];
    while (Date.now() < deadline) {
      try {
        const injection = await inject(handoffToken, bindingName);
        ownedTargetIds = injection.injectedTargetIds;
        rendererBridgeConnections.push(...injection.bridgeConnections);
        injected = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!injected) throw lastError || new Error("Aboard injection timed out");
    // ChatGPT applies its own application icon late in startup. Set Aboard's
    // icon only after the dashboard renderer is fully injected, then close the
    // one-shot main-process inspector from inside Electron.
    await new Promise(resolve => setTimeout(resolve, 500));
    await setRuntimeDockIcon();

    // Stay alive to service explicit handoffs. Track the exact renderer targets
    // we injected rather than only the shared CDP port; a replacement Aboard
    // process can otherwise keep an obsolete launcher alive forever.
    const ownedTargets = new Set(ownedTargetIds);
    let misses = 0;
    while (misses < 6) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (rendererBridgeConnections.some(connection => connection.closed)) {
        throw new Error("The Aboard renderer bridge disconnected");
      }
      try {
        const response = await fetch(`http://localhost:${cdpPort}/json/list`, {
          signal: AbortSignal.timeout(600)
        });
        const pages = response.ok ? await response.json() : [];
        const ownsCurrentRenderer = pages.some(page => ownedTargets.has(page.id));
        misses = ownsCurrentRenderer ? 0 : misses + 1;
      } catch {
        misses += 1;
      }
    }
    throw new Error("The Aboard renderer exited while its runtime was still active");
  } finally {
    for (const connection of rendererBridgeConnections) connection.socket.close();
    bridge.closeAllConnections?.();
    await new Promise(resolve => bridge.close(resolve));
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(async error => {
    await log(`ERROR ${error instanceof Error ? error.stack : String(error)}`);
    // A launcher that never acquired the bridge is only a contender. It must
    // never terminate the Electron singleton merely because another launcher
    // won the race or because bridge ownership remained temporarily unclear.
    if (mayTerminateOwnedRuntime()) {
      try { process.kill(ownedRuntimePid, "SIGTERM"); } catch {}
    }
    process.exitCode = 1;
  });
}

export {
  acquireHandoffBridge,
  ensureRuntime,
  hasDefaultOfficialRuntime,
  isSupportedConversationUrl,
  loadRuntimeSnapshots,
  mayTerminateOwnedRuntime,
  openInOfficialApp,
  parseRolloutRuntimeTail,
  setRuntimeDockIcon,
  threadAvailability
};
