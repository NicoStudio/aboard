#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const cdpPort = Number(process.env.CONVERSATION_DASHBOARD_CDP_PORT || 9237);
const dashboardPath = process.env.ABOARD_DASHBOARD_PATH
  || "/Applications/Aboard.app/Contents/Resources/dashboard/web/dashboard.html";
const dashboardTemplate = await readFile(dashboardPath, "utf8");
const projects = [
  ["project-app", "App", 5],
  ["project-website", "Website", 2],
  ["project-ai", "AI", 1],
  ["project-hiring", "Hiring", 2],
  ["project-enterprise", "Enterprise", 4],
  ["project-skills", "Skills", 1],
  ["project-personal", "Personal", 3]
].map(([id, name, count], index) => ({ id, name, count, accent: "#146A59", order: index + 1, sortBy: "updated" }));
const items = projects.flatMap(project => Array.from({ length: project.count }, (_, index) => ({
  id: `${project.id}-item-${index}`,
  title: `${project.name} item ${index + 1}`,
  kind: "work",
  topic: null,
  projectId: project.id,
  pinned: false,
  marker: "p2",
  progress: 0,
  runtimeStatus: "idle",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: `2026-08-20T00:0${index}:00.000Z`,
  url: `codex://threads/11111111-1111-4111-8111-${String(project.order).padStart(12, "0")}`
})));
const fixture = {
  version: 2,
  defaultTab: "professional",
  chatSortBy: { professional: "updated", personal: "updated" },
  projects: projects.map(({ count: _count, ...project }) => project),
  items
};
const source = dashboardTemplate.replace("__BOARD_JSON__", JSON.stringify(fixture).replaceAll("</script", "<\\/script"));

const pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3_000) }).then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
if (!page) throw new Error("Aboard window not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Aboard compact layout test connection timed out")), 4_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  waiter(message);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Aboard compact layout test ${method} timed out`));
  }, 5_000);
  pending.set(id, message => { clearTimeout(timer); resolve(message); });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
  return response.result?.result?.value;
};

let result;
try {
  result = await evaluate(`(async () => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const storageKey = "conversation-dashboard-board-v1";
    const originalBoard = localStorage.getItem(storageKey);
    const frame = document.createElement("iframe");
    frame.id = "aboard-project-compact-layout-test";
    frame.style.cssText = "position:fixed;left:-2400px;top:0;width:1500px;height:1000px;visibility:hidden;border:0";
    frame.srcdoc = ${JSON.stringify(source)};
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Compact layout fixture load timed out")), 4_000);
      frame.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const doc = frame.contentDocument;
    const laneIds = () => [...doc.querySelectorAll(".project-lane")].map(lane => (
      [...lane.querySelectorAll(":scope > .project-card")].map(card => card.dataset.projectId)
    ));
    const laneGaps = () => [...doc.querySelectorAll(".project-lane")].flatMap(lane => {
      const cards = [...lane.querySelectorAll(":scope > .project-card")];
      return cards.slice(1).map((card, index) => card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom);
    });
    const snapshot = () => ({
      lanes: laneIds(),
      gaps: laneGaps(),
      cardCount: doc.querySelectorAll(".project-card").length,
      listRole: doc.querySelector(".project-grid")?.getAttribute("role") || "",
      listItemRoles: [...doc.querySelectorAll(".project-card")].every(card => card.getAttribute("role") === "listitem"),
      titleTopDelta: (() => {
        const chats = doc.querySelector(".chat-column .section-title")?.getBoundingClientRect();
        const work = doc.querySelector(".work-column .section-title")?.getBoundingClientRect();
        return chats && work ? work.top - chats.top : null;
      })(),
      titleCountGaps: [".chat-column", ".work-column"].map(selector => {
        const title = doc.querySelector(selector + " .section-title")?.getBoundingClientRect();
        const count = doc.querySelector(selector + " .section-title-wrap > .count")?.getBoundingClientRect();
        return title && count ? count.left - title.right : null;
      }),
      websiteEnterpriseGap: (() => {
        const website = doc.querySelector('[data-project-id="project-website"]')?.getBoundingClientRect();
        const enterprise = doc.querySelector('[data-project-id="project-enterprise"]')?.getBoundingClientRect();
        return website && enterprise ? enterprise.top - website.bottom : null;
      })()
    });
    const desktop = snapshot();
    frame.style.width = "1100px";
    await sleep(180);
    const tablet = snapshot();
    frame.style.width = "800px";
    await sleep(180);
    const narrow = snapshot();
    frame.style.width = "1500px";
    await sleep(180);
    const child = frame.contentWindow;
    const hiring = doc.querySelector('[data-project-id="project-hiring"]');
    const skillsLaneEnd = doc.querySelector('[data-project-drop-lane="2"] [data-project-lane-end]');
    const transfer = new child.DataTransfer();
    const dispatchProjectDrag = (target, type, init = {}) => target.dispatchEvent(new child.DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      ...init
    }));
    dispatchProjectDrag(hiring.querySelector(".project-heading"), "dragstart");
    const endRect = skillsLaneEnd.getBoundingClientRect();
    dispatchProjectDrag(skillsLaneEnd, "dragenter", { clientX: endRect.left + endRect.width / 2, clientY: endRect.top + 24 });
    dispatchProjectDrag(skillsLaneEnd, "dragover", { clientX: endRect.left + endRect.width / 2, clientY: endRect.top + 24 });
    const indicator = doc.getElementById("internal-insertion-indicator");
    const feedback = {
      visible: indicator?.classList.contains("show") === true,
      lane: indicator?.dataset.projectLane || "",
      placement: indicator?.dataset.placement || "",
      wholeCardHighlighted: Boolean(doc.querySelector(".is-reorder-target"))
    };
    dispatchProjectDrag(skillsLaneEnd, "drop", { clientX: endRect.left + endRect.width / 2, clientY: endRect.top + 24 });
    await sleep(80);
    const movedProject = child.eval("board.projects.find(project => project.id === 'project-hiring')");
    const specifiedDrop = {
      feedback,
      lanes: laneIds(),
      hiringLane: movedProject?.layoutLane,
      hiringOrder: movedProject?.layoutOrder,
      indicatorCleared: !doc.getElementById("internal-insertion-indicator")?.classList.contains("show")
    };
    frame.remove();
    return {
      desktop,
      tablet,
      narrow,
      specifiedDrop,
      boardExact: localStorage.getItem(storageKey) === originalBoard,
      fixtureRemoved: !document.getElementById("aboard-project-compact-layout-test")
    };
  })()`);
} finally {
  try { await evaluate(`document.getElementById("aboard-project-compact-layout-test")?.remove()`); } catch {}
  socket.close();
}

const nearFourteen = gaps => gaps.length > 0 && gaps.every(gap => Math.abs(gap - 14) < 0.75);
result.ok = JSON.stringify(result?.desktop?.lanes) === JSON.stringify([
    ["project-app", "project-hiring", "project-personal"],
    ["project-website", "project-enterprise"],
    ["project-ai", "project-skills"]
  ])
  && Math.abs(result.desktop.websiteEnterpriseGap - 14) < 0.75
  && Math.abs(result.desktop.titleTopDelta) < 0.75
  && result.desktop.titleCountGaps.every(gap => Math.abs(gap - 9) < 0.75)
  && nearFourteen(result.desktop.gaps)
  && JSON.stringify(result?.tablet?.lanes) === JSON.stringify([
    ["project-app", "project-hiring", "project-personal"],
    ["project-website", "project-ai", "project-enterprise", "project-skills"]
  ])
  && nearFourteen(result.tablet.gaps)
  && JSON.stringify(result?.narrow?.lanes) === JSON.stringify([projects.map(project => project.id)])
  && nearFourteen(result.narrow.gaps)
  && [result.desktop, result.tablet, result.narrow].every(snapshot => (
    snapshot.cardCount === projects.length && snapshot.listRole === "list" && snapshot.listItemRoles
  ))
  && result.specifiedDrop?.feedback?.visible
  && result.specifiedDrop.feedback.lane === "2"
  && result.specifiedDrop.feedback.placement === "empty"
  && !result.specifiedDrop.feedback.wholeCardHighlighted
  && JSON.stringify(result.specifiedDrop.lanes[2]) === JSON.stringify(["project-ai", "project-skills", "project-hiring"])
  && result.specifiedDrop.hiringLane === 2
  && result.specifiedDrop.hiringOrder === 3
  && result.specifiedDrop.indicatorCleared
  && result.boardExact
  && result.fixtureRemoved;

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
