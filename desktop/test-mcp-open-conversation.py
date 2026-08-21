#!/usr/bin/env python3
"""Verify the app-only direct-open tool without launching another application."""

import importlib.util
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
INSTALLED = "--installed" in sys.argv[1:]
SERVER = (
    Path("/Applications/Aboard.app/Contents/Resources/dashboard/server/dashboard_mcp.py")
    if INSTALLED
    else ROOT / "server" / "dashboard_mcp.py"
)
if not SERVER.is_file():
    raise SystemExit(f"Missing MCP server: {SERVER}")
spec = importlib.util.spec_from_file_location("aboard_dashboard_mcp", SERVER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

calls = []


def fake_run(argv, **kwargs):
    calls.append((list(argv), dict(kwargs)))


module.subprocess.run = fake_run
for key in ("CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI"):
    os.environ[key] = "must-not-leak"

valid_urls = [
    "codex://threads/11111111-1111-4111-8111-111111111111",
    "codex://threads/11111111-1111-4111-8111-111111111111?hostId=remote%3Aqa",
    "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    "https://www.chat.openai.com/c/22222222-2222-4222-8222-222222222222/",
]
for url in valid_urls:
    module.open_conversation(url)

invalid_urls = [
    "",
    "https://example.com/c/22222222-2222-4222-8222-222222222222",
    "http://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    "https://chatgpt.com.evil.test/c/22222222-2222-4222-8222-222222222222",
    "codex://threads/short",
    "codex://threads/11111111-1111-4111-8111-111111111111#fragment",
    "codex://threads/11111111-1111-4111-8111-111111111111?hostId=",
    "codex://threads/11111111-1111-4111-8111-111111111111?hostId=a&hostId=b",
    "codex://user:secret@threads/11111111-1111-4111-8111-111111111111",
]
rejected = 0
for url in invalid_urls:
    try:
        module.open_conversation(url)
    except ValueError:
        rejected += 1

descriptor = next(tool for tool in module.tool_descriptors() if tool["name"] == "open_conversation")
result = module.result_for_tool("open_conversation", {"url": valid_urls[0]})
all_calls_safe = all(
    argv[:4] == ["/usr/bin/open", "-b", "com.openai.codex", expected]
    and kwargs.get("timeout") == 6
    and all(key not in kwargs.get("env", {}) for key in ("CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI"))
    for (argv, kwargs), expected in zip(calls[: len(valid_urls)], valid_urls)
)

checks = {
    "ok": True,
    "validUrlsOpened": len(calls) == len(valid_urls) + 1,
    "invalidUrlsRejected": rejected == len(invalid_urls),
    "launchServicesContract": all_calls_safe,
    "appOnly": descriptor.get("_meta", {}).get("ui", {}).get("visibility") == ["app"],
    "private": descriptor.get("_meta", {}).get("openai/visibility") == "private",
    "toolResult": result.get("structuredContent") == {"ok": True},
    "noIntermediateDetailUi": "conversation-detail" not in module.HTML_TEMPLATE
    and "conversation-dashboard/request-detail" not in module.HTML_TEMPLATE,
}
checks["ok"] = all(checks.values())
print(json.dumps(checks, ensure_ascii=False))
if not checks["ok"]:
    raise SystemExit(1)
