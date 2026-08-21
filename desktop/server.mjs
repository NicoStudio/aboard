#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.CONVERSATION_DASHBOARD_ROOT || path.join(import.meta.dirname, ".."));
const dataDir = path.resolve(process.env.CONVERSATION_DASHBOARD_DATA_DIR || path.join(process.env.HOME, "Library", "Application Support", "Conversation Dashboard"));
const host = "127.0.0.1";
const port = Number(process.env.CONVERSATION_DASHBOARD_PORT || 47843);
const htmlPath = path.join(root, "web", "dashboard.html");
const defaultBoardPath = path.join(root, "desktop", "default-board.json");
const dataPath = path.join(dataDir, "dashboard.json");

async function loadBoard() {
  for (const candidate of [dataPath, defaultBoardPath]) {
    try {
      const board = JSON.parse(await readFile(candidate, "utf8"));
      if (Array.isArray(board?.projects) && Array.isArray(board?.items)) return board;
    } catch {}
  }
  throw new Error("Dashboard data is unavailable");
}

async function saveBoard(input) {
  if (!input || !Array.isArray(input.projects) || !Array.isArray(input.items)) {
    throw new Error("Invalid dashboard data");
  }
  const board = structuredClone(input);
  board.version = 1;
  board.updatedAt = new Date().toISOString();
  await mkdir(dataDir, { recursive: true });
  const temporaryPath = `${dataPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  await rename(temporaryPath, dataPath);
  return board;
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      const board = await loadBoard();
      const boardJson = JSON.stringify(board).replaceAll("<", "\\u003c");
      const html = (await readFile(htmlPath, "utf8")).replace("__BOARD_JSON__", boardJson);
      const body = Buffer.from(html);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors app://-;",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/board") {
      sendJson(response, 200, { board: await loadBoard() });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/board") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error("Dashboard data is too large");
        chunks.push(chunk);
      }
      const board = await saveBoard(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      sendJson(response, 200, { ok: true, board });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Conversation Dashboard is available at http://${host}:${port}/dashboard?embedded=1\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
