#!/usr/bin/env python3
"""Dependency-free MCP server for the Aboard plugin."""

import copy
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlparse


PLUGIN_ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = PLUGIN_ROOT / "web" / "dashboard.html"
HTML_TEMPLATE = HTML_PATH.read_text(encoding="utf-8")
UI_URI = "ui://conversation-dashboard/main.html"
FALLBACK_DATA_DIR = Path.home() / ".codex" / "plugin-data" / "conversation-dashboard"
DATA_DIR = Path(os.environ.get("PLUGIN_DATA", str(FALLBACK_DATA_DIR))).expanduser()
DATA_PATH = DATA_DIR / "dashboard.json"


DEFAULT_BOARD = {"version": 2, "defaultTab": "professional", "projects": [], "items": []}
OFFICIAL_CODEX_BUNDLE_ID = "com.openai.codex"


def secure_existing_data_paths():
    if DATA_DIR.is_symlink():
        raise RuntimeError("Aboard data directory must not be a symbolic link")
    if DATA_DIR.exists():
        if not DATA_DIR.is_dir():
            raise RuntimeError("Aboard data path must be a directory")
        os.chmod(DATA_DIR, 0o700)
    if DATA_PATH.is_symlink():
        raise RuntimeError("Aboard board file must not be a symbolic link")
    if DATA_PATH.exists():
        if not DATA_PATH.is_file():
            raise RuntimeError("Aboard board path must be a regular file")
        os.chmod(DATA_PATH, 0o600)


secure_existing_data_paths()


def conversation_url(value):
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    try:
        path = unquote(parsed.path)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except (UnicodeError, ValueError):
        raise ValueError("Invalid conversation link")
    if parsed.username or parsed.password or port or parsed.fragment:
        raise ValueError("Invalid conversation link")
    if parsed.scheme.lower() == "codex":
        query = parse_qsl(parsed.query, keep_blank_values=True)
        valid_query = len(query) <= 1 and all(key == "hostId" and item.strip() for key, item in query)
        valid = (
            host == "threads"
            and re.fullmatch(r"/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/?", path, re.IGNORECASE)
            and valid_query
        )
    else:
        valid = (
            parsed.scheme.lower() == "https"
            and host in {"chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"}
            and re.fullmatch(r"/c/[A-Za-z0-9_-]{12,}/?", path)
        )
    if not valid:
        raise ValueError("Unsupported conversation link")
    return raw


def open_conversation(value):
    url = conversation_url(value)
    environment = dict(os.environ)
    for key in (
        "ABOARD_RUNTIME_PID",
        "CODEX_CI",
        "CODEX_ELECTRON_AGENT_RUN_ID",
        "CODEX_ELECTRON_USER_DATA_PATH",
        "CODEX_SESSION_ID",
        "CODEX_THREAD_ID",
    ):
        environment.pop(key, None)
    subprocess.run(
        ["/usr/bin/open", "-b", OFFICIAL_CODEX_BUNDLE_ID, url],
        check=True,
        timeout=6,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def now_iso():
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def load_board():
    try:
        with DATA_PATH.open("r", encoding="utf-8") as handle:
            board = json.load(handle)
        if not isinstance(board, dict) or not isinstance(board.get("items"), list):
            raise ValueError("Invalid board payload")
        board["items"] = [
            {**item, "kind": "work"} if item.get("kind") == "codex" else item
            for item in board["items"]
        ]
        return board
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return copy.deepcopy(DEFAULT_BOARD)


def save_board(board):
    if not isinstance(board, dict):
        raise ValueError("board must be an object")
    if not isinstance(board.get("projects"), list) or not isinstance(board.get("items"), list):
        raise ValueError("board requires projects and items arrays")
    board = copy.deepcopy(board)
    board["items"] = [
        {**item, "kind": "work"} if item.get("kind") == "codex" else item
        for item in board["items"]
    ]
    board["version"] = 2
    board["updatedAt"] = now_iso()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA_DIR, 0o700)
    temp_path = DATA_PATH.with_suffix(".tmp")
    descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(board, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(str(temp_path), str(DATA_PATH))
    os.chmod(DATA_PATH, 0o600)
    return board


def ui_html():
    board_json = json.dumps(load_board(), ensure_ascii=False).replace("<", "\\u003c")
    return HTML_TEMPLATE.replace("__BOARD_JSON__", board_json)


def tool_descriptors():
    board_schema = {"type": "object", "additionalProperties": True}
    return [
        {
            "name": "open_dashboard",
            "title": "Aboard",
            "description": "Open the user's full-screen visual AI conversation board.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "outputSchema": {
                "type": "object",
                "properties": {"board": board_schema},
                "required": ["board"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "openWorldHint": False,
            },
            "_meta": {
                "ui": {"resourceUri": UI_URI, "visibility": ["model", "app"]},
                "openai/ui": {"entrypoints": [{"type": "global"}]},
                "openai/outputTemplate": UI_URI,
                "openai/widgetAccessible": True,
                "openai/toolInvocation/invoking": "Opening Aboard…",
                "openai/toolInvocation/invoked": "Aboard ready",
            },
        },
        {
            "name": "get_dashboard",
            "title": "Refresh Aboard",
            "description": "Return the latest locally saved dashboard data.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "outputSchema": {
                "type": "object",
                "properties": {"board": board_schema},
                "required": ["board"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "openWorldHint": False,
            },
            "_meta": {
                "ui": {"visibility": ["app"]},
                "openai/widgetAccessible": True,
                "openai/visibility": "private",
            },
        },
        {
            "name": "save_dashboard",
            "title": "Save Aboard",
            "description": "Save the user's local dashboard organization and links.",
            "inputSchema": {
                "type": "object",
                "properties": {"board": board_schema},
                "required": ["board"],
                "additionalProperties": False,
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "ok": {"type": "boolean"},
                    "updatedAt": {"type": "string"},
                },
                "required": ["ok", "updatedAt"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "openWorldHint": False,
                "idempotentHint": True,
            },
            "_meta": {
                "ui": {"visibility": ["app"]},
                "openai/widgetAccessible": True,
                "openai/visibility": "private",
            },
        },
        {
            "name": "open_conversation",
            "title": "Open Aboard conversation",
            "description": "Open a validated ChatGPT or Codex conversation in the official desktop client.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "minLength": 1},
                    "id": {"type": "string"},
                    "kind": {"type": "string", "enum": ["chat", "work"]},
                    "title": {"type": "string"},
                    "hostId": {"type": "string"},
                },
                "required": ["url"],
                "additionalProperties": False,
            },
            "outputSchema": {
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": False,
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "openWorldHint": False,
                "idempotentHint": True,
            },
            "_meta": {
                "ui": {"visibility": ["app"]},
                "openai/widgetAccessible": True,
                "openai/visibility": "private",
            },
        },
    ]


