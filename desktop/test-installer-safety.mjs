#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [installer, friendlyInstaller, verifier, boardStorage, installedProbe, installedTestSupervisor] = await Promise.all([
  readFile(path.join(repoRoot, "scripts", "install-on-mac.sh"), "utf8"),
  readFile(path.join(repoRoot, "Install Aboard.command"), "utf8"),
  readFile(path.join(repoRoot, "scripts", "verify.sh"), "utf8"),
  readFile(path.join(repoRoot, "desktop", "board-storage.mjs"), "utf8"),
  readFile(path.join(repoRoot, "desktop", "verify-installed.mjs"), "utf8"),
  readFile(path.join(repoRoot, "scripts", "installed-test-supervisor.py"), "utf8")
]);

assert.match(friendlyInstaller, /Aboard 一键安装 \/ Easy Installer/,
  "the double-click installer must identify itself in plain language");
assert.match(friendlyInstaller, /if \.\/scripts\/install-on-mac\.sh; then[\s\S]*else[\s\S]*install_status=\$\?/,
  "the friendly installer must preserve and report the real installation status");
assert.match(friendlyInstaller, /Aboard 安装完成/,
  "successful installation must end with a clear user-facing message");
assert.match(friendlyInstaller, /Aboard 安装失败/,
  "failed installation must end with a clear user-facing message");
assert.match(friendlyInstaller, /\[\[ -t 0 \]\][\s\S]*read -k 1/,
  "the installer may pause only when showing an interactive failure");
for (const stage of ["1/4", "2/4", "3/4", "4/4"]) {
  assert.ok(installer.includes(stage), `the installer must expose progress stage ${stage}`);
}

const appVerification = installer.indexOf('"$NODE_BIN" "$REPO_ROOT/desktop/verify-installed.mjs"');
const pluginUpdate = installer.indexOf('"$CODEX_BIN" plugin add conversation-dashboard@personal');
const commit = installer.indexOf("install_committed=true", appVerification);
assert.ok(appVerification >= 0 && pluginUpdate > appVerification,
  "the replacement app must pass live verification before the plugin cache is updated");
assert.ok(commit > appVerification && commit < pluginUpdate,
  "a verified app must be committed before the independent plugin refresh so plugin failure cannot roll it back");
assert.match(installer, /ensure_marketplace_plugin_link "\$MARKETPLACE_PLUGIN" "\$REPO_ROOT"/,
  "every upgrade must point the personal marketplace at the current extracted source");
assert.match(installer, /Aboard plugin version mismatch after installation/,
  "the installer must verify the plugin version after plugin add returns");
assert.equal(installer.includes("trap rollback_install EXIT INT TERM"), false,
  "signal traps must not return to the interrupted installer");
assert.match(installer, /handle_install_signal\(\)[\s\S]*rollback_install[\s\S]*exit "\$signal_status"/,
  "INT and TERM must rollback and then exit explicitly");

const backupFunctionStart = installer.indexOf("secure_existing_board_backups() {");
const backupFunctionEnd = installer.indexOf("\n}\n\nensure_marketplace_plugin_link()", backupFunctionStart);
assert.ok(backupFunctionStart >= 0 && backupFunctionEnd > backupFunctionStart,
  "legacy backup permission helper must be extractable for regression testing");
