#!/usr/bin/env node

import path from "node:path";
import { loadRuntimeSnapshots, parseRolloutRuntimeTail, threadAvailability } from "./launcher.mjs";

const activeId = "11111111-1111-4111-8111-111111111111";
const idleId = "22222222-2222-4222-8222-222222222222";
const now = Date.now();
const event = (type, payload = {}) => JSON.stringify({
  timestamp: new Date(now).toISOString(),
  type: "event_msg",
  payload: { type, ...payload }
});
const tokenCount = event("token_count", {
  info: {
    last_token_usage: { total_tokens: 50_000 },
    model_context_window: 100_000
  }
});

const direct = {
  active: parseRolloutRuntimeTail([
    event("task_started"),
    tokenCount
  ].join("\n"), { writerActive: true, modifiedAtMs: now, nowMs: now }),
  completed: parseRolloutRuntimeTail([
    event("task_started"),
    tokenCount,
    event("task_complete")
  ].join("\n"), { writerActive: true, modifiedAtMs: now, nowMs: now }),
  recentStreamingTail: parseRolloutRuntimeTail(tokenCount, {
    writerActive: true,
    modifiedAtMs: now - 5_000,
    nowMs: now
  }),
  staleWriter: parseRolloutRuntimeTail(tokenCount, {
    writerActive: true,
    modifiedAtMs: now - 300_000,
    nowMs: now
  })
};

