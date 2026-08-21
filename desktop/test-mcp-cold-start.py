#!/usr/bin/env python3
"""Verify Aboard MCP cold-starts after its versioned plugin cache is gone."""

import json
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_NAME = "conversation-dashboard"
UI_URI = "ui://conversation-dashboard/main.html"
INSTALLED_APP = Path("/Applications/Aboard.app")


def request(process, request_id, method, params=None, timeout=5):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
    process.stdin.flush()

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(timeout):
            detail = ""
            if process.poll() is not None:
                detail = process.stderr.read().strip()
            raise RuntimeError(detail or f"Timed out waiting for MCP response to {method}")
        line = process.stdout.readline()
    finally:
        selector.close()

    if not line:
        raise RuntimeError(process.stderr.read().strip() or "Aboard MCP server closed unexpectedly")
    response = json.loads(line)
    if "error" in response:
        raise RuntimeError(response["error"].get("message", "Unknown MCP error"))
    return response["result"]


def validate_stable_config(server_config):
    command = server_config.get("command")
    if not isinstance(command, str) or not os.path.isabs(command):
        raise AssertionError("Aboard MCP command must be absolute and independent of plugin cache cwd")

    cwd = server_config.get("cwd")
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        raise AssertionError("Aboard MCP cwd must be an absolute stable directory")

    serialized = json.dumps(server_config, ensure_ascii=False)
    if "./server/dashboard_mcp.py" in serialized or '"cwd": "."' in serialized:
        raise AssertionError("Aboard MCP still uses a versioned plugin cache relative path")
    if "ABOARD_APP_PATH" not in serialized:
        raise AssertionError("Aboard MCP config must support ABOARD_APP_PATH for portable cold starts")
    if "/Applications/Aboard.app" not in serialized:
        raise AssertionError("Aboard MCP config must default to the stable installed Aboard bundle")
    if "Contents/Resources/dashboard/server/dashboard_mcp.py" not in serialized:
        raise AssertionError("Aboard MCP config must resolve the server bundled in Aboard.app resources")


def start_and_read(server_config, environment):
    process = subprocess.Popen(
        [server_config["command"], *server_config.get("args", [])],
        cwd=server_config["cwd"],
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        initialized = request(process, 1, "initialize", {"protocolVersion": "2025-06-18"})
        resource = request(process, 2, "resources/read", {"uri": UI_URI})
        return initialized, resource
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def verify_installed_bundle():
    bundled_root = INSTALLED_APP / "Contents" / "Resources" / "dashboard"
    bundled_server = bundled_root / "server" / "dashboard_mcp.py"
    bundled_html = bundled_root / "web" / "dashboard.html"
    if not bundled_server.is_file():
        raise AssertionError(f"Installed Aboard MCP server is missing: {bundled_server}")
    if not os.access(bundled_server, os.X_OK):
        raise AssertionError(f"Installed Aboard MCP server is not executable: {bundled_server}")
    if not bundled_html.is_file():
        raise AssertionError(f"Installed Aboard dashboard HTML is missing: {bundled_html}")

    config = json.loads((REPO_ROOT / ".mcp.json").read_text(encoding="utf-8"))
    server_config = config["mcpServers"][SERVER_NAME]
    validate_stable_config(server_config)

    sentinel = "aboard-installed-mcp-isolated-board"
    with tempfile.TemporaryDirectory(prefix="aboard-mcp-installed-data-") as data_root:
        isolated_board = {
            "version": 2,
            "defaultTab": "professional",
            "projects": [],
            "items": [{"id": "installed-test", "title": sentinel, "kind": "chat"}],
        }
        (Path(data_root) / "dashboard.json").write_text(
            json.dumps(isolated_board), encoding="utf-8"
        )
        environment = {**os.environ, "PLUGIN_DATA": data_root}
        # Exercise the production default path from .mcp.json. An inherited
        # development override would make this test pass without using the app.
        environment.pop("ABOARD_APP_PATH", None)
        initialized, resource = start_and_read(server_config, environment)

    html = resource["contents"][0]["text"]
    installed_template = bundled_html.read_text(encoding="utf-8")
    result = {
        "ok": initialized["serverInfo"]["name"] == SERVER_NAME
        and "Aboard" in html
        and "__BOARD_JSON__" not in html,
        "usedDefaultInstalledApp": True,
        "bundledServer": str(bundled_server),
        "bundledHtml": str(bundled_html),
        "installedTemplateHasBoardSlot": "__BOARD_JSON__" in installed_template,
        "boardDataIsolated": sentinel in html,
    }
    print(json.dumps(result, ensure_ascii=False))
    if (
        not result["ok"]
        or not result["installedTemplateHasBoardSlot"]
        or not result["boardDataIsolated"]
    ):
        raise SystemExit(1)


def verify_removed_cache_cold_start():
    temp_root = Path(tempfile.mkdtemp(prefix="aboard-mcp-cold-start-"))
    stale_cache = temp_root / "plugins" / "cache" / "conversation-dashboard" / "old-version"
    fake_app = temp_root / "Aboard.app"
    bundled_root = fake_app / "Contents" / "Resources" / "dashboard"
    data_root = temp_root / "data"
    try:
        stale_cache.mkdir(parents=True)
        shutil.copy2(REPO_ROOT / ".mcp.json", stale_cache / ".mcp.json")
        (bundled_root / "server").mkdir(parents=True)
        (bundled_root / "web").mkdir()
        shutil.copy2(
            REPO_ROOT / "server" / "dashboard_mcp.py",
            bundled_root / "server" / "dashboard_mcp.py",
        )
        shutil.copy2(
            REPO_ROOT / "web" / "dashboard.html",
            bundled_root / "web" / "dashboard.html",
        )

        # Model the host capturing an installed version's config, followed by the
        # marketplace replacing that version before the MCP process first starts.
        captured = json.loads((stale_cache / ".mcp.json").read_text(encoding="utf-8"))
        server_config = captured["mcpServers"][SERVER_NAME]
        validate_stable_config(server_config)
        shutil.rmtree(stale_cache)

        environment = {
            **os.environ,
            "ABOARD_APP_PATH": str(fake_app),
            "PLUGIN_DATA": str(data_root),
        }
        initialized, resource = start_and_read(server_config, environment)
        html = resource["contents"][0]["text"]
        result = {
            "ok": initialized["serverInfo"]["name"] == SERVER_NAME
            and "Aboard" in html
            and "__BOARD_JSON__" not in html,
            "cacheRemovedBeforeStart": not stale_cache.exists(),
            "usedBundledServer": "Aboard" in html,
            "boardInjected": "__BOARD_JSON__" not in html,
        }
        print(json.dumps(result, ensure_ascii=False))
        if not result["ok"]:
            raise SystemExit(1)
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


def main():
    if sys.argv[1:] == ["--installed"]:
        verify_installed_bundle()
        return
    if sys.argv[1:]:
        raise SystemExit("Usage: test-mcp-cold-start.py [--installed]")
    verify_removed_cache_cold_start()


if __name__ == "__main__":
    main()
