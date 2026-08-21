#!/usr/bin/env python3
"""Ensure a running Aboard MCP server survives a plugin cache directory swap."""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def request(process, request_id, method, params=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
    process.stdin.flush()
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read() or "Aboard MCP server closed unexpectedly")
    response = json.loads(line)
    if "error" in response:
        raise RuntimeError(response["error"].get("message", "Unknown MCP error"))
    return response["result"]


def main():
    temp_root = Path(tempfile.mkdtemp(prefix="aboard-mcp-cache-"))
    plugin_root = temp_root / "plugin-v1"
    moved_root = temp_root / "plugin-retired"
    data_root = temp_root / "data"
    process = None
    try:
        (plugin_root / "server").mkdir(parents=True)
        (plugin_root / "web").mkdir()
        shutil.copy2(REPO_ROOT / "server" / "dashboard_mcp.py", plugin_root / "server" / "dashboard_mcp.py")
        shutil.copy2(REPO_ROOT / "web" / "dashboard.html", plugin_root / "web" / "dashboard.html")
        data_root.mkdir(mode=0o755)
        data_path = data_root / "dashboard.json"
        data_path.write_text(
            json.dumps({"version": 2, "defaultTab": "professional", "projects": [], "items": []}),
            encoding="utf-8",
        )
        data_root.chmod(0o755)
        data_path.chmod(0o644)
        environment = {**os.environ, "PLUGIN_DATA": str(data_root)}
        process = subprocess.Popen(
            ["python3", str(plugin_root / "server" / "dashboard_mcp.py")],
            cwd=plugin_root,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        request(process, 1, "initialize", {"protocolVersion": "2025-06-18"})
        startup_permissions_restricted = (
            (data_root.stat().st_mode & 0o777) == 0o700
            and (data_path.stat().st_mode & 0o777) == 0o600
        )
        request(
            process,
            2,
            "tools/call",
            {
                "name": "save_dashboard",
                "arguments": {
                    "board": {
                        "version": 2,
                        "defaultTab": "professional",
                        "projects": [],
                        "items": [],
                    }
                },
            },
        )
        permissions_restricted = startup_permissions_restricted and (
            (data_root.stat().st_mode & 0o777) == 0o700
            and (data_path.stat().st_mode & 0o777) == 0o600
        )
        first = request(process, 3, "resources/read", {"uri": "ui://conversation-dashboard/main.html"})
        plugin_root.rename(moved_root)
        second = request(process, 4, "resources/read", {"uri": "ui://conversation-dashboard/main.html"})
        first_text = first["contents"][0]["text"]
        second_text = second["contents"][0]["text"]
        result = {
            "ok": "Aboard" in first_text
            and "Aboard" in second_text
            and "__BOARD_JSON__" not in second_text
            and permissions_restricted,
            "survivedCacheMove": "Aboard" in second_text,
            "boardInjected": "__BOARD_JSON__" not in second_text,
            "permissionsRestricted": permissions_restricted,
            "startupPermissionsRestricted": startup_permissions_restricted,
        }
        print(json.dumps(result, ensure_ascii=False))
        if not result["ok"]:
            raise SystemExit(1)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
