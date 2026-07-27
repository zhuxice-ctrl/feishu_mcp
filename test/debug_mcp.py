#!/usr/bin/env python3
"""Debug: check raw MCP response format."""
import subprocess, time, sys, os, signal, httpx, json

PORT = 3012
BASE = f"http://127.0.0.1:{PORT}"
MCP = f"{BASE}/mcp"
TOKEN = "test-secret-token"
WS = "/tmp/mcp-test-workspace"

os.makedirs(f"{WS}/subdir", exist_ok=True)
with open(f"{WS}/test.txt", "w") as f: f.write("Hello MCP!")
with open(f"{WS}/config.json", "w") as f: f.write('{"key":"value"}')
with open(f"{WS}/.env", "w") as f: f.write("secret-token-test")

env = os.environ.copy()
env["ALLOWED_DIRS"] = WS
env["MCP_AUTH_TOKEN"] = TOKEN
env["PORT"] = str(PORT)

proc = subprocess.Popen(["node", "dist/index.js"], env=env,
    cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

for i in range(40):
    try:
        if httpx.get(f"{BASE}/health", timeout=2).status_code == 200:
            print(f"Ready after {i}s"); break
    except: time.sleep(1)

headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": f"Bearer {TOKEN}",
}

# Initialize
print("\n=== INITIALIZE ===")
r = httpx.post(MCP, json={"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}, headers=headers, timeout=10)
print(f"Status: {r.status_code}")
print(f"Content-Type: {r.headers.get('content-type')}")
print(f"Session-ID: {r.headers.get('mcp-session-id', 'N/A')}")
print(f"Body ({len(r.text)} chars): {r.text[:500]}")

session_id = r.headers.get('mcp-session-id', '')
if session_id:
    headers["Mcp-Session-Id"] = session_id
    print(f"\nUsing session: {session_id}")

# Tools list
print("\n=== TOOLS LIST ===")
r = httpx.post(MCP, json={"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}, headers=headers, timeout=10)
print(f"Status: {r.status_code}")
print(f"Content-Type: {r.headers.get('content-type')}")
print(f"Body ({len(r.text)} chars): {r.text[:500]}")

# Ping
print("\n=== PING ===")
r = httpx.post(MCP, json={"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{"message":"hello"}}}, headers=headers, timeout=10)
print(f"Status: {r.status_code}")
print(f"Content-Type: {r.headers.get('content-type')}")
print(f"Body ({len(r.text)} chars): {r.text[:500]}")

# Read file
print("\n=== READ FILE ===")
r = httpx.post(MCP, json={"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"path":f"{WS}/test.txt"}}}, headers=headers, timeout=10)
print(f"Status: {r.status_code}")
print(f"Content-Type: {r.headers.get('content-type')}")
print(f"Body ({len(r.text)} chars): {r.text[:500]}")

proc.send_signal(signal.SIGTERM)
proc.wait()
print("\n=== DONE ===")