const backupHelper = `${installer.slice(backupFunctionStart, backupFunctionEnd + 2)}\nsecure_existing_board_backups "$1"`;
const backupFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "aboard-private-backups-"));
try {
  const supportRoot = path.join(backupFixtureRoot, "Conversation Dashboard");
  const legacyBackup = path.join(supportRoot, "board-before-install-20260820-120000.json");
  await mkdir(supportRoot);
  await writeFile(legacyBackup, "{}", { mode: 0o644 });
  await chmod(legacyBackup, 0o644);
  const secured = spawnSync("/bin/zsh", ["-c", backupHelper, "aboard-backup-test", supportRoot], { encoding: "utf8" });
  assert.equal(secured.status, 0, secured.stderr || "legacy board backup permission tightening failed");
  assert.equal((await stat(legacyBackup)).mode & 0o777, 0o600,
    "existing board-before-install backups must be readable only by the current user");

  const outsideFile = path.join(backupFixtureRoot, "outside.json");
  const linkedBackup = path.join(supportRoot, "board-before-install-20260820-130000.json");
  await writeFile(outsideFile, "{}", { mode: 0o644 });
  await chmod(outsideFile, 0o644);
  await symlink(outsideFile, linkedBackup);
  const refusedLink = spawnSync("/bin/zsh", ["-c", backupHelper, "aboard-backup-test", supportRoot], { encoding: "utf8" });
  assert.notEqual(refusedLink.status, 0, "a symlink disguised as a private board backup must be rejected");
  assert.equal((await stat(outsideFile)).mode & 0o777, 0o644,
    "rejecting a backup symlink must not chmod its external target");
} finally {
  await rm(backupFixtureRoot, { recursive: true, force: true });
}

assert.equal(verifier.includes('if [[ "${1:-}" == "--installed" ]] && curl'), false,
  "installed verification must not be skipped when the runtime is unavailable");
assert.match(verifier, /run_installed_test "\$REPO_ROOT\/desktop\/verify-installed\.mjs"/,
  "installed verification must start and probe the actual app");
assert.match(verifier, /installed-test-supervisor\.py[^\n]*45000 1000/,
  "every installed UI regression must run under the bounded child-owning supervisor");
assert.match(installedTestSupervisor, /Installed Aboard test timed out:/,
  "the installed-test supervisor must report its bounded timeout");
assert.equal(/board-storage\.mjs" restore "\$BOARD_BACKUP"[^\n]*\|\| true/.test(verifier), false,
  "board restoration errors must never be swallowed");
assert.match(verifier, /Recovery backup preserved at:/,
  "a failed restore must tell the user where the untouched recovery backup remains");
assert.match(verifier, /cmp -s "\$BOARD_BACKUP" "\$verification_backup"/,
  "restored board data must be read back and compared exactly before the backup is removed");
const verificationBackupCreation = verifier.indexOf('BOARD_BACKUP="$(mktemp /tmp/aboard-verify-board.XXXXXX)"');
const incompleteBackupTrap = verifier.indexOf("trap cleanup_incomplete_backup EXIT", verificationBackupCreation);
const verificationBackupWrite = verifier.indexOf('board-storage.mjs" backup "$BOARD_BACKUP"', verificationBackupCreation);
assert.ok(verificationBackupCreation >= 0
  && incompleteBackupTrap > verificationBackupCreation
  && incompleteBackupTrap < verificationBackupWrite,
"a cleanup trap must protect the private verification backup before any write can fail");
assert.match(verifier, /cleanup_incomplete_backup\(\)[\s\S]*discard_sensitive_temp "\$BOARD_BACKUP"/,
  "a failed or interrupted initial backup must be wiped from the temporary directory");
assert.match(verifier, /handle_verify_exit\(\)[\s\S]*stop_active_installed_test[\s\S]*restore_board/,
  "the EXIT recovery path must stop every active installed test before restoring the board");
assert.match(verifier, /handle_verify_signal\(\)[\s\S]*stop_active_installed_test[\s\S]*restore_board/,
  "the signal recovery path must stop every active installed test before restoring the board");
assert.match(verifier, /handle_verify_exit\(\)[\s\S]*trap '' INT TERM[\s\S]*stop_active_installed_test/,
  "EXIT recovery must ignore repeated signals until child cleanup and board restoration finish");
assert.match(verifier, /handle_verify_signal\(\)[\s\S]*trap '' INT TERM[\s\S]*stop_active_installed_test/,
  "signal recovery must ignore repeated signals until child cleanup and board restoration finish");
assert.match(verifier, /active_installed_launch_in_progress=true[\s\S]*active_installed_test_pid=\$![\s\S]*finish_active_installed_launch/,
  "the installed test PID must be published before a deferred launch-time signal can restore the board");
assert.equal(verifier.includes('/bin/ps -p "$pid"'), false,
  "signal cleanup must wait on tracked children directly instead of polling and later killing a reusable bare PID");
