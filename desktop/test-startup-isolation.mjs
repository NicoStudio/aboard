#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(moduleDir, "aboard-runtime-launcher.zsh");
const launcherPath = path.join(moduleDir, "launcher.mjs");
const profilePreparationPath = path.join(moduleDir, "prepare-runtime-profile.mjs");
const injectionPath = path.join(moduleDir, "inject.js");
const taskScopedVariables = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI"
];

function parseEnvironment(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function waitForReadableFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw lastError || new Error(`Timed out waiting for ${filePath}`);
}

async function runWrapperIsolationTest() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "aboard-startup-isolation-"));
  try {
    const contents = path.join(sandbox, "Aboard.app", "Contents");
    const macos = path.join(contents, "MacOS");
    const dashboardDesktop = path.join(contents, "Resources", "dashboard", "desktop");
    const runtime = path.join(contents, "Resources", "runtime");
    const sourceApp = path.join(sandbox, "OfficialChatGPT.app");
    const sourceMacOS = path.join(sourceApp, "Contents", "MacOS");
    const home = path.join(sandbox, "home");
    const wrapper = path.join(macos, "Aboard");
    const runtimeBinary = path.join(sourceMacOS, "ChatGPT");
    const nodeBinary = path.join(runtime, "node");
    const launcherEnvironmentPath = path.join(sandbox, "launcher.env");
    const runtimeEnvironmentPath = path.join(sandbox, "runtime.env");
    const runtimeArgumentsPath = path.join(sandbox, "runtime.args");

    await Promise.all([dashboardDesktop, runtime, macos, sourceMacOS, home].map(directory => (
      mkdir(directory, { recursive: true })
    )));
    await copyFile(wrapperPath, wrapper);
    await writeFile(path.join(dashboardDesktop, "launcher.mjs"), "// test double\n", "utf8");
    await writeFile(nodeBinary, `#!/bin/zsh\nset -eu\ncase \"\${1:-}\" in *prepare-runtime-profile.mjs) exit 0 ;; esac\n/usr/bin/env > \"\${ABOARD_TEST_LAUNCHER_ENV:?}\"\n`, "utf8");
    await writeFile(runtimeBinary, `#!/bin/zsh\nset -eu\n/usr/bin/env > \"\${ABOARD_TEST_RUNTIME_ENV:?}\"\nprintf \"%s\\n\" \"$@\" > \"\${ABOARD_TEST_RUNTIME_ARGS:?}\"\n`, "utf8");
    await Promise.all([wrapper, nodeBinary, runtimeBinary].map(file => chmod(file, 0o755)));

    const inheritedEnvironment = {
      ...process.env,
      HOME: home,
      ABOARD_TEST_LAUNCHER_ENV: launcherEnvironmentPath,
      ABOARD_TEST_RUNTIME_ENV: runtimeEnvironmentPath,
      ABOARD_TEST_RUNTIME_ARGS: runtimeArgumentsPath,
      ABOARD_SOURCE_APP: sourceApp,
      ABOARD_TEST_MODE: "1",
      CODEX_THREAD_ID: "thread-must-not-escape",
      CODEX_SESSION_ID: "session-must-not-escape",
      CODEX_CI: "1",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "test-originator",
      CODEX_SHELL: "/tmp/test-shell"
    };
    const child = spawn(wrapper, [], {
      env: inheritedEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
    assert.equal(exitCode, 0, `wrapper test double failed: ${stderr}`);

    const [launcherText, runtimeText, runtimeArgumentsText] = await Promise.all([
      waitForReadableFile(launcherEnvironmentPath),
      waitForReadableFile(runtimeEnvironmentPath),
      waitForReadableFile(runtimeArgumentsPath)
    ]);
    const launcherEnvironment = parseEnvironment(launcherText);
    const runtimeEnvironment = parseEnvironment(runtimeText);
    for (const variable of taskScopedVariables) {
      assert.equal(variable in launcherEnvironment, false, `${variable} leaked into the Aboard launcher`);
      assert.equal(variable in runtimeEnvironment, false, `${variable} leaked into the Aboard runtime`);
    }
    assert.equal(launcherEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "test-originator");
    assert.equal(runtimeEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "test-originator");
    assert.equal(
      launcherEnvironment.ABOARD_RUNTIME_PID,
      String(child.pid),
      "the bridge launcher must track the LaunchServices-owned runtime PID"
    );
    assert.equal(
      "ABOARD_RUNTIME_PID" in runtimeEnvironment,
      false,
      "ABOARD_RUNTIME_PID must remain scoped to the bridge launcher"
    );
    assert.equal(
      runtimeEnvironment.CODEX_ELECTRON_USER_DATA_PATH,
      path.join(home, "Library", "Application Support", "Conversation Dashboard", "ChatGPT Profile"),
      "the signed runtime must use Aboard's isolated desktop profile"
    );
    assert.ok(
      runtimeArgumentsText.split(/\r?\n/).includes(`--user-data-dir=${runtimeEnvironment.CODEX_ELECTRON_USER_DATA_PATH}`),
      "the Aboard profile must be selected before Electron's native single-instance check"
    );
    assert.ok(
      runtimeArgumentsText.split(/\r?\n/).includes("--inspect=127.0.0.1:9238"),
      "Aboard must expose a loopback-only, one-shot main-process inspector for its Dock icon"
    );
    const supportRoot = path.join(home, "Library", "Application Support", "Conversation Dashboard");
    const profileRoot = path.join(supportRoot, "ChatGPT Profile");
    const logRoot = path.join(home, "Library", "Logs", "Conversation Dashboard");
    for (const privateDirectory of [supportRoot, profileRoot, logRoot]) {
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700,
        `private Aboard directory must be mode 0700: ${privateDirectory}`);
    }
    for (const logName of ["launcher.stdout.log", "launcher.stderr.log", "runtime.stdout.log", "runtime.stderr.log"]) {
      assert.equal((await stat(path.join(logRoot, logName))).mode & 0o777, 0o600,
        `Aboard log must be mode 0600: ${logName}`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function runProfilePreparationTest() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "aboard-profile-isolation-"));
  try {
    const statePath = path.join(sandbox, "browser-sidebar-page-states.json");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      pages: {
        persisted: { conversationId: "11111111-1111-4111-8111-111111111111", title: "must be removed" },
        draft: { conversationId: "client-new-thread:test", title: "safe draft" },
        unrelated: { title: "no conversation" }
      }
    }), "utf8");
    const child = spawn(process.execPath, [profilePreparationPath, sandbox], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
    assert.equal(exitCode, 0, `profile preparation failed: ${stderr}`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.version, 1);
    assert.deepEqual(Object.keys(state.pages).sort(), ["draft", "unrelated"]);
    assert.equal(state.pages.draft.title, "safe draft");

    await writeFile(statePath, "{not valid json", "utf8");
    const malformedChild = spawn(process.execPath, [profilePreparationPath, sandbox], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const malformedExitCode = await new Promise((resolve, reject) => {
      malformedChild.once("error", reject);
      malformedChild.once("exit", code => resolve(code));
    });
    assert.equal(malformedExitCode, 0, "malformed optional sidebar state must not block Aboard startup");
    assert.equal(await readFile(statePath, "utf8"), "{not valid json");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function extractNeutralExpression(source) {
  const functionMatch = source.match(
    /async function requestNeutralRouteOnce\(pages\) \{([\s\S]*?)\n\}\n\nasync function injectInto/
  );
  assert.ok(functionMatch, "requestNeutralRouteOnce must remain independently testable");
  const expressionMatch = functionMatch[1].match(
    /expression:\s*`([\s\S]*?)`,\n\s*awaitPromise:\s*true/
  );
  assert.ok(expressionMatch, "startup neutral-route expression was not found");
  return expressionMatch[1];
}

async function runNeutralRouteIdempotenceTest() {
  const source = await readFile(launcherPath, "utf8");
  const expression = extractNeutralExpression(source);
  const messages = [];
  const window = {
    postMessage(message, origin) {
      messages.push({ message, origin });
    }
  };
  const document = {
    readyState: "complete",
    querySelector(selector) {
      return selector === "aside" ? {} : null;
    }
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const evaluate = new AsyncFunction("window", "document", `return await (${expression});`);

  assert.equal(await evaluate(window, document), true);
  assert.equal(await evaluate(window, document), true);
  assert.deepEqual(messages, [{
    message: { type: "navigate-to-route", path: "/", replace: true },
    origin: "*"
  }], "repeated startup probes must emit exactly one neutral navigation");

  const mainMatch = source.match(/async function main\(\) \{([\s\S]*?)\n\}\n\nconst isMainModule/);
  assert.ok(mainMatch, "launcher main function was not found");
  const main = mainMatch[1];
  assert.equal(
    (main.match(/await requestNeutralRouteOnce\(/g) || []).length,
    1,
    "each launcher lifecycle must request startup neutralization exactly once"
  );
  assert.ok(
    main.indexOf("if (!bridge)") < main.indexOf("await requestNeutralRouteOnce("),
    "a duplicate launcher must exit before it can request another neutral route"
  );
  assert.ok(
    main.indexOf("await requestNeutralRouteOnce(") < main.indexOf("while (Date.now() < deadline)"),
    "neutral navigation must stay outside the retrying injection loop"
  );

  for (const forbidden of ["thread/resume", "thread/start", "navigate-to-route\", path: \"/local/"]) {
    assert.equal(source.includes(forbidden), false, `launcher must not claim a task at startup (${forbidden})`);
  }
}

function rendererInjectionSource(source) {
  return source
    .replace("__ABOARD_HANDOFF_BINDING__", JSON.stringify("__aboard_test_handoff"))
    .replace("__CONVERSATION_DASHBOARD_HTML__", JSON.stringify("<!doctype html><title>Aboard</title>"))
    .replace("__CODEX_THREAD_METADATA__", "[]")
    .replace("__ABOARD_HANDOFF_ENDPOINT__", JSON.stringify("http://127.0.0.1:47844/api/handoff"))
    .replace("__ABOARD_HANDOFF_TOKEN__", JSON.stringify("test-token"));
}

function createDocumentStartHarness(source) {
  const animationFrames = new Map();
  const observedRoots = [];
  const styles = new Map();
  let nextFrameId = 1;

  const document = {
    documentElement: null,
    head: null,
    body: null,
    visibilityState: "visible",
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) { return styles.get(id) || null; },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), id: "", textContent: "" };
    },
    hasFocus() { return true; }
  };
  const window = {
    addEventListener() {},
    matchMedia() {
      return { matches: false, addEventListener() {} };
    },
    postMessage() {}
  };
  window.window = window;

  const requestAnimationFrame = callback => {
    const id = nextFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => animationFrames.delete(id);
  class TestMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(root) {
      assert.ok(root, "MutationObserver must never be attached before the document root exists");
      observedRoots.push(root);
    }
    disconnect() {}
  }

  const context = vm.createContext({
    AbortController,
    MutationObserver: TestMutationObserver,
    URL,
    cancelAnimationFrame,
    clearInterval,
    clearTimeout,
    console,
    document,
    requestAnimationFrame,
    setInterval,
    setTimeout,
    window
  });

  return {
    document,
    observedRoots,
    styles,
    window,
    evaluate() {
      vm.runInContext(source, context, { filename: "inject.js" });
    },
    attachRoot() {
      const appendChild = element => {
        if (element?.id) styles.set(element.id, element);
        return element;
      };
      document.documentElement = {
        appendChild,
        classList: { contains() { return false; } },
        dataset: {}
      };
      document.head = { appendChild };
      document.body = { appendChild };
      return document.documentElement;
    },
    flushNextFrame() {
      const next = animationFrames.entries().next().value;
      assert.ok(next, "expected a pending document-root retry frame");
      const [id, callback] = next;
      animationFrames.delete(id);
      callback(Date.now());
    },
    pendingFrameCount() {
      return animationFrames.size;
    }
  };
}

