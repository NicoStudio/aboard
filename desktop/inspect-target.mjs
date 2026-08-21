#!/usr/bin/env node

const pages = await fetch("http://127.0.0.1:9237/json/list").then(response => response.json());
const page = pages.find(target => target.type === "page" && target.url === "app://-/index.html");
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
  if (callback) { pending.delete(message.id); callback(message); }
});
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const expressions = [
  "document.readyState",
  "document.body && document.body.childElementCount",
  "document.documentElement.outerHTML.slice(0,500)",
  "window.__conversationDashboardVersion",
  "document.body.innerText.slice(0,500)",
  "[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,30)",
  "document.getElementById('conversation-dashboard-sidebar-entry')?.outerHTML",
  "document.getElementById('conversation-dashboard-surface')?.outerHTML.slice(0,500)",
  "document.body.innerHTML.slice(0,1000)",
  "document.querySelector('aside')?.outerHTML.slice(0,12000)",
  "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Demo Chat Thread')?.parentElement?.parentElement?.outerHTML",
  "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Demo Chat Thread')?.closest('[class*=sidebar-item]')?.outerHTML",
  "(() => { let e=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Demo Chat Thread'); let a=[]; for(let i=0;e&&i<8;i++,e=e.parentElement)a.push(e.outerHTML.slice(0,1200)); return a; })()",
  "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Demo Work Thread')?.parentElement?.parentElement?.outerHTML",
  "(() => { let e=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Demo Work Thread'); let a=[]; for(let i=0;e&&i<7;i++,e=e.parentElement)a.push(e.outerHTML.slice(0,1800)); return a; })()",
  "(() => { let e=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent.trim()==='Demo Work Thread'); let a=[]; for(let i=0;e&&i<14;i++,e=e.parentElement)a.push(e.outerHTML.slice(0,1800)); return a; })()",
  "location.href"
];
for (const expression of expressions) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  console.log(expression, JSON.stringify(result));
}
socket.close();