assert.equal(verifier.includes('kill -KILL "$watched_test_pid"'), false,
  "the shell watchdog must not issue a delayed KILL against a PID that its parent may already have reaped");
assert.match(installedTestSupervisor, /return_code = child\.poll\(\)[\s\S]*child\.kill\(\)[\s\S]*return_code = child\.wait\(\)/,
  "the sole child-owning supervisor must poll, kill if still unreaped, and wait before returning");

const stopHelperStart = verifier.indexOf("  stop_active_installed_test() {");
const stopHelperEnd = verifier.indexOf("\n  run_installed_test() {", stopHelperStart);
const signalHandlerStart = verifier.indexOf("  handle_verify_signal() {");
const signalHandlerEnd = verifier.indexOf("\n  trap handle_verify_exit EXIT", signalHandlerStart);
assert.ok(stopHelperStart >= 0 && stopHelperEnd > stopHelperStart,
  "installed-test child cleanup helper must remain extractable for signal regression testing");
assert.ok(signalHandlerStart >= 0 && signalHandlerEnd > signalHandlerStart,
  "installed verification signal handler must remain extractable for regression testing");

const signalFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "aboard-verify-signal-"));
try {
  const eventsPath = path.join(signalFixtureRoot, "events.log");
  const childReadyPath = path.join(signalFixtureRoot, "child-ready.log");
  const parentReadyPath = path.join(signalFixtureRoot, "parent-ready");
  const delayedTestPath = path.join(signalFixtureRoot, "delayed-test.mjs");
  const supervisorPath = path.join(repoRoot, "scripts", "installed-test-supervisor.py");
  await writeFile(delayedTestPath, `
import { appendFileSync } from "node:fs";
const events = process.env.ABOARD_SIGNAL_EVENT_PATH;
const ready = process.env.ABOARD_SIGNAL_READY_PATH;
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  appendFileSync(events, "test-term\\n");
  setTimeout(() => {
    appendFileSync(events, "test-delayed\\ntest-exit\\n");
    process.exit(0);
  }, 400);
});
appendFileSync(ready, "ready\\n");
setInterval(() => {}, 1_000);
`);
  const stopHelper = verifier.slice(stopHelperStart, stopHelperEnd);
  const signalHandler = verifier.slice(signalHandlerStart, signalHandlerEnd);
  const harnessSource = `
set -uo pipefail
events_path="$1"
child_ready_path="$2"
parent_ready_path="$3"
node_bin="$4"
supervisor_path="$5"
test_file="$6"
active_installed_test_pid=0
active_installed_launch_in_progress=false
active_installed_deferred_signal=0
active_installed_signal_phase="verify"
${stopHelper}
restore_board() {
  print -r -- "restore" >> "$events_path"
}
${signalHandler}
trap 'dispatch_active_installed_signal 143' TERM
active_installed_launch_in_progress=true
ABOARD_SIGNAL_EVENT_PATH="$events_path" ABOARD_SIGNAL_READY_PATH="$child_ready_path" python3 "$supervisor_path" "$node_bin" "$test_file" 20000 1000 &
for attempt in {1..150}; do
  child_ready="$(<"$child_ready_path" 2>/dev/null || true)"
  [[ "$child_ready" == *ready* ]] && break
  sleep 0.02
done
[[ "$child_ready" == *ready* ]] || exit 97
print -r -- ready > "$parent_ready_path"
while [[ "$active_installed_deferred_signal" == 0 ]]; do sleep 0.02; done
active_installed_test_pid=$!
finish_active_installed_launch
exit 98
`;
  const harness = spawn("/bin/zsh", [
    "-c",
    harnessSource,
    "aboard-verify-signal-test",
    eventsPath,
    childReadyPath,
    parentReadyPath,
    process.execPath,
    supervisorPath,
    delayedTestPath
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let harnessStderr = "";
  harness.stderr.setEncoding("utf8");
  harness.stderr.on("data", chunk => { harnessStderr += chunk; });
  const readyDeadline = Date.now() + 3_000;
  while (Date.now() < readyDeadline) {
    try {
      if ((await readFile(parentReadyPath, "utf8")).trim() === "ready") break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal((await readFile(parentReadyPath, "utf8")).trim(), "ready",
    "synthetic installed-test signal harness did not become ready");
  assert.equal(harness.kill("SIGTERM"), true, "the parent-only TERM signal was not delivered");
  const cleanupDeadline = Date.now() + 2_000;
  let cleanupStarted = false;
  while (Date.now() < cleanupDeadline) {
    try {
      cleanupStarted = (await readFile(eventsPath, "utf8")).includes("test-term");
      if (cleanupStarted) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(cleanupStarted, true, "the first TERM did not start supervised child cleanup");
  assert.equal(harness.kill("SIGTERM"), true,
    "a repeated parent-only TERM must be delivered while cleanup is still in progress");
  const harnessResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      harness.kill("SIGKILL");
      reject(new Error("installed-test signal harness timed out"));
    }, 5_000);
    harness.once("error", error => { clearTimeout(timer); reject(error); });
    harness.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(harnessResult, { code: 143, signal: null },
    `parent-only TERM must exit through the recovery handler: ${harnessStderr}`);
  const events = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/);
  const restoreIndex = events.indexOf("restore");
  assert.ok(restoreIndex >= 0, "the signal recovery handler must restore the board");
  assert.ok(events.indexOf("test-term") >= 0, "the supervised test must receive TERM");
  assert.ok(events.indexOf("test-delayed") > events.indexOf("test-term"),
    "the supervised test must be allowed to finish its delayed TERM cleanup");
  assert.ok(events.indexOf("test-exit") > events.indexOf("test-delayed"),
    "the supervised test must exit after its delayed cleanup");
  assert.ok(events.indexOf("test-exit") < restoreIndex,
    "restore must wait until the supervisor has reaped the installed test");
  assert.equal(restoreIndex, events.length - 1,
    "no child may write after board restoration");

  const timeoutEventsPath = path.join(signalFixtureRoot, "timeout-events.log");
  const ignoringTestPath = path.join(signalFixtureRoot, "ignoring-test.mjs");
  await writeFile(ignoringTestPath, `
import { appendFileSync } from "node:fs";
const events = process.env.ABOARD_TIMEOUT_EVENT_PATH;
process.on("SIGTERM", () => appendFileSync(events, "term\\n"));
setTimeout(() => appendFileSync(events, "late-write\\n"), 1_500);
setInterval(() => {}, 1_000);
`);
  const timedOut = spawnSync("python3", [
    supervisorPath,
    process.execPath,
    ignoringTestPath,
    "500",
    "150"
  ], {
    encoding: "utf8",
    env: { ...process.env, ABOARD_TIMEOUT_EVENT_PATH: timeoutEventsPath },
    timeout: 3_000
  });
  assert.equal(timedOut.status, 124, timedOut.stderr || "the installed-test supervisor did not time out");
  await new Promise(resolve => setTimeout(resolve, 1_550));
  assert.deepEqual((await readFile(timeoutEventsPath, "utf8")).trim().split(/\r?\n/), ["term"],
    "the child-owning timeout supervisor must stop an uncooperative test without any late write");
} finally {
  await rm(signalFixtureRoot, { recursive: true, force: true });
}

for (const [name, source] of [["board storage", boardStorage], ["installed probe", installedProbe]]) {
  assert.match(source, /AbortSignal\.timeout\(/, `${name} fetches must be bounded`);
  assert.match(source, /Timed out connecting to the Aboard renderer/, `${name} WebSocket opens must be bounded`);
  assert.match(source, /Timed out waiting for \$\{method\}/, `${name} CDP calls must be bounded`);
}
for (const sensitiveProbe of ["frameText", "bodyText", "firstThreadPayload", "appActionSidebarThreadTitle"]) {
  assert.equal(installedProbe.includes(sensitiveProbe), false,
    `installed verification must not collect or print native user data: ${sensitiveProbe}`);
}
const installedExpression = installedProbe.match(/expression:\s*`([\s\S]*?)`,\s*\n\s*returnByValue:\s*true/);
assert.ok(installedExpression, "installed verification Runtime.evaluate expression must remain extractable");
assert.doesNotThrow(() => new Function(installedExpression[1]),
  "installed verification Runtime.evaluate expression must be valid JavaScript");
const boardHelperStart = boardStorage.indexOf("function cdpEvaluationFailure(message)");
const boardHelperEnd = boardStorage.indexOf("\ntry {", boardHelperStart);
assert.ok(boardHelperStart >= 0 && boardHelperEnd > boardHelperStart,
  "board backup response helpers must be extractable for regression testing");
const boardHelpers = new Function(
  `const emptyBoard = JSON.stringify({ version: 2, defaultTab: "professional", chatSortBy: { professional: "updated", personal: "updated" }, projects: [], items: [] });\n${boardStorage.slice(boardHelperStart, boardHelperEnd)}\nreturn { cdpEvaluationFailure, serializedBoardBackup };`
)();
const absentBackup = boardHelpers.serializedBoardBackup(null);
assert.ok(absentBackup.length > 0 && JSON.parse(absentBackup).items.length === 0,
  "a truly absent board must produce a valid, non-empty backup");
assert.equal(boardHelpers.serializedBoardBackup(""), "",
  "an existing empty string must not be silently rewritten as an absent board");
for (const invalidBackupValue of [undefined, 42, false, {}, []]) {
  assert.throws(
    () => boardHelpers.serializedBoardBackup(invalidBackupValue),
    /invalid board backup value/,
    "a missing or non-string CDP value must fail closed instead of becoming an empty board"
  );
}
assert.equal(boardHelpers.cdpEvaluationFailure({ result: { result: { value: null } } }), null,
  "a successful Runtime.evaluate returning null is a valid never-saved board");
assert.match(
  boardHelpers.cdpEvaluationFailure({ result: { exceptionDetails: { text: "synthetic evaluation failure" } } }).message,
  /synthetic evaluation failure/,
  "a Runtime.evaluate exception must fail backup or restore instead of masquerading as an empty board"
);
assert.match(boardStorage, /const evaluationFailure = cdpEvaluationFailure\(message\)[\s\S]*else if \(evaluationFailure\) request\.reject/,
  "CDP evaluation exceptions must be rejected before backup or restore can continue");

const functionStart = installer.indexOf("ensure_marketplace_plugin_link() {");
const functionEnd = installer.indexOf("\n}\n\nport_is_open()", functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, "marketplace link helper must be extractable for regression testing");
const helper = `${installer.slice(functionStart, functionEnd + 2)}\nensure_marketplace_plugin_link "$1" "$2"`;
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "aboard-marketplace-link-"));
try {
  const oldSource = path.join(fixtureRoot, "old-source");
  const newSource = path.join(fixtureRoot, "new-source");
  const marketplaceLink = path.join(fixtureRoot, "plugins", "conversation-dashboard");
  await mkdir(oldSource, { recursive: true });
  await mkdir(newSource, { recursive: true });
  await mkdir(path.dirname(marketplaceLink), { recursive: true });
  await symlink(oldSource, marketplaceLink);
  const replaced = spawnSync("/bin/zsh", ["-c", helper, "aboard-link-test", marketplaceLink, newSource], { encoding: "utf8" });
  assert.equal(replaced.status, 0, replaced.stderr || "marketplace symlink repoint failed");
  assert.equal(await realpath(marketplaceLink), await realpath(newSource), "an upgrade from a new extraction must repoint the existing symlink");

  await rm(marketplaceLink);
  await mkdir(marketplaceLink);
  const realDirectoryPath = await realpath(marketplaceLink);
  const refused = spawnSync("/bin/zsh", ["-c", helper, "aboard-link-test", marketplaceLink, oldSource], { encoding: "utf8" });
  assert.notEqual(refused.status, 0, "a real marketplace directory must never be overwritten");
  assert.equal(await realpath(marketplaceLink), realDirectoryPath, "the refused real directory must remain intact");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("Aboard installer safety verification passed.");