const lockDir = "/tmp/aboard-runtime-progress-locks";
const rolloutPath = "/tmp/aboard-runtime-progress-active.jsonl";
const fixtureTail = `${event("task_started")}\n${tokenCount}\n`;
let missingLockFiltered = false;
const snapshots = await loadRuntimeSnapshots([activeId, idleId], {
  disableCache: true,
  writerLocksDir: lockDir,
  statFile: async candidate => {
    if (candidate === path.join(lockDir, `${activeId}.lock`)) return {};
    throw Object.assign(new Error("missing synthetic lock"), { code: "ENOENT" });
  },
  execFileAsync: async (command, args) => {
    if (command === "/usr/sbin/lsof") {
      missingLockFiltered = args.includes(path.join(lockDir, `${activeId}.lock`))
        && !args.includes(path.join(lockDir, `${idleId}.lock`));
      return { stdout: `p123\nf9\nn${path.join(lockDir, `${activeId}.lock`)}\n`, stderr: "" };
    }
    if (command === "/usr/bin/sqlite3") {
      return { stdout: JSON.stringify([{ id: activeId, rollout_path: rolloutPath }]), stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  },
  openFile: async candidate => {
    if (candidate !== rolloutPath) throw new Error("Unexpected rollout path");
    return {
      stat: async () => ({ size: Buffer.byteLength(fixtureTail), mtimeMs: now }),
      read: async buffer => {
        buffer.write(fixtureTail);
        return { bytesRead: Buffer.byteLength(fixtureTail), buffer };
      },
      close: async () => {}
    };
  }
});
const claimedAvailability = await threadAvailability(activeId, {
  writerLocksDir: lockDir,
  ownedRuntimePid: 100,
  processParents: new Map([[123, 100], [100, 1]]),
  statFile: async () => ({}),
  execFileAsync: async command => {
    if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
    return { stdout: `p123\nf9\nn${path.join(lockDir, `${activeId}.lock`)}\n`, stderr: "" };
  }
});
const externallyClaimedAvailability = await threadAvailability(activeId, {
  writerLocksDir: lockDir,
  ownedRuntimePid: 100,
  processParents: new Map([[123, 999], [999, 1], [100, 1]]),
  statFile: async () => ({}),
  execFileAsync: async command => {
    if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
    return { stdout: `p123\nf9\nn${path.join(lockDir, `${activeId}.lock`)}\n`, stderr: "" };
  }
});
const idleAvailability = await threadAvailability(idleId, {
  writerLocksDir: lockDir,
  statFile: async () => {
    throw Object.assign(new Error("missing synthetic lock"), { code: "ENOENT" });
  },
  execFileAsync: async command => {
    throw new Error(`lsof must not run for a missing lock: ${command}`);
  }
});

const noMatchError = Object.assign(new Error("lsof found no matching files"), {
  code: 1,
  stdout: "",
  stderr: ""
});
const idleFromNormalNoMatch = await threadAvailability(idleId, {
  writerLocksDir: lockDir,
  statFile: async () => ({}),
  execFileAsync: async command => {
    if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
    throw noMatchError;
  }
});

const vanishedProbeError = (missingPaths, stdout = "") => Object.assign(
  new Error("lsof raced with a removed lock"),
  {
    code: 1,
    stdout,
    stderr: missingPaths.map(candidate =>
      `lsof: status error on ${candidate}: No such file or directory`
    ).join("\n")
  }
);

const singleMissingPath = path.join(lockDir, `${idleId}.lock`);
let singleMissingStatCalls = 0;
let singleMissingLsofCalls = 0;
let singleMissingWaitCalls = 0;
const idleAfterStatRace = await threadAvailability(idleId, {
  writerLocksDir: lockDir,
  statFile: async candidate => {
    singleMissingStatCalls += 1;
    if (candidate !== singleMissingPath) throw new Error(`Unexpected lock path: ${candidate}`);
    if (singleMissingStatCalls === 1) return {};
    throw Object.assign(new Error("lock vanished after stat"), { code: "ENOENT" });
  },
  waitForWriterLockRetry: async () => { singleMissingWaitCalls += 1; },
  execFileAsync: async command => {
    if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
    singleMissingLsofCalls += 1;
    throw vanishedProbeError([singleMissingPath]);
  }
});

const activeLockPath = path.join(lockDir, `${activeId}.lock`);
const idleLockPath = path.join(lockDir, `${idleId}.lock`);
const mixedStatCalls = new Map();
const mixedLsofArgs = [];
let mixedWaitCalls = 0;
const mixedSnapshots = await loadRuntimeSnapshots([activeId, idleId], {
  disableCache: true,
  writerLocksDir: lockDir,
  statFile: async candidate => {
    const calls = (mixedStatCalls.get(candidate) || 0) + 1;
    mixedStatCalls.set(candidate, calls);
    if (candidate === activeLockPath) return {};
    if (candidate === idleLockPath && calls === 1) return {};
    if (candidate === idleLockPath) {
      throw Object.assign(new Error("idle lock vanished"), { code: "ENOENT" });
    }
    throw new Error(`Unexpected lock path: ${candidate}`);
  },
  waitForWriterLockRetry: async () => { mixedWaitCalls += 1; },
  execFileAsync: async (command, args) => {
    if (command === "/usr/sbin/lsof") {
      mixedLsofArgs.push(args.slice());
      if (mixedLsofArgs.length === 1) {
        throw vanishedProbeError(
          [idleLockPath],
          `p123\nf9\nn${activeLockPath}\n`
        );
      }
      return { stdout: `p123\nf9\nn${activeLockPath}\n`, stderr: "" };
    }
    if (command === "/usr/bin/sqlite3") {
      return { stdout: JSON.stringify([{ id: activeId, rollout_path: rolloutPath }]), stderr: "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  },
  openFile: async candidate => {
    if (candidate !== rolloutPath) throw new Error("Unexpected rollout path");
    return {
      stat: async () => ({ size: Buffer.byteLength(fixtureTail), mtimeMs: now }),
      read: async buffer => {
        buffer.write(fixtureTail);
        return { bytesRead: Buffer.byteLength(fixtureTail), buffer };
      },
      close: async () => {}
    };
  }
});
const mixedRetryPathsExact = mixedLsofArgs.length === 2
  && mixedLsofArgs[0].includes(activeLockPath)
  && mixedLsofArgs[0].includes(idleLockPath)
  && mixedLsofArgs[1].includes(activeLockPath)
  && !mixedLsofArgs[1].includes(idleLockPath);

let transientLsofCalls = 0;
let transientWaitCalls = 0;
const claimedAfterTransientRace = await threadAvailability(activeId, {
  writerLocksDir: lockDir,
  ownedRuntimePid: 100,
  processParents: new Map([[123, 100], [100, 1]]),
  statFile: async () => ({}),
  waitForWriterLockRetry: async () => { transientWaitCalls += 1; },
  execFileAsync: async command => {
    if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
    transientLsofCalls += 1;
    if (transientLsofCalls === 1) throw vanishedProbeError([activeLockPath]);
    return { stdout: `p123\nf9\nn${activeLockPath}\n`, stderr: "" };
  }
});

const retryUnknownFailure = async retryError => {
  let calls = 0;
  let waits = 0;
  let rejected = false;
  try {
    await threadAvailability(activeId, {
      writerLocksDir: lockDir,
      statFile: async () => ({}),
      waitForWriterLockRetry: async () => { waits += 1; },
      execFileAsync: async command => {
        if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
        calls += 1;
        if (calls === 1) throw vanishedProbeError([activeLockPath]);
        throw retryError;
      }
    });
  } catch {
    rejected = true;
  }
  return { calls, waits, rejected };
};
const retryPermissionFailure = await retryUnknownFailure(Object.assign(
  new Error("lsof permission failure after retry"),
  { code: 1, stdout: "", stderr: "permission denied" }
));
const retryTimeoutFailure = await retryUnknownFailure(Object.assign(
  new Error("lsof timeout after retry"),
  { code: "ETIMEDOUT", killed: true, signal: "SIGTERM", stdout: "", stderr: "" }
));

let timeoutRejected = false;
let timeoutCalls = 0;
try {
  await threadAvailability(activeId, {
    writerLocksDir: lockDir,
    statFile: async () => ({}),
    execFileAsync: async command => {
      if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
      timeoutCalls += 1;
      throw Object.assign(new Error("lsof timed out"), {
        code: "ETIMEDOUT",
        killed: true,
        signal: "SIGTERM",
        stdout: "",
        stderr: ""
      });
    }
  });
} catch {
  timeoutRejected = true;
}

let permissionRejected = false;
let permissionCalls = 0;
try {
  await threadAvailability(activeId, {
    writerLocksDir: lockDir,
    statFile: async () => ({}),
    execFileAsync: async command => {
      if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
      permissionCalls += 1;
      throw Object.assign(new Error("lsof permission failure"), {
        code: 1,
        stdout: "",
        stderr: "permission denied"
      });
    }
  });
} catch {
  permissionRejected = true;
}

let invalidRejected = false;
try {
  await threadAvailability("not-a-thread", { disableCache: true });
} catch {
  invalidRejected = true;
}

const result = {
  direct,
  snapshots,
  availability: {
    claimed: claimedAvailability,
    external: externallyClaimedAvailability,
    idle: idleAvailability,
    noMatch: idleFromNormalNoMatch
  },
  lockProbeRaces: {
    singleMissing: idleAfterStatRace,
    mixedSnapshots,
    claimedAfterTransientRace,
    singleMissingStatCalls,
    singleMissingLsofCalls,
    singleMissingWaitCalls,
    mixedRetryPathsExact,
    mixedWaitCalls,
    transientLsofCalls,
    transientWaitCalls
  },
  lockProbeFailures: {
    timeoutRejected,
    permissionRejected,
    timeoutCalls,
    permissionCalls,
    retryPermissionFailure,
    retryTimeoutFailure,
    missingLockFiltered
  },
  invalidRejected,
  ok: direct.active.runtimeStatus === "active"
    && direct.active.progress === 50
    && direct.completed.runtimeStatus === "idle"
    && direct.completed.progress === null
    && direct.recentStreamingTail.runtimeStatus === "active"
    && direct.recentStreamingTail.progress === 50
    && direct.staleWriter.runtimeStatus === "idle"
    && direct.staleWriter.progress === null
    && snapshots.length === 2
    && snapshots.find(entry => entry.id === activeId)?.runtimeStatus === "active"
    && snapshots.find(entry => entry.id === activeId)?.progress === 50
    && snapshots.find(entry => entry.id === idleId)?.runtimeStatus === "idle"
    && snapshots.find(entry => entry.id === idleId)?.progress === null
    && claimedAvailability.id === activeId
    && claimedAvailability.claimed === true
    && claimedAvailability.ownership === "self"
    && externallyClaimedAvailability.claimed === true
    && externallyClaimedAvailability.ownership === "other"
    && idleAvailability.id === idleId
    && idleAvailability.claimed === false
    && idleAvailability.ownership === "none"
    && idleFromNormalNoMatch.claimed === false
    && idleFromNormalNoMatch.ownership === "none"
    && idleAfterStatRace.claimed === false
    && idleAfterStatRace.ownership === "none"
    && singleMissingStatCalls === 2
    && singleMissingLsofCalls === 1
    && singleMissingWaitCalls === 0
    && mixedSnapshots.find(entry => entry.id === activeId)?.runtimeStatus === "active"
    && mixedSnapshots.find(entry => entry.id === activeId)?.progress === 50
    && mixedSnapshots.find(entry => entry.id === idleId)?.runtimeStatus === "idle"
    && mixedRetryPathsExact
    && mixedWaitCalls === 1
    && claimedAfterTransientRace.claimed === true
    && claimedAfterTransientRace.ownership === "self"
    && transientLsofCalls === 2
    && transientWaitCalls === 1
    && timeoutRejected
    && permissionRejected
    && timeoutCalls === 1
    && permissionCalls === 1
    && retryPermissionFailure.rejected
    && retryPermissionFailure.calls === 2
    && retryPermissionFailure.waits === 1
    && retryTimeoutFailure.rejected
    && retryTimeoutFailure.calls === 2
    && retryTimeoutFailure.waits === 1
    && missingLockFiltered
    && invalidRejected
};

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