def result_for_tool(name, arguments):
    if name == "open_dashboard":
        return {
            "content": [{"type": "text", "text": "Aboard 已打开。"}],
            "structuredContent": {"board": load_board()},
        }
    if name == "get_dashboard":
        return {
            "content": [{"type": "text", "text": "Aboard 已刷新。"}],
            "structuredContent": {"board": load_board()},
        }
    if name == "save_dashboard":
        saved = save_board((arguments or {}).get("board"))
        return {
            "content": [{"type": "text", "text": "Aboard 已保存。"}],
            "structuredContent": {"ok": True, "updatedAt": saved["updatedAt"]},
        }
    if name == "open_conversation":
        open_conversation((arguments or {}).get("url"))
        return {
            "content": [{"type": "text", "text": "正在打开原对话。"}],
            "structuredContent": {"ok": True},
        }
    raise ValueError("Unknown tool: " + str(name))


def handle(request):
    method = request.get("method")
    params = request.get("params") or {}
    if method == "initialize":
        requested = params.get("protocolVersion") or "2025-06-18"
        return {
            "protocolVersion": requested,
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {"subscribe": False, "listChanged": False},
            },
            "serverInfo": {"name": "conversation-dashboard", "version": "1.0.1"},
            "instructions": "Use open_dashboard whenever the user asks to view Aboard.",
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_descriptors()}
    if method == "tools/call":
        return result_for_tool(params.get("name"), params.get("arguments") or {})
    if method == "resources/list":
        return {
            "resources": [
                {
                    "uri": UI_URI,
                    "name": "Aboard",
                    "description": "Full-screen AI conversation board.",
                    "mimeType": "text/html;profile=mcp-app",
                }
            ]
        }
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != UI_URI:
            raise ValueError("Unknown resource")
        return {
            "contents": [
                {
                    "uri": UI_URI,
                    "mimeType": "text/html;profile=mcp-app",
                    "text": ui_html(),
                    "_meta": {
                        "ui": {"prefersBorder": False},
                        "openai/widgetDescription": "A full-screen AI conversation board for chats and project work.",
                        "openai/widgetPrefersBorder": False,
                    },
                }
            ]
        }
    raise ValueError("Method not found: " + str(method))


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        request = None
        try:
            request = json.loads(raw_line)
            if "id" not in request:
                continue
            result = handle(request)
            send({"jsonrpc": "2.0", "id": request["id"], "result": result})
        except Exception as exc:
            request_id = request.get("id") if isinstance(request, dict) else None
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": str(exc)},
                }
            )


if __name__ == "__main__":
    main()
