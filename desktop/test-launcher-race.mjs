#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sandbox = await mkdtemp(path.join(tmpdir(), "aboard-launcher-race-"));
const previousHome = process.env.HOME;

try {
  process.env.HOME = sandbox;
  const {
    acquireHandoffBridge,
    hasDefaultOfficialRuntime,
    isSupportedConversationUrl,
    mayTerminateOwnedRuntime,
    openInOfficialApp,
    setRuntimeDockIcon
  } = await import(`./launcher.mjs?race-test=${Date.now()}`);

  let dockSocketClosed = false;
  let dockEvaluation = null;
  const dockResult = await setRuntimeDockIcon({
    targets: [{ webSocketDebuggerUrl: "ws://127.0.0.1:9238/test" }],
    iconPath: "/Applications/Aboard.app/Contents/Resources/Aboard.png",
    connect: async url => {
      assert.equal(url, "ws://127.0.0.1:9238/test");
      return {
        socket: { close() { dockSocketClosed = true; } },
        send: async (method, params) => {
          assert.equal(method, "Runtime.evaluate");
          dockEvaluation = params.expression;
          return { result: { result: { value: { ok: true, width: 1024, height: 1024 } } } };
        }
      };
    }
  });
  assert.deepEqual(dockResult, { ok: true, width: 1024, height: 1024 });
  assert.equal(dockSocketClosed, true, "the one-shot Dock inspector connection must close after use");
  assert.match(dockEvaluation, /electron\.app\.dock\.setIcon\(image\)/,
    "the runtime must apply Aboard's icon through Electron's own Dock API");
  assert.match(dockEvaluation, /node:inspector/,
    "the temporary Node inspector must close itself after applying the icon");
  assert.match(dockEvaluation, /Aboard\.png/,
    "the runtime Dock icon must use the transparent Aboard artwork");

  const legacyChatId = "22222222-2222-4222-8222-222222222222";
  assert.equal(isSupportedConversationUrl(`https://chat.openai.com/c/${legacyChatId}`), true,
    "legacy official Chat URLs accepted by Aboard must also be accepted by handoff");
  assert.equal(isSupportedConversationUrl(`https://www.chat.openai.com/c/${legacyChatId}`), true,
    "legacy www Chat URLs must remain openable");
  assert.equal(isSupportedConversationUrl(`https://chatgpt.com/c/${legacyChatId}/`), true,
    "official Chat URLs with a trailing slash must remain openable");
  assert.equal(isSupportedConversationUrl(`codex://threads/${legacyChatId}?hostId=remote%3Aqa`), true,
    "remote Work URLs must preserve their single hostId query");
  assert.equal(isSupportedConversationUrl(`https://chat.openai.com.evil.example/c/${legacyChatId}`), false,
    "lookalike Chat hosts must remain rejected");
  assert.equal(isSupportedConversationUrl("codex://threads/not-a-uuid"), false,
    "local Work links must carry a UUID");
  assert.equal(isSupportedConversationUrl(`codex://threads/${legacyChatId}?hostId=`), false,
    "empty remote host IDs must remain rejected");
  assert.equal(isSupportedConversationUrl(`codex://threads/${legacyChatId}?hostId=a&hostId=b`), false,
    "ambiguous duplicate host IDs must remain rejected");
  assert.equal(isSupportedConversationUrl(`codex://user:secret@threads/${legacyChatId}`), false,
    "conversation links with embedded credentials must remain rejected");

  const officialRuntime = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  assert.equal(hasDefaultOfficialRuntime(`101 ${officialRuntime}\n102 ${officialRuntime} --user-data-dir=/tmp/Aboard`), true,
    "the normal default-profile client must be distinguished from Aboard's isolated runtime");
  assert.equal(hasDefaultOfficialRuntime(`102 ${officialRuntime} --user-data-dir=/tmp/Aboard`, 102), false,
    "Aboard alone must never be mistaken for the normal official client");
  const launchArgs = [];
  const spawnProcess = (_command, args) => {
    launchArgs.push(args);
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const safeUrl = `codex://threads/${legacyChatId}`;
  await openInOfficialApp(safeUrl, { defaultOfficialRuntimeIsRunning: async () => true, spawnProcess });
  await openInOfficialApp(safeUrl, { defaultOfficialRuntimeIsRunning: async () => false, spawnProcess });
  assert.deepEqual(launchArgs[0], ["-b", "com.openai.codex", safeUrl],
    "a running default client must receive the URL without a new instance");
  assert.deepEqual(launchArgs[1], ["-n", "-b", "com.openai.codex", safeUrl],
    "a cold handoff must force a new default-profile official client");

  const activeServer = { marker: "winner" };
  const winner = await acquireHandoffBridge("token", 53, "binding-winner", {
    startBridge: async (_token, _version, bindingName) => {
      assert.equal(bindingName, "binding-winner", "bridge identity must be carried into the health owner");
      return activeServer;
    },
    bridgeOwnsActiveRenderer: async () => false,
    runtimeIsAlive: () => true,
    pause: async () => {},
    attempts: 1,
    writeLog: async () => {}
  });
  assert.equal(winner, activeServer, "the launcher that binds the bridge must keep ownership");

  let sharedBridgeClaimed = false;
  let sharedRendererInjected = false;
  let sharedBridgeCount = 0;
  const concurrentServer = { marker: "concurrent-winner" };
  const concurrentOptions = {
    startBridge: async () => {
      // Let both contenders enter before electing exactly one listener.
      await Promise.resolve();
      if (sharedBridgeClaimed) return null;
      sharedBridgeClaimed = true;
      sharedBridgeCount += 1;
      return concurrentServer;
    },
    bridgeOwnsActiveRenderer: async () => sharedRendererInjected,
    runtimeIsAlive: () => true,
    pause: async () => { sharedRendererInjected = true; },
    attempts: 4,
    retryDelayMs: 0,
    writeLog: async () => {}
  };
  const concurrentResults = await Promise.all([
    acquireHandoffBridge("token-a", 53, "binding-a", concurrentOptions),
    acquireHandoffBridge("token-b", 53, "binding-b", concurrentOptions)
  ]);
  assert.equal(sharedBridgeCount, 1, "concurrent opens must elect exactly one bridge listener");
  assert.equal(
    concurrentResults.filter(result => result === concurrentServer).length,
    1,
    "only one concurrent launcher may own the bridge"
  );
  assert.equal(
    concurrentResults.filter(result => result === null).length,
    1,
    "the concurrent loser must exit after the winning renderer is injected"
  );

  let ownershipProbes = 0;
  let pauseCount = 0;
  const contender = await acquireHandoffBridge("token", 53, "binding-contender", {
    startBridge: async () => null,
    bridgeOwnsActiveRenderer: async () => ++ownershipProbes >= 2,
    // This is the important regression: the primary Electron singleton is
    // still alive while another launcher finishes injecting it.
    runtimeIsAlive: () => true,
    pause: async () => { pauseCount += 1; },
    attempts: 4,
    retryDelayMs: 0,
    writeLog: async () => {}
  });
  assert.equal(contender, null, "a healthy injected bridge must win even while the contender's runtime is alive");
  assert.equal(pauseCount, 1, "the contender should exit as soon as renderer ownership is proven");

  const forwardedLaunch = await acquireHandoffBridge("token", 53, "binding-forwarded", {
    startBridge: async () => null,
    bridgeOwnsActiveRenderer: async () => false,
    runtimeIsAlive: () => false,
    pause: async () => { throw new Error("a forwarded secondary launch must not retry"); },
    attempts: 4,
    writeLog: async () => {}
  });
  assert.equal(forwardedLaunch, null, "a launcher whose secondary runtime exited must yield cleanly");

  await assert.rejects(
    acquireHandoffBridge("token", 53, "binding-unresolved", {
      startBridge: async () => null,
      bridgeOwnsActiveRenderer: async () => false,
      runtimeIsAlive: () => true,
      pause: async () => {},
      attempts: 2,
      retryDelayMs: 0,
      writeLog: async () => {}
    }),
    error => error?.code === "ABOARD_BRIDGE_OWNERSHIP_UNRESOLVED",
    "an unresolved foreign listener must be reported without claiming ownership"
  );

  assert.equal(
    mayTerminateOwnedRuntime(false, 4242, 4242),
    false,
    "a launcher that did not acquire the bridge must never terminate a live runtime"
  );
  assert.equal(
    mayTerminateOwnedRuntime(true, 4242, 4242),
    true,
    "the actual bridge owner may stop its directly-owned runtime after a fatal startup failure"
  );
  assert.equal(
    mayTerminateOwnedRuntime(true, 4242, 1),
    false,
    "an orphaned launcher must not terminate an unrelated process with a reused PID"
  );

  console.log("Aboard concurrent launcher ownership verification passed.");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(sandbox, { recursive: true, force: true });
}
