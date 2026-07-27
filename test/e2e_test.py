#!/usr/bin/env python3
"""
Comprehensive end-to-end test for aily-local-file-mcp server.
Tests all Phase 1-3 features: tools, auth, security, file operations.
Handles SSE (text/event-stream) responses from MCP Streamable HTTP.
"""

import subprocess
import time
import json
import sys
import os
import signal
import httpx

SERVER_PORT = 3013
BASE_URL = f"http://127.0.0.1:{SERVER_PORT}"
MCP_URL = f"{BASE_URL}/mcp"
TOKEN = "test-secret-token"
WORKSPACE = "/tmp/mcp-test-workspace"
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": f"Bearer {TOKEN}",
}

HEADERS_NO_AUTH = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def parse_sse_response(text):
    """Parse SSE response, extract JSON from data: lines."""
    for line in text.strip().split("\n"):
        line = line.strip()
        if line.startswith("data: "):
            return json.loads(line[6:])
        elif line.startswith("data:"):
            return json.loads(line[5:])
    # If not SSE, try plain JSON
    return json.loads(text)


def mcp_request(method, params=None, req_id=1, auth=True):
    """Make an MCP JSON-RPC request, handle SSE responses."""
    payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    headers = HEADERS if auth else HEADERS_NO_AUTH
    try:
        resp = httpx.post(MCP_URL, json=payload, headers=headers, timeout=10)
        if resp.status_code == 401 or resp.status_code == 429:
            return resp.status_code, resp.json() if resp.text else {}
        if resp.text:
            return resp.status_code, parse_sse_response(resp.text)
        return resp.status_code, {}
    except Exception as e:
        return -1, {"error": str(e)}


def call_tool(name, arguments, req_id=1, auth=True):
    return mcp_request("tools/call", {"name": name, "arguments": arguments}, req_id, auth)


def extract_text(result):
    """Extract text content from a tool call result."""
    if isinstance(result, dict):
        content = result.get("content", [])
        if content and isinstance(content, list):
            return content[0].get("text", "")
        if "error" in result:
            return f"ERROR: {result['error']}"
    return str(result)


