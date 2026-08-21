#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const injectSource = await readFile(new URL("./inject.js", import.meta.url), "utf8");
const start = injectSource.indexOf("  function recentThreadsButton() {");
const end = injectSource.indexOf("\n  function topModeButton() {", start);
assert.ok(start >= 0 && end > start, "Recents hydration helpers must remain extractable");
const helpers = injectSource.slice(start, end);
assert.equal(helpers.includes("fetch("), false, "Recents hydration must not make its own network request");
assert.match(helpers, /async function ensureThreadRowsVisible\(\)[\s\S]*await hydrateRecentThreads\(\{ force: true \}\)[\s\S]*if \(allThreadRows\(\)\.length\)/,
  "Recents must be expanded and hydrated before an unrelated Work row can satisfy readiness");

let cacheSize = 20;
let recentRows = Array.from({ length: 3 }, () => ({}));
let desiredRows = 19;
let hydrationScheduled = false;
let clickCount = 0;
const scrollAssignments = [];
const attributes = new Map([["aria-expanded", "false"]]);
const recentsButton = {
  isConnected: true,
  textContent: "Recents",
  getAttribute(name) { return attributes.get(name) ?? null; },
  click() {
    clickCount += 1;
    attributes.set("aria-expanded", "true");
  }
};

const listeners = new Map();
const scroller = {
  clientHeight: 200,
  scrollHeight: 500,
  style: { scrollBehavior: "smooth", overflowAnchor: "auto" },
  _scrollTop: 35,
  contains(element) { return element === recentsButton; },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (listeners.get(type) === listener) listeners.delete(type);
  },
  get scrollTop() { return this._scrollTop; },
  set scrollTop(value) {
    this._scrollTop = value;
    scrollAssignments.push(value);
    const bottom = Math.max(0, this.scrollHeight - this.clientHeight);
    if (value >= bottom && recentRows.length < desiredRows && !hydrationScheduled) {
      hydrationScheduled = true;
      setTimeout(() => {
        recentRows = Array.from({ length: desiredRows }, () => ({}));
        this.scrollHeight += 400;
        hydrationScheduled = false;
      }, 30);
    }
  }
};
const aside = {
  clientHeight: 900,
  scrollHeight: 900,
  contains(element) { return element === recentsButton; },
  querySelectorAll() { return [scroller]; }
};

const context = vm.createContext({
  CHAT_THREAD_SELECTOR: "[data-recents-row]",
  recentHydrationPromise: null,
  recentHydrationButton: null,
  recentHydrationCacheSize: -1,
  recentHydrationAttempts: 0,
  listenerController: { signal: { aborted: false } },
  document: {
    querySelector(selector) { return selector === "aside" ? aside : null; },
    querySelectorAll(selector) {
      if (selector === "aside button") return [recentsButton];
      if (selector === "[data-recents-row]") return recentRows;
      return [];
    }
  },
  visibleText(element) { return String(element?.textContent || "").replace(/\s+/g, " ").trim(); },
  conversationCache() {
    return new Map(Array.from({ length: cacheSize }, (_, index) => [String(index), {}]));
  },
  allThreadRows() { return [{ kind: "work" }, ...recentRows]; },
  requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
  setTimeout,
  clearTimeout,
  Promise
});
vm.runInContext(`${helpers}\nthis.hydrateRecentThreads = hydrateRecentThreads;`, context);

const hydrated = await context.hydrateRecentThreads({ force: true });
assert.equal(clickCount, 1, "a collapsed Recents section must be expanded exactly once");
assert.equal(hydrated.length, 19, "the local virtual list must mount the complete cached Recents set");
assert.equal(scroller.scrollTop, 35, "preloading must restore the user's exact sidebar position");
assert.deepEqual(scroller.style, { scrollBehavior: "smooth", overflowAnchor: "auto" },
  "temporary scroll styles must be restored");
assert.equal(listeners.size, 0, "temporary interaction listeners must be removed");
assert.ok(scrollAssignments.some(value => value >= 300), "preloading must visit the virtual list's lower range");

const assignmentCount = scrollAssignments.length;
await context.hydrateRecentThreads();
assert.equal(scrollAssignments.length, assignmentCount,
  "an unchanged hydrated sidebar must not be scrolled repeatedly by metadata polling");

cacheSize = 21;
desiredRows = 22;
const afterCacheGrowth = await context.hydrateRecentThreads();
assert.equal(afterCacheGrowth.length, 22, "a larger native cache must trigger one new local hydration pass");
assert.equal(scroller.scrollTop, 35, "cache growth hydration must still preserve the sidebar position");

console.log("Aboard Recents hydration verification passed.");