async function runDocumentStartInjectionTest() {
  const rawSource = await readFile(injectionPath, "utf8");
  const source = rendererInjectionSource(rawSource);
  const expectedVersion = Number(rawSource.match(/const INJECTION_VERSION = (\d+);/)?.[1]);
  assert.ok(Number.isInteger(expectedVersion), "injection version must remain discoverable");

  const initialDocument = createDocumentStartHarness(source);
  assert.doesNotThrow(() => initialDocument.evaluate(), "document-start injection must tolerate a missing root");
  assert.equal(initialDocument.window.__conversationDashboardVersion, expectedVersion);
  assert.equal(initialDocument.pendingFrameCount(), 1, "missing-root injection must schedule exactly one retry");

  // The launcher evaluates the script once immediately in addition to registering
  // it for new documents. A same-document duplicate must not cancel the first
  // attempt or create a second observer startup loop.
  assert.doesNotThrow(() => initialDocument.evaluate());
  assert.equal(initialDocument.pendingFrameCount(), 1);
  const initialRoot = initialDocument.attachRoot();
  initialDocument.flushNextFrame();
  assert.deepEqual(initialDocument.observedRoots, [initialRoot, initialRoot]);
  assert.ok(initialDocument.styles.has("conversation-dashboard-host-style"));

  // A hard navigation creates a fresh renderer document/window. The registered
  // new-document script must perform the same deferred startup again there.
  const navigatedDocument = createDocumentStartHarness(source);
  assert.doesNotThrow(() => navigatedDocument.evaluate(), "hard-navigation reinjection must tolerate a missing root");
  const navigatedRoot = navigatedDocument.attachRoot();
  navigatedDocument.flushNextFrame();
  assert.equal(navigatedDocument.window.__conversationDashboardVersion, expectedVersion);
  assert.deepEqual(navigatedDocument.observedRoots, [navigatedRoot, navigatedRoot]);
  assert.ok(navigatedDocument.styles.has("conversation-dashboard-host-style"));
}

await runWrapperIsolationTest();
await runProfilePreparationTest();
await runNeutralRouteIdempotenceTest();
await runDocumentStartInjectionTest();
console.log("Aboard startup isolation verification passed.");