def main():
    # Prepare test workspace
    os.makedirs(f"{WORKSPACE}/subdir", exist_ok=True)
    with open(f"{WORKSPACE}/test.txt", "w") as f:
        f.write("Hello MCP!")
    with open(f"{WORKSPACE}/config.json", "w") as f:
        f.write('{"key":"value"}')
    with open(f"{WORKSPACE}/.env", "w") as f:
        f.write("secret-token-test")

    # Start server
    env = os.environ.copy()
    env["ALLOWED_DIRS"] = WORKSPACE
    env["MCP_AUTH_TOKEN"] = TOKEN
    env["AUTH_MODE"] = "none"
    env["CONSENT_ABSOLUTE_PATH"] = "allow"
    env["CONSENT_SENSITIVE_FILE"] = "deny"
    env["PORT"] = str(SERVER_PORT)
    env["LOG_DIR"] = os.path.join(PROJECT_DIR, "logs")

    print("Starting server...")
    proc = subprocess.Popen(
        ["node", "dist/index.js"],
        env=env,
        cwd=PROJECT_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    for i in range(40):
        try:
            r = httpx.get(f"{BASE_URL}/health", timeout=2)
            if r.status_code == 200:
                print(f"Server ready after {i}s")
                break
        except:
            time.sleep(1)
    else:
        print("FAIL: Server didn't start")
        proc.kill()
        sys.exit(1)

    passed = 0
    failed = 0
    results = []

    def test(name, condition, detail=""):
        nonlocal passed, failed
        status = "PASS" if condition else "FAIL"
        if condition:
            passed += 1
        else:
            failed += 1
        msg = f"[{status}] {name}"
        if detail:
            msg += f" -- {detail}"
        results.append(msg)
        print(msg)

    rid = 100  # request ID counter

    # === Health Check ===
    r = httpx.get(f"{BASE_URL}/health", timeout=5)
    health = r.json()
    test("Health check returns 200", r.status_code == 200)
    test("Health shows 11 tools", len(health.get("tools", [])) == 11, f"got {len(health.get('tools', []))}")
    test("Health shows auth enabled", health.get("authEnabled") == True)

    # === No Auth -> 401 ===
    code, body = mcp_request("initialize", auth=False)
    test("No auth -> 401", code == 401, f"got {code}")

    # === Wrong token -> 401 ===
    headers_wrong = {**HEADERS, "Authorization": "Bearer wrong-token"}
    try:
        r = httpx.post(MCP_URL, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}}, headers=headers_wrong, timeout=10)
        test("Wrong token -> 401", r.status_code == 401, f"got {r.status_code}")
    except Exception as e:
        test("Wrong token -> 401", False, str(e))

    # === MCP Initialize ===
    rid += 1
    code, body = mcp_request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}, rid)
    test("MCP initialize succeeds", code == 200, f"got {code}, body={str(body)[:200]}")
    if code == 200 and "result" in body:
        si = body["result"].get("serverInfo", {})
        test("Server name correct", si.get("name") == "feishu-mcp", str(si))
        test("Server version 1.0.0", si.get("version") == "1.0.0", str(si.get("version")))

    # === Tools List ===
    rid += 1
    code, body = mcp_request("tools/list", {}, rid)
    tools = []
    if code == 200 and "result" in body:
        tools = [t["name"] for t in body["result"].get("tools", [])]
    test("Tools list returns 11 tools", len(tools) == 11, f"got {len(tools)}: {tools}")
    expected_tools = {"ping", "read_file", "write_file", "edit_file", "create_directory", "list_directory", "move_file", "search_files", "get_file_info", "list_allowed_directories", "auth"}
    test("All expected tools present", expected_tools.issubset(set(tools)), f"missing: {expected_tools - set(tools)}")

    # === Ping Tool ===
    rid += 1
    code, body = call_tool("ping", {"message": "hello"}, rid)
    text = extract_text(body.get("result", body))
    test("Ping returns pong", "pong" in text, text)

    # === Read File ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/test.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Read file content correct", "Hello MCP!" in text, text[:100])

    # === List Directory ===
    rid += 1
    code, body = call_tool("list_directory", {"path": WORKSPACE}, rid)
    text = extract_text(body.get("result", body))
    test("List directory shows test.txt", "test.txt" in text, text[:200])
    test("List directory shows config.json", "config.json" in text)
    test("List directory shows subdir", "subdir" in text)

    # === Path Traversal (should be denied) ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/../../../etc/passwd"}, rid)
    text = extract_text(body.get("result", body))
    test("Path traversal blocked", "outside" in text.lower() or "error" in text.lower(), text[:100])

    # === Sensitive File (.env should be denied) ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/.env"}, rid)
    text = extract_text(body.get("result", body))
    test("Sensitive file (.env) blocked", "sensitive" in text.lower() or "blocked" in text.lower() or "error" in text.lower(), text[:100])

    # === Blocked Extension (.exe write should be denied) ===
    rid += 1
    code, body = call_tool("write_file", {"path": f"{WORKSPACE}/malware.exe", "content": "fake"}, rid)
    text = extract_text(body.get("result", body))
    test("Blocked extension (.exe) write denied", "blocked" in text.lower() or "error" in text.lower(), text[:100])

    # === Write File ===
    rid += 1
    code, body = call_tool("write_file", {"path": f"{WORKSPACE}/newfile.txt", "content": "Written by MCP!"}, rid)
    text = extract_text(body.get("result", body))
    test("Write file succeeds", "success" in text.lower() or "wrote" in text.lower(), text[:100])

    # === Verify Write ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/newfile.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Read back written file", "Written by MCP!" in text, text[:100])

    # === Edit File ===
    rid += 1
    code, body = call_tool("edit_file", {"path": f"{WORKSPACE}/newfile.txt", "oldText": "Written", "newText": "Edited"}, rid)
    text = extract_text(body.get("result", body))
    test("Edit file succeeds", "success" in text.lower() or "edited" in text.lower() or "replace" in text.lower(), text[:100])

    # === Verify Edit ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/newfile.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Edit applied correctly", "Edited by MCP!" in text, text[:100])

    # === Edit File Dry Run ===
    rid += 1
    code, body = call_tool("edit_file", {"path": f"{WORKSPACE}/newfile.txt", "oldText": "Edited", "newText": "Previewed", "dryRun": True}, rid)
    text = extract_text(body.get("result", body))
    test("Edit dryRun shows preview", "dry" in text.lower() or "preview" in text.lower() or "would" in text.lower(), text[:100])

    # === Search Files ===
    rid += 1
    code, body = call_tool("search_files", {"path": WORKSPACE, "pattern": "*.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Search finds .txt files", "test.txt" in text or "newfile.txt" in text, text[:200])

    # === Search with exclude ===
    rid += 1
    code, body = call_tool("search_files", {"path": WORKSPACE, "pattern": "*", "excludePatterns": ["*.json"]}, rid)
    text = extract_text(body.get("result", body))
    test("Search with exclude works", "config.json" not in text, text[:200])

    # === Get File Info ===
    rid += 1
    code, body = call_tool("get_file_info", {"path": f"{WORKSPACE}/test.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Get file info returns metadata", '"type"' in text and '"size"' in text, text[:200])
    test("Get file info shows file type", '"file"' in text, text[:200])

    # === Create Directory ===
    rid += 1
    code, body = call_tool("create_directory", {"path": f"{WORKSPACE}/newdir"}, rid)
    text = extract_text(body.get("result", body))
    test("Create directory succeeds", "success" in text.lower() or "created" in text.lower() or "exists" in text.lower(), text[:100])

    # === Move File ===
    rid += 1
    code, body = call_tool("move_file", {"source": f"{WORKSPACE}/newfile.txt", "destination": f"{WORKSPACE}/newdir/moved.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Move file succeeds", "success" in text.lower() or "moved" in text.lower(), text[:100])

    # === Verify Move ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/newdir/moved.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Moved file readable at new location", "Edited by MCP!" in text, text[:100])

    # === Old location gone ===
    rid += 1
    code, body = call_tool("read_file", {"path": f"{WORKSPACE}/newfile.txt"}, rid)
    text = extract_text(body.get("result", body))
    test("Old file gone after move", "not found" in text.lower() or "error" in text.lower(), text[:100])

    # === List Allowed Directories ===
    rid += 1
    code, body = call_tool("list_allowed_directories", {}, rid)
    text = extract_text(body.get("result", body))
    test(
        "List allowed dirs shows workspace",
        os.path.normcase(os.path.abspath(WORKSPACE))
        in os.path.normcase(os.path.abspath(text.strip())),
        text[:100],
    )

    # === Audit Log Check ===
    log_path = f"{PROJECT_DIR}/logs/mcp-operations.log"
    try:
        with open(log_path) as f:
            log_lines = f.readlines()
        test("Audit log has entries", len(log_lines) > 5, f"{len(log_lines)} entries")
        test("Audit log has write operations", any('"write_file"' in l for l in log_lines))
        test("Audit log has denied operations", any('"denied"' in l for l in log_lines))
    except Exception as e:
        test("Audit log exists", False, str(e))

    # === Soft-delete / Trash Check ===
    trash_path = f"{WORKSPACE}/.trash"
    test("Trash directory exists", os.path.exists(trash_path))
    if os.path.exists(trash_path):
        trash_items = os.listdir(trash_path)
        test("Trash has items (soft-delete worked)", len(trash_items) > 0, f"{len(trash_items)} items: {trash_items[:3]}")

    # Cleanup
    proc.send_signal(signal.SIGTERM)
    proc.wait()

    # Summary
    print(f"\n{'='*60}")
    print(f"RESULTS: {passed} passed, {failed} failed, {passed + failed} total")
    print(f"{'='*60}")

    if failed > 0:
        print("\nFAILED TESTS:")
        for r in results:
            if r.startswith("[FAIL]"):
                print(f"  {r}")
        sys.exit(1)
    else:
        print("\nAll tests passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
