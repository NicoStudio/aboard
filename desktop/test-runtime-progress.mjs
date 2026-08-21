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

let timeoutRejected = false;
try {
  await threadAvailability(activeId, {
    writerLocksDir: lockDir,
    statFile: async () => ({}),
    execFileAsync: async command => {
      if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
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
try {
  await threadAvailability(activeId, {
    writerLocksDir: lockDir,
    statFile: async () => ({}),
    execFileAsync: async command => {
      if (command !== "/usr/sbin/lsof") throw new Error(`Unexpected command: ${command}`);
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
  lockProbeFailures: { timeoutRejected, permissionRejected, missingLockFiltered },
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
    && timeoutRejected
    && permissionRejected
    && missingLockFiltered
    && invalidRejected
};

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
